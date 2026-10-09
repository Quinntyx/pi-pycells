# Configuration reference

Everything `pi-pycells` does is configured through environment variables. There is no
settings file: the extension reads `process.env` once when it loads (`loadSettingsFromEnv`,
`src/utils.ts:63`), builds a `PtcSettings` object (`src/contracts/settings.ts`), and uses it
for the lifetime of the pi session. This page lists every variable, its type, its default,
and where it takes effect.

## What it does

One startup read turns your environment into the extension's entire configuration: execution
timeouts, output-preview sizing, which pi tools Python may call, auto-routing and recovery
behavior, kernel and library paths, and the optional pi-subagents integration. Kernels are
spawned with a copy of the extension's environment (`src/python-session-manager.ts` spawns
with `env: { ...process.env }`), so the same `PTC_*` variables are also visible inside
`exec_cell` cells, and the Python runtime reads some of them (`PTC_MAX_SPOOL_CHARS`) directly
as a fallback. Because settings are captured at extension load, changing a variable requires
starting a new pi session (or reloading the extension), not just setting it mid-session.

## How it works

- `loadSettingsFromEnv()` (`src/utils.ts:63-95`) maps each `PTC_*` variable to one
  `PtcSettings` field using three parsers:
  - **Booleans** (`parseBooleanEnv`): `1`, `true`, `yes`, `on` (case-insensitive) are truthy;
    everything else — including unset — falls back to the field's default.
  - **Positive integers** (`parsePositiveIntEnv`): invalid or non-positive values fall back
    to the default.
  - **Clamped integers** (`parseClampedIntEnv`): values outside the documented range are
    clamped, not rejected.
  - **Lists** (`parseListEnv`): comma-separated, trimmed; empty values are treated as unset.
- The resulting `PtcSettings` object is passed to the tool registry, session manager, sandbox
  manager, and panel code. No part of the extension reads a config file or pi settings store;
  environment variables are the only configuration surface.
- **Managed SDK source.** Register `git:git.quinntyx.dev/quinntyx/pi-subagents@dev`
  as a Pi package. The installed SDK supplies the runtime source. The fallback
  repository defaults to `https://git.quinntyx.dev/quinntyx/pi-subagents.git`
  on branch `dev`; `PTC_SUBAGENTS_REPO_URL` can select a different remote.
- **Managed SDK source.** Register `git:git.quinntyx.dev/quinntyx/pi-subagents@dev`
  as a Pi package. The installed SDK supplies the runtime source. The fallback
  repository defaults to `https://git.quinntyx.dev/quinntyx/pi-subagents.git`
  on branch `dev`; `PTC_SUBAGENTS_REPO_URL` can select a different remote.
- **No local development default.** The plugin does not probe an author-specific
  checkout. Installed managed SDK sources are used, with a remote `dev` cache
  fallback where required. Publish changes to remote `dev` and update with Pi.
- **Subagent agent-dir selection.** Spawned subagents run under the orchestrator's own
  agent dir by default (`PI_CODING_AGENT_DIR` else `~/.pi/agent`) — same config, extensions,
  and auth, zero setup. Set `PI_CODING_SUBAGENT_DIR` to any directory with a pi config
  (a pi-profiles-managed profile directory works) to give them a separate environment.
- **Venv and cache root under `~/.cache/pi-pycells`.** The provisioner creates
  `~/.cache/pi-pycells/python-env-3.14` (via `uv venv --python 3.14`; uv is required) and a managed
  `pi-subagents` clone there. Kernels always run on that venv's interpreter
  (`resolvePythonExecutable`, `src/sandbox-manager.ts`) — there is no system-python fallback.
  Set `PTC_PYTHON_EXECUTABLE` to pin your own interpreter; the target
  must be Python ≥ 3.10 (kernels fail fast otherwise).
pi agent-dir convention.** `PTC_LIBRARY_DIR`'s default assumes pi's
  `$PI_CODING_AGENT_DIR`/`~/.pi/agent` layout, and `PTC_EVALS_PATH`'s default `.pi/evals/ptc`
  assumes a pi project with that directory. Set either variable explicitly if your layout
  differs.
- **Sync stamp inside the extension clone.** The pi-subagents sync stamp lives at
  `<extensionRoot>/.ptc-subagents-sync.json`; because `pi update` resets package clones, each
  update triggers a fresh sync from whatever `PTC_SUBAGENTS_REPO_URL`/`PTC_SUBAGENTS_SOURCE`
  resolve to on your machine at that moment — keep those variables pointing somewhere you
  can reach.
