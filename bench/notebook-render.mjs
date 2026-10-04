// Run after npm run build: node bench/notebook-render.mjs [history sizes...]
// Measures warmed redraws, not Shiki startup or agent/network latency.
import { performance } from "node:perf_hooks";
import { createRequire } from "node:module";
import { initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
const require = createRequire(import.meta.url);
const { renderNotebookCall, renderNotebookResult, setNotebookTuiModeProvider } = require("../dist/execution/notebook-render.js");
const { highlightCellCode } = require("../dist/execution/code-highlight.js");
const theme = {
  fg: (_color, text) => text,
  bg: (_color, text) => `\x1b[48;2;250;250;235m${text}\x1b[49m`,
  colors: { toolSuccessBg: { kind: "rgb", r: 250, g: 250, b: 235 } },
};
const code = Array.from({ length: 24 }, (_, i) => `value_${i} = sum(range(${i + 1}))`).join("\n");
// ~11 KB / 300 lines: within the normal 12,000-character output preview.
const output = Array.from({ length: 300 }, (_, i) => `${String(i).padStart(3)}: result data abcdefghijklmnopqrst`).join("\n");
const sizes = process.argv.slice(2).map(Number);
if (!sizes.length) sizes.push(75, 300, 1200);
if (sizes.some((n) => !Number.isInteger(n) || n < 1 || n > 5000)) throw new Error("History sizes must be integers from 1 to 5000");
initTheme("light", false);
setNotebookTuiModeProvider(() => "fullscreen");
await highlightCellCode(code, theme);
const definition = {
  renderShell: "self",
  renderCall: (args, liveTheme, context) => renderNotebookCall(args.code, undefined, liveTheme, context),
  renderResult: (value, options, liveTheme, context) => renderNotebookResult("exec_cell", value, options, liveTheme, context),
};
let checksum = 0;
const report = [];
for (const count of sizes) {
  const value = (i) => ({ content: [{ type: "text", text: output }], details: { userCode: code.split("\n"), cellIdx: i + 1 } });
  const direct = Array.from({ length: count }, (_, i) => renderNotebookResult("exec_cell", value(i), {}, theme, { state: {} }));
  const shells = Array.from({ length: count }, (_, i) => {
    const host = new ToolExecutionComponent("exec_cell", `bench-${i}`, { code }, {}, definition, { requestRender() {} }, process.cwd());
    host.setArgsComplete();
    host.markExecutionStarted();
    host.updateResult(value(i), false);
    return host;
  });
  for (const [kind, components] of [["boxes", direct], ["pi-shell", shells], ["pi-shell-active-last", shells], ["pi-shell-invalidated", shells]]) {
    for (const component of components) component.render(100);
    const frames = [];
    for (let frame = 0; frame < 5; frame++) {
      const start = performance.now();
      if (kind.endsWith("active-last")) {
        // Only the streaming row should rebuild while settled history stays warm.
        const next = value(count - 1);
        next.details.liveOutput = [...output.split("\n"), `stream frame ${frame}`];
        shells[count - 1].updateResult(next, true);
      }
      for (const component of components) {
        if (kind.endsWith("invalidated")) component.invalidate();
        checksum += component.render(100).length;
      }
      frames.push(performance.now() - start);
    }
    frames.sort((a, b) => a - b);
    report.push({ kind, blocks: count, median_ms: +frames[2].toFixed(2), min_ms: +frames[0].toFixed(2), max_ms: +frames[4].toFixed(2) });
  }
}
console.table(report);
console.log(JSON.stringify({ results: report, checksum }));
setNotebookTuiModeProvider(undefined);
