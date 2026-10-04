---
name: pi-subagents
description: "Use when work decomposes into multiple agent-sized units or stages,
  when the user requests subagents, parallel agents, pools, or workflows, or when
  several pi instances need orchestration. NOT for single-step work or simple
  parallel tool calls."
metadata:
  type: procedure
---

# Contract

## Input Contract

- A bounded objective, acceptance checks, workspace, permitted effects, and any
  user-specified models or effort levels.
- A notebook-backed kernel, or permission to provision one with `provision_kernel`.
  Keep reusable workflow notebooks in the project's `.pi/workflows/` directory
  unless the user selects another permitted location.
- A tmux environment and an agent profile loading pi-sock and pi-activity. The
  library checks its environment at import; do not repair configuration without
  permission. A standalone profile does not inherit the parent's extensions.
- `PI_SUBAGENTS_MAX_CONCURRENT`, defining C, the admitted active-capacity ceiling
  shared by pools in this process. Read it without changing the environment. If
  unset, use the library default of 8; reject invalid or non-positive values.
- An approved baseline identity, file and shared-resource ownership, dependency
  gates, and explicit permission for any worktree allocation or integration.
- A narrowly declared recoverable-completion policy, or a policy that all task
  exceptions propagate. Record eligible task/stage identities, exact cause types,
  containment conditions, and the required accounting before execution.

## Output Contract

- A completion-driven workflow with bounded tasks, explicit prompt contracts,
  dependency-gated routing, and a stated termination condition and round cap.
- A durable notebook recording constants, reviewable orchestration, outcomes,
  inspection, and a separate deliberate teardown cell.
- Findings, blockers, cancellations, and remaining risks tied to the approved
  baseline and handoff identity. Every acceptance check is passed, failed, or
  not-run, with a reason and supporting evidence; editing alone is not validation.
- Dependencies released only by semantically complete, accepted deliverables.
  Schema-valid blocked or incomplete reports must not release dependencies.
- Successful validated sessions may become dormant automatically. Failed or
  interrupted sessions remain available for inspection; durable identity and
  cached inspection stay on handles until explicit pool close.
- `pool.close()` returns a `PoolSummary` and invalidates handles; `subagents.finish()`
  closes all live pools and returns a count. Teardown leaves no orphaned windows.

# Entrypoint

## Stage 1: Prepare

1. Record the objective, acceptance criteria, effects, workspace, stages, and
   termination condition. State the review/fix round cap and narrowly recoverable
   completion failures before launching work. Record the approved baseline's
   checkout path, revision, and identity of any approved uncommitted changes;
   include an immutable snapshot or path/digest manifest rather than only a branch
   name. Tasks and handoffs must identify the baseline they actually inspected.
2. Read C from `PI_SUBAGENTS_MAX_CONCURRENT`. Use pool concurrency at most C; use
   `AgentPool()` to inherit the library ceiling unless a smaller limit is needed.
   Do not equate a queued roster with active concurrency.
3. Decompose the objective into small bounded deliverables. Record each task's
   identity, ownership, dependencies, prompt contract, checks, and timeout. Keep
   task duration bounded enough that completions can release useful work promptly.
4. Separate ready work from dependency-blocked work. Maintain a useful ready
   frontier around 3C when independent work exists; this is planning/queue
   headroom, not permission to run 3C agents. Do not invent work to meet a quota.
5. Assign ownership of files and all shared resources, including generated
   outputs, caches, ports, fixtures, and background processes. Record exclusive
   owners or serialization gates for commands with repo-wide effects. Readers may
   share a worktree. Writers may share one only when file and resource ownership
   is disjoint; serialize repo-wide commands. A read-only source audit may still
   mutate shared resources through its checks. If effects overlap or ownership is
   uncertain, go to Stage 2: Isolate. Otherwise go to Stage 3: Author.

## Stage 2: Isolate

1. Confirm permission before creating or manipulating worktrees or git state.
   Use separate worktrees only when overlapping effects make isolation useful
   and it is authorized. Worktrees do not isolate shared caches, ports, fixtures,
   or external services; assign or serialize those resources separately.
2. Record a bounded allocation count and resource budget. Allocate lazily when
   tasks become dispatch-ready, from the approved baseline; never create one
   worktree per queued roster entry eagerly. Reuse only an inspected compatible
   workspace. Retained failed workspaces count against the allocation budget.
3. If authorized isolation fits the budget, record each task's actual checkout,
   resource ownership, baseline identity, and integration gates, then go to
   Stage 3: Author. Otherwise serialize conflicting effects or repartition
   ownership, then go to Stage 3: Author. If neither is safe, report the affected
   tasks blocked and stop launching them; unaffected ready work may proceed to
   Stage 3: Author. Never bypass permission or delete failed workspaces for space.

## Stage 3: Author

1. Provision one durable notebook-backed kernel. Import `pi_subagents as subagents`.
   Inspect unfamiliar public APIs with `help()` or `dir()` rather than using older
   argument names or internal socket/RPC plumbing.
2. Use `write_cell` to save a constants cell containing imports, prompts, schemas,
   paths, input roster, C, limits, and model requests. Saving does not execute it;
   do not construct tasks or launch work here.
3. Save the opening workflow cell with `write_cell`. Keep construction of every
   `Task`, prompt composition, explicit `cwd`, schema, timeout, ownership routing,
   pool/stage creation, completion consumption, and round gates visible in this
   cell. Do not hide reviewable effects in an opaque wrapper.
4. Guard replay: reuse an existing open pool when resuming an interrupted workflow.
   Check that its recorded inputs match the current workflow before submitting
   anything new. Replay cached reports only when all required outcomes/checks
   succeeded and their identity matches inputs, prompts, paths, schemas, limits,
   approved baseline, resource ownership, and integration state. Schema validity
   alone cannot qualify a blocked report for replay. Never cache partial or failed
   work as done or duplicate already-submitted units.
5. Save a separate final teardown cell using synchronous `pool.close()` without
   `await`. Leave the pool open in all substantial workflow cells. Constants,
   workflow, and teardown require at least three recorded cells; later recorded
   cells may inspect results, continue work, or steer agents.
6. Go to Stage 4: Review. Scratch probes are allowed, but workflow execution must
   not depend on variables or functions existing only in scratch or deleted cells.

## Stage 4: Review

1. If the user explicitly requests autonomy or no prompts, skip the review request
   and go to Stage 5: Run. Otherwise submit the saved opening workflow cell to
   `request_cell_review(session_id=..., n=...)` before substantial orchestration;
   review destructive operations before execution as well.
2. The review tool never executes code. Keep constants in the preceding recorded
   cell and actual task construction in the cell being reviewed. Execution tools
   have no review/confirmation flag.
3. On approval, go to Stage 5: Run. On rejection, apply feedback and return to
   Stage 3: Author. Missing UI or a broken review dialog counts as rejection.
4. Approval covers the intended operation, not a code hash. Ordinary repairs within
   approved scope need no repeat review. New targets, permissions, destructive
   effects, or materially greater cost return to Stage 4: Review before execution.
   Do not prompt mid-workflow for unchanged scope.

## Stage 5: Run

1. First execute the saved constants cell with `run_cell`; validate its successful
   execution and initialized prompts, schemas, paths, roster, C, limits, and model
   requests against the approved inputs. If execution or validation fails, return
   to Stage 3: Author without launching work. Otherwise execute the saved approved
   workflow with `run_cell`; it executes only the selected cell, not prerequisites.
   Use one orchestration consumer per pool and ordered cell execution; never split
   a workflow across concurrent execution calls. Top-level `await` is available;
   do not use `asyncio.run(...)` or scratch execution to launch the workflow.
2. Create stages with `pool.stage(name, slots=...)`. Stage slots are soft priorities
   whose sum cannot exceed pool concurrency; idle slots are borrowed. Give
   latency-critical review, fix, or integration stages positive reservations.
   A zero-slot stage may borrow capacity, but has no starvation-freedom promise.
   Submit only ready work through `stage.submit(task)` or `stage.submit_all(tasks)`.
3. Consume completions with `await pool.pop(timeout=...)`. After each completion,
   record its outcome exactly once and evaluate semantic acceptance. Release gates
   only when the prerequisite deliverable is complete and its required checks pass;
   a valid schema, settled status, or blocked report is not acceptance. Route bounded
   review/fix work and refill unaffected ready submissions immediately. Avoid fixed
   batch barriers, serial waits in submission order, and unnecessary sleeps.
4. Replenish the useful frontier as tasks complete. Submitted queued tasks may
   exceed C; admitted active work remains bounded by pool and global capacity.
   A handle can be marked starting while waiting for global admission. Do not use
   the count of all starting statuses as proof that C has been exceeded.
   Blocked tasks do not count as ready headroom and must not consume agent slots
   while waiting for prerequisites. Stop submitting when the bounded objective is
   covered; allow the frontier to drain rather than manufacture tail work.
5. Integrate only after required implementation and checks succeed. Assign an
   integration owner and verify the approved baseline, source checkout, changed
   paths/artifact digests, acceptance evidence, and target identity at handoff.
   Reject unexplained baseline drift; reconcile it before integration. Gate
   downstream validation on accepted integration. In a shared workspace, gate
   dependent reviews/checks on accepted writer completion, and serialize repo-wide
   commands that mutate shared resources. Intermediate edits are evolving snapshots,
   not final integrated results; report the inspected snapshot identity explicitly.
6. For every cyclic review/fix path, carry integer `metadata["rounds"]` forward and
   increment it for the next cycle. Stop requeuing at the declared cap and report
   unresolved findings. Unless explicitly authorized, never run an unbounded cycle.
7. On a failure covered by the predeclared recoverable-completion policy, account
   for the failed result exactly once, block its dependent work, retain diagnostics
   and workspace, and continue Stage 5: Run with unaffected ready-work replenishment.
   Do not automatically retry it. Unexpected failures propagate and stop the cell;
   go to Stage 6: Inspect with pools intact. Interruptions also go to Stage 6: Inspect.
   When `pop()` returns `None`, go to Stage 6: Inspect; quiescence does not close the
   pool or prove success if blocked or unsubmitted work remains.

## Stage 6: Inspect

1. Inspect reports, acceptance evidence, handoff identities, ownership, outstanding
   dependencies, and `pool.snapshot()` / `pool.handles(...)`. Account for every task
   and continuation, including recoverable failures already consumed. Report missing
   work, cancellations, failures, and round-limit findings. Record each check as
   passed, failed, or not-run with its reason, inspected identity, and evidence.
   Keep blocked reports distinct from accepted deliverables even when schema-valid.
2. Retain failed, crashed, cancelled, timed-out, schema-exhausted, and interrupted
   Pi/tmux sessions for manual inspection and continuation. Do not close pools
   from error handlers or workflow-wide `finally` blocks. If a process has already
   died, retain its handle and diagnostics rather than claiming it is live. Retain
   failed workspaces and generated evidence for inspection; pool teardown does not
   authorize their deletion. Count them in any later allocation budget.
3. If continuation is needed and authorized, submit or send bounded follow-ups
   using the continuation contract below, then return to Stage 5: Run. If scope
   expands, return to Stage 4: Review instead. Otherwise go to Stage 7: Teardown
   only after inspection is complete and no retained session is still needed.

## Stage 7: Teardown

1. Execute the dedicated teardown cell calling `pool.close()` without `await`.
   Inspect its `PoolSummary`; retain the notebook's reports, outputs, and failed
   workspaces. Filesystem/worktree cleanup requires separate explicit permission
   after inspection; never infer it from pool close. Use `subagents.finish()` only
   when deliberate cleanup of all live pools is intended.
2. Report the notebook path, completed deliverables, checks, failures, blockers,
   remaining risks, and required follow-ups. Do not describe cleanup as validation.

# Prompt contracts

- Give each task one bounded deliverable and a concrete stop condition. Split
  broad implementation or audit work into independently verifiable units.
- Include task identity, objective, explicit `Task.cwd`, approved baseline identity,
  permitted files or read-only scope, generated-output/cache/port/fixture ownership,
  repo-wide command gates, forbidden effects, satisfied dependencies, acceptance
  checks, timeout, required response fields/schema, and escalation instructions.
- Require explicit complete or blocked deliverable status and passed/failed/not-run
  acceptance evidence with reasons. A blocked report can be a valid task response
  without completing its objective; the parent must not release downstream gates.
  Report handoff identity through checkout/baseline and changed path/artifact digests.
- Instruct writers not to edit another owner's files; instruct all agents not to
  spawn subagents. Keep scheduling and integration decisions in the parent.
- Supply only relevant context and exact paths. Require evidence with paths/lines,
  checks performed or not run, assumptions, blockers, risks, and parent follow-ups.
- Require bounded completion or a blocker report, not waiting for another agent.
  The parent schedules dependent work after prerequisites settle successfully.
- Schema bodies are validated dictionaries. Extract needed fields in Python and
  translate them into concise prose, bullets, and concrete next actions for the
  next prompt. Never paste raw JSON, full dictionary dumps, or tool payloads into
  a user-observable follow-up prompt.

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
  turn; startup observes cancellation even before a session is retained. It
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
- Set explicit `Task.timeout` and pop timeouts. `AgentPoolTimeoutError` stops the
  waiting cell, not its pool; inspect `.pool` / `.snapshot` and continue later.
- Do not blanket-catch a workflow. Catch `AgentPoolFailureError` only around the
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

- Unless the user names a model, inherit the subagents profile's default; do not
  select one manually. Resolve named models with `best_model_match`, `model_slugs`,
  `resolve_models`, or `list_models`; use a full provider/model slug when needed.
  Catalog TTL is `PI_SUBAGENTS_CATALOG_TTL` (default 120 seconds); misses refresh,
  and `list_models(refresh=True)` forces a reread. Set thinking when appropriate.
- `with AgentPool(...)` closes on clean exit; reserve it for trivial fixtures
  without retained sessions or substantial orchestration. Exceptions inside the
  context leave the pool intact. Real workflows use separate teardown cells.
- Interrupts stop cells, not pools. Do not kill/reset a kernel while agents are
  active: losing handles can orphan windows. Continue using the same namespace.
- Do not blindly `run_all` an active workflow. Notebook sources, stored outputs,
  and the live namespace may differ; inspect before reruns, preserve submission
  identity, and never treat stale outputs as validation of changed inputs.
- Do not change profiles, environment settings, dependencies, git state, or
  another writer's files without permission. Worktree use and cleanup remain
  subject to user authorization. Runtime success-only dormancy is not permission
  for extra destructive cleanup or early pool close.
