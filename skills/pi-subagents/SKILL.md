---
name: pi-subagents
description: "Use when orchestrating Pi subagents, pools, worktrees, or parallel implementation."
metadata:
  type: procedure
---

# Contract

## Input Contract

- The overall user request, target repository and integration branch, and allowed effects.
- Effective pool concurrency C, the requested subsystem scope, and acceptance criteria.
- Git/worktree and push permission for implementation; preserve preexisting user work.
- An installed pi-subagents runtime, the subagent profile, and an explicit persistent kernel.
- Forgejo Actions access and an available runner when the remote host is git.quinntyx.dev.
- Review caps: five intermediate review/repair cycles and five final cycles unless overridden.

## Output Contract

- An exploratory subsystem implementation, reduced through CI-gated balanced merge nodes.
- A published, reviewed integration tip containing every accepted contributing branch.
- A durable notebook with task lineage, review counters, CI evidence and merge-tree state.
- On interruption or failure, retained local/remote branches and worktrees for recovery.
- Cleanup only after the whole workflow succeeds and all owned work is safely integrated.

# Entrypoint

## Stage 1: Prepare

1. Identify the overall requested behavior, acceptance criteria, constraints and target branch.
   Do not invent a delivery deadline, task time quota, file allowlist or implementation design.
   For a planning-only or read-only request, do not create CI or mutate Git; go to Stage 3.
   For implementation, inspect the actual remote and test framework, then go to Stage 2.
2. Resolve C from the user's concurrency request and actual runtime capacity. Record the value
   explicitly; C bounds live agents across build, review and repair, not the submitted backlog.
3. Decompose by cohesive subsystems or features. Give each builder the full user request plus
   its piece to discover and implement. Builders choose their own files, interfaces and design.
   Limited alternative implementations are welcome when they explore meaningfully different
   approaches; avoid many agents independently rebuilding the entire application.

## Stage 2: Establish CI before fan-out

1. If the repository remote host is git.quinntyx.dev, configure or repair Forgejo Actions before
   submitting builders. Otherwise retain existing CI and record the available validation gate.
2. Inspect the project's test discovery and canonical test command. Reuse the actual framework;
   do not substitute a token smoke check for the test suite. Ensure added tests are discovered.
3. Reuse existing workflows. Forgejo reads .forgejo/workflows and falls back to .github/workflows
   only when the former directory is absent; do not accidentally disable existing automation.
   Cover pushes to every temporary build and merge branch, not only dev/main or pull requests.
4. Verify Actions is enabled, a compatible runner is available, and required jobs can report a
   result. Missing runners, permissions or credentials are infrastructure blockers, not success.
   Do not install services, invent credentials, deploy production or weaken tests to get green.
5. Commit/push the CI setup on an authorized bootstrap branch based on the target. Wait for the
   required test jobs to succeed at that exact commit, then use it as the builders' baseline.
   Preserve the target branch until final integration. If the baseline is red, fix bootstrap
   or report its blocker before fan-out; unrelated local green tests cannot replace this gate.
6. Record required workflows/jobs and their commit identity. Missing, queued, running, skipped,
   cancelled or stale results are not green. Use the forge's supported API/CLI for its installed
   version; do not assume GitHub-only commands work on Forgejo. Proceed to Stage 3 when ready.

## Stage 3: Author and submit the initial cohort

1. Use a persistent kernel with a meaningful name and explicit kernel selection on operations.
   Preflight Task/AgentPool APIs, the profile and failure classes before submitting work.
   Store constants, execution and teardown as distinct notebook cells. Review the saved
   execution cell unless the user explicitly authorized no-prompt execution.
2. For read-only work, submit the requested useful units without CI or Git mutation; inspect
   their outcomes and go directly to Stage 7. For implementation, create Build,
   IntermediateReview and FinalReview stages sharing the same total capacity C.
   The parent coordinates dependency release and mechanical merges; agents do not coordinate
   other agents unless separately authorized with finite inherited delegation fuel.
3. For implementation, prepare 3C initial Build items and submit them with build.submit_all.
   This is the initial queued cohort, not 3C simultaneously running processes. Later population
   develops through review, repair and merge outcomes; do not maintain a predictive 3C frontier
   or refill merely to meet that number. If scope cannot support useful 3C items, report that
   before launching instead of padding the cohort with fabricated features or duplicate busywork.
4. Give every builder its own branch and worktree from the green baseline. Isolation is the
   default, not a fallback after exhaustive file partitioning. Checkouts may touch any files
   needed for their subsystem. Allocate all initial worktrees without treating disk count as
   a concurrency limit. Keep leases only for genuinely shared ports/services/mutable resources.
5. Compose clear task briefs: overall request, assigned subsystem, acceptance criteria, actual
   checkout and test/CI responsibilities. Do not prescribe implementation interfaces, exact
   edit paths, arbitrary completion times or a detailed parent-designed solution.
6. Require builders to add relevant tests, verify discovery, and ensure CI actually runs those
   tests. Report implemented behavior, design decisions, checks, risks and real blockers.
   Set cwd and agentDir explicitly. Use schemas and counters for routing, not solution design.
7. Record each branch, worktree, baseline, feature scope, session handle and review-cycle count.
   Consume completions as they arrive. Go to Stage 4 for a settled builder; process independent
   jobs concurrently rather than waiting for a phase-wide barrier.

## Stage 4: Intermediate review and repair

1. Commit/push the candidate tip and obtain CI evidence for that exact tip. Assign an isolated
   reviewer the implemented feature and actual diff. Explicitly say it is an INTERMEDIATE
   review, not a final whole-project review. Inspect evidence, not merely the builder's claims.
2. The intermediate reviewer must ignore bugs outside this feature/integration scope and be
   relatively loose. Block only substantive failures: critical logic bugs, races, deadlocks,
   crashing exceptions, missing required behavior, or similarly consequential test failures.
   Do not block on nits, style, minor cleanup, speculative redesign or unrelated existing bugs.
3. CI remains a hard gate even when review is loose. Do not suppress a failing required test.
   Classify infrastructure failure separately and repair/rerun it; never treat it as a pass.
4. If review approves and required CI is green for the current tip, add the node to the ready
   merge buckets in Stage 5. Otherwise send actionable scoped feedback to the original builder
   in its retained worktree/session, through Build, then review its next tip again in Stage 4.
5. Count each intermediate review/repair cycle once; default cap is five. A merge repair uses
   this same loop. At exhaustion retain the branch/worktree, report the unresolved blocker and
   stop retrying that node. Independent work may continue; do not silently discard failed work.

## Stage 5: Balanced mechanical merge and CI gate

1. Store approved nodes by tree depth. Initial build nodes have depth zero. Each node records
   its branch, worktree, head commit, contributing features, parent nodes and CI evidence.
2. Atomically claim two ready nodes at the same depth d. Create a distinct merge branch/worktree,
   start from one parent tip and run ordinary git merge of the other. Successful output has
   depth d+1 and enters that depth's bucket only after validation. Never append it to a flat
   first-ready queue where it can immediately absorb unrelated depth-zero arrivals.
3. Do not spawn merge agents by default. If git merge has textual conflicts, queue a Build
   repair task in this merge worktree. If it succeeds, push the merge tip and wait for required
   CI. CI failure after merge is semantic incompatibility and also queues a Build repair task.
   Operational push/runner/auth failures remain blockers, not fabricated merge success.
4. Tell repair builders the combined feature scope, both parents and observed conflicts/test
   failures. Let them choose the sound reconciliation, including choosing the more promising
   competing implementation while preserving requested behavior. Do not impose a repair design.
5. A repair returns through Stage 4's five-cycle intermediate loop plus exact-tip CI. A clean
   git merge with green CI needs no intermediate agent pass merely for having been merged;
   move that result directly to its depth bucket. Failures never enter ready buckets.
6. Drain same-depth pairs in parallel. Do not release an unreviewed parent or reuse a node that
   another merge has already claimed. Preserve every original branch/worktree until completion.
7. Cross-depth joins are exceptional: wait until the build frontier is genuinely quiescent,
   including reviews, CI waits, merge repairs or in-flight merges that can release more nodes.
   Once no equal-depth pair remains and no earlier work can change the frontier, carry the
   lowest-depth orphan into the next nearest-depth node, then resume same-depth reduction.
8. Apply at most one orphan carry at a level before moving upward; some cohort sizes require
   carries at multiple levels. Do not interpret 'one odd branch' as one global exception that
   leaves the forest unreduced. Every carry still uses git merge, exact-tip CI and the same
   repair/review gate. Go to Stage 6 only when all accepted nodes reduce to one validated root.

## Stage 6: Final review and integration

1. Give the final reviewer the whole request, combined tree and actual test/CI evidence. Say it
   is FINAL review: it may apply stricter project-wide standards and inspect cross-subsystem
   behavior, regressions, maintainability and duplication. This is not a scoped loose review.
2. If rejected, route substantive feedback through Build on the combined worktree and repeat
   final review and exact-tip CI. Default final review/repair cap is five cycles, counted
   separately from intermediate cycles. At exhaustion retain state and report the blocker.
3. When final review and CI pass, fetch the target. If it moved incompatibly, reconcile on the
   integration worktree and repeat validation/review for the changed candidate; never force-push
   or reuse stale approval. Merge the accepted root into the authorized target and push it.
4. Require target CI green at the published tip and verify every contributing task tip is an
   ancestor of it. A PR, clean local checkout or unpublished branch is not delivery. Create
   PRs only if the user asked. Proceed to Stage 7 only when the whole workflow succeeds.

## Stage 7: Retention, cleanup and handoff

1. For read-only work, report inspected outcomes and close only the owned completed pool;
   preserve repository state. For implementation, keep all initial, intermediate merge,
   repair and review worktrees and remote branches for
   the ENTIRE workflow. Do not delete either merged children or remote branches incrementally.
   'Deleting worktrees from the server' means deleting their remote branches, not remote folders.
2. Large counts are expressly acceptable. With N=3C initial builders and distinct binary merge
   worktrees, the tree has N-1 merge nodes and 2N-1 = 6C-1 worktrees/branches, before extras.
   This is expected and authorized by this workflow, not a reason to lower C or serialize work.
3. The user accepts heavy disk use. Use sccache for Rust and analogous cache solutions when
   other compilers become problematic; fix cache/resource behavior at that layer instead of
   reducing agent concurrency. Cache setup still must respect credentials and install policy.
4. After every worker is stopped, all contributing work is reachable from the published target,
   target CI is green and final review approved, close the pool. Only then remove owned temporary
   remote branches and local worktrees/branches. Preserve dev/main, canonical worktrees and user
   data; use trash for filesystem removal, never rm. Do not force-delete dirty or unmerged work.
5. A blocked requested subsystem forbids whole-workflow success and cleanup unless the user
   explicitly supersedes its scope. On partial failure, interruption or unresolved rejected
   work, retain recoverable state.
   Report delivered behavior, unresolved issues, test evidence and resume identities; do not
   claim success or clean away the failed branch to manufacture a completed workflow.

# Runtime and prompt discipline

- The scheduler is event-driven; the initial 3C Build cohort is not a fixed-size batch barrier.
  Review, repair and merge work may grow the submitted pool while live admission remains C.
- Preserve explicit user-requested counts. Do not manufacture unrelated subsystems to satisfy C.
- Acceptance criteria describe required behavior, not parent-specified classes/files/interfaces.
  Do not call exhaustive design prescriptions 'contracts' and smuggle them into builder prompts.
- Worktree ownership replaces per-file ownership. Shared services still need exclusive leases
  where actual interference exists; immutable inputs can be shared without arbitrary handcuffs.
- Never impose invented task quotas. Distinguish real user deadlines from transport/startup
  watchdogs. Use supported runtime guards; a timeout is not evidence that the work is useless.
- Kernel means the persistent Python interpreter; notebook is its recorded .ipynb; session means
  a Pi agent conversation. Use explicitly named kernels, saved-cell review and durable lineage.
- Continue valid agent sessions across review feedback. Native compaction handles context
  pressure; do not request early handoffs or mark a feature done just to refresh context.
- No automatic recursive delegation. Authorized child orchestrators inherit finite B/L fuel,
  global admission bounds and any real user deadline; leaves have zero delegation fuel.
  Review/repair caps bound feedback branching. Queued work is not extra permission to run agents.
- Prepare shared-resource identifiers and effect permissions, but do not predesign the product.
- Keep prompts readable. Translate validated results into concrete prose for follow-up agents;
  do not dump raw JSON into prompts. Use metadata for depth, rounds, parents and CI identities.
- Preserve model/profile choices unless the user requests a change. Never infer completion or
  mergeability from a model's self-report, an empty reply, a schema pass or an inactive window.
- Resume from durable notebook state; deduplicate submission by task identity. Retained failure
  windows and workspaces are recovery assets. Do not resubmit the entire cohort on cell replay.

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

- Unless the user names a model, inherit the selected agent directory/profile's
  default; do not select one manually. Resolve named models with `best_model_match`,
  `model_slugs`, `resolve_models`, or `list_models`; use a full provider/model slug
  when needed.
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
  another builder's worktree without permission. Worktree use and cleanup remain
  subject to user authorization. Runtime success-only dormancy is not permission
  for extra destructive cleanup or early pool close.

# Forgejo references

- Workflows, runner prerequisites and branch triggers:
  https://forgejo.org/docs/latest/user/actions/overview/
  https://forgejo.org/docs/latest/user/actions/quick-start/
  https://forgejo.org/docs/latest/user/actions/reference/
