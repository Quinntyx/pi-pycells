import * as net from "node:net";
import { randomUUID, createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import { PythonSessionManager, UnknownKernelError } from "../python-session-manager";
import * as executionErrors from "../execution/execution-errors";
import type { PtcSettings, SandboxManager } from "../types";
import type { PythonSessionManagerHooks } from "../contracts/execution-types";
import { cleanArguments, HOST_PROTOCOL_VERSION, type HostState, type HostedKernel, type HostOperation, type SerializedError } from "./protocol";
const exec = promisify(execFile);
export interface HostEndpoint { socketPath: string; tmuxSession: string; tmuxSocket: string; }
export function hostSocketPath(tmuxSocket: string, sessionId: string, root = path.join(os.tmpdir(), `pi-pycells-${process.getuid?.() ?? "user"}`)): string {
  const key = createHash("sha256").update(`${tmuxSocket}\0${sessionId}`).digest("hex").slice(0, 24);
  return path.join(root, `kernel-${key}.sock`);
}
async function tmux(args: string[]): Promise<string> {
  return (await exec("tmux", args, { timeout: 10_000 })).stdout.trim();
}
export async function resolveHostEndpoint(): Promise<HostEndpoint> {
  if (!process.env.TMUX || !process.env.TMUX_PANE) throw new Error("Persistent kernels require Pi to run inside a tmux session");
  const result = await tmux(["display-message", "-p", "-t", process.env.TMUX_PANE, "#{session_id}\t#{socket_path}"]);
  const [tmuxSession, tmuxSocket] = result.split("\t");
  if (!/^\$\d+$/.test(tmuxSession ?? "") || !tmuxSocket) throw new Error("Cannot identify Pi's owning tmux session");
  return { tmuxSession, tmuxSocket, socketPath: hostSocketPath(tmuxSocket, tmuxSession) };
}
async function reachable(socketPath: string): Promise<boolean> {
  return await new Promise(resolve => {
    const socket = net.createConnection(socketPath);
    const timer = setTimeout(() => { socket.destroy(); resolve(false); }, 1_000);
    socket.once("connect", () => { clearTimeout(timer); socket.destroy(); resolve(true); });
    socket.once("error", () => { clearTimeout(timer); resolve(false); });
  });
}
function processIdentity(pid: number): string | undefined {
  try { return fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").slice(1).join(") ").trim().split(/\s+/)[19]; }
  catch { return undefined; }
}
function liveLease(lease: { pid?: number; birth?: string }): boolean {
  if (!Number.isInteger(lease.pid) || lease.pid! < 1) return false;
  try { process.kill(lease.pid!, 0); } catch { return false; }
  const current = processIdentity(lease.pid!);
  return !current || !lease.birth || current === lease.birth;
}
async function acquireCreationLease(socketPath: string): Promise<() => void> {
  const file = socketPath + ".lock", nonce = randomUUID(), deadline = Date.now() + 15_000;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  while (true) {
    try {
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid, birth: processIdentity(process.pid), nonce }), { flag: "wx", mode: 0o600 });
      return () => {
        try { if (JSON.parse(fs.readFileSync(file, "utf8")).nonce === nonce) fs.unlinkSync(file); } catch {}
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const before = fs.statSync(file);
        let stale = false;
        try { stale = !liveLease(JSON.parse(fs.readFileSync(file, "utf8"))); }
        catch { stale = Date.now() - before.mtimeMs > 5_000; }
        // A dead launcher's lease cannot strand all future clients. Fence the
        // observed inode before retiring it; never steal a live launcher's lock.
        if (stale && fs.statSync(file).ino === before.ino) { fs.unlinkSync(file); continue; }
      } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      if (Date.now() > deadline) throw new Error("Kernel host creation is still owned by another live client; retry discovery");
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
}
export async function ensureHost(endpoint: HostEndpoint, extensionRoot: string): Promise<void> {
  if (await reachable(endpoint.socketPath)) return;
  // Git packages are source-loaded by Pi and installed without build tooling.
  // Prefer the shipped launcher over potentially stale local build output.
  const sourceMain = path.join(extensionRoot, "src/kernel-host/launch.cjs");
  const compiledMain = path.join(extensionRoot, "dist/kernel-host/main.js");
  const main = fs.existsSync(sourceMain) ? sourceMain : compiledMain;
  if (!fs.existsSync(main)) throw new Error(`Kernel host executable missing: expected ${sourceMain} or ${compiledMain}. Reinstall/update pi-pycells before provisioning.`);
  const args = ["-S", endpoint.tmuxSocket];
  // A PID-fenced creation lease survives an interrupted launcher without the
  // permanently held lock that tmux wait-for -L would leave after SIGKILL.
  const release = await acquireCreationLease(endpoint.socketPath);
  try {
    if (await reachable(endpoint.socketPath)) return;
    fs.mkdirSync(path.dirname(endpoint.socketPath), { recursive: true, mode: 0o700 });
    fs.chmodSync(path.dirname(endpoint.socketPath), 0o700);
    if (fs.existsSync(endpoint.socketPath)) fs.unlinkSync(endpoint.socketPath); // stale socket, not user data
    const environmentPath = endpoint.socketPath + ".environment";
    fs.writeFileSync(environmentPath, JSON.stringify(process.env), { mode: 0o600 });
    fs.chmodSync(environmentPath, 0o600);
    const command = [process.execPath, main, "--socket", endpoint.socketPath, "--root", extensionRoot, "--environment", environmentPath];
    const window = await tmux([...args, "new-window", "-d", "-P", "-F", "#{window_id}", "-t", endpoint.tmuxSession, "-n", "pycells-kernels", "--", ...command]);
    await tmux([...args, "set-window-option", "-t", window, "automatic-rename", "off"]);
    await tmux([...args, "set-window-option", "-t", window, "allow-rename", "off"]);
    await tmux([...args, "set-option", "-t", endpoint.tmuxSession, "@pi_pycells_kernel_socket", endpoint.socketPath]);
    await tmux([...args, "set-option", "-t", endpoint.tmuxSession, "@pi_pycells_kernel_window", window]);
    for (let i = 0; i < 100; i++) {
      if (await reachable(endpoint.socketPath)) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`Kernel host did not become ready; inspect tmux window ${window}`);
  } finally { release(); }
}
export function decodeHostError(error: SerializedError): Error {
  if (error.name === "PtcPythonError") return new executionErrors.PtcPythonError(error.rawMessage ?? error.message, error.traceback);
  const ctor = (executionErrors as any)[error.name];
  if (typeof ctor === "function") return new ctor(error.message);
  const result = new Error(error.message); result.name = error.name; return result;
}
export class KernelHostConnection {
  state: HostState = { kernels: [], operations: [], pid: 0 };
  private socket?: net.Socket;
  private pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; update?: (frame: any) => void }>();
  constructor(readonly socketPath: string, private onState?: (state: HostState) => void) {}
  get connected(): boolean { return Boolean(this.socket && !this.socket.destroyed); }
  async connect(owner: string): Promise<void> {
    if (!this.socket || this.socket.destroyed) {
      const socket = this.socket = net.createConnection(this.socketPath);
      await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
      const reader = createInterface({ input: socket, crlfDelay: Infinity });
      reader.on("error", () => socket.destroy());
      reader.on("line", line => {
        let frame: any;
        try { frame = JSON.parse(line); } catch { socket.destroy(); return; }
        if (frame.event === "state") { this.state = frame.state; this.onState?.(this.state); return; }
        const pending = this.pending.get(frame.id);
        if (!pending) return;
        if (frame.event === "update") { pending.update?.(frame.update); return; }
        this.pending.delete(frame.id);
        frame.error ? pending.reject(decodeHostError(frame.error)) : pending.resolve(frame.result);
      });
      socket.on("error", () => undefined);
      socket.on("close", () => {
        reader.close();
        for (const [id, pending] of this.pending) pending.reject(new Error(`Detached from kernel host while operation ${id} was in flight. The kernel may still be running; reconnect and inspect before resubmitting.`));
        this.pending.clear();
      });
    }
    await this.request("hello", { owner, version: HOST_PROTOCOL_VERSION });
    // A discover response provides an initial snapshot without depending on frame scheduling.
    this.state.kernels = await this.request("discover", {});
  }
  async request(op: string, body: Record<string, unknown>, update?: (frame: any) => void, id = randomUUID()): Promise<any> {
    if (!this.socket || this.socket.destroyed) throw new Error("Kernel host client is not attached");
    return await new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, update });
      this.socket!.write(JSON.stringify({ ...body, op, id }) + "\n", error => { if (error) { this.pending.delete(id); reject(error); } });
    });
  }
  detach(): void { this.socket?.destroy(); }
}

/** Pi-side adapter. Only explicit dispose(id) terminates an interpreter. */
export class PersistentSessionManager extends PythonSessionManager {
  private connection?: KernelHostConnection;
  private owner = "";
  private ready?: Promise<void>;
  constructor(sandbox: SandboxManager, settings: PtcSettings, private hostRoot: string,
    private clientHooks: PythonSessionManagerHooks = {}, private endpointOverride?: HostEndpoint) {
    super(sandbox, settings, hostRoot, clientHooks);
  }
  async attachOwner(owner: string): Promise<void> {
    if (!owner) throw new Error("A Pi session ID is required to attach a kernel client");
    if (this.owner === owner && this.ready && this.connection?.connected) return this.ready;
    this.owner = owner;
    // Loading Pi outside tmux is allowed; only kernel operations require it.
    if (!this.endpointOverride && (!process.env.TMUX || !process.env.TMUX_PANE)) { this.ready = undefined; return; }
    this.ready = (async () => {
      const endpoint = this.endpointOverride ?? await resolveHostEndpoint();
      if (!this.endpointOverride) await ensureHost(endpoint, this.hostRoot);
      this.connection ??= new KernelHostConnection(endpoint.socketPath, state => {
        for (const kernel of state.kernels) if (kernel.snapshot) this.clientHooks.onSubagentSnapshot?.(kernel.id, "", kernel.snapshot);
      });
      await this.connection.connect(owner);
    })();
    try { await this.ready; } catch (error) { this.ready = undefined; throw error; }
  }
  private async ensureConnected(): Promise<void> {
    if (!this.owner) throw new Error("Kernel client has no Pi session identity; attach before using kernels");
    await this.attachOwner(this.owner);
    if (!this.connection?.connected) throw new Error("Persistent kernels require Pi to run inside a tmux session");
  }
  private async call(method: string, args: unknown[]): Promise<any> {
    await this.ensureConnected();
    let update: ((frame: any) => void) | undefined;
    for (const arg of args) if (arg && typeof arg === "object" && typeof (arg as any).onUpdate === "function") update = (arg as any).onUpdate;
    if (method === "provision") (args[0] as any).launchEnvironment = { ...process.env };
    const result = await this.connection!.request("call", { method, args: cleanArguments(args) }, update);
    if (result?.scriptError?.name) result.scriptError = decodeHostError(result.scriptError);
    // Request completion precedes state broadcast. Refresh before synchronous name resolution.
    this.connection!.state.kernels = await this.connection!.request("discover", {});
    return result;
  }
  override list() { return this.connection?.state.kernels ?? []; }
  override get(id: string) { return this.list().some(k => k.id === id); }
  override getPythonExecutable(id: string) { return this.list().find(k => k.id === id)?.pythonExecutable; }
  override getSubagentSnapshot(id: string) { return this.list().find(k => k.id === id)?.snapshot ?? null; }
  override allSubagentSnapshots() { return this.list().flatMap(k => k.snapshot ? [{ sessionId: k.id, snapshot: k.snapshot }] : []); }
  override latestSubagentSnapshot() { return this.allSubagentSnapshots()[0]?.snapshot ?? null; }
  override mostRecentActive() { return this.list().find(k => k.running) ?? this.list()[0] ?? null; }
  override resolveKernel(name: string) {
    const kernel = this.list().find(k => k.name === name);
    if (!kernel) throw new UnknownKernelError(name, this.list().map(k => k.name));
    return kernel;
  }
  async discover(allSessions = false): Promise<HostedKernel[]> { await this.ensureConnected(); return this.connection!.request("discover", { allSessions }); }
  async attachKernel(id: string, alias?: string): Promise<HostedKernel> {
    await this.ensureConnected(); const kernel = await this.connection!.request("attach", { kernelId: id, alias });
    this.connection!.state.kernels = await this.connection!.request("discover", {}); return kernel;
  }
  async operation(id: string): Promise<HostOperation> { await this.ensureConnected(); return this.connection!.request("operation", { operationId: id }); }
  override interruptRunning(id: string): boolean {
    if (!this.get(id) || !this.list().find(k => k.id === id)?.running) return false;
    void this.call("interruptRunning", [id]).catch(error => this.clientHooks.onInterrupted?.(id, String(error))); return true;
  }
  override async disposeAll(): Promise<void> { this.connection?.detach(); this.ready = undefined; this.owner = ""; }
  override async provision(...args: Parameters<PythonSessionManager["provision"]>): Promise<Awaited<ReturnType<PythonSessionManager["provision"]>>> { return this.call("provision", args); }
  override async inspectKernel(...args: Parameters<PythonSessionManager["inspectKernel"]>): Promise<Awaited<ReturnType<PythonSessionManager["inspectKernel"]>>> { return this.call("inspectKernel", args); }
  override async readCellOutput(...args: Parameters<PythonSessionManager["readCellOutput"]>): Promise<Awaited<ReturnType<PythonSessionManager["readCellOutput"]>>> { return this.call("readCellOutput", args); }
  override async execForeground(...args: Parameters<PythonSessionManager["execForeground"]>): Promise<Awaited<ReturnType<PythonSessionManager["execForeground"]>>> { return this.call("execForeground", args); }
  override async scratchRun(...args: Parameters<PythonSessionManager["scratchRun"]>): Promise<Awaited<ReturnType<PythonSessionManager["scratchRun"]>>> { return this.call("scratchRun", args); }
  override async writeCell(...args: Parameters<PythonSessionManager["writeCell"]>): Promise<Awaited<ReturnType<PythonSessionManager["writeCell"]>>> { return this.call("writeCell", args); }
  override async deleteCell(...args: Parameters<PythonSessionManager["deleteCell"]>): Promise<Awaited<ReturnType<PythonSessionManager["deleteCell"]>>> { return this.call("deleteCell", args); }
  override async readCells(...args: Parameters<PythonSessionManager["readCells"]>): Promise<Awaited<ReturnType<PythonSessionManager["readCells"]>>> { return this.call("readCells", args); }
  override async readCell(...args: Parameters<PythonSessionManager["readCell"]>): Promise<Awaited<ReturnType<PythonSessionManager["readCell"]>>> { return this.call("readCell", args); }
  override async runCell(...args: Parameters<PythonSessionManager["runCell"]>): Promise<Awaited<ReturnType<PythonSessionManager["runCell"]>>> { return this.call("runCell", args); }
  override async runTo(...args: Parameters<PythonSessionManager["runTo"]>): Promise<Awaited<ReturnType<PythonSessionManager["runTo"]>>> { return this.call("runTo", args); }
  override async runAll(...args: Parameters<PythonSessionManager["runAll"]>): Promise<Awaited<ReturnType<PythonSessionManager["runAll"]>>> { return this.call("runAll", args); }
  override async resetKernel(...args: Parameters<PythonSessionManager["resetKernel"]>): Promise<Awaited<ReturnType<PythonSessionManager["resetKernel"]>>> { return this.call("resetKernel", args); }
  override async toScript(...args: Parameters<PythonSessionManager["toScript"]>): Promise<Awaited<ReturnType<PythonSessionManager["toScript"]>>> { return this.call("toScript", args); }
  override async dispose(...args: Parameters<PythonSessionManager["dispose"]>): Promise<Awaited<ReturnType<PythonSessionManager["dispose"]>>> { return this.call("dispose", args); }
}
