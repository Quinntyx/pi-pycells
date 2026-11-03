import * as fs from "node:fs";

export function processIdentity(pid: number): string | undefined {
  try { return fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").slice(1).join(") ").trim().split(/\s+/)[19]; }
  catch { return undefined; }
}

export function liveProcess(owner: { pid?: number; birth?: string }): boolean {
  if (!Number.isInteger(owner.pid) || owner.pid! < 1) return false;
  try { process.kill(owner.pid!, 0); } catch { return false; }
  const current = processIdentity(owner.pid!);
  return !current || !owner.birth || current === owner.birth;
}
