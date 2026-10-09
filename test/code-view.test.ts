const test = require("node:test");
const assert = require("node:assert/strict");
const { computeCodeViewStart, CODE_VIEW_HEIGHT, CODE_VIEW_MARGIN } = require("../dist/execution/code-view.js");

test("execution viewport is eight lines with two following context lines", () => {
  assert.equal(CODE_VIEW_HEIGHT, 8);
  assert.equal(CODE_VIEW_MARGIN, 2);
  for (let line = 1; line <= 100; line++) {
    const start = computeCodeViewStart(line, 100, undefined);
    assert.ok(start <= line && line <= start + 7);
    if (line <= 98) assert.ok(start + 7 >= line + 2);
    assert.ok(start >= 1 && start <= 93);
  }
});

test("short loops settle once and do not bounce when their body plus context fits", () => {
  let start;
  for (const line of [2, 3, 4, 5, 6, 7]) start = computeCodeViewStart(line, 30, start);
  assert.equal(start, 2);
  for (const line of [2, 3, 4, 5, 6, 7, 2, 5, 7, 2, 6]) {
    start = computeCodeViewStart(line, 30, start);
    assert.equal(start, 2);
  }
});

test("backward execution does not scroll until the marker actually leaves the window", () => {
  assert.equal(computeCodeViewStart(4, 30, 3), 3);
  assert.equal(computeCodeViewStart(3, 30, 3), 3);
  assert.equal(computeCodeViewStart(2, 30, 3), 2);
  assert.equal(computeCodeViewStart(9, 30, 3), 4);
});

test("viewport clamps stale positions, short cells, end of file and malformed trace values", () => {
  assert.equal(computeCodeViewStart(20, 20, undefined), 13);
  assert.equal(computeCodeViewStart(5, 5, 99), 1);
  assert.equal(computeCodeViewStart(1, 100, 999), 1);
  assert.equal(computeCodeViewStart(NaN, 20, undefined), 1);
  assert.equal(computeCodeViewStart(4, 0, undefined), 1);
});
