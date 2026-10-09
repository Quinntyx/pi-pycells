# Implementation workflow

Load this reference only after the main Entrypoint selects workflow mode for a substantial
implementation or the user explicitly requests this implementation workflow. A request to
launch subagents, their number, or permission to edit does not select this protocol by itself.

The five-cycle intermediate/final review defaults, initial 3C cohort and balanced merge tree
below are conditional workflow policy, not general AgentPool requirements. Preserve explicit
user-requested counts and overrides. Live admission remains C across all stages.

Use AgentPool, Task and the main skill's API, failure, continuation and lifecycle contracts.
Record the integration branch, effect permissions and required CI before proceeding to Stage 1.


## Stage 1: Prepare

1. Identify the overall requested behavior, acceptance criteria, constraints and target branch.
   Do not invent a delivery deadline, task time quota, file allowlist or implementation design.
   This reference governs implementation only. For planning-only or read-only work, return to
   the main Entrypoint instead of creating CI or mutating Git. Otherwise inspect the actual
   remote and test framework, then go to Stage 2.
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
2. Create Build,
   IntermediateReview and FinalReview stages sharing the same total capacity C.
   The parent coordinates dependency release and mechanical merges; agents do not coordinate
   other agents unless separately authorized with finite inherited delegation fuel.
3. Preserve an explicit requested builder count N. Otherwise, prepare 3C initial Build items
   only when this selected workflow has enough useful scope. Submit the chosen cohort with
   build.submit_all. This is the initial queued cohort, not 3C simultaneously running processes.
   Later population develops through review, repair and merge outcomes; do not maintain a
   predictive 3C frontier or refill merely to meet that number. If useful scope cannot support
   the default cohort, choose a natural smaller cohort or return to lightweight delegation.
   Never pad the cohort with fabricated features or duplicate busywork.
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

1. Keep all initial, intermediate merge, repair and review worktrees and remote branches for
   the ENTIRE workflow. Do not delete either merged children or remote branches incrementally.
   'Deleting worktrees from the server' means deleting their remote branches, not remote folders.
2. Large counts are expressly acceptable. With N initial builders and distinct binary merge
   worktrees, the tree has N-1 merge nodes and 2N-1 worktrees/branches, before extras. For the
   default N=3C cohort this is 6C-1; explicit user-requested counts take precedence.
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

# Forgejo references

- Workflows, runner prerequisites and branch triggers:
  https://forgejo.org/docs/latest/user/actions/overview/
  https://forgejo.org/docs/latest/user/actions/quick-start/
  https://forgejo.org/docs/latest/user/actions/reference/
