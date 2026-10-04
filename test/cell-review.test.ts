const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
// Import the production review module, not the host-only extension entrypoint.
const { createCellReviewTool, createRenderedCellReviewTool } = require("../dist/tools/cell-review.js");

const theme = { fg: (_color, text) => text };
const approvalInstructions = "Cell approved for the intended operation. Nothing was executed. Execute separately; small fixes within this scope do not require another review.";

function renderedText(tool, result, expanded, context = {}, isPartial = false, width = 200) {
  return tool.renderResult(result, { expanded, isPartial }, theme, context).render(width)
    .map((line) => line.trimEnd()).join("\n");
}

function assertApprovalRendering(tool, result) {
  const before = JSON.stringify(result);
  assert.equal(result.content[0].text, approvalInstructions);
  for (const expanded of [false, true]) {
    for (const width of [8, 80, 200]) {
      assert.equal(renderedText(tool, result, expanded, { isError: false }, false, width), "Approved");
    }
  }
  assert.equal(JSON.stringify(result), before, "rendering must not alter agent-facing content or details");
}

function fixture(decision = { action: "approve" }) {
  const seen = [];
  const manager = {
    list: () => [{ id: "kernel-1" }],
    get: (id) => id === "kernel-1" ? {} : undefined,
    readCell: async (id, n) => {
      seen.push(["read", id, n]);
      return { cells: [{ cellType: n === 2 ? "markdown" : "code", source: "print('review only')" }] };
    },
    exec: () => { throw new Error("review must never execute code"); },
    runCell: () => { throw new Error("review must never execute a notebook cell"); },
  };
  const tool = createRenderedCellReviewTool(manager, async (_ctx, id, code) => {
    seen.push(["review", id, code]);
    return decision;
  });
  const call = (params, cwd = process.cwd()) => tool.execute("review-1", params, undefined, undefined, { cwd, hasUI: true });
  return { tool, call, seen };
}

test("reviewing inline code approves without executing or requiring a kernel", async () => {
  const { tool, call, seen } = fixture();
  const result = await call({ code: "raise RuntimeError('do not execute')" });
  assertApprovalRendering(tool, result);
  assert.equal(result.details.approved, true);
  assert.equal(result.details.rejected, false);
  assert.match(result.content[0].text, /Nothing was executed/);
  assert.deepEqual(seen, [["review", "unbound", "raise RuntimeError('do not execute')"]]);
});

test("reviewing a notebook cell shows its saved source from the most recent kernel", async () => {
  const { tool, call, seen } = fixture();
  const result = await call({ n: 1 });
  assertApprovalRendering(tool, result);
  assert.equal(result.details.approved, true);
  assert.equal(result.details.sessionId, "kernel-1");
  assert.deepEqual(seen, [["read", "kernel-1", 1], ["review", "kernel-1", "print('review only')"]]);
});

test("rejection returns the user feedback without executing", async () => {
  const { call } = fixture({ action: "reject", note: "Reduce the affected directory scope." });
  const result = await call({ code: "print('draft')" });
  assert.equal(result.details.approved, false);
  assert.equal(result.details.note, "Reduce the affected directory scope.");
  assert.match(result.content[0].text, /Cell rejected/);
});

test("review rejects missing, conflicting, unknown-kernel and markdown inputs", async () => {
  const { call, seen } = fixture();
  for (const params of [{}, { code: "x", n: 1 }, { file: "x.py", code: "x" }, { n: 1, session_id: "missing" }, { n: 2 }]) {
    const result = await call(params);
    assert.equal(result.details.approved, false);
    assert.equal(result.isError, true);
  }
  assert.ok(!seen.some(([kind]) => kind === "review"));
});

test("file review reads the complete file relative to the tool context", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cell-review-"));
  const source = "print('first line')\nprint('last line')\n";
  await fs.writeFile(path.join(directory, "draft.py"), source);
  const { tool, call, seen } = fixture();
  const result = await call({ file: "draft.py" }, directory);
  assertApprovalRendering(tool, result);
  assert.equal(result.details.approved, true);
  assert.deepEqual(seen, [["review", "unbound", source]]);
});

test("the actual approval popup renders only Approved; reject and Escape do not", { timeout: 5000 }, async () => {
  const tool = createRenderedCellReviewTool({});
  for (const key of ["y", "n", "\x1b"]) {
    let dialogCount = 0;
    const ctx = {
      cwd: process.cwd(), hasUI: true,
      ui: {
        theme,
        custom: async (factory) => new Promise((resolve) => {
          dialogCount++;
          const component = factory({ requestRender() {} }, theme, {}, resolve);
          component.handleInput(key);
        }),
      },
    };
    const result = await tool.execute("popup-review", { code: "x = 1" }, undefined, undefined, ctx);
    assert.equal(dialogCount, 1);
    if (key === "y") {
      assertApprovalRendering(tool, result);
    } else {
      assert.equal(result.details.approved, false);
      for (const expanded of [false, true]) {
        assert.equal(renderedText(tool, result, expanded), "Cell rejected. Nothing was executed.");
      }
    }
  }
});

test("the actual review path fails closed without UI", async () => {
  const tool = createRenderedCellReviewTool({});
  const result = await tool.execute("no-ui-review", { code: "x = 1" }, undefined, undefined,
    { cwd: process.cwd(), hasUI: false });
  assert.equal(result.details.approved, false);
  for (const expanded of [false, true]) {
    assert.equal(renderedText(tool, result, expanded), result.content[0].text);
    assert.match(renderedText(tool, result, expanded), /no UI is available/);
  }
});

test("rejections, edits and cancellations never render as Approved", async () => {
  for (const decision of [
    { action: "reject" },
    { action: "reject", note: "Review cancelled." },
    { action: "reject", note: "Please edit the cell first." },
    { action: "edit" }, // An unexpected decision must also fail closed.
  ]) {
    const { tool, call } = fixture(decision);
    const result = await call({ code: "x = 1" });
    for (const expanded of [false, true]) {
      assert.equal(renderedText(tool, result, expanded), result.content[0].text);
      assert.notEqual(renderedText(tool, result, expanded), "Approved");
    }
  }
});

test("missing approval evidence, partial results and errors cannot render as Approved", async () => {
  const { tool, call } = fixture();
  const approved = await call({ code: "x = 1" });
  for (const expanded of [false, true]) {
    assert.equal(renderedText(tool, approved, expanded, {}, true), "Reviewing…");
    // Pi supplies the error flag separately in renderer context, not in result.
    assert.notEqual(renderedText(tool, approved, expanded, { isError: true }), "Approved");
    assert.notEqual(renderedText(tool, { ...approved, isError: true }, expanded), "Approved");
    for (const details of [undefined, {}, { approved: true },
      { approved: false, rejected: false }, { approved: true, rejected: true },
      { approved: true, rejected: false, edited: true },
      { approved: true, rejected: false, cancelled: true }]) {
      const result = { content: [{ type: "text", text: "Not an approval." }], details };
      assert.equal(renderedText(tool, result, expanded), "Not an approval.");
    }
    const invalid = await call({});
    assert.equal(renderedText(tool, invalid, expanded), invalid.content[0].text);
  }
});

test("renderer preserves failure diagnostics and all fallback text blocks", async () => {
  const tool = createRenderedCellReviewTool({}, async () => { throw new Error("dialog unavailable"); });
  const result = await tool.execute("review-1", { code: "x = 1" }, undefined, undefined, { cwd: process.cwd() });
  assert.equal(result.isError, true);
  for (const expanded of [false, true]) {
    assert.equal(renderedText(tool, result, expanded), "Cell review failed: dialog unavailable");
    assert.equal(renderedText(tool, {
      content: [{ type: "text", text: "Cell rejected." }, { type: "text", text: "User feedback: edit first." }],
      details: { approved: false, rejected: true },
    }, expanded), "Cell rejected.\nUser feedback: edit first.");
  }
});

test("a broken review dialog fails closed", async () => {
  const tool = createCellReviewTool({}, async () => { throw new Error("dialog unavailable"); });
  const result = await tool.execute("review-1", { code: "x = 1" }, undefined, undefined, { cwd: process.cwd() });
  assert.equal(result.details.approved, false);
  assert.equal(result.details.rejected, true);
  assert.equal(result.isError, true);
});
