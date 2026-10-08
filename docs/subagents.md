# Subagent orchestration (`pi_subagents`)

## What it does

The subagent feature lets the model fan work out to multiple real pi instances — active agents run interactive pi sessions in tmux windows — and orchestrate them from Python cells: queue tasks in typed stages, consume results in completion order, steer or continue agents, and chain multi-stage build/review/fix loops. Successfully validated sessions may hibernate between turns; failed or interrupted sessions remain available for inspection until explicit cleanup. The orchestration API (`pi_subagents`) is a Python module that is provisioned automatically on session start and auto-imported into every PTC kernel, while the TypeScript side of the extension renders a live panel of what every spawned agent is doing and summarizes finished runs into the transcript.

## How it works

**Provisioning.** `pi_subagents` is *not* part of the npm install. At extension startup (unless `PI_SUBAGENT_DEPTH` is set), `ensureSubagentsEnv` runs fire-and-forget (`src/index.ts:1640-1644`, `src/subagents-env.ts`):

1. Ensures a venv at `~/.cache/pi-pycells/python-env-3.14` exists (`uv venv --python 3.14`; uv is required, no fallback). Kernels always run on this venv's interpreter, even for users who never touch subagents.
   **Provisioning only runs when `PI_SUBAGENTS_MAX_CONCURRENT` is set** — subagents are opt-in; without it nothing is downloaded and cells importing `pi_subagents` get a hint explaining how to enable them.

Syncs are throttled by a stamp file, `<extensionRoot>/.ptc-subagents-sync.json`, that lives *inside this package's clone* — so `pi update` (which resets package clones) forces a fresh sync on the next session start. Between updates the interval defaults to 24 hours (`PTC_SUBAGENTS_SYNC_INTERVAL_HOURS`). A failed stamp with the runtime still missing retries immediately. Syncs are serialized by a pid-tagged lock file (dead holders' locks are broken; legacy timestamp locks use a 5-minute age heuristic), and all output goes to `~/.cache/pi-pycells/subagents-sync.log` (rotated at 1 MB).

**Import and depth.** The kernel prelude auto-imports the module as both `pi_subagents` and `subagents` (`src/execution/session-prelude.ts:37-52`). When `PI_SUBAGENT_DEPTH` is set (pi's convention for spawned subagents), the autoimport is skipped; the import itself raises `NotImplementedError` at depth ≥ 1, and the extension adds a system-prompt note telling the agent that spawning is unavailable but `exec_cell` still works (`src/index.ts:1534-1544`). Spawned agents can never spawn agents.

**Runtime.** Each `subagents.Task` becomes a real interactive pi process in a tmux window titled `pi - (subagent) <name> - <cwd>`, prompted over a per-agent unix socket. Spawned agents run under the orchestrator's agent dir by default, or `PI_CODING_SUBAGENT_DIR` when set (see Configuration). Progress flows back as `subagent_state` frames over the kernel's RPC pipe (`src/python-runtime/session.py:32-36`), fans out through the session manager to:

- A **live panel** under the running cell (`src/execution/subagent-panel.ts`): **Working** lists every running/starting agent without an entry cap; **Queued** follows below, showing up to 4 entries normally or 12 when expanded, plus the hidden queued count. Idle and terminal sessions remain in the aggregate totals rather than occupying working entries. The full-width background matches the enclosing Out block (pending, successful, or failed).
- A **status footer** — `subagents: ● N running · ✓ M done` — filtered to agents relevant to the current exec (`src/index.ts:1459-1488`).
- A **per-cell `subagents:` summary** in the exec-done report, built defensively so a broken registry can never break cell reporting (`src/python-runtime/session.py:407-443`).
- A **transcript notification** (customType `subagent-notification`) persisting the finished fan, since collapsed tool results would otherwise erase it (`src/index.ts:1240-1250`).
- A **global API** on `globalThis[Symbol.for('pi-ptc:subagent-runtime')]` with `getSnapshot()` / `subscribe(fn)` for external UI consumers (`src/index.ts:1413-1457`).

## Usage

Read the bundled [pi-subagents skill](../skills/pi-subagents/SKILL.md) for
workflow review and cleanup policy. Use separate recorded cells for constants,
task construction and data flow, and teardown. Author the opening workflow
with `write_cell`, submit the saved cell to `request_cell_review`, and execute
it with `run_cell` after approval. Explicit no-prompt/autonomous requests skip
review, not recorded cells. There is no review flag on execution; ordinary
repairs within approved scope do not need another review. Keep the pool open
for inspection; close it in a dedicated final cell, not a workflow-wide
`finally` or error handler. Trivial fixtures may use a context manager, which
closes on clean exit but leaves the pool alive on exceptions.

Record an **approved baseline** before launch: objective and permissions, actual
checkout paths, revision and approved uncommitted-change identity, an immutable
snapshot or path/digest manifest (not only a branch name), input roster,
prompt/schema versions, command/resource ownership, checks, limits, model
requests, and termination condition. A handoff identifies the producing
task/result, source checkout/baseline, changed path/artifact digests, acceptance
evidence, integration target, outstanding blockers, and receiving owner. Reject
unexplained baseline drift and reconcile it before integration. Approval is not
a code hash, but it does not silently authorize changed inputs or effects.
Materially new targets, permissions, destructive effects, or cost require renewed
review unless already authorized by the user's autonomy request.

On replay or resumption, inspect the live pool and notebook before submitting.
Reuse the existing open pool only when its recorded identity matches the current
workflow; do not duplicate queued/running units or treat stale outputs as evidence
for changed inputs. Cached completion is reusable only when all required outcomes
and checks passed for the same baseline, prompts, paths, schemas, limits,
resource ownership, and integration state. Schema-valid blocked reports are
not accepted deliverables or successful replay entries.

### Completion-driven scheduling and queue headroom

Let **C = `PI_SUBAGENTS_MAX_CONCURRENT`** (currently 8 in the agreed workflow).
It limits active turns across pools in the Python process, not the number of
submitted tasks, queued handles, or retained failed sessions. Pool concurrency
may be smaller than C. A handle can be marked `starting` while waiting for
process-wide capacity; counting every `starting` status is not proof that C has
been exceeded. This is not a cross-kernel coordinator or provider admission
policy.

- Decompose work into small, bounded units with explicit acceptance checks.
  Maintain ready headroom around **3C** when useful (about 24 ready units for
  C=8), so replacements are available without waiting for a whole wave. This
  is a planning target, not a required minimum or runtime queue limit. A
  queued roster is not active concurrency; do not pad it with speculative or
  dependency-blocked tasks just to reach the target. Bound the frontier to useful
  independent deliverables and drain it when the objective is covered; headroom
  is not a reason to manufacture tail work.
- Submit independent ready work, then consume `await pool.pop(...)` in
  **completion order**, routing each result and replenishing ready work
  immediately. Do not await submissions in roster order or insert batch
  barriers while independent work is available. Split slow, oversized units
  rather than leaving most slots idle behind one straggler.
- Stage `slots` are soft priority reservations, not hard per-stage caps.
  Their sum cannot exceed pool concurrency. Give downstream review/verification
  stages **positive reservations** when they need prompt service (for example,
  implementation/review/verification slots of 6/1/1 at pool concurrency 8).
  The runtime permits zero slots, but zero supplies no reserved priority under
  sustained upstream load. With smaller pools, combine stages or adjust the
  allocation rather than exceed the cap. A stage with ready work can borrow
  idle capacity from another stage: this is work-conserving stage scheduling
  (work stealing), not permission for an agent to take another writer's files.
- Use one completion consumer per pool. Gate dependent review, integration,
  and follow-up work on the required handoffs and acceptance evidence, not just
  a settled status or schema-valid response. The parent records **passed,
  failed, or not-run (with reason)** for each required check. Failure, missing
  evidence, cancellation, unresolved blockers, or a mismatched baseline keeps
  dependent acceptance/integration blocked. Route authorized bounded repair
  or evidence-gathering tasks instead of launching agents to wait on blockers.
  Keep every review/fix cycle bounded by an explicit `metadata["rounds"]` limit;
  enqueue only ready continuations.
  `pool.pop()` returning `None` means quiescent, not closed or necessarily
  that the user's overall objective passed.

### Prompt contracts and workspace ownership

Every prompt identifies the task, `Task.cwd`, approved baseline/handoff,
allowed files or read-only audit scope, command/resource ownership, forbidden
effects, satisfied prerequisites, acceptance checks, timeout, response schema,
and escalation instructions. Require paths/lines, check outcomes and scope,
snapshot assumptions, blockers, risks, and actionable parent follow-ups. Require
explicit **complete or blocked** deliverable status and evidence that distinguishes
**passed, failed, and not-run with reason**; a schema-valid report is not proof
that its objective or checks passed. Ask agents to finish
their bounded unit and report blockers rather than wait for other agents. Set
explicit task budgets; unavailable providers may otherwise wait out the default
30-minute settle timeout. Spawned agents cannot spawn agents; orchestration stays
in the parent.

Shared-workspace writers must have **disjoint file ownership**. Assign source
and test authors separate files; readers must report evolving snapshot
assumptions rather than treat intermediate edits as final changes. Ownership
also covers **shared resources and command effects**, not just named source
files: formatters, generators, tests/builds, caches, output directories, locks,
sockets/ports, databases, and long-lived processes can conflict even when source
paths are disjoint. Give each conflicting command/resource one owner, isolate
its outputs when authorized, or serialize it. A read-only audit must not quietly
run a command that writes shared state. Specify permitted commands/check scope
and who owns integration, full-suite execution, and cleanup before launch.

Possible overlaps require separately authorized worktrees or serial execution;
worktrees do not automatically isolate external resources. Record a bounded
allocation/resource budget and allocate lazily from the approved baseline when
work becomes ready, not one worktree per queued entry. Reuse only inspected,
compatible workspaces; retained failed workspaces still count against the budget.
Agents must not create or manipulate worktrees, git state, configuration,
dependencies, or another writer's files without permission. If ownership cannot
safely be separated, report affected tasks blocked instead of launching conflicting
work; unaffected ready work may proceed. Keep integration dependency-gated and
in the parent or an explicitly owned integration task. These rules apply
regardless of available scheduling capacity.

### Current dev API

For dev work, the designated checkout is authoritative; cross-check its public
signatures against `help(subagents.Task)` and `help(subagents.AgentStage.submit)`
in the actual kernel rather than copying older examples. Report a checkout/import
mismatch instead of changing profiles, installed copies, dependencies, or the
environment without permission. The dev checkout's continuation API is
**`stage.submit(..., session_handle=...)`**, not `Task.resume_from`; the agent-directory keyword is **`Task.agentDir`**, not
`profile`. Set `Task.cwd` explicitly rather than instructing a directory change
in the prompt.

- `work.submit(task)` returns a queued handle immediately;
  `work.submit_all(tasks)` queues a roster without increasing active capacity.
- `await handle`, `handle.wait(timeout=...)`, and
  `await handle.wait_async(timeout=...)` return a successful `AgentResult` or
  raise the underlying task exception.
- Successful results expose `sequence`, `task`, `stage`, `handle`, `body`,
  `status`, `duration_ms`, and `parent`. Schema-task bodies are validated Python
  dictionaries; read their fields directly, without JSON parsing or `.unwrap()`.
  There is no `result.ok` flag or `fail_fast` option.
- `await pool.pop(timeout=...)` raises `AgentPoolFailureError` for a failed
  completion: `.result` identifies the task/handle and `__cause__` is the
  original exception. That completion has been consumed; remaining results
  stay queued. Record it exactly once, even if also observed by awaiting its
  handle. Before execution, declare narrowly recoverable task/stage identities,
  exact allowed cause types, containment conditions and required accounting,
  or let all task exceptions propagate. Catch the wrapper only around an
  individual `pop()` and match that policy, not a broad exception base. Retain
  diagnostics/workspace, block dependents and replenish unaffected ready work
  only when the failure is contained. Unexpected causes, baseline/resource
  uncertainty, scheduler errors and interruptions propagate; no automatic retry
  is added. A pop timeout is not a completion and must not increment outcome
  counts. Report `status="cancelled"` separately; cancellation is not a successful
  dictionary response.
- Invalid structured output gets the actual parse/schema error in up to three
  existing repair follow-ups. Exhaustion raises `SchemaValidationError`;
  invalid JSON is never a successful schema-task body. Hibernation does not
  add retries or change this validation policy.
- Inspect `handle.state()`, `handle.agent_state()`, `handle.get_session()`,
  `handle.activity()`, or `await handle.activity_async()`. Cached inspection and
  durable session identity/path remain available after hibernation; inspection
  must not reopen a dormant agent. `pool.snapshot()` and `pool.handles(status={...})` expose
  pool progress. Activities are relayed from pi-activity through pi-sock;
  label-assignment policies can evolve independently.
- For an explicitly configured continuation, use
  `stage.submit(new_task, parent=result, session_handle=result.handle)`.
  It produces a **new handle/result**, preserving the old completion. Omitted
  model/thinking/cwd/agentDir inherit the session; conflicting configuration
  raises `SessionReuseError`. Only one queued/running continuation may own a
  session. `session_name=...` changes the Pi session display name, not the tmux
  placement identity.
- `parent=result` carries metadata forward; explicitly supplied child keys
  override it. Root `rounds` defaults to zero; inheritance does not reset or
  automatically increment it. Increment rounds deliberately for a new cycle,
  and enforce the round cap in the parent.
- Inherit the configured agent-directory model default unless the user names
  a model; resolve named models through the catalog helpers. Translate selected
  result fields into readable findings and actions before the next prompt,
  never a raw JSON/dictionary dump.

### Success-only hibernation, sending, and cleanup

Automatic unloading is **only** for successfully validated tasks whose last
terminal outcome is `ok`. Here `ok` describes the runtime outcome, not a public
`AgentResult.ok` property. Eligibility also requires an idle agent with no pending
messages, a durable transcript with a successful terminal assistant outcome, and
safe window unloading. Hibernation is best-effort; failed inspection or unloading
may leave the successful session live without turning its result into a failure. The handle
retains session identity, the persisted session path, and cached inspection.
Hibernation is not `pool.close()` and does not invalidate results or erase
completion accounting. Runtime success/dormancy does not imply semantic
acceptance: a schema-valid blocked report must still hold downstream gates.

Failed, crashed, cancelled, timed-out, schema-exhausted, or interrupted sessions
are **not automatically unloaded**. Leave surviving Pi/tmux sessions available
for manual inspection and continuation; a crashed process cannot be resurrected
merely by keeping its handle. A cell interrupt, task failure, or pop timeout is
not permission to close the pool. `AgentPoolTimeoutError` leaves work intact;
inspect its `.pool`/`.snapshot`, then continue in a later recorded cell.

`handle.send(text)` and `await handle.send_async(text)` have two roles:

- While the agent is active, they steer its current turn (default
  `mode="steer"`; existing transport modes remain available).
- On a settled, failed, or cancelled handle **with a retained session**, they
  submit a **new pool-scheduled prompt**, rather than steer a completed turn.
  A retained live session continues in place; **only a dormant session** is
  transparently reopened with `pi --session` using its saved path, and only
  **after pool capacity is acquired**. A queued cancellation or startup failure
  with no retained session cannot be continued this way. A dead retained
  non-dormant process is not automatically respawned. Do not manually spawn or
  reopen agents to bypass C.

On terminal handles, the returned dictionary is a **scheduling receipt**, not
an agent reply or completed outcome: `{"scheduled": True, "handle": new_handle,
"handleId": new_handle.id, "status": "queued"}`. Await `receipt["handle"]` or
consume its new completion with `pool.pop()`; do not await the old settled handle
expecting the new answer. `"queued"` is an acknowledgement, not a fresh live-state
snapshot (dispatch may already have begun). Active sends retain the transport's
acknowledgement shape and do not create an independent completion.

Scheduled sends preserve the source handle's stage/name and task's schema,
timeout and metadata, with its result as `parent`; they do **not** increment
`rounds`. Use explicit `stage.submit(..., parent=..., session_handle=...)` when
changing metadata, schema, stage routing, or a review/fix cycle's round counter. The new
handle/completion is separately accounted; the old result remains unchanged.
Continuation exclusivity applies across all handles sharing the session: do not
race `.send()` against another queued/running continuation. Inspection alone
does not submit a turn or consume active capacity.

Spawn/reopen placement targets the **stable tmux session ID**, not a cached
session name: renaming the containing tmux session must not break subsequent
spawns. This is separate from renaming a Pi session with `session_name`.

After inspecting results and any failed sessions, call synchronous
`pool.close()` in the dedicated teardown cell. It invalidates handles and
closes retained live windows; inspect its returned `PoolSummary`.
`subagents.finish()` closes all live pools and returns their count. Retain
notebook reports, failed workspaces and generated evidence; pool teardown does
not authorize filesystem/worktree deletion or other cleanup without separate
explicit permission. Neither automatic success hibernation nor a quiescent
`pop()` replaces this
cleanup. Avoid killing/resetting the interpreter with a live pool: it loses
in-memory handles and can orphan windows. No persistence service or
cross-kernel recovery coordinator is implied.

## Options / Configuration

### Environment variables (this extension)

| Variable | Default | Purpose |
| --- | --- | --- |
| `PTC_SUBAGENT_FOOTER` | `true` | Set `false` to hide the `subagents:` status footer (for custom footers consuming the `pi-ptc:subagent-runtime` API) |
| `PTC_SUBAGENTS_SOURCE` | `~/docs/src/pi-subagents` | Dev checkout to install `pi_subagents` from, preferred over the managed clone |
| `PTC_SUBAGENTS_REPO_URL` | `https://github.com/Quinntyx/pi-subagents` | Git source for the managed clone |
| `PTC_SUBAGENTS_SYNC_INTERVAL_HOURS` | `24` | Minimum interval between pi_subagents syncs |
| `PI_SUBAGENT_DEPTH` | unset | Set by pi on spawned subagents; suppresses the autoimport and provisioning — subagents cannot spawn subagents |

### Runtime knobs (read by the `pi_subagents` Python module)

| Variable | Default | Purpose |
| --- | --- | --- |
| `PI_SUBAGENTS_MAX_CONCURRENT` | *(unset — subagents disabled)* | Set to a positive number to enable subagents; also the global cap across all pools (stage `slots` are priorities, not hard limits). pi-pycells provisions the `pi_subagents` module when this is set. |
| `PI_SUBAGENTS_CATALOG_TTL` | `120` s | Model-catalog cache lifetime before a live re-check |
| `PI_CODING_SUBAGENT_DIR` | *(unset — subagents share the orchestrator's agent dir)* | Agent dir spawned subagent instances run under (env `PI_CODING_SUBAGENT_DIR`; `Task.agentDir` can override per task) |

### Settings

- `subagentFooter` (`src/contracts/settings.ts:23`) — the settings-file form of `PTC_SUBAGENT_FOOTER` (default `true`).

## Subagents setup

### Shared configuration (default)

Spawned agents use the orchestrator's current Pi agent directory unless `PI_CODING_SUBAGENT_DIR` or `Task.agentDir` overrides it. They inherit that configuration's extensions, credentials, and default model. `pi install git:github.com/Quinntyx/pi-pycells` installs pi-sock as a dependency and declares its extension for loading, so this default configuration needs no separate pi-sock installation. A profile named `subagents` is not selected automatically.

If that configuration already loads a standalone pi-sock package, disable its extension with `pi config` and keep the copy supplied by pi-pycells enabled. Loading both copies can create competing socket servers. This does not apply to a standalone subagents profile that only installs pi-sock.

### Standalone subagents profile

A separate profile does not inherit packages installed in the orchestrator's profile. **Install and enable pi-sock and pi-activity in the configuration used by spawned agents**, even if pi-pycells is already installed in the main profile:

```bash
# Use an existing Pi agent directory with working model credentials.
PI_CODING_AGENT_DIR=/path/to/subagents pi install git:github.com/Quinntyx/pi-sock
PI_CODING_AGENT_DIR=/path/to/subagents pi install https://git.quinntyx.dev/quinntyx/pi-activity.git
export PI_CODING_SUBAGENT_DIR=/path/to/subagents
export PI_SUBAGENTS_MAX_CONCURRENT=8
# Start the orchestrator in tmux using its usual configuration.
pi
```

Replace `/path/to/subagents` with your standalone profile's agent directory. The first two commands install both extensions into that directory; `PI_CODING_SUBAGENT_DIR` selects it for spawned agents without changing the orchestrator's configuration. A task's `agentDir` override must likewise select a configuration loading both extensions. Installing pi-pycells into the standalone profile supplies and declares both extensions, so separate installs are unnecessary in that case. pi-pycells itself is not required in the standalone profile unless those agents need notebook tools.

pi-sock supplies the control socket used to deliver prompts and communicate with agents; without it, startup waits for the socket and fails. Run the orchestrator under tmux and ensure the selected profile can answer a normal Pi prompt.

### Provisioning notes

The Python module is provisioned separately from the Pi extensions. Relevant defaults and overrides:

- **Source URL.** `PTC_SUBAGENTS_REPO_URL` defaults to the public GitHub mirror (`https://github.com/Quinntyx/pi-subagents`) and works anonymously. Point it at your own fork if you maintain one: `export PTC_SUBAGENTS_REPO_URL=https://github.com/<you>/pi-subagents`. The provisioner shells out to plain `git`, so the URL must be reachable by your credential helper.
- **Author-specific dev-checkout path.** `PTC_SUBAGENTS_SOURCE` defaults to `~/docs/src/pi-subagents` (joined from your homedir, `src/subagents-env.ts:50`). If you don't have that directory nothing breaks — resolution falls through to the managed clone — but set `PTC_SUBAGENTS_SOURCE` if you keep a checkout elsewhere. With sibling worktrees, select the intended checkout explicitly: the container's `main/` fallback does not select `dev/`. For example, set `PTC_SUBAGENTS_SOURCE` to `/home/zlare/docs/src/pi-subagents/dev` for this development version. Restart kernels after changing the source; an already imported module does not switch implementations.
- **tmux and pi-sock are required for subagents.** `pi_subagents` warns at import when not running under tmux (its API then raises `NotImplementedError`). pi-pycells bundles and loads pi-sock and the API-only pi-activity extension in its own configuration. A standalone subagents profile must load both separately, as described above. Extensions and auth carry over only when agents share the orchestrator's configuration.
- **`pi_subagents` is not on PyPI / npm.** It is fetched from git at sync time. Without network access to a valid repo, provisioning fails (stamped, and logged to `~/.cache/pi-pycells/subagents-sync.log`); a previous working checkout or dev source keeps working. You can also supply any checkout via `PTC_SUBAGENTS_SOURCE` — it must contain a `pyproject.toml` at its root or under a `main/` subdirectory.
- **Machine cache layout.** The venv (`python-env/`), managed clone (`pi-subagents/`), sync log, and lock file all live under `~/.cache/pi-pycells/` (non-configurable in code). The venv is used for *all* PTC kernels, even if you never use subagents; delete it if you want kernels on a different interpreter.
- **`uv` and `git` assumed.** `uv` is preferred for venv creation and editable installs (falls back to `python3 -m venv` / `pip`); `git` is required for the managed-clone path.
- **Sync-stamp quirk.** The repo currently tracks `.ptc-subagents-sync.json` containing the author's absolute `editablePath` — harmless at runtime (it's just a stale stamp that triggers one extra sync), but expect a diff on first run.
- **pi-depth convention.** "Subagents can't spawn subagents" relies on pi's `PI_SUBAGENT_DEPTH` env convention. In hosts that don't set it, the depth-note system prompt simply never applies; the pool API is unaffected.
