import { homedir } from "node:os";
import * as path from "node:path";
import type { PythonSessionManager } from "./python-session-manager";
import type { PtcSettings } from "./types";

export const KERNEL_CALLS = ["provision", "inspectKernel", "readCellOutput", "execForeground", "scratchRun",
  "writeCell", "deleteCell", "readCells", "readCell", "runCell", "runTo", "runAll", "resetKernel", "dispose"] as const;
export type KernelCall = (typeof KERNEL_CALLS)[number];
export type KernelManager = Pick<PythonSessionManager, KernelCall | "list" | "getPythonExecutable" |
  "allSubagentSnapshots" | "interruptRunning" | "resolveLibraryDir" | "disposeAll">;

export function resolveLibraryDir(settings: PtcSettings): string {
  const configured = settings.libraryDir?.trim() || process.env.PTC_LIBRARY_DIR?.trim();
  if (configured) {
    const expanded = configured === "~" || configured.startsWith(`~${path.sep}`)
      ? path.join(homedir(), configured.slice(2))
      : configured;
    return path.resolve(expanded);
  }
  const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || path.join(homedir(), ".pi", "agent");
  return path.resolve(agentDir, "pycells-library");
}
