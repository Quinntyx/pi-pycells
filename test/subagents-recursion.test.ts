const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  subagentDepthPolicy, inheritedSubagentsRuntime, isNestedSubagent,
  ensureSubagentsEnv, ensurePtcVenv, ensurePythonForVersion,
} = require("../dist/subagents-env.js");

const keys = ["PI_SUBAGENT_DEPTH", "PI_SUBAGENTS_MAX_DEPTH", "PI_SUBAGENTS_PARENT_TOKEN",
  "PTC_PYTHON_EXECUTABLE", "PTC_SUBAGENTS_SOURCE"];
async function withInheritedRuntime(callback) {
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ptc-recursion-"));
  const source = path.join(tmp, "source");
  const python = path.join(tmp, "python");
  fs.mkdirSync(path.join(source, "src", "pi_subagents"), { recursive: true });
  fs.writeFileSync(path.join(source, "pyproject.toml"), "[project]\nname='pi-subagents'\n");
  const module = path.join(source, "src", "pi_subagents", "__init__.py");
  const writeProbe = (version, origin = module) => fs.writeFileSync(python,
    `#!${process.execPath}\nconsole.log(${JSON.stringify(JSON.stringify({ version, module: origin }))});\n`,
    { mode: 0o700 });
  writeProbe("3.14.4");
  process.env.PI_SUBAGENT_DEPTH = "1";
  process.env.PI_SUBAGENTS_MAX_DEPTH = "2";
  process.env.PTC_PYTHON_EXECUTABLE = python;
  process.env.PTC_SUBAGENTS_SOURCE = source;
  try { await callback({ tmp, source, python, writeProbe }); }
  finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test("depth policy defaults flat and rejects malformed or negative limits", () => {
  assert.deepEqual(subagentDepthPolicy({}), { depth: 0, maxDepth: 1 });
  assert.deepEqual(subagentDepthPolicy({ PI_SUBAGENT_DEPTH: "2", PI_SUBAGENTS_MAX_DEPTH: "3" }),
    { depth: 2, maxDepth: 3 });
  for (const text of ["-1", "1junk", "1.5", "", " 1", "Infinity", "9007199254740992"]) {
    assert.throws(() => subagentDepthPolicy({ PI_SUBAGENT_DEPTH: text }), /nonnegative integer/);
    assert.throws(() => subagentDepthPolicy({ PI_SUBAGENTS_MAX_DEPTH: text }), /positive integer/);
  }
  assert.throws(() => subagentDepthPolicy({ PI_SUBAGENTS_MAX_DEPTH: "0" }), /positive integer/);
});

test("nested provisioning reuses source/interpreter even at the depth boundary without sync artifacts", async () => {
  await withInheritedRuntime(async ({ tmp, source, python }) => {
    process.env.PI_SUBAGENT_DEPTH = "2";
    const cacheRoot = path.join(tmp, "must-not-bootstrap");
    const result = await ensureSubagentsEnv({ cacheRoot });
    assert.equal(result.status, "ok");
    assert.equal(result.editablePath, source);
    assert.equal(result.venvPython, python);
    assert.equal(await ensurePtcVenv(), true);
    assert.equal(await ensurePythonForVersion("3.14"), python);
    assert.equal(fs.existsSync(cacheRoot), false);
    await assert.rejects(ensurePythonForVersion("3.13"), /no fallback or provisioning/);
  });
});

test("missing or mismatched inherited runtime fails before child provisioning", async () => {
  await withInheritedRuntime(async ({ tmp, writeProbe }) => {
    writeProbe("3.14.4", path.join(tmp, "unrelated", "pi_subagents.py"));
    assert.throws(() => inheritedSubagentsRuntime(), /does not load pi_subagents from/);
    writeProbe("3.14.4", null);
    assert.throws(() => inheritedSubagentsRuntime(), /does not load pi_subagents from/);
    delete process.env.PTC_PYTHON_EXECUTABLE;
    const result = await ensureSubagentsEnv({ cacheRoot: path.join(tmp, "no-install") });
    assert.equal(result.status, "failed");
    assert.match(result.reason, /bootstrap is disabled/);
    assert.equal(fs.existsSync(path.join(tmp, "no-install")), false);
  });
});

test("inherited parent identity cannot become flat bootstrap by lowering local depth", async () => {
  await withInheritedRuntime(async ({ tmp }) => {
    process.env.PI_SUBAGENT_DEPTH = "0";
    process.env.PI_SUBAGENTS_MAX_DEPTH = "1";
    process.env.PI_SUBAGENTS_PARENT_TOKEN = "inherited-token";
    assert.equal(isNestedSubagent(), true);
    const cacheRoot = path.join(tmp, "no-flat-bypass");
    assert.equal((await ensureSubagentsEnv({ cacheRoot })).status, "ok");
    assert.equal(process.env.PI_SUBAGENTS_PARENT_TOKEN, "inherited-token");
    assert.equal(fs.existsSync(cacheRoot), false);
  });
});
