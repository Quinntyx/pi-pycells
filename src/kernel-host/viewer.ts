import * as fs from "node:fs";
import type { HostState, HostedKernel } from "./protocol";

/** Notebook text is untrusted terminal input; never execute escape/control sequences. */
export function safeText(value: unknown): string {
  return String(value ?? "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}
function text(value: unknown): string { return safeText(Array.isArray(value) ? value.join("") : value); }
export function notebookLines(kernel: HostedKernel, state: HostState): string[] {
  const rows: string[] = [];
  if (kernel.notebookPath) {
    try {
      const document = JSON.parse(fs.readFileSync(kernel.notebookPath, "utf8"));
      for (const [index, cell] of (document.cells ?? []).entries()) {
        rows.push("", `${cell.cell_type === "markdown" ? "Markdown" : `In [${cell.execution_count ?? " "}]`}  · cell ${index + 1}`);
        text(cell.source).split("\n").forEach((line, n) => rows.push(` ${String(n + 1).padStart(4)} │ ${line}`));
        for (const output of cell.outputs ?? []) {
          const body = output.text ?? output.data?.["text/plain"] ?? output.traceback ?? "";
          const label = output.output_type === "error" ? "Error" : output.output_type === "execute_result" ? `Out [${cell.execution_count ?? " "}]` : "Output";
          rows.push(`      └ ${label}`, ...text(body).split("\n").map(line => `        ${line}`));
          if (output.data?.["image/png"]) rows.push("        [PNG image saved in notebook]");
        }
      }
    } catch (error) { rows.push(`Notebook unavailable: ${safeText((error as Error).message)}`); }
  } else rows.push("This kernel is not bound to a notebook.");
  const active = state.operations.find(op => op.kernelId === kernel.id && op.status === "running");
  if (active) {
    const details = (active.update as any)?.details;
    rows.push("", `▶ Executing ${active.method} · ${active.id}`);
    if (details?.userCode) details.userCode.forEach((line: string, n: number) => rows.push(`${details.currentLine === n + 1 ? "▶" : " "}${String(n + 1).padStart(4)} │ ${safeText(line)}`));
    if (details?.liveOutput) rows.push("", ...details.liveOutput.map((line: string) => `      ${safeText(line)}`));
  }
  return rows;
}
export function renderHostView(state: HostState, selected: number, scroll: number, width: number, height: number): { lines: string[]; maxScroll: number } {
  width = Math.max(20, width); height = Math.max(6, height);
  const kernel = state.kernels[selected];
  const tabs = state.kernels.map((k, i) => `${i === selected ? "▶ " : ""}${safeText(k.name)}${k.running ? " ●" : ""}`).join("  │  ");
  const body = kernel ? notebookLines(kernel, state) : ["No kernels yet. Provision from a Pi session attached to this tmux session."];
  const available = height - 5;
  const maxScroll = Math.max(0, body.length - available);
  const offset = scroll < 0 ? maxScroll : Math.min(scroll, maxScroll);
  const lines = ["PI PYCELLS · persistent kernel host", tabs || "(empty)",
    kernel ? `${safeText(kernel.name)} · ${kernel.running ? "RUNNING" : "IDLE"} · Pi owner ${safeText(kernel.ownerSessionId)}` : `Host PID ${state.pid}`,
    ...body.slice(offset, offset + available)];
  while (lines.length < height - 2) lines.push("");
  lines.push("", "Tab/←/→ kernel · ↑/↓/PgUp/PgDn scroll · End follow · Ctrl-C leaves kernels running");
  return { lines: lines.slice(0, height).map(line => line.slice(0, width)), maxScroll };
}
export function startHostViewer(readState: () => HostState): () => void {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return () => undefined;
  let selected = 0, scroll = -1, previous = "";
  process.stdin.setRawMode(true); process.stdin.resume();
  process.stdout.write("\x1b[?1049h\x1b[?25l");
  const render = () => {
    const state = readState(); selected = Math.min(selected, Math.max(0, state.kernels.length - 1));
    const view = renderHostView(state, selected, scroll, process.stdout.columns || 100, process.stdout.rows || 30);
    const screen = view.lines.join("\r\n");
    if (screen !== previous) { process.stdout.write("\x1b[H" + screen + "\x1b[J"); previous = screen; }
  };
  const input = (bytes: Buffer) => {
    const key = bytes.toString();
    const count = readState().kernels.length;
    if (["\t", "\x1b[C", "\x1b[D"].includes(key) && count) { selected = (selected + (key === "\x1b[D" ? count - 1 : 1)) % count; scroll = -1; }
    if (["\x1b[A", "\x1b[B", "\x1b[5~", "\x1b[6~"].includes(key)) {
      const max = renderHostView(readState(), selected, scroll, 100, process.stdout.rows || 30).maxScroll;
      scroll = Math.max(0, Math.min(max, (scroll < 0 ? max : scroll) + (key === "\x1b[A" ? -1 : key === "\x1b[B" ? 1 : key === "\x1b[5~" ? -15 : 15)));
    }
    if (["\x1b[F", "\x1b[4~"].includes(key)) scroll = -1;
    if (["\x1b[H", "\x1b[1~"].includes(key)) scroll = 0;
    render();
  };
  process.stdin.on("data", input); const timer = setInterval(render, 250); render();
  return () => { clearInterval(timer); process.stdin.off("data", input); process.stdin.setRawMode(false); process.stdin.pause(); process.stdout.write("\x1b[?25h\x1b[?1049l"); };
}
