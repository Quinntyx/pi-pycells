import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { KernelHost } from "../dist/kernel-host/server.js";
import { KernelHostConnection, PersistentSessionManager, hostSocketPath, ensureHost } from "../dist/kernel-host/client.js";
import { renderHostView } from "../dist/kernel-host/viewer.js";

function fakeManager() {
  const kernels = new Map(); let count = 0, disposed = 0, executions = 0;
  return {
    kernels, get disposed() { return disposed; }, get executions() { return executions; },
    list() { return [...kernels.values()]; },
    getPythonExecutable() { return "/python"; }, getSubagentSnapshot() { return null; },
    async provision(options) { const id = `k${++count}`; kernels.set(id, { id, name: options.name, running: false, cwd: "/tmp", pythonVersion: "3.14" }); return { id, name: options.name, pythonExecutable: "/python" }; },
    async execForeground(id, code, options) { executions++; const kernel = kernels.get(id); kernel.running = true; options.onUpdate({ details: { userCode: [code], currentLine: 1 } }); await (this.executionGate ?? new Promise(resolve => setTimeout(resolve, 100))); kernel.running = false; return { text: code, cellIdx: executions }; },
    async dispose(id) { disposed++; kernels.delete(id); }, async disposeAll() { disposed += kernels.size; kernels.clear(); },
    async resetKernel(id) { return { ...kernels.get(id) }; },
    interruptRunning() { return true; },
  };
}
async function fixture() {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "pycells-host-"));
  const manager = fakeManager(); const host = new KernelHost(manager, path.join(folder, "host.sock")); await host.listen();
  const clients = [];
  const connect = async owner => { const client = new KernelHostConnection(host.socketPath); clients.push(client); await client.connect(owner); return client; };
  return { manager, host, connect, async close() { clients.forEach(c => c.detach()); await host.close(); } };
}
test("persistent host is keyed by tmux server and stable session ID, not session name", () => {
  assert.equal(hostSocketPath("/tmux/a", "$1"), hostSocketPath("/tmux/a", "$1"));
  assert.notEqual(hostSocketPath("/tmux/a", "$1"), hostSocketPath("/tmux/a", "$2"));
  assert.notEqual(hostSocketPath("/tmux/a", "$1"), hostSocketPath("/tmux/b", "$1"));
});
test("session-scoped discovery, duplicate names, explicit attachment and reconnection", async () => {
  const f = await fixture();
  try {
    const a = await f.connect("pi-a"), b = await f.connect("pi-b");
    const ka = await a.request("call", { method: "provision", args: [{ name: "analysis" }] });
    const kb = await b.request("call", { method: "provision", args: [{ name: "analysis" }] });
    assert.notEqual(ka.id, kb.id);
    assert.deepEqual((await b.request("discover", {})).map(k => k.id), [kb.id]);
    assert.equal((await b.request("discover", { allSessions: true })).length, 2);
    await assert.rejects(b.request("call", { method: "dispose", args: [ka.id] }), /not attached/);
    await assert.rejects(b.request("attach", { kernelId: ka.id }), /different alias/);
    const attached = await b.request("attach", { kernelId: ka.id, alias: "recovered" });
    assert.equal(attached.ownerSessionId, "pi-a"); assert.equal(attached.name, "recovered");
    b.detach(); const b2 = await f.connect("pi-b");
    assert.deepEqual((await b2.request("discover", {})).map(k => k.name), ["recovered", "analysis"]);
    const reset = await b2.request("call", { method: "resetKernel", args: [ka.id, { cwd: "/tmp" }] });
    assert.equal(reset.id, ka.id); assert.equal(reset.name, "recovered");
    assert.equal((await b2.request("discover", {})).find(k => k.id === ka.id).ownerSessionId, "pi-a");
  } finally { await f.close(); }
});
test("Pi disconnect does not cancel execution, lose its outcome, or replay it", async () => {
  const f = await fixture();
  try {
    const a = await f.connect("pi-a"); const kernel = await a.request("call", { method: "provision", args: [{ name: "analysis" }] });
    let releaseExecution, announceExecution;
    f.manager.executionGate = new Promise(resolve => { releaseExecution = resolve; });
    const started = new Promise(resolve => { announceExecution = resolve; });
    const pending = a.request("call", { method: "execForeground", args: [kernel.id, "one execution", {}] }, () => announceExecution(), "cell-1");
    const rejected = assert.rejects(pending, /may still be running/);
    await started; a.detach(); await rejected;
    releaseExecution();
    const resumed = await f.connect("pi-a");
    assert.equal((await resumed.request("discover", {}))[0].id, kernel.id);
    await new Promise(resolve => setTimeout(resolve, 20));
    const result = await resumed.request("operation", { operationId: "cell-1" });
    assert.equal(result.status, "completed"); assert.equal(result.result.text, "one execution");
    const preview = f.host.state().operations.find(op => op.id === "cell-1");
    assert.equal("result" in preview, false, "state feeds must not rebroadcast retained outputs");
    assert.equal("update" in preview, false, "completed live previews belong to the notebook/history");
    assert.equal(f.manager.executions, 1); assert.equal(f.manager.disposed, 0);
    await assert.rejects(resumed.request("call", { method: "execForeground", args: [kernel.id, "duplicate", {}] }, undefined, "cell-1"), /already submitted/);
    await resumed.request("call", { method: "dispose", args: [kernel.id] }); assert.equal(f.manager.disposed, 1);
  } finally { await f.close(); }
});
test("viewer tabs show actual notebook source/results without terminal escape injection", () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "pycells-view-")); const file = path.join(folder, "view.ipynb");
  fs.writeFileSync(file, JSON.stringify({ cells: [{ cell_type: "code", source: ["value = 42\n", "value"], execution_count: 1, outputs: [{ output_type: "execute_result", data: { "text/plain": ["42\x1b[2J"] } }] }] }));
  const kernel = { id: "k", name: "analysis", ownerSessionId: "pi-a", notebookPath: file, running: false };
  const rendered = renderHostView({ kernels: [kernel], operations: [], pid: 12 }, 0, -1, 100, 25);
  assert.ok(rendered.lines.some(line => line.includes("value = 42")));
  assert.ok(rendered.lines.some(line => line.includes("Out [1]")));
  assert.ok(rendered.lines.every(line => !line.includes("\x1b")));
});

test("real kernel retains namespace and notebook when client dies and fork attaches", { skip: process.env.PTC_TEST_REAL_RUNTIME !== "true" }, async () => {
  const { PythonSessionManager } = await import("../dist/python-session-manager.js");
  const { loadSettingsFromEnv } = await import("../dist/utils.js");
  const { createSandbox } = await import("../dist/sandbox-manager.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pycells-real-host-"));
  const sandbox = await createSandbox();
  const manager = new PythonSessionManager(sandbox, loadSettingsFromEnv(), path.resolve("."));
  const host = new KernelHost(manager, path.join(dir, "host.sock")); await host.listen();
  const clients = [];
  const connect = async owner => { const c = new KernelHostConnection(host.socketPath); clients.push(c); await c.connect(owner); return c; };
  try {
    const original = await connect("original");
    const kernel = await original.request("call", { method: "provision", args: [{ name: "alive", cwd: dir, notebookPath: path.join(dir, "work.ipynb") }] });
    const pending = original.request("call", { method: "execForeground", args: [kernel.id, "import asyncio\nvalue = 42\nawait asyncio.sleep(0.3)\nvalue", { cwd: dir }] }, undefined, "real-cell");
    const disconnected = assert.rejects(pending, /may still be running/);
    await new Promise(r => setTimeout(r, 50)); original.detach(); await disconnected;
    const fork = await connect("fork"); assert.equal((await fork.request("discover", {})).length, 0);
    assert.equal((await fork.request("discover", { allSessions: true })).length, 1);
    await fork.request("attach", { kernelId: kernel.id });
    let op;
    for (let i = 0; i < 100; i++) { op = await fork.request("operation", { operationId: "real-cell" }); if (op.status !== "running") break; await new Promise(r => setTimeout(r, 30)); }
    assert.equal(op.status, "completed", op.error?.message);
    const result = await fork.request("call", { method: "scratchRun", args: [kernel.id, "value", { cwd: dir }] });
    assert.match(result.output, /42/);
    const notebook = JSON.parse(fs.readFileSync(path.join(dir, "work.ipynb"), "utf8"));
    assert.equal(notebook.cells.length, 1); assert.ok(JSON.stringify(notebook.cells[0].outputs).includes("42"));
  } finally { clients.forEach(c => c.detach()); await host.close(); await sandbox.cleanup(); }
});


test("Pi may initialize outside tmux, but kernel operations explain the requirement", async () => {
  const before = [process.env.TMUX, process.env.TMUX_PANE];
  const { loadSettingsFromEnv } = await import("../dist/utils.js");
  try {
    delete process.env.TMUX; delete process.env.TMUX_PANE;
    const manager = new PersistentSessionManager({}, loadSettingsFromEnv(), path.resolve("."));
    await manager.attachOwner("outside-tmux");
    await assert.rejects(manager.discover(), /inside a tmux session/);
    await manager.disposeAll();
  } finally {
    for (const [i, key] of ["TMUX", "TMUX_PANE"].entries()) {
      if (before[i] === undefined) delete process.env[key]; else process.env[key] = before[i];
    }
  }
});

test("response errors retain their class and traceback across kernel transport", async () => {
  const f = await fixture();
  try {
    const { PtcPythonError } = await import("../dist/execution/execution-errors.js");
    f.manager.execForeground = async () => { throw new PtcPythonError("bad input", "traceback evidence"); };
    const c = await f.connect("errors");
    const k = await c.request("call", { method: "provision", args: [{ name: "errors" }] });
    await assert.rejects(c.request("call", { method: "execForeground", args: [k.id, "bad", {}] }), error => {
      assert.ok(error instanceof PtcPythonError); assert.equal(error.traceback, "traceback evidence"); return true;
    });
  } finally { await f.close(); }
});


test("tmux host survives SIGKILL of a real client and tmux-session renaming", {
  skip: process.env.PTC_TEST_REAL_RUNTIME !== "true" || spawnSync("tmux", ["-V"]).status !== 0,
}, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pycells-tmux-host-"));
  const label = `pycells-test-${process.pid}-${Date.now()}`;
  const tx = (...args) => {
    const result = spawnSync("tmux", ["-L", label, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  };
  let child, fork;
  tx("new-session", "-d", "-s", "original", "sleep", "120");
  try {
    const [socket, pid, session, pane] = tx("display-message", "-p", "-t", "original", "#{socket_path}\t#{pid}\t#{session_id}\t#{pane_id}").split("\t");
    const root = path.resolve("."); const file = path.join(dir, "parent.cjs");
    const expectedEndpoint = hostSocketPath(socket, session);
    fs.mkdirSync(path.dirname(expectedEndpoint), { recursive: true });
    fs.writeFileSync(expectedEndpoint + ".lock", JSON.stringify({ pid: 99999999, nonce: "dead-launcher" }));
    fs.writeFileSync(file, String.raw`
      const { PersistentSessionManager } = require(${JSON.stringify(path.join(root, "dist/kernel-host/client.js"))});
      const { createSandbox } = require(${JSON.stringify(path.join(root, "dist/sandbox-manager.js"))});
      const { loadSettingsFromEnv } = require(${JSON.stringify(path.join(root, "dist/utils.js"))});
      (async () => {
        const manager = new PersistentSessionManager(await createSandbox(), loadSettingsFromEnv(), ${JSON.stringify(root)});
        await manager.attachOwner("process-owner");
        const kernel = await manager.provision({ name: "survivor", cwd: ${JSON.stringify(dir)}, notebookPath: ${JSON.stringify(path.join(dir, "work.ipynb"))} });
        let announced = false;
        await manager.execForeground(kernel.id, "import asyncio\ncounter = globals().get('counter', 0) + 1\nawait asyncio.sleep(0.5)\ncounter", {
          cwd: ${JSON.stringify(dir)}, onUpdate(update) {
            if (!announced && update.details?.currentLine > 0) {
              announced = true; console.log(JSON.stringify({ started: true, kernelId: kernel.id }));
            }
          }
        });
      })().catch(error => { console.error(error); process.exit(1); });
    `);
    child = spawn(process.execPath, [file], { cwd: root, env: { ...process.env, TMUX: `${socket},${pid},0`, TMUX_PANE: pane, PI_SUBAGENT_DEPTH: "0" }, stdio: ["ignore", "pipe", "pipe"] });
    let errors = ""; child.stderr.on("data", chunk => { errors += chunk; });
    const started = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`client startup timeout: ${errors}`)), 15_000);
      let buffered = "";
      child.stdout.on("data", chunk => {
        buffered += chunk;
        for (const line of buffered.split("\n")) {
          try { const value = JSON.parse(line); if (value.started) { clearTimeout(timer); resolve(value); } } catch {}
        }
      });
      child.once("exit", code => { clearTimeout(timer); reject(new Error(`client exited ${code}: ${errors}`)); });
    });
    const exited = new Promise(resolve => child.once("exit", resolve)); child.kill("SIGKILL"); await exited;
    const endpoint = hostSocketPath(socket, session);
    tx("rename-session", "-t", session, "renamed");
    assert.equal(tx("show-option", "-v", "-t", session, "@pi_pycells_kernel_socket"), endpoint);
    const hostWindow = tx("show-option", "-v", "-t", session, "@pi_pycells_kernel_window");
    assert.equal(tx("list-windows", "-t", session, "-F", "#{window_id}").split("\n").filter(id => id === hostWindow).length, 1);
    await ensureHost({ socketPath: endpoint, tmuxSocket: socket, tmuxSession: session }, root);
    assert.equal(tx("show-option", "-v", "-t", session, "@pi_pycells_kernel_window"), hostWindow);
    fork = new KernelHostConnection(endpoint); await fork.connect("process-fork");
    assert.equal((await fork.request("discover", {})).length, 0);
    assert.equal((await fork.request("discover", { allSessions: true })).length, 1);
    await fork.request("attach", { kernelId: started.kernelId });
    let kernel;
    for (let i = 0; i < 100; i++) {
      [kernel] = await fork.request("discover", {});
      if (kernel.lastOperation?.status === "completed") break;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    assert.equal(kernel.lastOperation.status, "completed");
    const result = await fork.request("call", { method: "scratchRun", args: [kernel.id, "counter", { cwd: dir }] });
    assert.match(result.output, /Out\[2\]: 1/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "work.ipynb"), "utf8")).cells.length, 1);
    const screen = tx("capture-pane", "-p", "-t", tx("show-option", "-v", "-t", session, "@pi_pycells_kernel_window"));
    assert.match(screen, /persistent kernel host/); assert.match(screen, /survivor/);
  } finally {
    fork?.detach(); if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    spawnSync("tmux", ["-L", label, "kill-server"]);
  }
});
