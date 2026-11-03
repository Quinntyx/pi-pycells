import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import { createInterface } from "node:readline";
import { PythonSessionManager, normalizeKernelName } from "../python-session-manager";
import { serializeError, HOST_PROTOCOL_VERSION, type HostedKernel, type HostOperation, type HostState } from "./protocol";

import { notebookSnapshot } from "./notebook";

const METHODS = new Set(["provision", "inspectKernel", "readCellOutput", "execForeground", "scratchRun", "writeCell", "deleteCell", "readCells", "readCell", "runCell", "runTo", "runAll", "resetKernel", "toScript", "dispose", "interruptRunning"]);
const UPDATE_OPTIONS: Record<string, number> = { provision: 0, execForeground: 2, scratchRun: 2, runCell: 2, runTo: 2, runAll: 1, resetKernel: 1 };

/** Owns interpreters independently of any Pi connection. It contains no agent workflow logic. */
export class KernelHost {
  private clients = new Map<net.Socket, { owner: string; attached: Map<string, string> }>();
  private sockets = new Set<net.Socket>();
  private attachments = new Map<string, Map<string, string>>();
  private owners = new Map<string, { owner: string; name: string }>();
  private operations = new Map<string, HostOperation>();
  private server?: net.Server;
  private timer?: NodeJS.Timeout;
  private lastState = "";
  private provisionQueue: Promise<unknown> = Promise.resolve();
  constructor(readonly manager: PythonSessionManager, readonly socketPath: string,
    private options: { headless?: boolean; threadId?: string } = {}) {}

  state(): HostState {
    const kernels = this.manager.list().flatMap(row => {
      const identity = this.owners.get(row.id);
      const operation = [...this.operations.values()].reverse().find(op => op.kernelId === row.id);
      const lastOperation = operation ? { id: operation.id, method: operation.method, status: operation.status, startedAt: operation.startedAt, finishedAt: operation.finishedAt } : undefined;
      return identity ? [{ ...row, name: identity.name, ownerSessionId: identity.owner,
        pythonExecutable: this.manager.getPythonExecutable(row.id), snapshot: this.manager.getSubagentSnapshot(row.id), lastOperation }] : [];
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
  private visible(owner: string, attached: Map<string, string>): HostedKernel[] {
    return this.state().kernels.filter(k => k.ownerSessionId === owner || attached.has(k.id))
      .map(k => ({ ...k, name: attached.get(k.id) ?? k.name }));
  }
  private send(socket: net.Socket, message: unknown): void {
    if (socket.destroyed || !socket.writable) return;
    try {
      socket.write(JSON.stringify(message, (_key, value) => value instanceof Error ? serializeError(value) : value) + "\n", error => {
        if (error) socket.destroy();
      });
    } catch { socket.destroy(); } // A detached client cannot fail its completed operation.

  }
  private publish(force = false): void {
    const state = this.state();
    const serialized = JSON.stringify(state);
    if (!force && serialized === this.lastState) return;
    this.lastState = serialized;
    for (const [socket, client] of this.clients) this.send(socket, { event: "state", state: {
      ...state, kernels: this.visible(client.owner, client.attached), operations: state.operations.filter(op =>
        op.ownerSessionId === client.owner || (op.kernelId && client.attached.has(op.kernelId))) } });
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
      this.clients.set(socket, { owner: request.owner, attached });
      this.send(socket, { id: request.id, result: { version: HOST_PROTOCOL_VERSION } });
      this.publish(true); return;
    }
    const client = this.clients.get(socket);
    if (!client) throw new Error("Connect with a Pi session identity first");
    const allowed = (id: string) => this.visible(client.owner, client.attached).some(k => k.id === id);
    if (request.op === "discover") {
      this.send(socket, { id: request.id, result: request.allSessions ? this.state().kernels : this.visible(client.owner, client.attached) }); return;
    }
    if (request.op === "attach") {
      const kernel = this.state().kernels.find(k => k.id === request.kernelId);
      if (!kernel) throw new Error("Requested kernel is not live on this tmux session's host");
      const alias = normalizeKernelName(request.alias ?? kernel.name);
      if (this.visible(client.owner, client.attached).some(k => k.id !== kernel.id && k.name === alias)) throw new Error("Kernel name already visible; pass a different alias");
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
    const optionIndex = UPDATE_OPTIONS[request.method];
    if (optionIndex !== undefined) {
      const options = args[optionIndex] = { ...(args[optionIndex] ?? {}) };
      options.ctx = { cwd: options.cwd ?? process.cwd(), hasUI: false };
      options.onUpdate = (update: unknown) => {
        operation.update = update;
        this.send(socket, { event: "update", id: request.id, update }); this.publish();
      };
      // No caller AbortSignal: disconnecting a Pi client must not interrupt its interpreter.
    }
    const invoke = async () => {
      if (request.method === "provision") {
        const publicName = normalizeKernelName(args[0]?.name);
        if (this.visible(client.owner, client.attached).some(k => k.name === publicName)) throw new Error("Kernel name already in use in this Pi session");
        args[0].name = `${client.owner}:${publicName}`;
        if (args[0].launchEnvironment) {
          // The caller's Pi pane may disappear. Kernels live in the host pane,
          // while their profile configuration still comes from the creator.
          for (const key of ["TMUX", "TMUX_PANE"]) if (process.env[key]) args[0].launchEnvironment[key] = process.env[key];
        }
        const result = await this.manager.provision(args[0]);
        this.owners.set(result.id, { owner: client.owner, name: publicName });
        operation.kernelId = result.id;
        return { ...result, name: publicName, ownerSessionId: client.owner };
      }
      const fn = (this.manager as any)[request.method];
      const result = await fn.apply(this.manager, args);
      if (request.method === "dispose") this.owners.delete(args[0]);
      if (request.method === "resetKernel") {
        const publicName = client.attached.get(args[0]) ?? this.owners.get(args[0])?.name;
        return { ...result, name: publicName ?? result.name };
      }
      return result;
    };
    this.publish(true);
    try {
      // Serialize provisioning across clients so hidden namespaces cannot race shared manager names.
      const job = request.method === "provision" ? this.provisionQueue.then(invoke) : invoke();
      if (request.method === "provision") this.provisionQueue = job.catch(() => undefined);
      operation.result = await job;
      operation.status = "completed";
      this.send(socket, { id: request.id, result: operation.result });
    } catch (error) {
      operation.error = serializeError(error); operation.status = "failed";
      this.send(socket, { id: request.id, error: operation.error });
    } finally {
      operation.finishedAt = Date.now(); this.publish(true);
      // Retain recent outcomes for reconnects; never evict active work.
      const finished = [...this.operations.values()].filter(op => op.status !== "running");
      for (const old of finished.slice(0, Math.max(0, finished.length - 128))) this.operations.delete(old.id);
    }
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
