const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { loadPythonRuntimeSources } = require("../dist/execution/runtime-assets.js");

function withTempExtensionRoot(callback) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ptc-runtime-assets-"));

  try {
    return callback(tempRoot);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

test("loadPythonRuntimeSources reads all runtime files from the extension root", () => {
  withTempExtensionRoot((extensionRoot) => {
    const runtimeDir = path.join(extensionRoot, "src", "python-runtime");
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.writeFileSync(path.join(runtimeDir, "rpc.py"), "RPC = True\n", "utf-8");
    fs.writeFileSync(path.join(runtimeDir, "runtime.py"), "RUNTIME = True\n", "utf-8");
    fs.writeFileSync(path.join(runtimeDir, "session.py"), "SESSION = True\n", "utf-8");

    const sources = loadPythonRuntimeSources(extensionRoot);
    assert.equal(sources.rpcCode, "RPC = True\n");
    assert.equal(sources.runtimeCode, "RUNTIME = True\n");
    assert.equal(sources.sessionCode, "SESSION = True\n");
  });
});

test("loadPythonRuntimeSources also supports src-root entrypoints", () => {
  withTempExtensionRoot((extensionRoot) => {
    const srcRoot = path.join(extensionRoot, "src");
    const runtimeDir = path.join(srcRoot, "python-runtime");
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.writeFileSync(path.join(runtimeDir, "rpc.py"), "RPC = True\n", "utf-8");
    fs.writeFileSync(path.join(runtimeDir, "runtime.py"), "RUNTIME = True\n", "utf-8");
    fs.writeFileSync(path.join(runtimeDir, "session.py"), "SESSION = True\n", "utf-8");

    const sources = loadPythonRuntimeSources(srcRoot);
    assert.equal(sources.rpcCode, "RPC = True\n");
    assert.equal(sources.runtimeCode, "RUNTIME = True\n");
    assert.equal(sources.sessionCode, "SESSION = True\n");
  });
});

test("loadPythonRuntimeSources rejects missing runtime assets", () => {
  withTempExtensionRoot((extensionRoot) => {
    const runtimeDir = path.join(extensionRoot, "src", "python-runtime");
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.writeFileSync(path.join(runtimeDir, "rpc.py"), "RPC = True\n", "utf-8");

    assert.throws(
      () => loadPythonRuntimeSources(extensionRoot),
      /Expected Python runtime assets/
    );
  });
});

test("session exports actual runtime paths and emits local scoped snapshots without mutating input", () => {
  const { execFileSync } = require("node:child_process");
  withTempExtensionRoot((root) => {
    const source = path.join(root, "source");
    const modulePath = path.join(source, "src", "pi_subagents", "__init__.py");
    fs.mkdirSync(path.dirname(modulePath), { recursive: true });
    fs.writeFileSync(path.join(source, "pyproject.toml"), "[project]\nname='pi-subagents'\n");
    fs.writeFileSync(modulePath, "");
    const runtime = path.resolve(__dirname, "../src/python-runtime/session.py");
    const script = `
import ast, importlib.util, json, os, pathlib, sys, types
module = ast.parse(pathlib.Path(sys.argv[1]).read_text())
helpers = ast.Module(body=[node for node in module.body if isinstance(node, ast.FunctionDef)
    and node.name in {'_ptc_export_subagent_runtime', '_ptc_emit_subagent_state'}], type_ignores=[])
frames = []
ns = {'_ptc_os': os, '_ptc_sys': sys, '_emit_protocol': frames.append}
exec(compile(helpers, '<helpers>', 'exec'), ns)
importlib.util.find_spec = lambda name: types.SimpleNamespace(origin=sys.argv[2])
os.environ['PTC_PYTHON_EXECUTABLE'] = '/not-the-running-interpreter'
os.environ['PTC_SUBAGENTS_SOURCE'] = '/not-the-imported-source'
os.environ['PI_SUBAGENTS_ROOT_ID'] = 'root-id'
os.environ['PI_SUBAGENTS_PARENT_TOKEN'] = 'owner-token'
ns['_ptc_export_subagent_runtime']()
assert os.environ['PTC_PYTHON_EXECUTABLE'] == sys.executable
assert os.environ['PTC_SUBAGENTS_SOURCE'] == sys.argv[3]
snapshot = {'agents': [], 'totals': {'running': 2}, 'depth': 1}
ns['_ptc_emit_subagent_state'](snapshot)
assert 'rootId' not in snapshot
assert frames[0]['snapshot'] == dict(snapshot, rootId='root-id', parentToken='owner-token', scope='process')
print('ok')
`;
    assert.equal(execFileSync("python3", ["-c", script, runtime, modulePath, source],
      { encoding: "utf8" }).trim(), "ok");
  });
});
