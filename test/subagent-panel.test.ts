const test = require("node:test");
const assert = require("node:assert/strict");
const { relevantAgents } = require("../dist/execution/subagent-panel.js");

// The panel is flat and bounded, with aggregate metrics separate from retained
// session rows. Snapshot filtering is also used by the status-bar footer.

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
    assert.match(text, /read · implementing/);
    assert.ok(!/phase:|activity:|tool:/.test(text), "no repeated field-label soup");
    assert.ok(lines.length <= (expanded ? 60 : 30));
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
  for (const expected of ["3 active", "9 queued", "2 results ready", "5 settled", "1 failed", "2 cancelled", "1 idle"]) {
    assert.ok(text.includes(expected), expected);
  }
  assert.ok(!text.includes("999"));
  assert.ok(!text.includes("stale"), "idle sessions do not claim stale tools");
  assert.deepEqual(renderSubagentPanel(snapshot, { width: 80, now: 0 }),
    renderSubagentPanel(snapshot, { width: 80, now: 999999 }), "snapshot time remains frozen");
});


test("collapsed panel has a sparse header and no duplicated pool/stage diagnostics", () => {
  const snapshot = { agents: Array.from({ length: 8 }, (_, i) => ({
    id: `a${i}`, name: `deus-${i}-build`, status: i < 7 ? "starting" : "queued", phase: "build",
  })), pools: [{ id: "p", name: "deus-v1", status: "open", running: 7, queued: 1, results: 0,
    stages: [{ id: "s", name: "build", running: 7, queued: 0, settled: 0, failed: 0 },
      { id: "r", name: "review", running: 0, queued: 0, settled: 0, failed: 0 }],
  }] };
  const lines = renderSubagentPanel(snapshot, { width: 120 });
  const text = lines.join("\n");
  assert.match(text, /Subagents/);
  assert.match(text, /7 active · 1 queued/);
  assert.match(text, /Working/);
  assert.match(text, /4 agents hidden · expand for more/);
  assert.ok(!/pool totals|row totals|deus-v1|phase:|phase build|phase review/.test(text));
  assert.ok(!/\b0 (?:queued|ready|settled|failed|cancelled|pools|stages)/.test(text));
  const header = lines.findIndex((line) => line.includes("Subagents"));
  assert.match(lines[header + 2], /^\s*│\s*│$/, "space separates metrics and roster");
});

test("expanded view reveals bounded kernel-scoped diagnostics without zero hidden counts", () => {
  const snapshot = { agents: [{ id: "a", name: "writer", status: "starting", phase: "build" }],
    pools: [{ id: "p", name: "prototype-pool", status: "open", running: 1, queued: 0, results: 0,
      stages: Array.from({ length: 10 }, (_, i) => ({ id: `s${i}`, name: `stage-${i}`,
        running: i === 0 ? 1 : 0, queued: 0, settled: 0, failed: 0, cancelled: 0 })),
    }] };
  const text = renderSubagentPanel(snapshot, { width: 120, expanded: true }).join("\n");
  assert.match(text, /Pool detail · this kernel/);
  assert.match(text, /prototype-pool \(open\)/);
  assert.match(text, /stage-5/);
  assert.ok(!text.includes("stage-6"));
  assert.match(text, /4 stages hidden/);
  assert.ok(!/\b0 (?:pools|stages|queued|ready|settled|failed|cancelled)/.test(text));
});

test("primary names use available width and tools appear only for active rows", () => {
  const name = "prototype-backend-contract-validation-worker";
  const snapshot = { agents: [
    { id: "a", name, status: "running", label: "validating", liveTool: "read" },
    { id: "b", name: "idle-worker", status: "running", idle: true,
      label: "stale-idle-activity", liveTool: "stale-idle-tool" },
    { id: "c", name: "done-worker", status: "settled",
      label: "stale-done-activity", liveTool: "stale-done-tool" },
  ] };
  const lines = renderSubagentPanel(snapshot, { width: 120 });
  const nameLine = lines.findIndex((line) => line.includes(name));
  assert.ok(nameLine > 0, "wide layouts preserve the whole name");
  assert.match(lines[nameLine], /running/);
  assert.match(lines[nameLine + 1], /read · validating/);
  assert.ok(!lines.join("\n").includes("stale-"));
  assert.ok(lines.every((line) => visibleWidth(line) <= 120));
});

test("attention states are not buried behind a large active roster", () => {
  const snapshot = { agents: [...Array.from({ length: 1000 }, (_, i) => ({
    id: `a${i}`, name: `running-${i}`, status: "running",
  })), { id: "failure", name: "critical-failure", status: "failed" }] };
  const text = renderSubagentPanel(snapshot, { width: 100 }).join("\n");
  assert.match(text, /Needs attention/);
  assert.match(text, /critical-failure\s+failed/);
  assert.ok(text.indexOf("critical-failure") < text.indexOf("running-0"));
  assert.match(text, /997 agents hidden/);
});

test("heading and primary names are bold while status colors stay restrained", () => {
  const calls = [];
  const theme = {
    fg(color, text) { calls.push([color, text]); return text; },
    bold(text) { return `\x1b[1m${text}\x1b[22m`; },
  };
  const lines = renderSubagentPanel({ agents: [
    { id: "a", name: "worker-name", status: "running", label: "implementing", liveTool: "read" },
  ] }, { width: 100, theme });
  const text = lines.join("\n");
  assert.match(text, /\x1b\[1mSubagents\x1b\[22m/);
  assert.match(text, /\x1b\[1m  worker-name\x1b\[22m/);
  assert.ok(calls.some(([color, value]) => color === "accent" && value === "running"));
  assert.ok(!calls.some(([color, value]) => color === "accent" && value.includes("worker-name")));
  assert.ok(lines.every((line) => visibleWidth(line) <= 100));
});

test("expanded malicious diagnostics and dense populations stay width/height bounded", () => {
  const snapshot = { agents: Array.from({ length: 1000 }, (_, i) => ({
    id: `a${i}`, name: `漢字-${i}\nBAD\x1b]0;injected\x07\u202e`, status: "running",
    label: "activity\r\nlabel", liveTool: "read\x1b[31m", phase: "phase\u2028bad",
  })), pools: Array.from({ length: 8 }, (_, i) => ({
    id: `p${i}`, name: "pool\x1b[31m\nBAD\u202e", running: 2, queued: 1, results: 1,
    stages: Array.from({ length: 12 }, (_, j) => ({
      id: `s${j}`, name: "階段\nBAD\x1b]0;injected\x07", running: 1, queued: 2,
      settled: 3, failed: 1, cancelled: 1,
    })),
  })) };
  for (const width of [0, 1, 2, 3, 8, 16, 20, 38, 40, 80, 120]) {
    const lines = renderSubagentPanel(snapshot, { width, expanded: true });
    assert.ok(lines.length <= 90, `height at width ${width}`);
    assert.ok(lines.every((line) => visibleWidth(line) <= width), `width ${width}`);
    assert.ok(lines.every((line) => !/[\n\r\x1b\x07\u202e\u2028]/.test(line)));
  }
});
