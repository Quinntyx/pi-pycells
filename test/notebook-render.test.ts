const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildExecutingCodeLines,
  currentViewportMode,
  renderNotebookCall,
  renderNotebookResult,
  setNotebookTuiModeProvider,
} = require("../dist/execution/notebook-render.js");
const { executionIndicator, visibleWidth } = require("../dist/execution/cell-view.js");
const panelModule = require("../dist/execution/subagent-panel.js");

function stubTheme() {
  return {
    fg: (color, text) => `\u0001${color}\u0002${text}\u0003`,
  };
}

function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

const THEME = stubTheme();

function textResult(text, details = {}, isError = false) {
  return { content: [{ type: "text", text }], details, isError };
}

function renderLines(toolName, result, options = {}, state = {}) {
  const component = renderNotebookResult(toolName, result, options, THEME, { state });
  return component.render(50);
}

/** Identity theme: shape assertions without stub color tokens. */
const PLAIN_THEME = { fg: (_color, text) => text };

function renderPlain(toolName, result, options = {}, state = {}) {
  const component = renderNotebookResult(toolName, result, options, PLAIN_THEME, { state });
  return component.render(50);
}

// ---------------------------------------------------------------------------
// Viewport mode mapping
// ---------------------------------------------------------------------------

test("currentViewportMode: expanded wins; tuiMode decides fullscreen vs normal", () => {
  setNotebookTuiModeProvider(() => "fullscreen");
  assert.equal(currentViewportMode(false), "fullscreen");
  assert.equal(currentViewportMode(true), "expanded");
  setNotebookTuiModeProvider(() => "regular");
  assert.equal(currentViewportMode(false), "normal");
  setNotebookTuiModeProvider(undefined);
  assert.equal(currentViewportMode(false), "normal", "no provider collapses to normal");
  setNotebookTuiModeProvider(() => {
    throw new Error("RPC context");
  });
  assert.equal(currentViewportMode(false), "normal", "throwing provider collapses to normal");
  setNotebookTuiModeProvider(undefined);
});

// ---------------------------------------------------------------------------
// exec_cell
// ---------------------------------------------------------------------------

test("exec_cell completed: In[N] box + Out[N] box from the reported execution count", () => {
  const lines = renderPlain(
    "exec_cell",
    textResult("42", { userCode: ["x = 6", "x * 7"], cellIdx: 12 }),
  );
  assert.match(lines[0], /^ {14}┌/);
  assert.match(lines[1], /^ In\[12\]: {6}│/);
  // Shared metadata gutter keeps all rows 50 columns wide.
  assert.ok(lines.some((line, i) => /^ {14}┌/.test(line) && i > 1), lines.join("\n"));
  assert.ok(lines.some((line) => /^ Out\[12\]: {5}│/.test(line)), lines.join("\n"));
  const flat = lines.map(stripAnsi).join("\n");
  assert.ok(flat.includes("x = 6"), flat);
  assert.ok(flat.includes("42"), flat);
});

test("exec_cell without a reported count degrades to the empty In[ ] (never invents N)", () => {
  const lines = renderPlain("exec_cell", textResult("ok", { userCode: ["print(1)"] }));
  assert.match(lines[1], /^ In\[ \]: {7}│/);
});

test("exec_cell error results render the Out box red", () => {
  const lines = renderLines(
    "exec_cell",
    textResult("Traceback ...", { userCode: ["1 / 0"], cellIdx: 3 }, true),
  );
  const outRow = lines.find((line) => line.includes("Traceback"));
  assert.ok(outRow.includes("\u0001error\u0002"), JSON.stringify(outRow));
  const fenceRow = lines[0];
  assert.ok(!fenceRow.includes("\u0001error"), "In fence stays normal");
});

test("exec_cell collapsed normal mode shows 7 code lines + more-lines hint", () => {
  const userCode = Array.from({ length: 20 }, (_, i) => `line_${i + 1} = ${i}`);
  const lines = renderPlain(
    "exec_cell",
    textResult("done", { userCode, cellIdx: 1 }),
  );
  const flat = lines.map(stripAnsi);
  assert.ok(flat.some((line) => /\.\.\. 13 more lines >\.\.\./.test(line)), flat.join("\n"));
  assert.ok(flat.some((line) => line.includes("line_7 = 6")));
  assert.ok(!flat.some((line) => line.includes("line_8 = 7")));
});

test("exec_cell expanded (ctrl+o) shows the full code regardless of tui mode", () => {
  setNotebookTuiModeProvider(() => "fullscreen");
  const userCode = Array.from({ length: 20 }, (_, i) => `line_${i + 1} = ${i}`);
  const lines = renderPlain("exec_cell", textResult("done", { userCode, cellIdx: 1 }), { expanded: true });
  setNotebookTuiModeProvider(undefined);
  const flat = lines.map(stripAnsi).join("\n");
  assert.ok(flat.includes("line_20 = 19"), flat);
  assert.ok(!flat.includes("more lines"));
});

test("exec_cell fullscreen collapsed shows the 8-line scroll window anchored at the streaming scroll position", () => {
  setNotebookTuiModeProvider(() => "fullscreen");
  const userCode = Array.from({ length: 20 }, (_, i) => `line_${i + 1} = ${i}`);
  const lines = renderPlain("exec_cell", textResult("done", { userCode, cellIdx: 1 }), {}, { viewStartLine: 10 });
  setNotebookTuiModeProvider(undefined);
  const flat = lines.map(stripAnsi).join("\n");
  assert.ok(flat.includes("line_10 = 9"), flat);
  assert.ok(!flat.includes("more lines"), "fullscreen window scrolls instead of hinting");
});

// ---------------------------------------------------------------------------
// scratch_run
// ---------------------------------------------------------------------------

test("scratch_run: unnumbered In: box + Out: box", () => {
  const lines = renderPlain(
    "scratch_run",
    textResult("7", { userCode: ["3 + 4"], sectioned: true }),
  );
  assert.match(lines[0], /^ {14}┌/); // blank gutter on the fence row
  assert.ok(lines.some((line) => /^ Out: {9}│/.test(line)), lines.join("\n"));
});

// ---------------------------------------------------------------------------
// write_cell
// ---------------------------------------------------------------------------

test("write_cell insert: In box only, unexecuted (empty In[ ] gutter)", () => {
  const lines = renderPlain(
    "write_cell",
    textResult("Wrote code cell at position 4.", {
      at: 4,
      cellType: "code",
      total: 5,
      replaced: false,
      cellSource: "y = 2",
    }),
  );
  assert.match(lines[0], /^ {14}┌/);
  assert.match(lines[1], /^ In\[ \]: {7}│/);
  assert.ok(!lines.some((line) => /^ Out/.test(line)), "no Out box for a write");
  const flat = lines.map(stripAnsi).join("\n");
  assert.ok(flat.includes("y = 2"), flat);
});

test("write_cell replace: In box content renders as an inline diff", () => {
  const lines = renderLines(
    "write_cell",
    textResult("Wrote code cell at position 2.", {
      at: 2,
      replaced: true,
      oldCellSource: "a = 1\nb = 2",
      cellSource: "a = 1\nb = 3",
      total: 5,
    }),
    { expanded: true },
  );
  const flat = lines.map(stripAnsi).join("\n");
  assert.ok(lines.some((line) => line.includes("\u0001toolDiffRemoved\u0002")), "removed line is red");
  assert.ok(lines.some((line) => line.includes("\u0001toolDiffAdded\u0002")), "added line is green");
  assert.ok(flat.includes("b = 2") && flat.includes("b = 3"), flat);
});

test("write_cell replace-with-empty: content-only red (cleared), gutter normal", () => {
  const lines = renderLines(
    "write_cell",
    textResult("Wrote code cell at position 2.", {
      at: 2,
      replaced: true,
      oldCellSource: "a = 1\nb = 2",
      cellSource: "",
      total: 5,
    }),
    { expanded: true },
  );
  const contentRow = lines.find((line) => line.includes("a = 1"));
  assert.ok(contentRow.includes("\u0001error\u0002"), JSON.stringify(contentRow));
  assert.ok(lines[0].includes("\u0001muted\u0002"), "In gutter stays normal");
  assert.ok(!lines[0].includes("\u0001error"), "In gutter is not red for a clear");
});

test("write_cell replace without old source degrades to a fresh-write In box", () => {
  const lines = renderPlain(
    "write_cell",
    textResult("Wrote code cell at position 2.", { at: 2, replaced: true, cellSource: "z = 9" }),
  );
  assert.match(lines[0], /^ {14}┌/);
  assert.match(lines[1], /^ In\[ \]: {7}│/);
  assert.ok(lines.map(stripAnsi).join("\n").includes("z = 9"));
});

// ---------------------------------------------------------------------------
// delete_cell
// ---------------------------------------------------------------------------

test("delete_cell: whole cell red INCLUDING the In[N] gutter", () => {
  const lines = renderLines(
    "delete_cell",
    textResult("Deleted cell 3.", { n: 3, total: 4, cellSource: "gone = True" }),
    { expanded: true },
  );
  assert.ok(lines[0].includes("\u0001error\u0002"), "gutter label is red: " + JSON.stringify(lines[0]));
  const contentRow = lines.find((line) => line.includes("gone = True"));
  assert.ok(contentRow.includes("\u0001error\u0002"), JSON.stringify(contentRow));
});

test("delete_cell without the deleted source renders a red placeholder box", () => {
  const lines = renderLines("delete_cell", textResult("Deleted cell 3.", { n: 3, total: 4 }));
  assert.ok(lines[0].includes("\u0001error\u0002"));
  assert.ok(lines.map(stripAnsi).join("\n").includes("(source unavailable)"));
});

// ---------------------------------------------------------------------------
// run_to / run_all / reset_kernel
// ---------------------------------------------------------------------------

test("run_all: compact Run: box with per-cell status rows", () => {
  const lines = renderPlain(
    "run_all",
    textResult("ran 3 cells", {
      runSteps: [
        { index: 1, execCount: 1, ok: true },
        { index: 2, execCount: 2, ok: true },
        { index: 3, ok: false, error: "ZeroDivisionError: division by zero" },
      ],
    }),
  );
  assert.match(lines[0], /^ {5}┌/);
  assert.match(lines[1], /^Run: │/);
  const themed = renderLines(
    "run_all",
    textResult("ran 3 cells", {
      runSteps: [
        { index: 1, execCount: 1, ok: true },
        { index: 2, execCount: 2, ok: true },
        { index: 3, ok: false, error: "ZeroDivisionError: division by zero" },
      ],
    }),
  );
  const themedFlat = themed.map(stripAnsi).join("\n");
  assert.ok(themedFlat.includes("✓ cell 1 → Out[1]"), themedFlat);
  assert.ok(themedFlat.includes("✗ cell 3: ZeroDivisionError"), themedFlat);
  const failRow = themed.find((line) => line.includes("✗ cell 3"));
  assert.ok(failRow.includes("\u0001error\u0002"), JSON.stringify(failRow));
});

test("reset_kernel: compact muted restatement of the restart", () => {
  const lines = renderLines(
    "reset_kernel",
    textResult("Restarted kernel s1: fresh namespace.", { id: "s1" }),
  );
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes("\u0001muted\u0002"));
  assert.ok(lines[0].includes("Restarted kernel s1"));
});

// ---------------------------------------------------------------------------
// read_cell / read_cells
// ---------------------------------------------------------------------------

test("read_cell: In box with the cell's recorded execution count, plus its Out box", () => {
  const lines = renderPlain(
    "read_cell",
    textResult("--- Cell 2 ---", {
      total: 5,
      cells: [
        {
          index: 2,
          cellType: "code",
          executionCount: 7,
          source: "import os\nos.getcwd()",
          outputCount: 1,
          outputText: "'/tmp'",
        },
      ],
    }),
  );
  assert.match(lines[0], /^ {14}┌/);
  assert.match(lines[1], /^ In\[7\]: {7}│/);
  // Shared metadata gutter aligns the fences with the Out box below.
  assert.ok(lines.some((line, i) => /^ {14}┌/.test(line) && i > 2), lines.join("\n"));
  assert.ok(lines.some((line) => /^ Out\[7\]: {6}│1 │/.test(line)), lines.join("\n"));
});

test("read_cells: compact muted list, one block per cell", () => {
  const lines = renderPlain(
    "read_cells",
    textResult("cells", {
      total: 2,
      cells: [
        { index: 1, cellType: "code", source: "x = 1", outputCount: 0, outputText: "" },
        { index: 2, cellType: "markdown", executionCount: 2, source: "# hi", outputCount: 0, outputText: "" },
      ],
    }),
  );
  const flat = lines.map(stripAnsi);
  assert.ok(flat.some((line) => line.trimEnd() === "In[1] · code"), flat.join("\n"));
  assert.ok(flat.some((line) => line.trimEnd() === "In[2] · markdown · Out[2]"), flat.join("\n"));
  assert.ok(flat.some((line) => line.includes("  x = 1")));
});

// ---------------------------------------------------------------------------
// Zero-jitter + totality
// ---------------------------------------------------------------------------

test("zero-jitter: same (result, options, state, width) renders identical lines every time", () => {
  const result = textResult("out", { userCode: ["a = 1", "b = 2"], cellIdx: 5 });
  const a = renderPlain("exec_cell", result);
  const b = renderPlain("exec_cell", result);
  assert.deepEqual(a, b);
  assert.deepEqual(a.map(stripAnsi), a.map(stripAnsi));
});

test("geometry is width-derived at paint time: narrower width, same row count", () => {
  const result = textResult("out", { userCode: ["x = 'a long string value that will not fit at narrow widths'"], cellIdx: 2 });
  const wide = renderNotebookResult("exec_cell", result, {}, PLAIN_THEME, { state: {} }).render(60);
  const narrow = renderNotebookResult("exec_cell", result, {}, PLAIN_THEME, { state: {} }).render(30);
  assert.equal(wide.length, narrow.length);
  assert.ok(Math.max(...narrow.map(stripAnsi).map((line) => line.length)) <= 30 + 10, "content truncated to width");
});

test("totality: a renderer never throws, even on malformed details", () => {
  const component = renderNotebookResult(
    "write_cell",
    { content: [{ type: "text", text: "hi" }], details: { replaced: "not-a-boolean", at: "x" } },
    {},
    THEME,
    { state: { viewStartLine: "bogus" } },
  );
  assert.ok(component.render(40).length > 0);
});

test("doc-op failure without details degrades to muted text; isError renders red", () => {
  const muted = renderLines("write_cell", textResult("write_cell failed: boom", {}));
  assert.equal(muted.length, 1);
  assert.ok(muted[0].includes("\u0001muted\u0002"));
  const red = renderLines("delete_cell", textResult("delete_cell failed: boom", {}, true));
  assert.ok(red[0].includes("\u0001error\u0002"));
});

// ---------------------------------------------------------------------------
// Executing (partial) frames
// ---------------------------------------------------------------------------

test("partial frame: the In box carries the code while streaming, no legacy header", () => {
  const state = {};
  const lines = renderPlain(
    "exec_cell",
    textResult("", { userCode: ["a = 1", "b = 2", "c = 3"], currentLine: 2, totalLines: 3 }),
    { isPartial: true },
    state,
  );
  const flat = lines.map(stripAnsi);
  // The In box renders exactly like the settled one — no separate
  // "Executing Python code" header, no legacy line-marker view.
  assert.match(flat[0], /^ {14}┌/);
  assert.match(flat[1], /^ In\[ \]: {7}│/);
  assert.ok(flat.some((line) => line.includes("b = 2")), flat.join("\n"));
  assert.ok(!flat.some((line) => line.includes("Executing Python code")), flat.join("\n"));
});

test("partial frame: live Out box appended below the code view", () => {
  const lines = renderPlain(
    "exec_cell",
    textResult("", {
      userCode: ["for i in range(3): print(i)"],
      currentLine: 1,
      totalLines: 1,
      liveOutput: ["0", "1", "2"],
      liveOutputHidden: 4,
    }),
    { isPartial: true },
  );
  const flat = lines.map(stripAnsi).join("\n");
  assert.ok(flat.includes("... 4 earlier output lines"), flat);
  assert.match(flat, / Out\[ \]: {6}│1 │ 0/);
  assert.ok(flat.includes("│2 │ 1"), flat);
});

test("long streaming cells tail-pin the live Out box across updates", () => {
  const state = {};
  const userCode = Array.from({ length: 30 }, (_, i) => `line_${i + 1}`);
  const live = (n) =>
    renderPlain(
      "exec_cell",
      textResult("", { userCode, currentLine: n, totalLines: 30, liveOutput: Array.from({ length: n }, (_, i) => `out ${i}`) }),
      { isPartial: true, expanded: true },
      state,
    );
  const first = live(1);
  const second = live(15);
  // Zero-jitter: same code, same width — only the live Out content grows.
  assert.equal(first.filter((l) => l.includes("┌")).length, second.filter((l) => l.includes("┌")).length);
  // The newest output line is visible in the second frame (tail-pinned).
  assert.ok(second.some((l) => l.includes("out 14")), second.join("\n"));
});

// ---------------------------------------------------------------------------
// Live bracket frames and below-Out panel integration
// ---------------------------------------------------------------------------

test("executing unknown counts animate on the same component and settle to reported counts", (t) => {
  let now = 0;
  t.mock.method(Date, "now", () => now);
  for (const tool of ["exec_cell", "run_cell"]) {
    for (const cellIdx of [undefined, null]) {
      now = 0;
      const details = {
        execId: "exec_live", cellIdx, userCode: ["print(1)"], liveOutput: ["1"],
        highlightLines: ["\x1b[32mprint(1)\x1b[0m"],
      };
      const state = {};
      const component = renderNotebookResult(tool, textResult("", details),
        { isPartial: true }, PLAIN_THEME, { state });
      const first = component.render(50);
      const indicator = executionIndicator(now);
      assert.ok(first.some((line) => line.startsWith(` In[${indicator}]:`)));
      assert.ok(first.some((line) => line.startsWith(` Out[${indicator}]:`)));
      assert.ok(first.some((line) => line.includes("\x1b[32mprint(1)")));
      now = 119;
      assert.strictEqual(component.render(50), first, "same frame keeps the cache warm");
      now = 120;
      const second = component.render(50);
      assert.notStrictEqual(second, first, "clock frame invalidates cached lines");
      assert.ok(second.some((line) => line.startsWith(` In[${executionIndicator(now)}]:`)));
      assert.deepEqual(second.map((line) => line.replace(executionIndicator(now), " ")),
        first.map((line) => line.replace(indicator, " ")), "animation preserves geometry/colors");
      const settled = renderNotebookResult(tool, textResult("1", { ...details, cellIdx: 23 }),
        {}, PLAIN_THEME, { state }).render(50);
      assert.ok(settled.some((line) => line.startsWith(" In[23]:")));
      assert.ok(settled.some((line) => line.startsWith(" Out[23]:")));
      const reported = renderNotebookResult(tool, textResult("", { ...details, cellIdx: 23 }),
        { isPartial: true }, PLAIN_THEME).render(50);
      assert.ok(reported.some((line) => line.startsWith(" In[23]:")), "known live count wins");
      for (const width of [0, 1, 2, 8, 14, 20, 50]) {
        assert.ok(component.render(width).every((line) => visibleWidth(line) <= width));
      }
    }
  }
});

test("queued cells stay blank; scratch previews and partial/final cells stay unnumbered", () => {
  const details = { userCode: ["print(1)"], liveOutput: ["1"] };
  for (const tool of ["exec_cell", "run_cell"]) {
    const queued = renderPlain(tool, textResult("", details), { isPartial: true });
    assert.ok(queued.some((line) => line.startsWith(" In[ ]:")));
    assert.ok(queued.some((line) => line.startsWith(" Out[ ]:")));
    const unreported = renderPlain(tool, textResult("1", { ...details, execId: "exec_done" }));
    assert.ok(unreported.some((line) => line.startsWith(" In[ ]:")), "never invent a final count");
  }
  const preview = renderNotebookCall("print(1)", { toolName: "scratch_run" }, PLAIN_THEME).render(50);
  assert.ok(preview.some((line) => line.startsWith(" In:")));
  assert.ok(!preview.some((line) => /In\[/.test(line)));
  for (const isPartial of [true, false]) {
    const scratch = renderPlain("scratch_run", textResult("1", { ...details, execId: "exec_scratch" }),
      { isPartial });
    assert.ok(scratch.some((line) => line.startsWith(" In:")));
    assert.ok(scratch.some((line) => line.startsWith(" Out:")));
    assert.ok(!scratch.some((line) => /(?:In|Out)\[/.test(line)));
  }
});

test("snapshot panels append after the Out fence, even with no live stdout, without changing content", (t) => {
  const now = 1_200;
  t.mock.method(Date, "now", () => now);
  const snapshot = {
    timestamp: now,
    agents: [{ id: "a", name: "auditor", execScope: "exec_panel", status: "running",
      startedAt: 0, label: "reviewing", liveTool: "read src/example.ts" }],
  };
  for (const tool of ["exec_cell", "run_cell", "scratch_run"]) {
    for (const isPartial of [true, false]) {
      for (const expanded of [false, true]) {
        for (const liveOutput of [[], ["user_stdout"]]) {
          const details = {
            execId: "exec_panel", cellIdx: isPartial ? null : 4, userCode: ["await work()"],
            liveOutput, subagentSnapshot: snapshot,
          };
          const result = textResult("output:\n  user_stdout\n\nsubagents:\n  model_only_digest", details);
          const original = structuredClone(result);
          const lines = renderNotebookResult(tool, result, { isPartial, expanded }, PLAIN_THEME).render(80);
          const expected = panelModule.renderSubagentPanel(snapshot, {
            width: 80, theme: PLAIN_THEME, execId: details.execId, expanded, now,
          });
          assert.ok(expected.length > 0, "fixture must produce a panel");
          const panelStart = lines.length - expected.length;
          assert.deepEqual(lines.slice(panelStart), expected, "panel is a separate suffix");
          assert.equal(lines[panelStart - 1], "");
          assert.ok(lines[panelStart - 2].includes("┘"), "Out closes before the panel opens");
          assert.ok(lines.slice(0, panelStart).some((line) => /^ Out/.test(line)), "Out exists for pure awaits");
          assert.ok(!lines.slice(0, panelStart).some((line) => line.includes("auditor")));
          assert.ok(!lines.some((line) => line.includes("model_only_digest")));
          assert.deepEqual(result, original, "rendering never changes model-facing content/details");
        }
      }
    }
  }
});

test("panel clock invalidates known-count live frames; completed snapshots/time survive reconstruction", (t) => {
  let now = 240;
  t.mock.method(Date, "now", () => now);
  const calls = [];
  t.mock.method(panelModule, "renderSubagentPanel", (snapshot, options) => {
    calls.push({ snapshot: structuredClone(snapshot), options });
    return snapshot ? [`panel ${snapshot.agents[0].status} at ${options.now}`] : [];
  });
  const snapshot = { agents: [{ id: "a", name: "agent", status: "running", elapsedMs: 10 }] };
  const details = { execId: "exec_freeze", userCode: ["await work()"], cellIdx: 8, subagentSnapshot: snapshot };
  const result = textResult("output", details);
  const live = renderNotebookResult("exec_cell", result, { isPartial: true }, PLAIN_THEME);
  const first = live.render(50);
  assert.strictEqual(live.render(50), first);
  now += 120;
  assert.notStrictEqual(live.render(50), first, "known-count panels still receive animation ticks");
  assert.equal(calls.at(-1).options.now, now);
  const state = {};
  const final = renderNotebookResult("exec_cell", result, {}, PLAIN_THEME, { state });
  const frozen = final.render(50);
  const frozenTime = now;
  now += 60_000;
  snapshot.agents[0].status = "failed";
  snapshot.agents[0].elapsedMs = 60_010;
  assert.strictEqual(final.render(50), frozen, "clock alone never invalidates history");
  final.invalidate();
  assert.deepEqual(final.render(50), frozen, "explicit invalidation cannot advance the final panel");
  for (const expanded of [true, false]) {
    renderNotebookResult("exec_cell", result, { expanded }, PLAIN_THEME, { state }).render(60);
    const call = calls.at(-1);
    assert.equal(call.snapshot.agents[0].status, "running", "freeze faithfully, never infer outcomes");
    assert.equal(call.snapshot.agents[0].elapsedMs, 10);
    assert.equal(call.options.now, frozenTime, "missing timestamp freezes across Ctrl+o/resize");
    assert.equal(call.options.execId, "exec_freeze");
    assert.equal(call.options.expanded, expanded);
    assert.equal(call.options.width, 60);
  }
  const timestamped = { ...details, subagentSnapshot: { ...snapshot, timestamp: 120 } };
  renderNotebookResult("exec_cell", textResult("output", timestamped), {}, PLAIN_THEME).render(50);
  assert.equal(calls.at(-1).options.now, 120, "recorded snapshot time is authoritative");
});
