import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { KernelHost } from "../dist/kernel-host/server.js";
import { KernelHostConnection, RemoteKernelManager, hostSocketPath, ensureHost } from "../dist/kernel-host/client.js";
import { renderHostView } from "../dist/kernel-host/viewer.js";
import { normalizeKernelName } from "../dist/python-session-manager.js";

function fakeManager() {
  const kernels = new Map(); let count = 0, disposed = 0, executions = 0;
  return {
    kernels, get disposed() { return disposed; }, get executions() { return executions; },
    list() { return [...kernels.values()]; },
    getPythonExecutable() { return "/python"; }, getSubagentSnapshot() { return null; },
    async provision(options) {
      const name = normalizeKernelName(options.name);
      const { ownerSessionId } = options;
      if (this.list().some(kernel => kernel.name === name && kernel.ownerSessionId === ownerSessionId)) throw new Error("Kernel name already in use");
      const id = `k${++count}`;
      kernels.set(id, { id, name, ownerSessionId, running: false, cwd: "/tmp", pythonVersion: "3.14" });
      return { id, name, ownerSessionId, pythonExecutable: "/python" };
    },
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
    const name = "a".repeat(64);
    const provision = (client, ownerSessionId) => client.request("call", { method: "provision", args: [{ name, ownerSessionId }] });
    const ka = await provision(a, "pi-b");
    const kb = await provision(b);
    assert.equal(ka.name, name);
    assert.equal(kb.name, name);
    assert.notEqual(ka.id, kb.id);
    assert.deepEqual(f.manager.list().map(k => [k.name, k.ownerSessionId]), [[name, "pi-a"], [name, "pi-b"]]);
    await assert.rejects(provision(a), /already in use/);
    await a.request("attach", { kernelId: ka.id, alias: "renamed" });
    await assert.rejects(provision(a), /already in use/);
    await assert.rejects(a.request("call", { method: "provision", args: [{ name: "renamed" }] }), /already in use in this Pi session/);
    await assert.rejects(a.request("call", { method: "provision", args: [{ name: name + "a" }] }), /too long/);
    assert.deepEqual((await b.request("discover", {})).map(k => k.id), [kb.id]);
    assert.equal((await b.request("discover", { allSessions: true })).length, 2);
    await assert.rejects(b.request("call", { method: "dispose", args: [ka.id] }), /not attached/);
    await assert.rejects(b.request("attach", { kernelId: ka.id }), /different alias/);
    const attached = await b.request("attach", { kernelId: ka.id, alias: "recovered" });
    assert.equal(attached.ownerSessionId, "pi-a"); assert.equal(attached.name, "recovered");
    b.detach(); const b2 = await f.connect("pi-b");
    assert.deepEqual((await b2.request("discover", {})).map(k => k.name), ["recovered", name]);
    const reset = await b2.request("call", { method: "resetKernel", args: [ka.id, { cwd: "/tmp" }] });
    assert.equal(reset.id, ka.id); assert.equal(reset.name, "recovered");
    assert.equal((await b2.request("discover", {})).find(k => k.id === ka.id).ownerSessionId, "pi-a");
  } finally { await f.close(); }
});
test("provision reserves names across connections without blocking unrelated kernels", async () => {
  const f = await fixture();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  try {
    const a = await f.connect("pi-a"), a2 = await f.connect("pi-a"), b = await f.connect("pi-b");
    const provision = (client, name) => client.request("call", { method: "provision", args: [{ name }] });
    const existing = await provision(b, "existing");
    const original = f.manager.provision;
    let announce;
    const started = new Promise(resolve => { announce = resolve; });
    f.manager.provision = async function (options) {
      if (options.ownerSessionId === "pi-a" && options.name === "analysis") {
        announce();
        if (await gate === "fail") throw new Error("startup failed");
      }
      return original.call(this, options);
    };
    const pending = provision(a, "analysis");
    void pending.catch(() => undefined);
    await started;
    const otherOwner = provision(b, "analysis");
    void otherOwner.catch(() => undefined);
    await b.request("discover", {}); // same-socket barrier: the host has received the provision
    assert.ok(f.manager.list().some(k => k.ownerSessionId === "pi-b" && k.name === "analysis"));
    await otherOwner;
    const duplicate = assert.rejects(provision(a2, "analysis"), /already in use/);
    void duplicate.catch(() => undefined);
    await assert.rejects(a2.request("attach", { kernelId: existing.id, alias: "analysis" }), /different alias/);
    await duplicate;
    release("fail");
    await assert.rejects(pending, /startup failed/);
    f.manager.provision = original;
    assert.equal((await provision(a2, "analysis")).name, "analysis");
  } finally { release(); await f.close(); }
});

test("source replay blocks provisioning only for the same destination notebook", async () => {
  const f = await fixture();
  let release, announce;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { announce = resolve; });
  const cwd = path.dirname(f.host.socketPath);
  fs.symlinkSync(cwd, path.join(cwd, "alias"), "dir");
  fs.symlinkSync("shared.ipynb", path.join(cwd, "seeded.ipynb"));
  const entered = [];
  const original = f.manager.provision;
  f.manager.provision = async function (options) {
    entered.push(options.name);
    if (options.source) { announce(); await gate; }
    return original.call(this, options);
  };
  try {
    const a = await f.connect("pi-a"), b = await f.connect("pi-b");
    const provision = (client, name, notebookPath, source?) =>
      client.request("call", { method: "provision", args: [{ name, cwd, notebookPath, source }] });
    const seeded = provision(a, "seeded", "seeded.ipynb", "seed.py");
    void seeded.catch(() => undefined);
    await started;
    const shared = provision(b, "shared", "alias/shared.ipynb");
    void shared.catch(() => undefined);
    await b.request("discover", {}); // ensure the host keyed the request before the save
    // Saving a replayed cell atomically replaces the destination symlink.
    const saved = path.join(cwd, "saved.tmp");
    fs.writeFileSync(saved, "{}");
    fs.renameSync(saved, path.join(cwd, "seeded.ipynb"));
    const samePath = provision(b, "same-path", "alias/seeded.ipynb");
    void samePath.catch(() => undefined);
    await provision(b, "independent", "other.ipynb");
    assert.deepEqual(entered, ["seeded", "independent"]);
    release();
    await Promise.all([seeded, shared, samePath]);
    assert.deepEqual(entered.toSorted(), ["independent", "same-path", "seeded", "shared"]);
  } finally { release(); await f.close(); }
});

for (const legacy of [false, true]) test(`remote list is current at hello, provision, attach and disposal (${legacy ? "legacy host" : "no discovery round trips"})`, async (t) => {
  const threadId = process.env.T3_THREAD_ID;
  delete process.env.T3_THREAD_ID;
  t.after(() => { if (threadId !== undefined) process.env.T3_THREAD_ID = threadId; });
  const f = await fixture();
  const { loadSettingsFromEnv } = await import("../dist/utils.js");
  const manager = new RemoteKernelManager(loadSettingsFromEnv(), path.resolve("."), {}, { socketPath: f.host.socketPath });
  try {
    const peer = await f.connect("pi-b");
    const provision = (name) => peer.request("call", { method: "provision", args: [{ name }] });
    const external = await provision("external");
    if (legacy) {
      // Emulate a v1 host whose state broadcasts haven't arrived when it replies.
      f.host.sendState = () => {};
      const send = f.host.send.bind(f.host);
      f.host.send = (socket, frame) => {
        if (frame.result?.stateBeforeReply) frame = { ...frame, result: { version: frame.result.version } };
        send(socket, frame);
      };
    }
    const requests = [];
    const handle = f.host.request.bind(f.host);
    f.host.request = (socket, request) => {
      requests.push(request.op);
      return handle(socket, request);
    };
    const initial = await f.manager.provision({ name: "initial", ownerSessionId: "pi-a" });
    await manager.attachOwner("pi-a");
    assert.deepEqual(manager.list().map(k => k.id), [initial.id]);
    const kernel = await manager.provision({ name: "analysis" });
    assert.ok(manager.list().some(k => k.id === kernel.id));
    await manager.attachKernel(external.id, "imported");
    assert.equal(manager.list().find(k => k.id === external.id)?.name, "imported");
    await manager.dispose(kernel.id);
    assert.ok(!manager.list().some(k => k.id === kernel.id));
    assert.deepEqual(requests, legacy
      ? ["hello", "discover", "call", "discover", "attach", "discover", "call", "discover"]
      : ["hello", "call", "attach", "call"]);
  } finally { await manager.disposeAll(); await f.close(); }
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
    const manager = new RemoteKernelManager(loadSettingsFromEnv(), path.resolve("."));
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
    const result = spawnSync("tmux", ["-L", label, "-f", os.devNull, ...args], { encoding: "utf8" });
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
      const { RemoteKernelManager } = require(${JSON.stringify(path.join(root, "dist/kernel-host/client.js"))});
      const { loadSettingsFromEnv } = require(${JSON.stringify(path.join(root, "dist/utils.js"))});
      (async () => {
        const manager = new RemoteKernelManager(loadSettingsFromEnv(), ${JSON.stringify(root)});
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

test("source-only Git package starts a tmux host without dist or development dependencies", {
  skip: spawnSync("tmux", ["-V"]).status !== 0,
  timeout: 30_000,
}, async () => {
  const root = path.resolve(".");
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "pycells-git-install-"));
  const packageRoot = path.join(folder, "package");
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  fs.cpSync(path.join(root, "src"), path.join(packageRoot, "src"), { recursive: true });
  fs.copyFileSync(path.join(root, "package.json"), path.join(packageRoot, "package.json"));
  for (const name of Object.keys(manifest.dependencies)) {
    const dependency = path.join(packageRoot, "node_modules", name);
    fs.mkdirSync(path.dirname(dependency), { recursive: true });
    fs.symlinkSync(path.join(root, "node_modules", name), dependency, "dir");
  }
  assert.equal(fs.existsSync(path.join(packageRoot, "dist")), false);
  assert.equal(fs.existsSync(path.join(packageRoot, "node_modules", ".bin", "tsc")), false);

  const label = `pycells-git-test-${process.pid}-${Date.now()}`;
  const tx = (...args) => {
    const result = spawnSync("tmux", ["-L", label, "-f", os.devNull, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  let client;
  tx("new-session", "-d", "-s", "git-install", "sleep", "120");
  try {
    const [socket, session] = tx("display-message", "-p", "-t", "git-install", "#{socket_path}\t#{session_id}").split("\t");
    const endpoint = { socketPath: hostSocketPath(socket, session), tmuxSocket: socket, tmuxSession: session };
    await ensureHost(endpoint, packageRoot);
    client = new KernelHostConnection(endpoint.socketPath);
    await client.connect("git-install-owner");
    assert.deepEqual(await client.request("discover", {}), []);
    const window = tx("show-option", "-v", "-t", session, "@pi_pycells_kernel_window");
    assert.match(tx("capture-pane", "-p", "-t", window), /persistent kernel host/);

    if (process.env.PTC_TEST_REAL_RUNTIME === "true") {
      const notebookPath = path.join(folder, "source-only.ipynb");
      const kernel = await client.request("call", {
        method: "provision", args: [{ name: "git-install", cwd: folder, notebookPath }],
      });
      const result = await client.request("call", {
        method: "execForeground", args: [kernel.id, "source_only = 42\nsource_only", { cwd: folder }],
      });
      assert.match(result.output, /42/);
      const notebook = JSON.parse(fs.readFileSync(notebookPath, "utf8"));
      assert.equal(notebook.cells.length, 1);
      assert.ok(JSON.stringify(notebook.cells[0].outputs).includes("42"));
    }
  } finally {
    client?.detach();
    spawnSync("tmux", ["-L", label, "kill-server"]);
  }
});
