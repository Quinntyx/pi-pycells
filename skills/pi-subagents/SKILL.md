---
name: pi-subagents
description: "Use when launching, continuing, or coordinating individual or multiple Pi subagents."
metadata:
  type: procedure
---

# Contract

## Input Contract

- The user's requested work, desired agent count when specified, and permitted effects.
- A launch directory, profile and installed pi-subagents runtime; a repository only if needed.
- A meaningful persistent kernel name and actual runtime/delegation capacity.
- Acceptance criteria appropriate to the delegated work, without invented delivery deadlines.
- Git, push, shared-resource and cleanup permission only for operations the task actually needs.

## Output Contract

- AgentPool-owned handles and inspected outcomes, or a durable status handoff for pending work.
- Exactly the requested useful assignments, without inflating agent count into a workflow cohort.
- Retained sessions and recoverable work on failure, interruption or expected continuation.
- Only authorized effects, with completed work and remaining blockers reported accurately.

# Entrypoint

## Stage 1: Select the delegation mode

1. Identify the requested work, acceptance criteria, allowed effects and desired agent count N.
   Do not invent a delivery deadline, task time quota, file allowlist or implementation design.
   Ask only when missing information prevents a safe assignment; otherwise use known context.
2. Default to lightweight delegation: one agent or a natural small set of independent tasks.
   Asking to spin up subagents does not request a workflow. Agent count alone is not a reason
   to select one. Do not impose five review passes, a balanced merge tree or 3C decomposition.
3. Select workflow mode only if the user explicitly requests a workflow or the scope is large
   enough that dependent implementation, CI gates and multi-subsystem integration justify it.
   State the reason for that choice. Preserve user overrides and requested counts in either mode.
4. Resolve live concurrency C within runtime capacity and inherited permission. N is the number
   of assignments; C is the live admission bound, not a required number of tasks. Do not expand
   a request for N agents to 3C tasks. If N exceeds C, queue the requested N without duplication.
   Honor whether a count limits simultaneous agents, assignments or total launches. Do not
   reinterpret a total-launch cap as concurrency or add unrequested roles behind that cap.
5. Both modes go to Stage 2. After preparation, lightweight work goes to Stage 3; selected
   workflow work goes to Stage 4. Permission to edit does not implicitly select workflow mode.

## Stage 2: Prepare only what this work needs

1. Inspect the persistent kernel before using it. Preflight the installed AgentPool, Task,
   stage.submit, stage.submit_all, pool.pop and failure APIs, plus the requested profile.
   Use explicit kernel selection; retain submission identities and live pool/handle objects.
2. Import AgentPool and Task from pi_subagents. AgentPool is the launch entrypoint for both
   individual agents and many agents. Do not substitute SDK convenience launch helpers or
   manual tmux/CLI spawning. A pool does not imply a multi-stage workflow.
3. Choose cwd and agentDir explicitly, preserving the profile's model unless the user names one.
   Read-only agents may share immutable inputs without worktrees, CI setup or Git mutation.
   Isolate concurrent writers with separate worktrees/checkouts and lease real shared resources.
   Do not touch another writer's checkout or predesign interfaces to avoid creating worktrees.
4. Write readable briefs with the actual request, each assigned unit, acceptance criteria,
   directory, permitted effects and relevant checks. Builders choose their own files, interfaces
   and design. Worktree ownership replaces per-file ownership; never invent arbitrary allowlists.
5. Keep setup, submission/collection and teardown distinct for retained sessions. Review the saved
   execution cell unless the user explicitly authorized no-prompt execution. Do not resubmit on
   replay merely because earlier output is absent. Continue to the mode selected in Stage 1.

## Stage 3: Spin up individual subagents

1. For a single subagent, create one AgentPool with concurrency one and one named stage with
   slots one. Construct one Task and launch it with stage.submit; retain the returned handle.
   No additional build/review/merge stages, CI bootstrap or worktree tree are required.
2. For several independent agents, use the same pattern with concurrency bounded by C and the
   actual assignments. Use one stage or only the stages needed by those tasks. Submit exactly
   the requested N with stage.submit or stage.submit_all; never manufacture a 3C cohort.
3. Task carries prompt, name, cwd and agentDir; add schema, model, thinking, metadata or timeout
   only as required by the real task and runtime. Give leaves zero delegation fuel; child
   orchestrators need separately authorized finite inherited delegation fuel.
4. Record the pool, stage, handle, task identity and outcome. Collect through await handle or
   pool.pop, choosing one accounting path per outcome. A directly awaited result also has a
   pool completion event; do not process the same outcome twice. Check cancellation and errors
   using the contracts below rather than treating them as successful text or schema bodies.
5. If the request is start-only or background work, return handles/status without waiting or
   closing the pool. Keep its kernel alive. Otherwise inspect each result and perform only the
   verification the requested unit needs; no mandatory five-cycle review/repair loop applies.
6. For follow-up, reuse the retained session through the continuation contract below. Track the
   new handle on a scheduled continuation; awaiting the old handle cannot obtain its new answer.
   Do not close the pool between turns. Proceed to Stage 5 when reporting or finishing this work.

## Stage 4: Run a selected workflow

1. For substantial implementation or an explicitly requested implementation workflow, read
   [the implementation workflow](references/implementation-workflow.md) before submission.
   Follow its CI, review and integration gates only within that selected mode, then go to Stage 5.
2. For a requested non-implementation workflow, define AgentPool stages and dependency release
   according to that work. Do not import build CI, five-cycle review defaults, 3C fan-out or
   balanced Git merging into research, planning or other work where they serve no purpose.
   Preserve explicit counts, account for outcomes, and proceed to Stage 5 after delivery/handoff.

## Stage 5: Report, retain or close

1. Report verified outcomes, pending work, errors and blockers at the requested level of detail.
   Do not infer completion from an inactive window, an empty reply or a model's self-report.
2. If agents are active, follow-up is expected, or failure recovery remains, retain the owned
   pool, handles, sessions, notebook and workspaces. Return their status and resume identities.
   A cell interrupt or waiting timeout does not authorize cancellation, respawn or pool close.
3. Only when owned work is complete and no continuation is needed, close that pool explicitly.
   Pool close is permanent and invalidates its handles. Do not close unrelated pools globally.
   Git/worktree/branch cleanup needs separate authorization or the selected workflow's policy.
   Preserve user state and use trash for approved filesystem removal, never rm.

# Shared runtime and prompt discipline

- Native compaction handles context pressure. Do not request early handoffs, replace sessions
  or mark work done merely to refresh context; continue valid sessions across real feedback.
- No automatic recursive delegation. Authorized orchestrators inherit finite B/L fuel, global
  admission bounds and actual user deadlines; leaves have zero delegation fuel.
- Separate user delivery deadlines from operational transport/startup watchdogs. Use supported
  runtime guards without inventing business quotas or treating a timeout as worthless work.
- Keep prompts readable; translate validated results into concrete prose for follow-up agents.
  Metadata tracks lineage and real counters, not a parent-designed implementation contract.
- Preserve explicit user-requested counts and deduplicate submission by task identity. Review
  and merge policies belong to the selected workflow, not to every pool or implementation task.

# API and continuation contract

- `Task` is immutable. Public fields are `prompt`, `name`, `model`, `thinking`,
  `schema`, `cwd`, `agentDir`, `timeout`, and `metadata`. Set `cwd` explicitly;
  a prompt telling an agent to change directories is not a launch directory.
- Metadata includes non-negative integer `rounds`; roots default to zero.
  `stage.submit(task, parent=result)` inherits parent metadata, and explicitly
  supplied task metadata overrides it. A default root value must not reset rounds.
- `stage.submit(task, parent=result, session_handle=result.handle)` schedules a
  continuation on the retained session and returns a new handle. `parent` tracks
  lineage/metadata; `session_handle` chooses reuse. Earlier results stay unchanged.
  Omitted model, thinking, cwd, and agentDir inherit the session configuration;
  conflicts raise `SessionReuseError`. `session_name` controls the Pi session name.
- `handle.send(text)` / `await handle.send_async(text)` steer an active agent;
  their transport acknowledgement is not an independent completion. On a settled,
  failed, or cancelled handle, a new scheduled prompt requires a retained session
  with a live process or dormant continuation. A retained live session continues
  in place; only a dormant session reopens after capacity admission. Queued
  cancellation or startup failure without a retained session cannot continue this
  way; a dead non-dormant process is not automatically respawned.
- A terminal send returns a scheduling acknowledgement, not an agent reply:
  `scheduled`, new `handle`, `handleId`, and `status="queued"`. Queued is a receipt,
  not a current-state snapshot. Track the new handle and await it or consume its
  completion through `pool.pop()` exactly once; awaiting the old handle cannot
  obtain the new answer. The old result stays unchanged.
- Scheduled sends preserve the source handle's stage/name, task schema, timeout,
  and metadata, with its result as `parent` lineage; they do not increment `rounds`.
  Use explicit stage submission when changing metadata, schema, timeout, name,
  stage routing, or the cycle's round counter.
- At most one queued or active continuation may own a session. Do not submit
  concurrent follow-ups through different handles sharing that session. Active
  steering does not authorize an independent overlapping turn.
- Automatic dormancy applies only to successfully validated tasks whose latest
  outcome is successful. It unloads Pi/tmux resources, not the logical session or
  handle. All other outcomes stay inspectable; do not manually unload them.
- Handles preserve durable session identity/path, configuration, and cached
  inspection until explicit pool close. Inspecting a dormant handle must not
  start Pi. A scheduled continuation resumes it with `pi --session` only after
  capacity is acquired. Do not implement manual respawning around the library.
- Spawn and dormant reopen target the stable tmux session ID, not a cached session
  name. A user renaming the tmux session must not invalidate its placement.
- `await handle` / `handle.wait(timeout)` obtains its outcome or raises its error.
  `handle.cancel()` removes queued work or requests abort of a starting/running
  turn; startup observes cancellation even before a session is retained. Recursive
  cancellation also terminates owned descendants, not unrelated panes. It
  returns false for already-terminal work, not cancellation of a later follow-up;
  cancel the new continuation handle instead. Cancellation does not unload a
  retained session, close the pool, or interrupt unrelated tasks. A cell interrupt
  or pop timeout does not cancel tasks. Inspect and account for the actual outcome.
- Inspect through `handle.state()`, `handle.activity()`, `handle.agent_state()`,
  and `handle.get_session()`; asynchronous state/activity variants are available.
  Activity uses pi-activity; do not assume a label naming/assignment policy.
- Result fields include `task`, `stage`, `handle`, `body`, `error`, `status`,
  `duration_ms`, `parent`, and `session`. Use validated body fields directly.
  `pool.pop()` returns completions in observed completion order; `None` means
  quiescent, and the pool remains usable until closed.

# Failure contract

- Failures raise; do not use removed success-check or unwrap helpers. Awaiting a
  handle raises the underlying task error. `pool.pop()` raises
  `AgentPoolFailureError`, whose `.result` identifies the failed task/handle and
  whose `__cause__` preserves its error. Record that completion exactly once.
- Process death raises `PiSockSessionEnded`. Aborted/provider-error turns do not
  become successful empty replies. Explicit cancellations have cancelled status
  and no successful body; do not process them as a schema dictionary.
- Schema parsing/validation is automatic. Invalid JSON or mismatches receive up
  to three repair follow-ups containing validation errors after the initial
  reply. Exhaustion raises `SchemaValidationError`; repair timeout raises
  `PiSubagentsTimeoutError`. These reach `pop()` through `AgentPoolFailureError`.
- Use supported operational wait guards. `AgentPoolTimeoutError` stops the
  waiting cell, not its pool; inspect `.pool` / `.snapshot` and continue later.
- Do not blanket-catch delegated work. Catch `AgentPoolFailureError` only around the
  individual `pop()` whose task/stage and underlying cause may match the predeclared
  recoverable policy. Check exact allowed cause types and containment conditions;
  neither the wrapper nor membership in a broad exception base is sufficient.
- Recoverable means the failure is confined to the declared unit, diagnostics and
  workspace remain available, and unrelated work is safe. Record `.result` exactly
  once as failed, retain it, block its dependencies, and replenish unaffected ready
  work. Do not double-count a result also observed by awaiting its handle.
- Unexpected causes, shared-resource/baseline uncertainty, scheduler errors, and
  interruptions must propagate rather than being converted into recoverable task
  reports. A pop timeout is not a task completion and must not increment outcome
  counts. Inspect it separately; do not fabricate a result to keep the loop alive.
- Never fabricate success from an exception or add orchestration retries beyond
  the library's existing schema-repair policy. Semantic blocked reports require
  no exception catch, but must remain blocked in parent dependency accounting.

# Model, lifecycle, and replay discipline

- Unless the user names a model, inherit the selected agent directory/profile's
  default; do not select one manually. Resolve named models with `best_model_match`,
  `model_slugs`, `resolve_models`, or `list_models`; use a full provider/model slug
  when needed.
  Catalog TTL is `PI_SUBAGENTS_CATALOG_TTL` (default 120 seconds); misses refresh,
  and `list_models(refresh=True)` forces a reread. Set thinking when appropriate.
- `with AgentPool(...)` closes on clean exit; reserve it for trivial fixtures
  without retained sessions or substantial orchestration. Exceptions inside the
  context leave the pool intact. Retained individual agents and workflows use separate teardown
  cells; neither mode authorizes closing a pool while continuation is still needed.
- Interrupts stop cells, not pools. Do not kill/reset a kernel while agents are
  active: losing handles can orphan windows. Continue using the same namespace.
- Do not blindly `run_all` an active workflow. Notebook sources, stored outputs,
  and the live namespace may differ; inspect before reruns, preserve submission
  identity, and never treat stale outputs as validation of changed inputs.
- Do not change profiles, environment settings, dependencies, git state, or
  another builder's worktree without permission. Worktree use and cleanup remain
  subject to user authorization. Runtime success-only dormancy is not permission
  for extra destructive cleanup or early pool close.
