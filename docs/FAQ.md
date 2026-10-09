# FAQ

Answers grounded in clean-environment install tests (fresh `PI_CODING_AGENT_DIR`, no tmux, no pi-profiles) and failure-mode probes of this extension. File references point into this repo.

## Minimum working setup

Distilled from a verified clean install (pi 0.87.1, node v26, python 3.14, no `pi-profiles`, no `pi-tool-tree`):

1. **Install the extension:** `pi install git:github.com/Quinntyx/pi-pycells` (the normal way), or `pi install /path/to/repo` for a local checkout (clones to `<agent-dir>/git/github.com/Quinntyx/pi-pycells` and runs npm install there).
2. **Have `uv` on PATH — it is required.** uv provisions the Python environment (default CPython 3.14, downloaded automatically if missing) and powers on-demand package installs. No `npm install`/`npm run build` is needed for the extension itself — pi compiles the TypeScript at load and supplies its own runtime deps.
3. **Run pi** (TUI or `pi -p`) and ask the model to provision a kernel and run a cell. Verified headless: `provision_kernel({notebook: "..."})` → kernel id; `exec_cell("print(1+1)")` → `2`. Fresh-cache full session (install → venv → kernel → cell, incl. LLM call) took ~7.7s; warm cache ~5.6s.

No environment variables are required — but note there is **no sandboxing**: kernels run as plain host Python subprocesses (yolo mode only; VM-based checkpointing is planned).

---

## General

### Do I need pi-profiles?

No. There is no pi-profiles *package* dependency anywhere in pi-pycells, and kernels don't need profiles. Subagent spawning (via `pi_subagents`) runs spawned agents under the **orchestrator's own agent dir by default** (`PI_CODING_AGENT_DIR` else `~/.pi/agent`) — same config, extensions, and auth, zero setup. To give subagents a separate config, set `PI_CODING_SUBAGENT_DIR` to any directory with a pi config (a pi-profiles-managed profile directory works). Resolution lives entirely in pi-subagents.

### Does it work without tmux?

Kernels and cells work without tmux. Subagents still require their SDK transport setup.

### Does activity tracking require pi-tool-tree?

No. Pi-pycells bundles and loads pi-activity, an API-only extension, before registering its own tools. `withActivityLabel()` uses `globalThis[Symbol.for("pi-activity:api")]`. Subagent handles retrieve activity snapshots through pi-sock. A standalone subagents profile must install pi-activity alongside pi-sock; a profile with pi-pycells already receives both. Activity assignment is owned by pi-activity, and consumers should use its stable API rather than depend on labeling heuristics.

### Do I need to run `npm install` or `npm run build` before installing?

No. `package.json` declares `pi.extensions: ["./src/index.ts"]` and pi compiles the TypeScript itself at load time. A copied repo with **no `node_modules`** installed and ran fine — pi supplies `@mariozechner/pi-coding-agent`, `@mariozechner/pi-tui`, and typebox to extensions. `npm run build` is dev-only (and would fail without `npm i`, since `typescript` is a devDependency). Note: local-path installs load the package in place (settings.json stores the relative path, e.g. `"../repo"`); they do **not** copy it or run npm install. Git installs *do* run npm install inside the clone.

---

## First-run failures

### Why won't Python run after I install the extension?

The old `PTC_ALLOW_UNSANDBOXED_SUBPROCESS` startup gate was removed — there is no required opt-in anymore, and the extension starts out of the box. If Python still fails to run, check `uv` is on PATH (see the question below) and set `PTC_DEBUG=1` to see the `[PTC] Using subprocess runtime (no sandboxing substrate yet)` line at load.

### Is there any sandboxing or cell-level confinement?

No. Python cells run as a local subprocess and can spawn arbitrary child processes freely — `subprocess.run(['touch', ...])` inside a cell succeeds (rc 0). The extension currently only supports "yolo mode"; VM-based checkpointing is planned but complex and not implemented. No tools are gated — raw `subprocess`/`os.system` work (which is why gating the bridged `bash` tool was dropped as futile), and mutating tools are bridged too.

### Why does calling `bash(...)` in a cell raise `NameError: name 'bash' is not defined`?

Host tools are no longer bridged into Python. Use `subprocess` in a cell, or call the native `bash` tool from the parent agent.

### `provision_kernel` fails with a "PTC Python environment not found" error — what's wrong?

**`uv` isn't installed** (or provisioning failed). There is deliberately no system-python fallback: a silently-degraded interpreter reads as "the plugin is broken" instead of "my dependency is missing". Install uv and restart pi:

```
curl -LsSf https://astral.sh/uv/install.sh | sh
```

The startup `[PTC]` warning and `~/.cache/pi-pycells/subagents-sync.log` tell you exactly which step failed.

`PTC_PYTHON_EXECUTABLE` overrides the whole resolution — but note it's used verbatim with no existence check, so a bad value gives a crisp `spawn /nonexistent/python-xyz ENOENT` on kernel provisioning.

### Why does installing pi_subagents fail with a git auth error?

Once subagents are enabled (set `PI_SUBAGENTS_MAX_CONCURRENT`) the extension creates `~/.cache/pi-pycells/python-env-3.14` (`uv venv --python 3.14`; uv is required) and clones pi-subagents from the default `https://github.com/Quinntyx/pi-subagents` into `~/.cache/pi-pycells/pi-subagents`, then editable-installs it. If you point `PTC_SUBAGENTS_REPO_URL` at a repo that needs credentials, non-interactive git can't prompt and the clone logs something like:

```
fatal: could not read Username for '<host>': No such device or address
```

in `~/.cache/pi-pycells/subagents-sync.log`. The stamp `<pkg>/src/.ptc-subagents-sync.json` gets `"ok": false` and sync retries next session. **A one-line `[PTC]` warning now appears at startup** when provisioning fails (details in `~/.cache/pi-pycells/subagents-sync.log`). Kernels and sessions work fine; without provisioning, the first symptom is a later cell dying with `ModuleNotFoundError: No module named 'pi_subagents'`. If you point `PTC_SUBAGENTS_REPO_URL` at a private repo, make sure your git credential helper can read it.

A dev checkout at `~/docs/src/pi-subagents` (or `PTC_SUBAGENTS_SOURCE`) is preferred over the managed clone and skips git entirely.

### Why do I get `ModuleNotFoundError: No module named 'pi_subagents'`, and why doesn't the hint fix it?

See the previous two answers: provisioning failed (no python3/uv, clone failure, or the 24h sync stamp says "recently ok" so it was skipped). The error's built-in hint —

```
help: install it with provision_dependency('pi_subagents') then re-run
```

— is a dead end: **pi-subagents is not on PyPI** (pypi.org 404s), and `provision_dependency` just runs `uv pip install <name>` (`src/index.ts:540`). Instead, fix the sync: check `~/.cache/pi-pycells/subagents-sync.log`, fix git access or set `PTC_SUBAGENTS_REPO_URL`/`PTC_SUBAGENTS_SOURCE`, and start a new session (or delete the sync stamp to force a retry).

### What's the `.ptc-subagents-sync.json` stamp, and where does it live?

It throttles the pi_subagents sync to once per 24h (`PTC_SUBAGENTS_SYNC_INTERVAL_HOURS`). When pi loads the manifest-declared `src/index.ts`, `getExtensionRoot()` returns `__dirname`, so the stamp lands at `<pkg>/src/.ptc-subagents-sync.json` — *not* `<pkg>/` where the tracked file and comments assume. A recent `ok:true` stamp silently skips provisioning, which can make it look like nothing ran (empty cache dir) even though the code is fine. A stale, git-tracked root-level stamp with a machine-specific `editablePath` ships with non-git copies of the repo and can suppress provisioning or point at a nonexistent path — deleting it forces a fresh sync.

### Why do I get 429 provider errors on first run?

Not extension-related. With a fresh `PI_CODING_AGENT_DIR` and no model auth, pi falls back to a default provider and 429s. One tested gotcha: with `PI_CODING_AGENT_DIR` set, custom providers must go in `$PI_CODING_AGENT_DIR/models.json` (root) — a copy to `agent/models.json` is silently ignored; `auth.json` is picked up from either place.

---

## Runtime behavior

### Which environment variables does it read?

See [configuration.md](configuration.md) for supported notebook, recovery, output and subagent settings. Former bridge allowlists, concurrency and auto-routing flags are removed.

### What happens if I set a nonsense value for a `PTC_*` variable?

Supported numeric and boolean settings use documented fallback/clamping rules. Retired bridge settings are ignored and cannot re-enable host-tool calls.

### Why does my cell keep getting interrupted with `KeyboardInterrupt`?

`PTC_EXECUTION_TIMEOUT_MS` is an **idle/silence** timeout that re-arms on every interpreter frame (`src/python-session-manager.ts:443-467`) — not a wall-clock cap. Tiny values fire almost immediately: `PTC_EXECUTION_TIMEOUT_MS=1` made `time.sleep(2)` die instantly with `KeyboardInterrupt: chunk execution was interrupted`, and the model then retried for 4 minutes, dragging a 3-second question out to 4m07s. Keep it at or above the 270 000 ms default.

### Why is my cell output truncated?

Cells producing more than `PTC_OUTPUT_PREVIEW_CHARS`/`PTC_MAX_OUTPUT_CHARS` (default **12 000** chars) come back as a head/tail preview with a pointer, e.g.:

```
... 1 lines hidden (50004 of 50048 chars) — full output: read_cell_output(cellIdx=1)
```

Full output is persisted in the notebook and readable via `read_cell_output(cellIdx, offset?, limit?)` (max 2 000 lines / 50 KB per call; `PTC_MAX_SPOOL_CHARS` = 10 M chars is only an emergency capture valve). Other fixed limits: 4 Python sessions max, 8 parallel nested tool calls, 270 s idle timeout, `PTC_AUTO_ROUTE=true`, `PTC_AUTO_RECOVER=false`.

### Do kernel variables survive between pi sessions?

No. A second pi session on the same notebook got `NameError: name 'persistent_value' is not defined`. The `.ipynb` notebook (with outputs) does persist on disk, so history is recoverable via `read_cell_output`. Kernel processes die with the session (`handleSessionShutdown` → disposeAll + cleanup, SIGTERM→SIGKILL on detached process groups; verified no orphan python processes after headless runs).

### My kernel hangs when I use `subprocess` in a cell — why?

Children spawned from a cell inherit the interpreter's RPC pipes. Any child that reads stdin or writes to stdout can corrupt the protocol and hang the kernel. Always pass `stdin=subprocess.DEVNULL, capture_output=True` (see [Python execution boundary](python-runtime.md)).

### Which host tools can my Python code call, and how do I get more?

None. The bridge has been removed. Use standard Python libraries or invoke native Pi tools outside the cell.

### Where does the notebook library live?

`$PI_CODING_AGENT_DIR/pycells-library` (override with `PTC_LIBRARY_DIR`). Gotcha: a nonstandard `PI_CODING_AGENT_DIR` silently moves it. Note the directory is **not** created at startup — nothing appears there until you use the promote/flow features.

---

## Housekeeping

### How do I clean up kernels?

- **From the TUI:** `/ptc kill [session_id]` (also `/ptc interrupt`, and `stop` is accepted as a synonym for interrupt). Session end kills kernels automatically.
- **Manually:** stray kernels run as `<cache>/python-env/bin/python -u -c ...` in their own process group — `pkill -f 'python-env/bin/python'`.
- **Subagent leftovers:** kill tmux windows (`tmux kill-window`) or, for an isolated test server, `tmux -L <name> kill-server`.

### How do I fully uninstall / clean up a test environment?

Remove all of these (tested paths):

- The extension: `pi remove <pkg>` (e.g. `pi remove git:github.com/Quinntyx/pi-pycells`, ~0.3s), and the `"packages"` entry it wrote in `settings.json` for local-path installs.
- `PI_CODING_AGENT_DIR` tree (e.g. `/tmp/.../pi-home`) if you used a throwaway one.
- `$HOME/.cache/pi-pycells` — the venv, the managed pi-subagents clone, `subagents-sync.log`, and the lock file.
- `$HOME/.pi/agent/profiles/subagents` if you gave subagents their own pi-profiles-managed profile via `PI_CODING_SUBAGENT_DIR`.
- The repo copy, test notebooks, and `$HOME/.pi/pi-sock` sockets.

Verified no orphans remained after cleanup (`ps aux` for `python-env/bin/python` came back empty).

---

### Known documentation/behavior mismatches

For the record (tracked in `BUGS.md`): the `ModuleNotFoundError` recovery hint used to recommend a PyPI package that doesn't exist (fixed); blocked tools surface as bare `NameError`s with no policy hint; nonsense env values are silently accepted; and the sync stamp lands in `<pkg>/src/` under production loading, not `<pkg>/` as the tracked file assumes.
