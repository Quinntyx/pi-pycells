import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import { createInterface } from "node:readline";
import { PythonSessionManager, normalizeKernelName } from "../python-session-manager";
import { KERNEL_CALLS, type KernelCall } from "../kernel-manager";
import { serializeError, HOST_PROTOCOL_VERSION, type HostedKernel, type HostOperation, type HostState } from "./protocol";

import { notebookSnapshot } from "./notebook";

type Client = { owner: string; attached: Map<string, string> };
type HostCall = KernelCall | "interruptRunning";
const METHODS = new Set<HostCall>([...KERNEL_CALLS, "interruptRunning"]);
const UPDATE_OPTIONS: Partial<Record<HostCall, number>> = { provision: 0, execForeground: 2, scratchRun: 2, runCell: 2, runTo: 2, runAll: 1, resetKernel: 1 };

function notebookKey(absolutePath: string): string {
  try { return fs.realpathSync.native(absolutePath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  // realpath can't resolve a symlink until its target exists.
  const parent = path.dirname(absolutePath);
  let target: string | undefined;
  try { target = fs.readlinkSync(absolutePath); }
  catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    if (code !== "ENOENT" && code !== "EINVAL") throw error;
  }
  if (target !== undefined) {
    // Let realpath interpret any `..` following another symlink in the target.
    return notebookKey(path.isAbsolute(target) ? target : `${notebookKey(parent)}${path.sep}${target}`);
  }
  return parent === absolutePath ? absolutePath : path.join(notebookKey(parent), path.basename(absolutePath));
}

/** Owns interpreters independently of any Pi connection. It contains no agent workflow logic. */
export class KernelHost {
  private clients = new Map<net.Socket, Client>();
  private sockets = new Set<net.Socket>();
  private attachments = new Map<string, Map<string, string>>();
  private operations = new Map<string, HostOperation>();
  private server?: net.Server;
  private timer?: NodeJS.Timeout;
  private lastState = "";
  private reservedNames = new Set<string>();
  private notebookProvisions = new Map<string, Promise<unknown>>();
  constructor(readonly manager: PythonSessionManager, readonly socketPath: string,
    private options: { headless?: boolean; threadId?: string } = {}) {}

  state(): HostState {
    const kernels = this.manager.list().flatMap(row => {
      const { ownerSessionId } = row;
      if (ownerSessionId === undefined) return [];
      const operation = [...this.operations.values()].reverse().find(op => op.kernelId === row.id);
      const lastOperation = operation ? { id: operation.id, method: operation.method, status: operation.status, startedAt: operation.startedAt, finishedAt: operation.finishedAt } : undefined;
      return [{ ...row, ownerSessionId, pythonExecutable: this.manager.getPythonExecutable(row.id),
        snapshot: this.manager.getSubagentSnapshot(row.id), lastOperation }];
    });
    // State feeds are lightweight previews, not repeated notebook/result payloads.
    // Full retained output remains available through the explicit operation RPC.
    const operations = [...this.operations.values()].map(({ result: _result, update, error, ...operation }) => ({
      ...operation,
      ...(operation.status === "running" && update ? { update } : {}),
      ...(error ? { error: { name: error.name, message: error.message } } : {}),
    }));
    return { kernels, operations, pid: process.pid };
  }
  private visible(kernels: HostedKernel[], { owner, attached }: Client): HostedKernel[] {
    return kernels.filter(k => k.ownerSessionId === owner || attached.has(k.id))
      .map(k => ({ ...k, name: attached.get(k.id) ?? k.name }));
  }
  private nameInUse(client: Client, name: string, exceptId?: string): boolean {
    return this.reservedNames.has(`${client.owner}\0${name}`) || this.manager.list().some(k =>
      k.id !== exceptId && (k.ownerSessionId === client.owner || client.attached.has(k.id)) &&
      (client.attached.get(k.id) ?? k.name) === name);
  }
  private async provision(options: Parameters<PythonSessionManager["provision"]>[0]) {
    if (!options.notebookPath) return this.manager.provision(options);
    const key = notebookKey(path.resolve(options.cwd, options.notebookPath));
    const previous = this.notebookProvisions.get(key);
    // Source replay writes the notebook before the kernel is visible to clients.
    const job = previous
      ? previous.catch(() => undefined).then(() => this.manager.provision(options))
      : this.manager.provision(options);
    this.notebookProvisions.set(key, job);
    try { return await job; }
    finally {
      if (this.notebookProvisions.get(key) === job) this.notebookProvisions.delete(key);
    }
  }
  private send(socket: net.Socket, message: unknown): void {
    if (socket.destroyed || !socket.writable) return;
    try {
      socket.write(JSON.stringify(message, (_key, value) => value instanceof Error ? serializeError(value) : value) + "\n", error => {
        if (error) socket.destroy();
      });
    } catch { socket.destroy(); } // A detached client cannot fail its completed operation.

  }
  private sendState(socket: net.Socket, client: Client, state: HostState): void {
    this.send(socket, { event: "state", state: {
      ...state, kernels: this.visible(state.kernels, client), operations: state.operations.filter(op =>
        op.ownerSessionId === client.owner || (op.kernelId && client.attached.has(op.kernelId))) } });
  }
  private publish(force = false): void {
    if (!this.clients.size) return;
    const state = this.state();
    const serialized = JSON.stringify(state);
    if (!force && serialized === this.lastState) return;
    this.lastState = serialized;
    for (const [socket, client] of this.clients) this.sendState(socket, client, state);
  }
  async listen(): Promise<void> {
    fs.mkdirSync(path.dirname(this.socketPath), { recursive: true, mode: 0o700 });
    // Caller must fence stale endpoints before startup; never unlink a live socket here.
    this.server = net.createServer(socket => {
      this.sockets.add(socket);
      const reader = createInterface({ input: socket, crlfDelay: Infinity });
      reader.on("error", () => socket.destroy());
      reader.on("line", line => {
        if (line.length > 32 * 1024 * 1024) { socket.destroy(); return; }
        let request: any;
        try { request = JSON.parse(line); } catch { socket.destroy(); return; }
        void this.request(socket, request).catch(error => this.send(socket, { id: request.id, error: serializeError(error) }));
      });
      socket.on("error", () => undefined);
      socket.on("close", () => { reader.close(); this.clients.delete(socket); this.sockets.delete(socket); });
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.socketPath, () => { this.server!.removeListener("error", reject); resolve(); });
    });
    fs.chmodSync(this.socketPath, 0o600);
    this.timer = setInterval(() => this.publish(), 200);
    this.timer.unref();
  }
  private async request(socket: net.Socket, request: any): Promise<void> {
    if (typeof request.id !== "string" || !request.id || typeof request.op !== "string") throw new Error("Malformed host request");
    if (request.op === "notebookSnapshot" && this.options.headless) {
      this.send(socket, { id: request.id, result: await notebookSnapshot(this.state().kernels) });
      return;
    }
    if (request.op === "hello") {
      if (this.options.threadId && request.owner !== this.options.threadId) throw new Error("Kernel host belongs to a different T3 thread");
      if (request.version !== HOST_PROTOCOL_VERSION || typeof request.owner !== "string" || !request.owner) throw new Error("Invalid host version or Pi session identity");
      const attached = this.attachments.get(request.owner) ?? new Map<string, string>();
      this.attachments.set(request.owner, attached);
      const client = { owner: request.owner, attached };
      this.clients.set(socket, client);
      this.sendState(socket, client, this.state());
      this.send(socket, { id: request.id, result: { version: HOST_PROTOCOL_VERSION, stateBeforeReply: true } });
      return;
    }
    const client = this.clients.get(socket);
    if (!client) throw new Error("Connect with a Pi session identity first");
    const allowed = (id: string) => this.manager.list().some(k =>
      k.id === id && (k.ownerSessionId === client.owner || client.attached.has(id)));
    if (request.op === "discover") {
      const { kernels } = this.state();
      this.send(socket, { id: request.id, result: request.allSessions ? kernels : this.visible(kernels, client) }); return;
    }
    if (request.op === "attach") {
      const kernel = this.state().kernels.find(k => k.id === request.kernelId);
      if (!kernel) throw new Error("Requested kernel is not live on this tmux session's host");
      const alias = normalizeKernelName(request.alias ?? kernel.name);
      if (this.nameInUse(client, alias, kernel.id)) throw new Error("Kernel name already visible; pass a different alias");
      client.attached.set(kernel.id, alias);
      this.publish(true); this.send(socket, { id: request.id, result: { ...kernel, name: alias } }); return;
    }
    if (request.op === "operation") {
      const operation = this.operations.get(request.operationId);
      if (!operation || (operation.ownerSessionId !== client.owner && (!operation.kernelId || !allowed(operation.kernelId)))) throw new Error("Unknown operation in this Pi session");
      this.send(socket, { id: request.id, result: operation }); return;
    }
    if (request.op !== "call" || !METHODS.has(request.method) || !Array.isArray(request.args)) throw new Error("Unsupported kernel operation");
    const args = request.args;
    if (request.method !== "provision") {
      if (typeof args[0] !== "string" || !allowed(args[0])) throw new Error("Kernel is not attached to this Pi session; discover all sessions and attach explicitly");
    }
    // Stable operation IDs make duplicate delivery/reconnection observable, never an implicit replay.
    if (this.operations.has(request.id)) throw new Error("Operation ID already submitted; inspect its existing outcome");
    const operation: HostOperation = { id: request.id, ownerSessionId: client.owner, method: request.method,
      kernelId: request.method === "provision" ? undefined : args[0], status: "running", startedAt: Date.now() };
    this.operations.set(request.id, operation);
    const method: HostCall = request.method;
    const optionIndex = UPDATE_OPTIONS[method];
    if (optionIndex !== undefined) {
      const options = args[optionIndex] = { ...(args[optionIndex] ?? {}) };
      options.ctx = { cwd: options.cwd ?? process.cwd(), hasUI: false };
      options.onUpdate = (update: unknown) => {
        operation.update = update;
        this.send(socket, { event: "update", id: request.id, update });
      };
      // No caller AbortSignal: disconnecting a Pi client must not interrupt its interpreter.
    }
    const invoke = async () => {
      if (request.method === "provision") {
        const name = normalizeKernelName(args[0]?.name);
        if (this.nameInUse(client, name)) throw new Error("Kernel name already in use in this Pi session");
        const reservation = `${client.owner}\0${name}`;
        this.reservedNames.add(reservation);
        try {
          if (args[0].launchEnvironment) {
            // The caller's Pi pane may disappear. Kernels live in the host pane,
            // while their profile configuration still comes from the creator.
            for (const key of ["TMUX", "TMUX_PANE"]) if (process.env[key]) args[0].launchEnvironment[key] = process.env[key];
          }
          const result = await this.provision({ ...args[0], name, ownerSessionId: client.owner });
          operation.kernelId = result.id;
          return result;
        } finally {
          this.reservedNames.delete(reservation);
        }
      }
      if (method === "resetKernel") {
        const result = await this.manager.resetKernel(args[0], args[1]);
        const alias = client.attached.get(args[0]);
        return alias === undefined ? result : { ...result, name: alias };
      }
      const fn = this.manager[method] as (...args: any[]) => unknown;
      return fn.apply(this.manager, args);
    };
    this.publish();
    try {
      operation.result = await invoke();
      operation.status = "completed";
    } catch (error) {
      operation.error = serializeError(error); operation.status = "failed";
    }
    operation.finishedAt = Date.now();
    // Send the snapshot before settling the call so synchronous list() is current.
    this.publish();
    this.send(socket, operation.error ? { id: request.id, error: operation.error } : { id: request.id, result: operation.result });
    // Retain recent outcomes for reconnects; never evict active work.
    const finished = [...this.operations.values()].filter(op => op.status !== "running");
    for (const old of finished.slice(0, Math.max(0, finished.length - 128))) this.operations.delete(old.id);
  }
  /** Explicit host shutdown; Pi disconnect never calls this. */
  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    for (const socket of this.sockets) socket.destroy();
    await this.manager.disposeAll();
    await new Promise<void>(resolve => this.server ? this.server.close(() => resolve()) : resolve());
    if (fs.existsSync(this.socketPath)) fs.unlinkSync(this.socketPath);
  }
}
