import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as net from "node:net";
import { createInterface } from "node:readline";
import { resolveHostEndpoint, ensureHost, KernelHostConnection, RemoteKernelManager } from "../dist/kernel-host/client.js";
import { spawn } from "node:child_process";
import { notebookImages } from "../dist/execution/notebook-output.js";
import { KernelHost } from "../dist/kernel-host/server.js";

function request(socketPath, op) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const reader = createInterface({ input: socket });
    socket.on("error", reject);
    socket.on("connect", () => socket.write(JSON.stringify({ id: "observer", op }) + "\n"));
    reader.once("line", line => { reader.close(); socket.destroy(); resolve(JSON.parse(line)); });
  });
}

test("T3 thread endpoint wins over ambient tmux and rejects partial routing", async () => {
  const keys = ["T3_THREAD_ID", "T3_PYCELLS_SOCKET", "TMUX", "TMUX_PANE"];
  const original = keys.map(key => process.env[key]);
  try {
    process.env.T3_THREAD_ID = "thread-a";
    process.env.T3_PYCELLS_SOCKET = "/tmp/pycells-thread-a.sock";
    process.env.TMUX = "/not/a/tmux/server,1,0";
    process.env.TMUX_PANE = "%1";
    const endpoint = await resolveHostEndpoint();
    assert.equal(endpoint.socketPath, process.env.T3_PYCELLS_SOCKET);
    assert.equal(endpoint.headless, true);
    assert.equal(endpoint.threadId, "thread-a");
    delete process.env.T3_THREAD_ID;
    await assert.rejects(resolveHostEndpoint(), /T3_THREAD_ID.*T3_PYCELLS_SOCKET/);
  } finally {
    keys.forEach((key, i) => { if (original[i] === undefined) delete process.env[key]; else process.env[key] = original[i]; });
  }
});

test("notebook image selection is bounded and shared across MIME formats", () => {
  const bundles = [
    { data: { "text/html": "<script>bad()</script>", "image/svg+xml": "<svg/>" } },
    { data: { "image/png": ["aG", "VsbG8="], "image/jpeg": "ignored" } },
    ...Array.from({ length: 6 }, () => ({ data: { "image/jpeg": "anBlZw==" } })),
  ];
  assert.equal(notebookImages(bundles).length, 4);
  assert.deepEqual(notebookImages(bundles)[0], { mimeType: "image/png", data: "aGVsbG8=" });
  assert.equal(notebookImages(bundles)[1].mimeType, "image/jpeg");
});

test("headless observer reads notebook cells without attaching or executing; tmux host rejects it", async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "pycells-observer-"));
  const notebookPath = path.join(folder, "work.ipynb");
  fs.writeFileSync(notebookPath, JSON.stringify({ cells: [
    { id: "intro", cell_type: "markdown", source: ["# Analysis\n", "Read only"] },
    { id: "plot", cell_type: "code", source: "plot()", execution_count: 7, outputs: [
      { output_type: "stream", text: ["printed\n"] },
      { output_type: "display_data", data: { "text/plain": "an image", "image/png": ["aG", "VsbG8="], "image/jpeg": "ignored" } },
      { output_type: "execute_result", data: { "image/jpeg": "anBlZw==" } },
      { output_type: "error", ename: "ValueError", evalue: "bad", traceback: ["Traceback", "ValueError: bad"] },
    ] },
  ] }));
  const manager = { list: () => [{ id: "k1", notebookPath, running: false, name: "analysis", ownerSessionId: "thread-a" }],
    getPythonExecutable: () => undefined, getSubagentSnapshot: () => null, disposeAll: async () => {} };
  const host = new KernelHost(manager, path.join(folder, "headless.sock"), { headless: true });
  const terminalHost = new KernelHost(manager, path.join(folder, "terminal.sock"));
  await host.listen(); await terminalHost.listen();
  try {
    const frame = await request(host.socketPath, "notebookSnapshot");
    assert.equal(frame.error, undefined);
    assert.equal(frame.result.version, 1);
    assert.equal(frame.result.kernels[0].name, "analysis");
    assert.equal(frame.result.kernels[0].cells[0].source, "# Analysis\nRead only");
    const code = frame.result.kernels[0].cells[1];
    assert.equal(code.executionCount, 7);
    assert.deepEqual(code.outputs.filter(o => o.kind === "image"), [
      { kind: "image", mimeType: "image/png", data: "aGVsbG8=" },
      { kind: "image", mimeType: "image/jpeg", data: "anBlZw==" },
    ]);
    assert.equal(code.outputs.at(-1).kind, "error");
    assert.match((await request(terminalHost.socketPath, "notebookSnapshot")).error.message, /identity first/);
    assert.match((await request(host.socketPath, "call")).error.message, /identity first/);
  } finally { await host.close(); await terminalHost.close(); }
});

test("concurrent headless startup reuses one source host and follows its T3 owner lifecycle", async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "pycells-headless-"));
  const owner = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const endpoint = { socketPath: path.join(folder, "host.sock"), headless: true, threadId: "thread-host" };
  const keys = ["T3_THREAD_ID", "T3_PYCELLS_SOCKET", "T3_PYCELLS_OWNER_PID", "T3_PYCELLS_LAUNCH_SOCKET"];
  const original = keys.map(key => process.env[key]);
  const clients = [], launches = [];
  const launcher = net.createServer(socket => {
    const reader = createInterface({ input: socket });
    reader.once("line", line => {
      const recipe = JSON.parse(line);
      assert.equal(recipe.op, "launch");
      assert.equal(recipe.threadId, endpoint.threadId);
      assert.equal(recipe.socketPath, endpoint.socketPath);
      assert.equal(recipe.rootDir, path.resolve("."));
      assert.equal(recipe.environment.T3_PYCELLS_OWNER_PID, String(owner.pid));
      const child = spawn(process.execPath, [path.join(recipe.rootDir, "src/kernel-host/launch.cjs"), "--socket", recipe.socketPath, "--root", recipe.rootDir], { env: recipe.environment, stdio: "ignore" });
      launches.push(child);
      child.once("spawn", () => socket.end(JSON.stringify({ id: recipe.id, result: { pid: child.pid } }) + "\n"));
      socket.once("close", () => reader.close());
    });
  });
  let monitor;
  try {
    process.env.T3_THREAD_ID = endpoint.threadId;
    process.env.T3_PYCELLS_OWNER_PID = String(owner.pid);
    process.env.T3_PYCELLS_SOCKET = endpoint.socketPath;
    process.env.T3_PYCELLS_LAUNCH_SOCKET = path.join(folder, "launcher.sock");
    await new Promise(resolve => launcher.listen(process.env.T3_PYCELLS_LAUNCH_SOCKET, resolve));
    await Promise.all([ensureHost(endpoint, path.resolve(".")), ensureHost(endpoint, path.resolve("."))]);
    assert.equal(launches.length, 1);
    for (let i = 0; i < 2; i++) {
      const c = new KernelHostConnection(endpoint.socketPath); clients.push(c); await c.connect(endpoint.threadId);
    }
    assert.ok(clients[0].state.pid > 0);
    assert.equal(clients[0].state.pid, clients[1].state.pid);
    assert.equal(fs.existsSync(endpoint.socketPath + ".environment"), false);
    assert.equal(fs.existsSync(endpoint.socketPath + ".log"), false);
    await assert.rejects(clients[1].connect("another-thread"), /different T3 thread/);
    monitor = net.createConnection(endpoint.socketPath);
    await new Promise((resolve, reject) => { monitor.once("connect", resolve); monitor.once("error", reject); });
    const stopped = new Promise(resolve => monitor.once("close", resolve));
    const exited = new Promise(resolve => owner.once("exit", resolve));
    owner.kill("SIGTERM"); await exited; await stopped;
    assert.equal(fs.existsSync(endpoint.socketPath), false);
  } finally {
    clients.forEach(c => c.detach()); monitor?.destroy();
    if (owner.exitCode === null && owner.signalCode === null) owner.kill("SIGTERM");
    for (const child of launches) if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await new Promise(resolve => launcher.close(resolve));
    keys.forEach((key, i) => { if (original[i] === undefined) delete process.env[key]; else process.env[key] = original[i]; });
  }
});

test("real T3 delegated kernel resumes its namespace and notebook images match model images", {
  skip: process.env.PTC_TEST_REAL_RUNTIME !== "true",
}, async () => {
  const { loadSettingsFromEnv } = await import("../dist/utils.js");
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "pycells-headless-real-"));
  const owner = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const keys = ["T3_THREAD_ID", "T3_PYCELLS_SOCKET", "T3_PYCELLS_OWNER_PID", "T3_PYCELLS_LAUNCH_SOCKET"];
  const original = keys.map(key => process.env[key]);
  const managers = [];
  try {
    const threadId = "thread:delegated-task:command%3Amcp%3A11111111-1111-4111-8111-111111111111%3Adelegate-task%3A22222222-2222-4222-8222-222222222222";
    process.env.T3_THREAD_ID = threadId;
    delete process.env.T3_PYCELLS_LAUNCH_SOCKET;
    process.env.T3_PYCELLS_SOCKET = path.join(folder, "host.sock");
    process.env.T3_PYCELLS_OWNER_PID = String(owner.pid);
    const a = new RemoteKernelManager(loadSettingsFromEnv(), path.resolve(".")); managers.push(a);
    await a.attachOwner("transient-pi-a");
    const k = await a.provision({ name: "analysis", cwd: folder, notebookPath: path.join(folder, "analysis.ipynb") });
    assert.equal(k.name, "analysis");
    assert.equal(k.ownerSessionId, threadId);
    const result = await a.execForeground(k.id, "import matplotlib.pyplot as plt\nfrom IPython.display import display, Image\nimport base64\nvalue = 42\ndisplay(Image(data=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aNfkAAAAASUVORK5CYII=')))\nplt.plot([1, 2, 3], [1, 4, 2])\nvalue", { cwd: folder });
    assert.equal(result.images.length, 2);
    const snapshot = (await request(process.env.T3_PYCELLS_SOCKET, "notebookSnapshot")).result;
    assert.deepEqual(snapshot.kernels[0].cells[0].outputs.filter(o => o.kind === "image").map(({ kind, ...image }) => image), result.images);
    await a.disposeAll();
    const b = new RemoteKernelManager(loadSettingsFromEnv(), path.resolve(".")); managers.push(b);
    await b.attachOwner("transient-pi-b");
    assert.equal(b.list()[0].id, k.id);
    assert.equal(b.list()[0].name, "analysis");
    const resumed = await b.scratchRun(k.id, "value", { cwd: folder });
    assert.match(resumed.output, /42/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(folder, "analysis.ipynb"), "utf8")).cells.length, 1);
    await b.dispose(k.id);
  } finally {
    await Promise.all(managers.map(m => m.disposeAll()));
    owner.kill("SIGTERM");
    keys.forEach((key, i) => { if (original[i] === undefined) delete process.env[key]; else process.env[key] = original[i]; });
  }
});
