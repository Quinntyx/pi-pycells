const test = require("node:test");
const assert = require("node:assert/strict");
const {
  renderNotebookCall,
  renderNotebookResult,
  setNotebookTuiModeProvider,
} = require("../dist/execution/notebook-render.js");
const { renderInCell, renderOutCell, visibleWidth } = require("../dist/execution/cell-view.js");
const { highlightCellCode } = require("../dist/execution/code-highlight.js");

const THEME = {
  fg: (_color, text) => text,
  bg: (color, text) => `\x1b[48;2;240;240;230m${text}\x1b[49m`,
  colors: { toolSuccessBg: { kind: "rgb", r: 250, g: 250, b: 235 } },
};
const stripAnsi = (text) => text.replace(/\x1b\[[0-9;]*m/g, "");
const result = (details, text = "done") => ({ content: [{ type: "text", text }], details });
const wheel = (y, delta) => ({
  type: "wheel", button: "none", x: 15, y, screenX: 15, screenY: y,
  width: 80, height: 40, shift: false, alt: false, ctrl: false, wheelDelta: delta,
});
const source = Array.from({ length: 40 }, (_, i) => `line_${i} = ${i}`);
const output = Array.from({ length: 40 }, (_, i) => `output_${i}`);

function frame(details, state, partial = false, expanded = false) {
  return renderNotebookResult("exec_cell", result(details), { isPartial: partial, expanded }, THEME, { state });
}
function labelRow(lines, label) {
  return lines.findIndex((line) => stripAnsi(line).startsWith(` ${label}`));
}

test("default gutters align one/two/three digits, pending, and scratch cells with a one-column inset", () => {
  for (const n of [1, 12, 123, null, undefined]) {
    for (const render of [renderInCell, renderOutCell]) {
      const lines = render("x", { width: 50, mode: "expanded", cellNumber: n });
      assert.equal(lines[0].indexOf("┌"), 14);
      assert.match(lines[1], /^ (In|Out)/);
      assert.equal(visibleWidth(lines[1]), 50);
    }
  }
  assert.equal(renderInCell("x", { width: 50, mode: "expanded", cellNumber: 1234 })[0].indexOf("┌"), 14);
});

test("the normal tool background covers every complete In/Out row, fence, gutter, and hint", () => {
  const calls = [];
  const theme = { ...THEME, bg: (color, text) => { calls.push({ color, text }); return THEME.bg(color, text); } };
  for (const render of [renderInCell, renderOutCell]) {
    for (const mode of ["expanded", "normal", "fullscreen"]) {
      for (const background of ["toolPendingBg", "toolSuccessBg", "toolErrorBg"]) {
        calls.length = 0;
        const lines = render(source.join("\n"), { width: 80, mode, cellNumber: 12, theme, labelBackground: background });
        assert.equal(calls.length, lines.length);
        for (const [i, line] of lines.entries()) {
          assert.equal(calls[i].color, background);
          assert.equal(visibleWidth(calls[i].text), 80);
          assert.ok(line.startsWith("\x1b[48;2;240;240;230m"));
          assert.ok(line.endsWith("\x1b[49m"));
          assert.equal(visibleWidth(line), 80);
        }
      }
    }
  }
});

test("code and output ANSI resets restore the tool background instead of leaving holes", async () => {
  const pi = await import("@earendil-works/pi-coding-agent");
  const theme = new pi.Theme(
    { text: "#111111", muted: "#555555", thinkingXhigh: "#111111" },
    { toolSuccessBg: "#f0f0e6", selectedBg: "#f0f0e6" },
    "truecolor", { appearance: "light" },
  );
  const background = theme.getBgAnsi("toolSuccessBg");
  const highlighted = "\x1b[38;2;0;80;160mx\x1b[0m = 1";
  const input = renderInCell("x = 1", { width: 50, mode: "expanded", theme, highlightLines: [highlighted] });
  assert.ok(input[1].includes("\x1b[0m" + background));
  assert.ok(input[1].includes("\x1b[38;2;0;80;160mx"), "RGB channels must not be mistaken for resets");
  for (const reset of ["\x1b[49m", "\x1b[m", "\x1b[0;31m"]) {
    const output = renderOutCell("before" + reset + "after", { width: 50, mode: "expanded", theme });
    assert.ok(output[1].includes(reset + background));
    assert.equal(visibleWidth(output[1]), 50);
  }
  for (const explicit of ["\x1b[0;41m", "\x1b[0;48;2;49;0;1m"]) {
    const output = renderOutCell("before" + explicit + "after", { width: 50, mode: "expanded", theme });
    assert.ok(output[1].includes(explicit + "after"), "preserve intentional content backgrounds");
  }
});

test("named input previews use a compact bold tool-title header and clamp to pane width", () => {
  const theme = {
    ...THEME,
    bold: (text) => `\x1b[1m${text}\x1b[22m`,
    fg: (color, text) => color === "toolTitle" ? `\x1b[34m${text}\x1b[39m` : text,
  };
  for (const name of ["exec_cell", "scratch_run", "write_cell"]) {
    const state = {};
    const options = { toolName: name };
    const pending = renderNotebookCall(undefined, options, theme, { state });
    assert.deepEqual(pending.render(80).map(stripAnsi), [` ${name}`]);
    assert.ok(pending.render(80)[0].includes(`\x1b[34m\x1b[1m${name}`));
    const call = renderNotebookCall("print(1)", options, theme, { state });
    const painted = call.render(80);
    const lines = painted.map(stripAnsi);
    assert.equal(lines[0], ` ${name}`);
    assert.equal(labelRow(lines, "In[ ]:"), 2);
    assert.strictEqual(call.render(80), painted, "unchanged titled previews retain the row cache");
    state.resultOwnsInput = true;
    const titleOnly = call.render(80);
    assert.deepEqual(titleOnly.map(stripAnsi), [` ${name}`], "only the box transfers to the result");
    assert.strictEqual(call.render(80), titleOnly, "historical headers retain the row cache");
    for (const width of [0, 1, 5, 8, 80]) {
      assert.ok(call.render(width).every((line) => visibleWidth(line) <= width));
    }
  }
});

test("named call headers stay outside the input box wheel region", () => {
  setNotebookTuiModeProvider(() => "fullscreen");
  try {
    const call = renderNotebookCall(source.join("\n"), { toolName: "exec_cell" }, THEME, { state: {} });
    const lines = call.render(80).map(stripAnsi);
    assert.equal(lines[0], " exec_cell");
    assert.equal(call.handleMouse(wheel(0, -3)), undefined, "the title scrolls the transcript");
    const inputRow = labelRow(lines, "In[ ]:");
    assert.equal(call.handleMouse({ ...wheel(inputRow, -3), x: 1 }), undefined, "the gutter scrolls the transcript");
    assert.ok(call.handleMouse(wheel(inputRow, -3))?.handled);
    assert.ok(call.render(80).some((line) => stripAnsi(line).includes("line_29 =")));
  } finally { setNotebookTuiModeProvider(undefined); }
});

test("the first partial result replaces the argument preview in Pi's call-then-result paint order", () => {
  const state = {};
  const context = { state };
  const call = renderNotebookCall("print(1)", undefined, THEME, context);
  assert.equal(labelRow(call.render(80), "In[ ]:"), 1);
  // The host builds the call component before the result callback, then paints both.
  const preview = renderNotebookCall("print(1)", undefined, THEME, context);
  const partial = renderNotebookResult("exec_cell", result({ userCode: ["print(1)"], liveOutput: ["1"] }), { isPartial: true }, THEME, context);
  const lines = [...preview.render(80), ...partial.render(80)].map(stripAnsi);
  assert.equal(lines.filter((line) => /^ In/.test(line)).length, 1);
  const settledPreview = renderNotebookCall("print(1)", undefined, THEME, context);
  const settled = renderNotebookResult("exec_cell", result({ userCode: ["print(1)"], cellIdx: 43 }), {}, THEME, context);
  const final = [...settledPreview.render(80), ...settled.render(80)].map(stripAnsi);
  assert.equal(final.filter((line) => /^ In/.test(line)).length, 1);
  assert.ok(final.some((line) => /^ In\[43\]:/.test(line)));
  assert.ok(!final.some((line) => /^ In\[ \]:/.test(line)));
  assert.equal(final[0].indexOf("┌"), lines[0].indexOf("┌"));
});

test("an early error/rejection keeps exactly one submitted input box", () => {
  const state = {};
  const call = renderNotebookCall("dangerous()", undefined, THEME, { state });
  const failed = renderNotebookResult("exec_cell", { ...result({}, "Cell rejected by user."), isError: true }, {}, THEME, { state });
  const lines = [...call.render(80), ...failed.render(80)].map(stripAnsi);
  assert.equal(lines.filter((line) => /^ In/.test(line)).length, 1);
  assert.ok(lines.some((line) => line.includes("dangerous()")));
  assert.ok(lines.some((line) => line.includes("Cell rejected by user.")));
});

test("call streaming highlights asynchronously and keeps identical geometry; live/final boxes share it", async () => {
  const code = "streaming_example = 7\nprint(streaming_example)";
  const state = {};
  let redraws = 0;
  const context = { state, invalidate: () => { redraws++; } };
  const call = renderNotebookCall(code, undefined, THEME, context);
  const plain = call.render(80).map(stripAnsi);
  await highlightCellCode(code, THEME);
  await new Promise((resolve) => setImmediate(resolve));
  const colored = call.render(80);
  assert.ok(redraws > 0);
  assert.ok(colored.some((line) => line.includes("\x1b[38;2;")));
  assert.deepEqual(colored.map(stripAnsi), plain);
  for (const isPartial of [true, false]) {
    const component = renderNotebookResult("exec_cell", result({ userCode: code.split("\n"), cellIdx: 4 }), { isPartial }, THEME, context);
    assert.ok(component.render(80).some((line) => line.includes("\x1b[38;2;")));
  }
});

test("fullscreen input and output wheel windows scroll independently and persist across redraw/resize", () => {
  setNotebookTuiModeProvider(() => "fullscreen");
  try {
    const state = {};
    const details = { userCode: source, cellIdx: 12 };
    const component = renderNotebookResult("exec_cell", result(details, output.join("\n")), {}, THEME, { state });
    let lines = component.render(80);
    assert.ok(lines.some((line) => line.includes("line_0 =")));
    assert.deepEqual(component.handleMouse(wheel(2, 4)), { handled: true, render: true });
    lines = component.render(80);
    assert.ok(lines.some((line) => line.includes("line_4 =")));
    assert.ok(!lines.some((line) => line.includes("line_0 =")));
    const outRow = labelRow(lines, "Out[12]:");
    component.handleMouse(wheel(outRow, 3));
    lines = component.render(80);
    assert.ok(lines.some((line) => line.includes("output_3")));
    assert.ok(lines.some((line) => line.includes("line_4 =")));
    const recreated = renderNotebookResult("exec_cell", result(details, output.join("\n")), {}, THEME, { state });
    lines = recreated.render(55);
    assert.ok(lines.some((line) => line.includes("line_4 =")));
    assert.ok(lines.some((line) => line.includes("output_3")));
    assert.ok(recreated.handleMouse(wheel(0, -100))?.handled);
    recreated.render(55);
    assert.deepEqual(recreated.handleMouse(wheel(0, -100)), { handled: true, render: false });
    assert.equal(recreated.handleMouse({ ...wheel(2, 1), type: "press", button: "left" }), undefined);
  } finally { setNotebookTuiModeProvider(undefined); }
});

test("fullscreen wheel scrolling only captures the actual fenced box, not labels or gutter metadata", () => {
  setNotebookTuiModeProvider(() => "fullscreen");
  try {
    for (const cellIdx of [12, 123456789]) {
      const state = {};
      const component = frame({ userCode: source, cellIdx, liveOutput: output }, state, true);
      for (const width of [80, 55]) {
        const lines = component.render(width).map(stripAnsi);
        for (const label of [`In[${cellIdx}]:`, `Out[${cellIdx}]:`]) {
          const row = labelRow(lines, label);
          const left = lines[row - 1].indexOf("┌");
          const right = lines[row - 1].indexOf("┐");
          assert.ok(left > 0 && right > left);
          const positionsBefore = { ...state.scrollPositions };
          for (const y of [row - 1, row, row + 1, row + 2]) {
            for (const x of [0, 1, left - 1, right + 1]) {
              assert.equal(component.handleMouse({ ...wheel(y, 1), x }), undefined, `${label}, x=${x}, y=${y}`);
            }
          }
          assert.deepEqual(state.scrollPositions ?? {}, positionsBefore, "gutter events must not change box positions");
          assert.ok(component.handleMouse({ ...wheel(row, -1), x: left })?.handled, "left fence captures wheel events");
          component.invalidate();
          assert.ok(component.handleMouse({ ...wheel(row, 1), x: right })?.handled, "right fence captures before repaint");
          // Return to tail so the next box/width starts with unchanged state.
          component.handleMouse({ ...wheel(row, 100), x: left + 1 });
        }
        assert.equal(component.handleMouse(wheel(lines.length, 1)), undefined, "below the boxes is transcript space");
      }
    }
  } finally { setNotebookTuiModeProvider(undefined); }
});

test("generic boxes use their own fence bounds and clipped panes never capture invisible gutter space", () => {
  const { NotebookComponent } = require("../dist/execution/notebook-component.js");
  const { renderLabeledBox } = require("../dist/execution/cell-view.js");
  const component = new NotebookComponent((width, layout) => layout.box("generic", 40,
    { width, mode: "fullscreen", theme: THEME },
    (options) => renderLabeledBox("Run:", source.map((text) => ({ text })), options)));
  const lines = component.render(40).map(stripAnsi);
  const left = lines[0].indexOf("┌");
  assert.equal(component.handleMouse({ ...wheel(1, 1), x: left - 1 }), undefined);
  assert.ok(component.handleMouse({ ...wheel(1, 1), x: left })?.handled);
  component.render(3);
  assert.equal(component.handleMouse({ ...wheel(1, 1), x: 2 }), undefined);
});

test("unchanged history reuses painted rows while resize, state, and explicit invalidation rebuild", () => {
  const { NotebookComponent } = require("../dist/execution/notebook-component.js");
  const { renderLabeledBox } = require("../dist/execution/cell-view.js");
  const state = {};
  let builds = 0;
  let mode = "fullscreen";
  const component = new NotebookComponent((width, layout) => {
    builds++;
    return layout.box("input", source.length, { width, mode, theme: THEME },
      (options) => renderLabeledBox("Run:", source.map((text) => ({ text })), options));
  }, state, undefined, () => mode);
  const first = component.render(80);
  assert.strictEqual(component.render(80), first);
  assert.equal(builds, 1, "unchanged history must not rebuild rows");
  assert.equal(component.handleMouse({ ...wheel(1, 1), x: 0 }), undefined);
  assert.strictEqual(component.render(80), first, "transcript navigation leaves box cache warm");
  component.handleMouse(wheel(1, 1));
  assert.notStrictEqual(component.render(80), first);
  assert.equal(builds, 2);
  component.render(55);
  assert.equal(builds, 3, "width changes rebuild geometry");
  state.lastHighlights = { code: "x", lines: ["x"], themeKey: "light", revision: 1 };
  component.render(55);
  assert.equal(builds, 4, "async highlight completion refreshes colors");
  mode = "normal";
  component.render(55);
  assert.equal(builds, 5, "viewport mode changes rebuild even at identical width");
  assert.equal(component.handleMouse(wheel(1, 1)), undefined);
  component.invalidate();
  component.render(55);
  assert.equal(builds, 6, "explicit theme/content invalidation refreshes styling");
});

test("scrolling invalidates sibling cached components sharing a tool's viewport state", () => {
  const { NotebookComponent } = require("../dist/execution/notebook-component.js");
  const state = {};
  const make = () => new NotebookComponent((width, layout) => layout.box("input", source.length,
    { width, mode: "fullscreen", cellNumber: 1 },
    (options) => renderInCell(source.join("\n"), options)), state);
  const first = make();
  const sibling = make();
  first.render(80);
  const before = sibling.render(80);
  first.handleMouse(wheel(1, 3));
  const after = sibling.render(80);
  assert.notStrictEqual(after, before);
  assert.ok(after.some((line) => line.includes("line_3 =")));
});

test("cached real notebook frames refresh viewport mode without a resize", () => {
  let mode = "fullscreen";
  setNotebookTuiModeProvider(() => mode);
  try {
    const component = frame({ userCode: source, cellIdx: 2 }, {});
    const fullscreen = component.render(80);
    assert.strictEqual(component.render(80), fullscreen);
    mode = "regular";
    const normal = component.render(80);
    assert.notStrictEqual(normal, fullscreen);
    assert.ok(normal.some((line) => line.includes("more lines")));
    assert.equal(component.handleMouse(wheel(1, 1)), undefined);
    mode = "fullscreen";
    assert.ok(!component.render(80).some((line) => line.includes("more lines")));
    assert.ok(component.handleMouse(wheel(1, 1))?.handled);
  } finally { setNotebookTuiModeProvider(undefined); }
});

test("live output follows the tail, pauses while scrolled up, and resumes at the bottom", () => {
  setNotebookTuiModeProvider(() => "fullscreen");
  try {
    const state = {};
    const details = (count) => ({ userCode: ["print('logs')"], liveOutput: output.slice(0, count) });
    let component = frame(details(20), state, true);
    let lines = component.render(80);
    let row = labelRow(lines, "Out[ ]:");
    assert.ok(lines[row].includes("output_12"));
    assert.ok(lines[row + 1].includes("(20 lines)"));
    component.handleMouse(wheel(row, -4));
    component = frame(details(22), state, true);
    lines = component.render(80);
    row = labelRow(lines, "Out[ ]:");
    assert.ok(lines[row].includes("output_8"));
    assert.ok(lines[row + 1].includes("(22 lines)"));
    component.handleMouse(wheel(row, 100));
    component = frame(details(24), state, true);
    lines = component.render(80);
    row = labelRow(lines, "Out[ ]:");
    assert.ok(lines[row].includes("output_16"));
    assert.ok(lines[row + 1].includes("(24 lines)"));
  } finally { setNotebookTuiModeProvider(undefined); }
});

test("regular mode and expanded cells leave wheel events to transcript scrolling", () => {
  const state = {};
  setNotebookTuiModeProvider(() => "regular");
  try {
    for (const partial of [false, true]) {
      const component = frame({ userCode: source, liveOutput: output }, state, partial);
      component.render(80);
      assert.equal(component.handleMouse(wheel(2, 3)), undefined);
    }
    setNotebookTuiModeProvider(() => "fullscreen");
    const expanded = frame({ userCode: source }, state, false, true);
    expanded.render(80);
    assert.equal(expanded.handleMouse(wheel(2, 3)), undefined);
  } finally { setNotebookTuiModeProvider(undefined); }
});

test("write/read/delete/batch boxes also expose fullscreen scrolling", () => {
  setNotebookTuiModeProvider(() => "fullscreen");
  try {
    const cases = [
      ["write_cell", { cellSource: source.join("\n") }],
      ["delete_cell", { cellSource: source.join("\n"), n: 1 }],
      ["read_cell", { cells: [{ source: source.join("\n"), cellType: "code", outputText: "", executionCount: 3 }] }],
      ["run_all", { runSteps: source.map((_, i) => ({ index: i + 1, ok: true })) }],
    ];
    for (const [tool, details] of cases) {
      const state = {};
      const component = renderNotebookResult(tool, result(details), {}, THEME, { state });
      component.render(80);
      assert.ok(component.handleMouse(wheel(2, 3))?.handled, tool);
      assert.equal(Object.values(state.scrollPositions)[0], 4, tool);
    }
  } finally { setNotebookTuiModeProvider(undefined); }
});


test("streaming highlights retain colored prefixes while appended tokens wait for Shiki", async () => {
  const oldCode = "stream_flicker_regression = 123\nprint(stream_flicker_regression";
  const oldHighlights = await highlightCellCode(oldCode, THEME);
  const state = {};
  const context = { state, invalidate: () => {} };
  renderNotebookCall(oldCode, undefined, THEME, context).render(100);
  const newCode = oldCode + "_suffix)";
  const lines = renderNotebookCall(newCode, undefined, THEME, context).render(100);
  assert.ok(lines.some((line) => line.includes(oldHighlights[0])));
  assert.ok(lines.some((line) => line.includes("\x1b[0m_suffix)")));
  assert.ok(lines.map(stripAnsi).some((line) => line.includes("print(stream_flicker_regression_suffix)")));
  const dark = { ...THEME, colors: { toolSuccessBg: { kind: "rgb", r: 20, g: 20, b: 20 } } };
  const darkLines = renderNotebookCall(newCode + " # new theme", undefined, dark, context).render(100);
  assert.ok(!darkLines.some((line) => line.includes("\x1b[38;2;")), "do not retain the previous theme's foreground colors");
});

test("late streaming results cannot replace a settled highlight snapshot", async (t) => {
  const module = require("../dist/execution/code-highlight.js");
  const pending = [];
  t.mock.method(module, "highlightCellCode", (code) => new Promise((resolve) => pending.push({ code, resolve })));
  const state = {};
  const context = { state, invalidate: () => {} };
  const first = "out_of_order_shiki_regression = 1";
  const second = first + "2";
  renderNotebookCall(first, undefined, THEME, context).render(100);
  renderNotebookCall(second, undefined, THEME, context).render(100);
  assert.equal(pending.length, 1, "streaming highlight jobs are serialized");
  renderNotebookResult("exec_cell", result({
    userCode: [second], cellIdx: 1, highlightLines: ["\x1b[32m" + second + "\x1b[0m"],
  }), {}, THEME, context).render(100);
  pending[0].resolve(["\x1b[31m" + first + "\x1b[0m"]);
  for (let i = 0; i < 4; i++) await Promise.resolve();
  assert.equal(state.lastHighlights.code, second);
  assert.ok(state.lastHighlights.lines[0].includes("\x1b[32m"));
  assert.equal(pending.length, 1, "settling cancels the queued preview");
});

test("appending a newline and the next token never blacks out retained lines", async () => {
  const code = "newline_color_regression = 123";
  const colors = await highlightCellCode(code, THEME);
  const state = {};
  const context = { state, invalidate: () => {} };
  renderNotebookCall(code, undefined, THEME, context).render(100);
  for (const suffix of ["\n", "\np", "\nprint(1)", "\nprint(1)\n"]) {
    const lines = renderNotebookCall(code + suffix, undefined, THEME, context).render(100);
    assert.ok(lines.some((line) => line.includes(colors[0])), JSON.stringify(suffix));
  }
  state.streamingHighlights?.cancelPending();
});

test("streaming previews retain the newest lines with total-count gutter metadata", () => {
  try {
    for (const [mode, cap] of [["regular", 7], ["fullscreen", 8]]) {
      setNotebookTuiModeProvider(() => mode);
      const state = {};
      const context = { state };
      let code = source.slice(0, 11).join("\n");
      let component = renderNotebookCall(code, undefined, THEME, context);
      let lines = component.render(80).map(stripAnsi);
      assert.ok(lines[0].includes("┌"));
      assert.ok(lines[2].includes("(11 lines)"));
      assert.equal(lines.length, cap + 2);
      assert.ok(lines.some((line) => line.includes("line_10 =")));
      assert.ok(!lines.some((line) => line.includes("line_0 =")));
      assert.ok(!lines.some((line) => line.includes("more lines")));
      code += "\n" + source[11];
      component = renderNotebookCall(code, undefined, THEME, context);
      lines = component.render(80).map(stripAnsi);
      assert.ok(lines[2].includes("(12 lines)"));
      assert.ok(!lines.some((line) => line.includes("lines above")));
      assert.ok(lines.some((line) => line.includes("line_11 =")));
      if (mode === "fullscreen") {
        const row = labelRow(lines, "In[ ]:");
        assert.ok(component.handleMouse(wheel(row, -2))?.handled);
        component.invalidate();
        assert.ok(component.handleMouse(wheel(row, -1))?.handled, "hit regions survive invalidation before repaint");
        lines = component.render(80).map(stripAnsi);
        assert.ok(!lines.some((line) => line.includes("line_11 =")));
        const scrolledRow = labelRow(lines, "In[ ]:");
        component.handleMouse(wheel(scrolledRow, 100));
        assert.deepEqual(component.handleMouse(wheel(scrolledRow, 1)), { handled: true, render: false });
        code += "\n" + source[12];
        lines = renderNotebookCall(code, undefined, THEME, context).render(80).map(stripAnsi);
        assert.ok(lines.some((line) => line.includes("line_12 =")), "returning to the bottom resumes tail-following");
      }
    }
  } finally { setNotebookTuiModeProvider(undefined); }
});

test("real Pi tool shell replaces its call preview and routes fullscreen wheel events into the box", async () => {
  const { initTheme, ToolExecutionComponent } = await import("@earendil-works/pi-coding-agent");
  initTheme("light", false);
  setNotebookTuiModeProvider(() => "fullscreen");
  let redraws = 0;
  try {
    const definition = {
      renderShell: "self",
      renderCall: (args, theme, context) => renderNotebookCall(args.code, { toolName: "exec_cell" }, theme, context),
      renderResult: (value, options, theme, context) => renderNotebookResult("exec_cell", value, options, theme, context),
    };
    const host = new ToolExecutionComponent("exec_cell", "renderer-regression", { code: source.join("\n") }, {}, definition,
      { requestRender: () => { redraws++; } }, process.cwd());
    host.setArgsComplete();
    host.markExecutionStarted();
    assert.equal(host.render(80).map(stripAnsi).filter((line) => /^ In/.test(line)).length, 1);
    assert.equal(host.render(80).map(stripAnsi).filter((line) => line.trim() === "exec_cell").length, 1);
    assert.ok(!host.handleMouse(wheel(0, -3))?.handled, "header wheel events propagate to transcript scrolling");
    host.updateResult(result({ userCode: source, liveOutput: output.slice(0, 12) }), true);
    let lines = host.render(80).map(stripAnsi);
    assert.equal(lines.filter((line) => /^ In/.test(line)).length, 1);
    const inputRow = labelRow(lines, "In[ ]:");
    for (const y of [inputRow, inputRow + 1, inputRow + 2]) {
      assert.ok(!host.handleMouse({ ...wheel(y, 4), x: 1 })?.handled, "gutter events propagate to transcript navigation");
    }
    assert.ok(host.handleMouse(wheel(inputRow, 4))?.handled);
    assert.ok(host.handleMouse(wheel(inputRow, 2))?.handled, "a second event before repaint must not scroll the transcript");
    lines = host.render(80).map(stripAnsi);
    assert.ok(lines.some((line) => line.includes("line_6 =")));
    host.updateResult(result({ userCode: source, cellIdx: 43 }, output.join("\n")), false);
    lines = host.render(80).map(stripAnsi);
    assert.equal(lines.filter((line) => /^ In/.test(line)).length, 1);
    assert.ok(lines.some((line) => /^ In\[43\]:/.test(line)));
    assert.ok(!lines.some((line) => /^ In\[ \]:/.test(line)));
    assert.equal(lines.filter((line) => line.trim() === "exec_cell").length, 1);
    assert.ok(lines.some((line) => line.includes("line_6 =")));
    assert.ok(redraws > 0);
    const lightFrame = host.render(80);
    initTheme("dark", false);
    host.invalidate();
    const darkFrame = host.render(80);
    assert.notDeepEqual(darkFrame, lightFrame, "host theme invalidation must not reuse light styling");
    assert.deepEqual(darkFrame.map(stripAnsi), lightFrame.map(stripAnsi), "theme changes preserve box geometry");
  } finally {
    initTheme("light", false);
    setNotebookTuiModeProvider(undefined);
  }
});


function inputLabelClick(lines, label, overrides = {}) {
  const y = labelRow(lines, label);
  assert.ok(y >= 0, `missing label ${label}`);
  return { ...wheel(y, 0), type: "click", button: "left", x: 1, screenX: 1, ...overrides };
}

test("In labels toggle call previews, persist across reconstruction, and handle rapid clicks", () => {
  setNotebookTuiModeProvider(() => "fullscreen");
  try {
    const state = {};
    let redraws = 0;
    const context = { state, invalidate: () => { redraws++; } };
    let call = renderNotebookCall(source.join("\n"), { toolName: "exec_cell" }, THEME, context);
    const collapsed = call.render(80);
    assert.ok(collapsed.length < source.length);
    const click = inputLabelClick(collapsed, "In[ ]:");
    assert.deepEqual(call.handleMouse(click), { handled: true, render: true });
    assert.ok(call.render(80).some((line) => stripAnsi(line).includes("line_0 =")));
    assert.ok(call.render(80).length > source.length);
    call = renderNotebookCall(source.join("\n"), { toolName: "exec_cell" }, THEME, context);
    assert.ok(call.render(80).length > source.length, "per-row state survives renderer replacement");
    call.handleMouse(click);
    call.invalidate();
    call.handleMouse(click);
    assert.ok(call.render(80).length > source.length, "two clicks before repaint cancel out");
    call.handleMouse(click);
    assert.deepEqual(call.render(80), collapsed, "collapse restores the viewport position");
    assert.equal(redraws, 4);
  } finally { setNotebookTuiModeProvider(undefined); }
});

test("In expansion preserves the output viewport and survives partial/final transitions", () => {
  setNotebookTuiModeProvider(() => "fullscreen");
  try {
    const state = { scrollPositions: { input: 5, output: 4 } };
    let component = frame({ userCode: source, liveOutput: output, cellIdx: null }, state, true);
    const before = component.render(80);
    component.handleMouse(inputLabelClick(before, "In[ ]:"));
    const expanded = component.render(80);
    assert.ok(expanded.some((line) => stripAnsi(line).includes("line_39 =")));
    assert.deepEqual(expanded.slice(labelRow(expanded, "Out[ ]:") - 1), before.slice(labelRow(before, "Out[ ]:") - 1));
    component = renderNotebookResult("exec_cell", result({ userCode: source, cellIdx: 12 }, output.join("\n")), {}, THEME, { state });
    const final = component.render(80);
    assert.ok(final.some((line) => stripAnsi(line).includes("line_39 =")));
    component.handleMouse(inputLabelClick(final, "In[12]:"));
    const collapsed = component.render(80);
    assert.ok(collapsed.some((line) => stripAnsi(line).includes("line_4 =")));
    assert.ok(!collapsed.some((line) => stripAnsi(line).includes("line_39 =")));
    assert.deepEqual(state.scrollPositions, { input: 5, output: 4 });
  } finally { setNotebookTuiModeProvider(undefined); }
});

test("only unmodified left clicks on visible In text are handled", () => {
  setNotebookTuiModeProvider(() => "fullscreen");
  try {
    const component = frame({ userCode: source, cellIdx: 1234 }, {});
    const lines = component.render(80);
    const click = inputLabelClick(lines, "In[1234]:");
    for (const change of [
      { x: 0 }, { x: 10 }, { x: 15 }, { y: click.y - 1 }, { y: click.y + 1 },
      { type: "press" }, { type: "release" }, { type: "drag" }, { type: "move" },
      { button: "right" }, { button: "middle" }, { shift: true }, { alt: true }, { ctrl: true },
    ]) assert.equal(component.handleMouse({ ...click, ...change }), undefined, JSON.stringify(change));
    assert.equal(component.handleMouse(inputLabelClick(lines, "Out[1234]:")), undefined, "Out retains Pi's own expansion handler");
    assert.ok(component.handleMouse({ ...click, x: 9 })?.handled, "the label's final colon is clickable");
    const narrow = frame({ userCode: source, cellIdx: 1234 }, {});
    const clipped = narrow.render(2);
    assert.equal(narrow.handleMouse({ ...inputLabelClick(clipped, "In[1234]:"), x: 2 }), undefined);
  } finally { setNotebookTuiModeProvider(undefined); }
});

test("all input renderers support In clicks, including scratch, read, edit, clear, and delete", () => {
  setNotebookTuiModeProvider(() => "fullscreen");
  try {
    const cases = [
      ["scratch_run", { userCode: source }, "In:"],
      ["write_cell", { cellSource: source.join("\n") }, "In[ ]:"],
      ["write_cell", { cellSource: source.join("\n"), oldCellSource: "old = 1", replaced: true }, "In[ ]:"],
      ["write_cell", { cellSource: "", oldCellSource: source.join("\n"), replaced: true }, "In[ ]:"],
      ["delete_cell", { cellSource: source.join("\n"), n: 123 }, "In[123]:"],
      ["read_cell", { cells: [{ index: 1, cellType: "code", source: source.join("\n"), executionCount: 9, outputText: "out" }] }, "In[9]:"],
    ];
    for (const [tool, details, label] of cases) {
      const component = renderNotebookResult(tool, result(details), {}, THEME, { state: {} });
      const before = component.render(80);
      assert.ok(component.handleMouse(inputLabelClick(before, label))?.handled, tool);
      const after = component.render(80);
      assert.ok(after.length > before.length, tool);
      assert.ok(after.some((line) => stripAnsi(line).includes("line_39 =")), tool);
      component.handleMouse(inputLabelClick(after, label));
      assert.deepEqual(component.render(80), before, tool);
    }
  } finally { setNotebookTuiModeProvider(undefined); }
});

test("real Pi shell routes In clicks before and after execution without stealing Out or Ctrl+o", async () => {
  const { initTheme, ToolExecutionComponent } = await import("@earendil-works/pi-coding-agent");
  initTheme("light", false);
  setNotebookTuiModeProvider(() => "fullscreen");
  try {
    const definition = {
      renderShell: "self",
      renderCall: (args, theme, context) => renderNotebookCall(args.code, { toolName: "exec_cell" }, theme, context),
      renderResult: (value, options, theme, context) => renderNotebookResult("exec_cell", value, options, theme, context),
    };
    const host = new ToolExecutionComponent("exec_cell", "input-click-regression", { code: source.join("\n") }, {}, definition,
      { requestRender() {} }, process.cwd());
    host.setArgsComplete();
    host.markExecutionStarted();
    let lines = host.render(80);
    assert.ok(host.handleMouse(inputLabelClick(lines, "In[ ]:"))?.handled);
    assert.ok(host.render(80).some((line) => stripAnsi(line).includes("line_39 =")));
    host.updateResult(result({ userCode: source, cellIdx: 7 }, output.join("\n")), false);
    lines = host.render(80);
    assert.equal(lines.filter((line) => /^ In/.test(stripAnsi(line))).length, 1);
    assert.ok(host.handleMouse(inputLabelClick(lines, "In[7]:"))?.handled);
    lines = host.render(80);
    assert.ok(!lines.some((line) => stripAnsi(line).includes("line_39 =")));
    assert.ok(host.handleMouse(inputLabelClick(lines, "Out[7]:"))?.handled);
    lines = host.render(80);
    assert.ok(lines.some((line) => stripAnsi(line).includes("line_39 =")));
    assert.ok(lines.some((line) => stripAnsi(line).includes("output_39")));
    host.handleMouse(inputLabelClick(lines, "In[7]:"));
    lines = host.render(80);
    assert.ok(!lines.some((line) => stripAnsi(line).includes("line_39 =")));
    assert.ok(lines.some((line) => stripAnsi(line).includes("output_39")), "In collapse is independent of Out");
    host.setExpanded(false);
    host.render(80);
    host.setExpanded(true);
    lines = host.render(80);
    assert.ok(lines.some((line) => stripAnsi(line).includes("line_39 =")), "Ctrl+o supersedes local collapse");
    host.setExpanded(false);
    lines = host.render(80);
    assert.ok(!lines.some((line) => stripAnsi(line).includes("line_39 =")));
    assert.ok(!lines.some((line) => stripAnsi(line).includes("output_39")));
  } finally { setNotebookTuiModeProvider(undefined); }
});
