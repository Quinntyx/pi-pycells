const test = require("node:test");
const assert = require("node:assert/strict");
const { validateRpcMessage } = require("../dist/rpc-protocol.js");

test("notebook transport rejects retired host-tool request and response frames", () => {
  for (const type of ["tool_call", "tool_result"]) {
    assert.throws(() => validateRpcMessage({ type, id: "x", tool: "bash", params: { command: "false" } }), /Unknown RPC frame type/);
  }
});

test("notebook transport validates progress, output, images and subagent snapshots", () => {
  assert.deepEqual(validateRpcMessage({ type: "execution_progress", line: 2, total_lines: 4 }), { type: "execution_progress", line: 2, total_lines: 4 });
  assert.equal(validateRpcMessage({ type: "exec_done", id: "cell", output: "ok" }).output, "ok");
  assert.throws(() => validateRpcMessage({ type: "exec_done", id: "cell", output: "", images: [{ mimeType: "image/png", data: 42 }] }), /image/);
  assert.equal(validateRpcMessage({ type: "subagent_state", snapshot: { agents: [] } }).type, "subagent_state");
  assert.equal(validateRpcMessage({ type: "exec_error", id: "cell", message: "oops", interrupted: true, line: 3 }).interrupted, true);
  assert.throws(() => validateRpcMessage({ type: "execution_progress", line: "2", total_lines: 4 }), /execution_progress/);
});
