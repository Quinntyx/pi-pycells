const test = require("node:test");
const assert = require("node:assert/strict");
const { relevantAgents } = require("../dist/execution/subagent-panel.js");

// The workflow-tree renderer (subagent fan panel, transcript notification) was
// removed in the notebook-output rework. What survives here is the snapshot
// filter the status-bar footer (and a future re-render) builds on.

test("relevantAgents returns all rows when no exec id is given", () => {
  const snapshot = {
    agents: [
      { id: "a", name: "digger", status: "running" },
      { id: "b", name: "sweeper", status: "settled" },
    ],
    totals: { running: 1, settled: 1, failed: 0 },
    timestamp: Date.now(),
  };
  assert.deepEqual(relevantAgents(snapshot).map((a) => a.id), ["a", "b"]);
});

test("relevantAgents scopes to the streamed exec but keeps globally active rows", () => {
  const snapshot = {
    agents: [
      { id: "old", name: "batch2-ds", status: "settled", execScope: "exec_old" },
      { id: "cur", name: "scaffold", status: "running", execScope: "exec_cur" },
      { id: "glob", name: "orphan-runner", status: "running" },
      { id: "q", name: "waiting", status: "queued", execScope: "exec_other" },
      { id: "start", name: "booting", status: "starting", execScope: "exec_other" },
    ],
    totals: { running: 2, settled: 1, failed: 0 },
    timestamp: Date.now(),
  };
  assert.deepEqual(relevantAgents(snapshot, "exec_cur").map((a) => a.id), ["cur", "glob", "q", "start"]);
});

test("relevantAgents tolerates missing or malformed snapshots", () => {
  assert.deepEqual(relevantAgents(undefined), []);
  assert.deepEqual(relevantAgents({ agents: "not-an-array" }), []);
});


const { renderSubagentPanel } = require("../dist/execution/subagent-panel.js");
const { visibleWidth } = require("../dist/execution/cell-view.js");

test("flat panel is bounded for 1000 rows and reports hidden population", () => {
  const snapshot = { agents: Array.from({ length: 1000 }, (_, i) => ({
    id: `a${i}`, name: `worker-${i}`, status: i < 2 ? "running" : "queued",
    label: "implementing", liveTool: "read", phase: "building",
  })) };
  for (const expanded of [false, true]) {
    const lines = renderSubagentPanel(snapshot, { width: 120, expanded });
    const text = lines.join("\n");
    assert.match(text, /2 running/);
    assert.match(text, /998 queued/);
    assert.match(text, expanded ? /988 agents hidden/ : /996 agents hidden/);
    assert.match(text, /activity: implementing/);
    assert.match(text, /tool: read/);
    assert.ok(lines.length <= 30);
    assert.ok(!/[├┬┤]/.test(text), "no tree branches");
  }
});

test("flat panel clips CJK and sanitizes terminal/bidi/multiline labels at every width", () => {
  const snapshot = { agents: [{ id: "a", status: "running",
    name: "漢字\nBAD\x1b]0;injected\x07\u202e",
    label: "implementing\r\nactivity", liveTool: "read\x1b[31m", phase: "stage",
  }] };
  for (const width of [0, 1, 2, 8, 16, 17, 20, 40, 80]) {
    const lines = renderSubagentPanel(snapshot, { width });
    assert.ok(lines.every((line) => visibleWidth(line) <= width), `width ${width}`);
    assert.ok(lines.every((line) => !/[\n\r\x1b\x07\u202e]/.test(line)));
  }
});

test("pool counts are distinct from retained rows and ready results", () => {
  const snapshot = { agents: [{ id: "old", name: "old", status: "running", idle: true, liveTool: "stale" }],
    totals: { running: 999 }, pools: [{ id: "p", name: "workflow", running: 3, queued: 9, results: 2,
      stages: [{ id: "s", name: "phase", running: 3, queued: 9, settled: 5, failed: 1, cancelled: 2 }],
    }] };
  const text = renderSubagentPanel(snapshot, { width: 140 }).join("\n");
  for (const expected of ["3 running/starting", "9 queued", "2 ready", "5 settled", "1 failed", "2 cancelled", "1 idle"]) {
    assert.ok(text.includes(expected), expected);
  }
  assert.ok(!text.includes("999"));
  assert.ok(!text.includes("stale"), "idle sessions do not claim stale tools");
  assert.deepEqual(renderSubagentPanel(snapshot, { width: 80, now: 0 }),
    renderSubagentPanel(snapshot, { width: 80, now: 999999 }), "snapshot time remains frozen");
});
