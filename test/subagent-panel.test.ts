const test = require("node:test");
const assert = require("node:assert/strict");
const { relevantAgents } = require("../dist/execution/subagent-panel.js");

// The working roster is uncapped and the queue is bounded, with aggregate metrics separate from retained
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

test("queue stays bounded for 1000 rows and reports only hidden queued tasks", () => {
  const snapshot = { agents: Array.from({ length: 1000 }, (_, i) => ({
    id: `a${i}`, name: `worker-${i}`, status: i < 2 ? "running" : "queued",
    label: "implementing", liveTool: "read", phase: "building",
  })) };
  for (const expanded of [false, true]) {
    const lines = renderSubagentPanel(snapshot, { width: 120, expanded });
    const text = lines.join("\n");
    assert.match(text, /2 running/);
    assert.match(text, /998 queued/);
    assert.match(text, expanded ? /986 queued hidden/ : /994 queued hidden/);
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
  for (let i = 0; i < 8; i++) assert.ok(text.includes(`deus-${i}-build`));
  assert.ok(!text.includes("hidden"));
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

test("idle and terminal sessions contribute totals but never working entries", () => {
  const snapshot = { agents: [
    { id: "w", name: "active-worker", status: "running" },
    { id: "i", name: "idle-worker", status: "running", idle: true },
    ...["settled", "closed", "failed", "cancelled", "stopped", "dead", "unknown"].map((status) => ({
      id: status, name: `retained-${status}`, status,
    })),
  ] };
  for (const expanded of [false, true]) {
    const text = renderSubagentPanel(snapshot, { width: 120, expanded }).join("\n");
    assert.ok(text.includes("active-worker"));
    assert.ok(!text.includes("idle-worker"));
    assert.ok(!text.includes("retained-"));
    for (const total of ["1 idle", "1 settled", "1 closed", "2 failed", "1 cancelled", "1 stopped", "1 other"]) {
      assert.ok(text.includes(total), total);
    }
    assert.ok(!/Needs attention|Idle sessions|Finished|Other|agents hidden/.test(text));
  }
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

test("expanded diagnostics and dense working rosters remain sanitized and width bounded", () => {
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
    if (width >= 40) assert.ok(lines.length >= 1000, "working rows are never height-capped");
    assert.ok(lines.every((line) => visibleWidth(line) <= width), `width ${width}`);
    assert.ok(lines.every((line) => !/[\n\r\x1b\x07\u202e\u2028]/.test(line)));
  }
});


test("all working entries precede a separately capped queue in either view", () => {
  const working = Array.from({ length: 24 }, (_, i) => ({
    id: `w${i}`, name: `worker-${i}`, status: i % 2 === 0 ? "running" : "starting",
  }));
  const queued = Array.from({ length: 20 }, (_, i) => ({
    id: `q${i}`, name: `queued-${i}`, status: "queued",
  }));
  // A queue-first input must not displace any working agent.
  const snapshot = { agents: [...queued, ...working] };
  for (const expanded of [false, true]) {
    const text = renderSubagentPanel(snapshot, { width: 120, expanded }).join("\n");
    const limit = expanded ? 12 : 4;
    const workingStart = text.indexOf("Working");
    const queueStart = text.indexOf("Queued");
    assert.ok(workingStart >= 0 && queueStart > workingStart);
    for (let i = 0; i < working.length; i++) {
      const match = text.match(new RegExp(`worker-${i}\\b`, "g")) || [];
      assert.equal(match.length, 1, `worker-${i} appears exactly once`);
      assert.ok(text.indexOf(`worker-${i}`) > workingStart);
      assert.ok(text.indexOf(`worker-${i}`) < queueStart);
    }
    for (let i = 0; i < queued.length; i++) {
      const match = text.match(new RegExp(`queued-${i}\\b`, "g")) || [];
      assert.equal(match.length, i < limit ? 1 : 0, `queued-${i}`);
    }
    assert.match(text, new RegExp(`${queued.length - limit} queued hidden`));
    assert.ok(!text.includes("agents hidden"));
    assert.ok(text.indexOf("queued-0") > queueStart);
  }
});

test("a queue below its cap still follows every working agent without a hidden note", () => {
  const snapshot = { agents: [
    { id: "q", name: "pending", status: "queued" },
    { id: "w", name: "working", status: "running" },
  ] };
  for (const expanded of [false, true]) {
    const text = renderSubagentPanel(snapshot, { width: 80, expanded }).join("\n");
    assert.ok(text.indexOf("Working") < text.indexOf("Queued"));
    assert.ok(!text.includes("hidden"));
  }
});


test("panel background fills each line and survives nested foreground/style resets", () => {
  const backgrounds = {
    toolPendingBg: "\x1b[48;2;10;20;30m",
    toolSuccessBg: "\x1b[48;2;40;50;60m",
    toolErrorBg: "\x1b[48;5;123m",
  };
  const theme = {
    fg: (_color, text) => `\x1b[38;2;49;0;17m${text}\x1b[0m`,
    bold: (text) => `\x1b[1m${text}\x1b[0m`,
    bg: (name, text) => backgrounds[name] + text + "\x1b[49m",
    getBgAnsi: (name) => backgrounds[name],
  };
  const snapshot = { agents: [
    { id: "w", name: "worker", status: "running", liveTool: "read", label: "building" },
    { id: "q", name: "queued", status: "queued" },
  ] };
  for (const width of [1, 2, 3, 20, 38, 80, 120]) {
    for (const background of Object.keys(backgrounds)) {
      for (const expanded of [false, true]) {
        const lines = renderSubagentPanel(snapshot, { width, theme, background, expanded });
        for (const line of lines) {
          assert.equal(visibleWidth(line), width, "background covers the full available width");
          assert.ok(line.startsWith(backgrounds[background]));
          assert.ok(line.endsWith("\x1b[49m"));
          let active = false;
          for (const token of line.split(/(\x1b\[[0-9;]*m)/)) {
            if (!token) continue;
            const sgr = /^\x1b\[([0-9;]*)m$/.exec(token);
            if (!sgr) {
              assert.ok(active, `unpainted panel text: ${JSON.stringify(token)}`);
              continue;
            }
            const codes = sgr[1] === "" ? [0] : sgr[1].split(";").map(Number);
            for (let i = 0; i < codes.length; i++) {
              if (codes[i] === 0 || codes[i] === 49) active = false;
              else if (codes[i] === 38 || codes[i] === 48 || codes[i] === 58) {
                if (codes[i] === 48) active = true;
                if (codes[i + 1] === 2) i += 4;
                else if (codes[i + 1] === 5) i += 2;
              }
            }
          }
        }
      }
    }
  }
  assert.ok(renderSubagentPanel(snapshot, { width: 80, theme })[0].startsWith(backgrounds.toolSuccessBg));
});

test("background styling remains optional for unthemed and minimal-theme panels", () => {
  const snapshot = { agents: [{ id: "w", name: "worker", status: "running" }] };
  assert.deepEqual(renderSubagentPanel(snapshot, { width: 80 }),
    renderSubagentPanel(snapshot, { width: 80, theme: { fg: (_color, text) => text } }));
  assert.deepEqual(renderSubagentPanel(snapshot, { width: 0 }), []);
});
