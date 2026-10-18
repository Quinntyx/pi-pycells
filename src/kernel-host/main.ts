import * as fs from "node:fs";
import * as path from "node:path";
import { PythonSessionManager } from "../python-session-manager";
import { createSandbox } from "../sandbox-manager";
import { loadSettingsFromEnv } from "../utils";
import { KernelHost } from "./server";
import { startHostViewer } from "./viewer";

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
  const host = new KernelHost(manager, socketPath);
  await host.listen();
  const stopViewer = startHostViewer(() => host.state());
  let closing = false;
  const stop = async () => {
    if (closing) return; closing = true; stopViewer();
    await host.close(); await sandbox.cleanup(); process.exit(0);
  };
  process.on("SIGTERM", () => { void stop(); });
  process.on("SIGHUP", () => { void stop(); });
  process.on("SIGINT", () => undefined); // Ctrl-C is not implicit kernel disposal.
}
if (require.main === module) void main().catch(error => { console.error(error); process.exitCode = 1; });
