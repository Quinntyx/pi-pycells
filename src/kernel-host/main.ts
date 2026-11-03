import * as fs from "node:fs";
import * as path from "node:path";
import { PythonSessionManager } from "../python-session-manager";
import { createSandbox } from "../sandbox-manager";
import { loadSettingsFromEnv } from "../utils";
import { KernelHost } from "./server";
import { startHostViewer } from "./viewer";
import { liveProcess, processIdentity } from "./process-owner";

export async function main(): Promise<void> {
  const value = (name: string) => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
  const socketPath = value("--socket"), root = value("--root");
  if (!socketPath || !root) throw new Error("kernel host requires --socket and --root");
  const environment = value("--environment");
  if (environment) {
    const values = JSON.parse(fs.readFileSync(environment, "utf8"));
    for (const [name, val] of Object.entries(values)) if (typeof val === "string" && name !== "TMUX" && name !== "TMUX_PANE") process.env[name] = val;
    fs.unlinkSync(environment);
  }
  const sandbox = await createSandbox();
  const manager = new PythonSessionManager(sandbox, loadSettingsFromEnv(), path.resolve(root));
  const headless = process.argv.includes("--headless") || Boolean(process.env.T3_THREAD_ID && process.env.T3_PYCELLS_SOCKET === socketPath);
  const host = new KernelHost(manager, socketPath, { headless, threadId: headless ? process.env.T3_THREAD_ID : undefined });
  await host.listen();
  const stopViewer = headless ? () => {} : startHostViewer(() => host.state());
  let ownerTimer: NodeJS.Timeout | undefined;
  let closing = false;
  const stop = async () => {
    if (closing) return; closing = true; stopViewer();
    if (ownerTimer) clearInterval(ownerTimer);
    await host.close(); await sandbox.cleanup(); process.exit(0);
  };
  const ownerPid = Number(value("--owner-pid") ?? process.env.T3_PYCELLS_OWNER_PID);
  const owner = { pid: ownerPid, birth: value("--owner-birth") ?? processIdentity(ownerPid) };
  if (headless && Number.isInteger(owner.pid) && owner.pid > 0) {
    ownerTimer = setInterval(() => { if (!liveProcess(owner)) void stop(); }, 1_000);
    ownerTimer.unref();
    if (!liveProcess(owner)) await stop();
  }
  process.on("SIGTERM", () => { void stop(); });
  process.on("SIGHUP", () => { void stop(); });
  process.on("SIGINT", () => { if (headless) void stop(); }); // Ctrl-C in the tmux viewer is not kernel disposal.
}
if (require.main === module) void main().catch(error => { console.error(error); process.exitCode = 1; });
