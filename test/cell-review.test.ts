const test = require("node:test");
const assert = require("node:assert/strict");
// Import the production review module, not the host-only extension entrypoint.
const { createCellReviewTool, createRenderedCellReviewTool } = require("../dist/tools/cell-review.js");
const { KernelDirectory } = require("../dist/tools/kernel-directory.js");

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

function fixture(decision = { action: "approve" }, extraManager = {}) {
  const seen = [];
  const manager = {
    list: () => [{ id: "kernel-1", notebookPath: "/tmp/analysis.ipynb" }],
    get: (id) => id === "kernel-1" ? {} : undefined,
    readCell: async (id, n) => {
      seen.push(["read", id, n]);
      return { cells: [{ cellType: n === 2 ? "markdown" : "code", source: "print('review only')" }] };
    },
    exec: () => { throw new Error("review must never execute code"); },
    runCell: () => { throw new Error("review must never execute a notebook cell"); },
    ...extraManager,
  };
  const directory = new KernelDirectory(manager);
  directory.register("analysis", "kernel-1", "/tmp/analysis.ipynb");
  const tool = createRenderedCellReviewTool(manager, directory, async (_ctx, kernelName, code) => {
    seen.push(["review", kernelName, code]);
    return decision;
  });
  const call = (params, cwd = process.cwd()) => tool.execute("review-1", params, undefined, undefined, { cwd, hasUI: true });
  return { tool, call, seen, manager, directory };
}

test("reviewing a saved cell in the named kernel approves without executing", async () => {
  const { tool, call, seen } = fixture();
  const result = await call({ kernel: "analysis", n: 1 });
  assertApprovalRendering(tool, result);
  assert.equal(result.details.approved, true);
  assert.equal(result.details.rejected, false);
  assert.equal(result.details.kernel, "analysis");
  assert.deepEqual(seen, [["read", "kernel-1", 1], ["review", "analysis", "print('review only')"]]);
  assert.match(result.content[0].text, /Nothing was executed/);
});

test("review targets only the explicitly named kernel", async () => {
  const { call, seen } = fixture();
  const result = await call({ kernel: "missing", n: 1 });
  assert.equal(result.isError, true);
  assert.equal(result.details.approved, false);
  assert.match(result.content[0].text, /Unknown kernel "missing"/);
  assert.ok(!seen.some(([kind]) => kind === "review"));
  // The named kernel still resolves; ids are accepted only as live aliases.
  const byName = await call({ kernel: "analysis", n: 1 });
  assert.equal(byName.details.approved, true);
  assert.deepEqual(seen, [["read", "kernel-1", 1], ["review", "analysis", "print('review only')"]]);
});

test("review requires a saved cell position and rejects markdown cells", async () => {
  const { call, seen } = fixture();
  for (const params of [{}, { kernel: "analysis" }, { n: 1 }, { kernel: "analysis", n: 2 }]) {
    const result = await call(params);
    assert.equal(result.isError, true);
    assert.equal(result.details.approved, false);
  }
  assert.ok(!seen.some(([kind]) => kind === "review"));
  assert.ok(seen.some(([kind]) => kind === "read"));
});

test("rejection returns the user feedback without executing", async () => {
  const { call } = fixture({ action: "reject", note: "Reduce the affected directory scope." });
  const result = await call({ kernel: "analysis", n: 1 });
  assert.equal(result.details.approved, false);
  assert.equal(result.details.note, "Reduce the affected directory scope.");
  assert.match(result.content[0].text, /Cell rejected/);
});

test("the actual approval popup renders only Approved; reject and Escape do not", { timeout: 5000 }, async () => {
  const tool = createRenderedCellReviewTool({
    list: () => [{ id: "kernel-1", name: "analysis" }],
    get: (id) => id === "kernel-1" ? {} : undefined,
    readCell: async () => ({ cells: [{ cellType: "code", source: "x = 1" }] }),
  });
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
    const result = await tool.execute("popup-review", { kernel: "analysis", n: 1 }, undefined, undefined, ctx);
    assert.equal(dialogCount, 1);
    if (key === "y") {
      assertApprovalRendering(tool, result);
    } else {
      assert.equal(result.details.approved, false);
      for (const expanded of [false, true]) {
        assert.equal(renderedText(tool, result, expanded), "Rejected");
      }
    }
  }
});

test("the actual review path fails closed without UI", async () => {
  const tool = createRenderedCellReviewTool({
    list: () => [{ id: "kernel-1", name: "analysis" }],
    get: (id) => id === "kernel-1" ? {} : undefined,
    readCell: async () => ({ cells: [{ cellType: "code", source: "x = 1" }] }),
  });
  const result = await tool.execute("no-ui-review", { kernel: "analysis", n: 1 }, undefined, undefined,
    { cwd: process.cwd(), hasUI: false });
  assert.equal(result.details.approved, false);
  for (const expanded of [false, true]) {
    assert.equal(renderedText(tool, result, expanded), "Rejected · approval requested but no UI is available in this mode");
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
    const result = await call({ kernel: "analysis", n: 1 });
    for (const expanded of [false, true]) {
      assert.equal(renderedText(tool, result, expanded), `Rejected${decision.note ? ` · ${decision.note}` : ""}`);
      assert.notEqual(renderedText(tool, result, expanded), "Approved");
    }
  }
});

test("missing approval evidence, partial results and errors cannot render as Approved", async () => {
  const { tool, call } = fixture();
  const approved = await call({ kernel: "analysis", n: 1 });
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
      assert.equal(renderedText(tool, result, expanded), details?.rejected ? "Rejected" : "Review incomplete");
    }
    const invalid = await call({ kernel: "nope", n: 1 });
    assert.equal(renderedText(tool, invalid, expanded), invalid.content[0].text);
  }
});

test("renderer preserves errors but hides agent-only rejection instructions", async () => {
  const tool = createRenderedCellReviewTool({
    list: () => [{ id: "kernel-1", name: "analysis" }],
    get: (id) => id === "kernel-1" ? {} : undefined,
    readCell: async () => ({ cells: [{ cellType: "code", source: "x = 1" }] }),
  }, undefined, async () => { throw new Error("dialog unavailable"); });
  const result = await tool.execute("review-1", { kernel: "analysis", n: 1 }, undefined, undefined, { cwd: process.cwd() });
  assert.equal(result.isError, true);
  for (const expanded of [false, true]) {
    assert.equal(renderedText(tool, result, expanded), "Cell review failed: dialog unavailable");
    assert.equal(renderedText(tool, {
      content: [{ type: "text", text: "Cell rejected." }, { type: "text", text: "User feedback: edit first." }],
      details: { approved: false, rejected: true },
    }, expanded), "Rejected");
  }
});

test("a broken review dialog fails closed", async () => {
  const tool = createCellReviewTool({
    list: () => [{ id: "kernel-1", name: "analysis" }],
    get: (id) => id === "kernel-1" ? {} : undefined,
    readCell: async () => ({ cells: [{ cellType: "code", source: "x = 1" }] }),
  }, async () => { throw new Error("dialog unavailable"); }, new KernelDirectory({ list: () => [{ id: "kernel-1", name: "analysis" }] }));
  const result = await tool.execute("review-1", { kernel: "analysis", n: 1 }, undefined, undefined, { cwd: process.cwd() });
  assert.equal(result.details.approved, false);
  assert.equal(result.details.rejected, true);
  assert.equal(result.isError, true);
});

test("user-facing review rendering never leaks internal session ids", async () => {
  const { tool, call } = fixture();
  const approved = await call({ kernel: "analysis", n: 1 });
  const rejected = await call({ kernel: "missing", n: 1 });
  for (const result of [approved, rejected]) {
    const text = renderedText(tool, result, true);
    assert.ok(!/[0-9a-f]{12}/.test(text), `no opaque ids in user render: ${text}`);
    assert.ok(!/session_id/.test(text));
  }
});


test("detached review inputs are rejected even when accompanied by a saved-cell selector", async () => {
  const { call, seen } = fixture();
  for (const extra of [{ code: "print('bypass')" }, { file: "/tmp/bypass.py" }]) {
    const result = await call({ kernel: "analysis", n: 1, ...extra });
    assert.equal(result.isError, true);
    assert.equal(result.details.approved, false);
    assert.match(result.content[0].text, /Detached code and file reviews/);
  }
  assert.deepEqual(seen, []);
});
