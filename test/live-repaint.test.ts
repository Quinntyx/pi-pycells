const test = require("node:test");
const assert = require("node:assert/strict");
const { createLiveRepaint } = require("../dist/execution/live-repaint.js");

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("live repaint animates silent execution, copies details, and stops cleanly", async () => {
  const updates: any[] = [];
  const ticker = createLiveRepaint((update: any) => updates.push(update), 5);
  const snapshot = { agents: [{ name: "worker", status: "running" }] };
  const first = { content: [], details: { execId: "exec-1", subagentSnapshot: snapshot } };
  ticker.onUpdate(first);
  try {
    await delay(30);
    assert.ok(updates.length > 1);
    assert.notEqual(updates[1], first);
    assert.notEqual(updates[1].details, first.details);
    assert.equal(updates[1].details.subagentSnapshot, snapshot);
  } finally {
    ticker.stop();
  }
  const count = updates.length;
  await delay(20);
  ticker.onUpdate(first);
  assert.equal(updates.length, count);
  ticker.stop();
});

test("live repaint does not invent execution from queued/document updates", async () => {
  const updates: any[] = [];
  const ticker = createLiveRepaint((update: any) => updates.push(update), 5);
  try {
    ticker.onUpdate({ content: [], details: { queued: true } });
    await delay(20);
    assert.equal(updates.length, 1);
  } finally {
    ticker.stop();
  }
});

test("live repaint without a callback owns no interval", () => {
  const ticker = createLiveRepaint(undefined);
  assert.equal(ticker.onUpdate, undefined);
  ticker.stop();
});
