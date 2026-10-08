# pi-pycells

A persistent Python notebook runtime for [Pi](https://github.com/earendil-works/pi), with **optional parallel subagent orchestration**. Explore data, author code and markdown cells, rerun a notebook from a clean kernel, and save working notebooks as reusable workflows. Enable the subagent integration to coordinate multiple Pi agents from a cell, with each agent visible in its own tmux window.

Cells run on embedded IPython: imports, variables, and definitions survive across cells and conversation turns, with top-level `await`, Jupyter-style expression output, magics, and rich display output.

**Terminology:** a **kernel** is the Python interpreter, a **notebook** is the
`.ipynb` file a kernel records, and a **session** is the Pi conversation itself.
Kernels are addressed by human-readable names you choose at provisioning; the
session is never a kernel argument.

> **No sandbox.** Kernels run with your user permissions and full file, network, and subprocess access. Only execute code you trust. An approval prompt is not a security boundary.

## Install

First, make sure Pi can answer a normal prompt and that [`uv`](https://docs.astral.sh/uv/) is on your PATH.

```bash
pi install git:git.quinntyx.dev/quinntyx/pi-pycells@dev
```

For subagent orchestration, install the Python runtime as a separate Pi package:

```bash
pi install git:git.quinntyx.dev/quinntyx/pi-subagents@dev
pi update --extensions
```

Both packages track remote `dev`. After pushing changes to `pi-subagents/dev`,
`pi update --extensions` refreshes its installed package even when `pi-pycells`
has not changed. Restart Pi afterward; fresh kernels import the updated runtime.
No `~/docs/src` checkout or local runtime-loader extension is needed. The package
exports its installed location; children retain the parent's already-pinned
runtime without updating or installing anything.

Restart Pi after installing, then try:

```bash
pi -p "Create a Python kernel, execute a cell containing 1 + 1, and show the result."
```

To remove the package:

```bash
pi remove git:git.quinntyx.dev/quinntyx/pi-pycells@dev
```

### Requirements

- **Pi and a compatible Node.js runtime.** Follow Pi's current runtime requirements.
- **uv.** Provisions Python environments and installs dependencies. The default interpreter is CPython 3.14; it is downloaded automatically if needed. IPython is provisioned into kernel environments.
- **Subagents only:** `git` and [tmux](https://github.com/tmux/tmux). `pi install` installs and loads [pi-sock](https://github.com/Quinntyx/pi-sock) with pi-pycells; agents using the same Pi configuration inherit it. A separate subagents configuration needs pi-sock installed there too (see below). The `pi_subagents` Python module is provisioned when subagents are enabled.

The package includes three skills: **notebook-workflow** for authoring and handover, **pycells-library** for reusable notebooks, and **pi-subagents** for orchestration.

## Notebook workflow

Describe the artifact you need:

```text
Analyze data/events.json and create analysis.ipynb with a summary chart,
markdown explaining the findings, and cells that run top-to-bottom.
```

Pi provisions a kernel once, explores with scratch cells, then writes and runs notebook cells individually. A typical tool sequence is:

```text
provision_kernel({ name: "analysis", notebook: "analysis.ipynb" })
# Every other tool takes kernel: "analysis" to target this kernel by name.

write_cell({ kernel: "analysis", at: 1, type: "markdown", source: "# Event analysis" })
write_cell({ kernel: "analysis", at: 2, source: "from pathlib import Path\nimport json\nrows = json.loads(Path('data/events.json').read_text())\nlen(rows)" })
run_cell({ kernel: "analysis", n: 2 })
```

Use ordinary Python libraries inside cells. For example, `pathlib` handles files, pandas handles tabular data, and matplotlib produces plots. Use Pi's normal tools separately for host-side work.

### Naming and targeting kernels

- `provision_kernel` requires a **nonempty, unique `name`** (trimmed; control and
  terminal escape characters are rejected). Names must be unique among live
  kernels, and provisioning fails on a duplicate.
- Every other public tool requires **`kernel: "name"`** and resolves it by the
  human-readable live-kernel name. There is no implicit most-recent kernel:
  omitting `kernel`, or naming a kernel that is not live, is an error.
- There is no global discovery tool; `list_kernels` has been removed. You know
  the names you provisioned, and each result names its kernel.
- Internal kernel UUIDs may exist for protocol bookkeeping, but they are never
  shown in the terminal UI; tool calls and results are labeled with the kernel's
  name and notebook instead.

### Choosing an operation

| Tool | Purpose |
|---|---|
| `provision_kernel` | Start a persistent kernel bound to a notebook. Requires a unique `name`; accepts an optional source workflow and Python version. |
| `scratch_run` | Explore in the named kernel's live namespace without recording a notebook cell. |
| `write_cell` | Add or replace a code or markdown cell without executing it. Replacing a cell clears its stored outputs. |
| `run_cell` | Execute an existing code cell and refresh its outputs. The usual loop is **write one cell, run one cell**. |
| `exec_cell` | Execute proven code and append it as a new cell inside the named kernel; also accepts a Python file. |
| `request_cell_review` | Preview a saved code cell of the named kernel for user review without executing it. Takes only `kernel` and the cell position `n`. |
| `read_cells` / `read_cell` / `delete_cell` | Inspect and curate the notebook document. |
| `reset_kernel` | Restart the interpreter with an empty namespace, leaving the notebook intact. |
| `run_to` / `run_all` | Execute through a chosen position or the whole notebook, stopping at the first error. |
| `inspect_kernel` | Inspect a named kernel's namespace. |
| `read_cell_output` | Page through a cell's full persisted output. |
| `provision_dependency` | Install a Python distribution into a named kernel's environment. There is no global-environment fallback. |

**Notebook positions and execution counts are different.** Editing a cell does not update the live namespace or rerun dependent cells. Before handing over a notebook, reset the kernel and run all cells to check it from a clean state.

Every recorded execution updates the standard `.ipynb` on disk, including outputs and errors. Open it in Jupyter or an editor at any time. Omit `notebook` for throwaway work: the destination is reported alongside the kernel's name. Use an explicit project path for an artifact worth keeping.

### Output and rendering

- Every tool call and result is labeled compactly with the **kernel's name and
  its notebook**, so multi-kernel conversations stay readable at a glance.
- Model-only instructional prose and opaque internal identifiers are not
  rendered; the terminal shows kernel/notebook identity, cell positions, and
  results.
- Syntax-highlighted **In** boxes and numbered **Out** boxes render cells in the terminal.
- Live output streams below the executing cell; long output shows a preview while the full result stays in the notebook.
- Rich display output, including images, is captured in the notebook.
- `request_cell_review` asks the user to review a **saved cell** of the named kernel; execution is a separate call. Reviewed workflows use `write_cell` → review the saved cell → `run_cell`. **Esc** interrupts a running cell without disposing the kernel.

More: [kernels and document operations](docs/kernels.md).

## Reusable notebook library

> **Experimental:** the library and promotion interface may change.

Promote a finished notebook with `promote_to_skill_notebook({ kernel: "analysis", name: "event-analysis" })`. Promotion promotes the named kernel's **bound notebook** — it does not accept an unrelated external notebook path. It copies code, markdown, outputs, and metadata into the library; it does not modify the source notebook. Existing entries are only replaced with explicit overwrite permission.

Start future work with `provision_kernel({ name: "next-analysis", source: "event-analysis", notebook: "next-analysis.ipynb" })`. The source is copied and its code cells run before new work begins. Notebooks retain their recorded Python version, with an explicit `version` override available when provisioning.

The default library is `~/.pi/agent/pycells-library/`. Pi honors `PI_CODING_AGENT_DIR`, so the agent-directory path follows your configuration.

More: [notebook library](docs/notebook-library.md).

## Optional subagent orchestration

Enable subagents before starting Pi:

```bash
export PI_SUBAGENTS_MAX_CONCURRENT=8
pi
```

The positive value caps concurrency and enables background provisioning of `pi_subagents` into the shared Python environment. Without it, notebook work still functions and no subagent module is downloaded.

Cells can import `pi_subagents`, create an `AgentPool`, submit tasks to stages, and collect results in completion order. Each agent is a real Pi instance in a tmux window, visible and steerable while it works. Keep constants/prompts, task construction/data flow, and teardown in separate recorded cells. Failures raise at handle waits or `pool.pop()`; inspect the surviving pool before continuing. A dedicated `pool.close()` cell disposes the agent windows and reports the pool summary.

### Default configuration

Agents share your current Pi configuration by default. Installing pi-pycells also installs and loads **pi-sock** (agent communication) and **pi-activity** (activity tracking API). No separate installation is needed in this case, and **pi-tool-tree is not required**. If your configuration already loads standalone copies of these extensions, disable those copies with `pi config` to avoid duplicate loading; keep the copies supplied by pi-pycells enabled.

### Opt-in recursion

The default `PI_SUBAGENTS_MAX_DEPTH=1` keeps orchestration flat: the root is depth 0 and its children are depth 1. Set `PI_SUBAGENTS_MAX_DEPTH=2` before starting Pi to permit grandchildren, or `3` to permit another generation. A task must still explicitly authorize nested work. Importing `pi_subagents` is legal at the maximum depth; only spawning is blocked. Depth must be a nonnegative integer and the maximum a positive integer; malformed values fail rather than bypass the policy.

Recursive workflows share one root admission budget across all kernels and descendants. `PI_SUBAGENTS_MAX_CONCURRENT` remains a **per-process** cap. Immutable root limits are `PI_SUBAGENTS_ROOT_MAX_CONCURRENT` (live windows, default the process cap), `PI_SUBAGENTS_ROOT_MAX_TASKS` (window admissions/reopens, default 512, not all conversation turns), and `PI_SUBAGENTS_ROOT_TIMEOUT` (root deadline, default 1800 seconds, bounding admissions and waits). Independent workflows from the same primary Pi voice share these limits, not a fresh budget per pool. A new kernel does not renew exhausted admissions or the root deadline; start a new root Pi process for a new budget.

A parent awaiting children still occupies a live window. When root capacity is saturated, recursive admission **fails fast** rather than deadlocking behind that parent. Plan descendant headroom. Retained failure windows remain charged until explicit close confirms termination; a Python launcher's exit does not release a live-window permit. Only successful validated dormancy unloads automatically. Cancellation and close recursively terminate owned descendants, never the caller or unrelated panes.

Children must use the parent's existing compatible interpreter and `pi_subagents` source. The launcher explicitly forwards `PTC_PYTHON_EXECUTABLE` and `PTC_SUBAGENTS_SOURCE` through tmux's child environment, alongside root identity and immutable limits; Python environment changes are not automatically inherited by tmux windows, and launch reasserts the pinned values after shell startup. Spawn waits for root runtime readiness before forwarding those paths. Children do not sync repositories, bootstrap venvs, run installers, or take provisioning locks. An incompatible requested Python version fails explicitly without fallback.

The in-process PTC runtime subscription API emits local kernel snapshots with session/root identity. It does **not** relay descendant snapshots across processes through pi-sock, and local totals are not a root-wide telemetry aggregate.

### Separate subagents configuration

Set `PI_CODING_SUBAGENT_DIR` to a separate Pi agent directory for a leaner extension set or a different default model. **That configuration must load pi-sock and pi-activity** to provide agent communication and activity snapshots: installing pi-pycells in the main configuration does not install extensions into a separate profile. For an existing standalone subagents configuration, install both there:

```bash
# Replace this path with your subagents profile's Pi agent directory.
PI_CODING_AGENT_DIR=/path/to/subagents pi install git:github.com/Quinntyx/pi-sock
PI_CODING_AGENT_DIR=/path/to/subagents pi install git:git.quinntyx.dev/quinntyx/pi-activity
export PI_CODING_SUBAGENT_DIR=/path/to/subagents
```

If pi-pycells is installed in that configuration too, it already supplies both extensions; you do not need the separate installs. Make sure the selected configuration has working model credentials. Unless you explicitly select a model, agents use that configuration's default; [pi-profiles](https://github.com/chaychoong/pi-profiles) can manage these directories but is not required.

### Activity API

[pi-activity](https://git.quinntyx.dev/quinntyx/pi-activity) is a bundled, API-only dependency: it does not replace Pi's renderers. Pi-pycells loads it before registering its tools. Other extensions can query the stable API directly:

```js
const activity = globalThis[Symbol.for("pi-activity:api")];
const snapshot = activity?.getActivity();
```

For a subagent, `handle.activity()` retrieves its activity snapshot through pi-sock. Activity snapshots expose the current phase, label, running calls, and timing data. Label assignment is owned by pi-activity and may evolve; consumers should use the API rather than infer activities from tool names, prose, or rendering. See the [activity API reference](https://git.quinntyx.dev/quinntyx/pi-activity/src/branch/main/API.md).

More: [subagent setup](docs/subagents.md) and the bundled [pi-subagents skill](skills/pi-subagents/SKILL.md).

## Documentation

- [Notebook workflow skill](skills/notebook-workflow/SKILL.md): cell discipline, markdown narrative, and clean-kernel handover.
- [Kernels](docs/kernels.md): lifecycle, IPython semantics, document operations, and interrupts.
- [Notebook library](docs/notebook-library.md): promotion, sourcing, and version pinning.
- [Subagents](docs/subagents.md): provisioning and orchestration setup.
- [Configuration](docs/configuration.md): runtime and environment settings.

Some configuration names and older reference pages retain terminology from the original tool-calling extension. This README describes the notebook-focused workflow.

## Credits and license

Derived from [edxeth/pi-ptc-next](https://github.com/edxeth/pi-ptc-next), itself a fork of [cegersdoerfer/pi-ptc](https://github.com/cegersdoerfer/pi-ptc) by Chris Egersdoerfer.

MIT
