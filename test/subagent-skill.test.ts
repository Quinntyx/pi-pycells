const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const skillPath = path.join(__dirname, "../skills/pi-subagents/SKILL.md");
const skill = fs.readFileSync(skillPath, "utf8");

// Match concepts within their contract/stage, not a particular sentence or wrapping.
function prose(text) {
  return text.replace(/`([^`\r\n]+)`/g, "$1").replace(/\s+/g, " ").trim();
}

function section(title) {
  const headings = [...skill.matchAll(/^(#{1,6})\s+(.+)$/gm)];
  const index = headings.findIndex((heading) => heading[2] === title);
  assert.notEqual(index, -1, `missing section: ${title}`);
  const heading = headings[index];
  const next = headings.slice(index + 1).find((item) => item[1].length <= heading[1].length);
  return prose(skill.slice(heading.index + heading[0].length, next?.index ?? skill.length));
}

function concepts(text, patterns) {
  for (const pattern of patterns) {
    assert.match(text, pattern, `missing procedure concept: ${pattern}`);
  }
}

function orderedConcepts(text, patterns) {
  let remaining = text;
  for (const pattern of patterns) {
    const match = remaining.match(pattern);
    assert.ok(match, `missing or out-of-order procedure concept: ${pattern}`);
    remaining = remaining.slice(match.index + match[0].length);
  }
}

function stage(number, name) {
  return section(`Stage ${number}: ${name}`);
}

test("standalone procedure has descriptive frontmatter and no code demonstrations", () => {
  const frontmatter = skill.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  assert.ok(frontmatter, "skill must begin with YAML frontmatter");
  assert.match(frontmatter[1], /^name:\s*pi-subagents\s*$/m);
  assert.match(frontmatter[1], /^metadata:\s*\n\s+type:\s*procedure\s*$/m);
  const description = frontmatter[1].match(
    /^description:\s*(.+(?:\r?\n[ \t]+[^\r\n]+)*)/m,
  );
  assert.ok(description, "frontmatter must describe when to use the procedure");
  concepts(prose(description[1]), [
    /(?:agent-sized|decompos|multiple)/i,
    /(?:subagents|parallel agents|pools|workflows)/i,
    /(?:NOT|not).*single-step/i,
  ]);
  assert.doesNotMatch(skill, /^\s*(?:`{3,}|~{3,})/m, "no fenced code demonstrations");
  assert.doesNotMatch(skill, /^(?: {4}|\t)\S/m, "no indented code demonstrations");
  assert.doesNotMatch(skill, /^#+\s+.*(?:examples?|demos?)\b/im);
  assert.doesNotMatch(skill, /^#\s+(?:API|Rules)\s*$/m, "removed guide sections stay removed");
  for (const [index, line] of skill.split(/\r?\n/).entries()) {
    assert.ok([...line].length <= 100, `skill line ${index + 1} exceeds 100 characters`);
  }
});

test("Contract and Entrypoint define staged branching and bounded outputs", () => {
  concepts(section("Input Contract"), [
    /objective/i, /acceptance/i, /workspace/i, /permission/i, /dependenc/i,
  ]);
  concepts(section("Output Contract"), [
    /completion-driven/i, /bounded/i, /round cap/i, /notebook/i,
    /inspection/i, /teardown/i, /fail/i,
  ]);
  const entrypoint = section("Entrypoint");
  const names = ["Prepare", "Isolate", "Author", "Review", "Run", "Inspect", "Teardown"];
  const headings = [...entrypoint.matchAll(/## Stage (\d+): (\w+)/g)];
  assert.deepEqual(headings.map((heading) => [Number(heading[1]), heading[2]]),
    names.map((name, index) => [index + 1, name]));
  concepts(stage(1, "Prepare"), [/overlap/i, /Stage 2/, /Otherwise.*Stage 3/i]);
  concepts(stage(4, "Review"), [/approval/i, /rejection/i, /Stage 3/, /Stage 5/]);
  concepts(stage(5, "Run"), [/fail/i, /interrupt/i, /Stage 6/, /None/, /quiescen/i]);
  concepts(stage(6, "Inspect"), [/continuation/i, /Stage 5/, /Stage 4/, /Stage 7/]);
});

test("capacity is distinct from roster size and completion-driven ready headroom", () => {
  concepts(section("Input Contract"), [
    /PI_SUBAGENTS_MAX_CONCURRENT[^.]*active-capacity ceiling/i,
    /shared by pools[^.]*process/i, /default[^.]*8/i,
    /reject[^.]*invalid[^.]*non-positive/i,
  ]);
  const prepare = stage(1, "Prepare");
  concepts(prepare, [
    /PI_SUBAGENTS_MAX_CONCURRENT/, /\bC\b/, /concurrency.*(?:most|ceiling|limit)/i,
    /(?:not|never).*queued roster.*active concurrency/i,
    /(?:around|roughly|about)\s*3\s*\*?\s*C/i,
    /(?:ready|frontier)/i, /headroom/i, /not permission.*3C/i, /(?:not|never).*quota/i,
    /bounded.*deliverables/i,
  ]);
  concepts(stage(5, "Run"), [
    /await pool\.pop\(/, /(?:each|every) completion/i,
    /release gates[^.]*prerequisite[^.]*complete[^.]*checks pass/i,
    /refill.*immediate/i, /(?:avoid|no).*batch barriers/i,
    /work stealing[^.]*ready stages/i, /slots[^.]*not fixed worker partitions/i,
    /idle slots[^.]*borrowed/i, /zero-slot[^.]*no starvation-freedom promise/i,
    /queued tasks[^.]*exceed C/i, /(?:admitted|active) work[^.]*bounded/i,
    /starting[^.]*waiting[^.]*admission/i,
    /blocked tasks[^.]*not[^.]*ready headroom/i,
    /(?:not|must not)[^.]*consume agent slots/i, /frontier[^.]*drain/i,
    /integrat/i, /checks succeed/i, /integration owner/i,
    /(?:intermediate|evolving)[^.]*snapshots/i, /snapshot identity/i,
    /metadata\["rounds"\]/, /increment/i, /cap/i,
  ]);
});

test("runtime compatibility preflight rejects old APIs before constructing or dispatching work", () => {
  concepts(section("Input Contract"), [
    /loaded runtime[^.]*Stage 3 compatibility preflight/i,
    /skill edit[^.]*not upgrade[^.]*runtime/i,
  ]);
  const author = stage(3, "Author");
  orderedConcepts(author, [
    /import pi_subagents as subagents/i,
    /before constructing any tasks or pools/i,
    /subagents\.__file__/,
    /inspect\.signature\(subagents\.Task\)/,
    /inspect\.signature\(subagents\.AgentStage\.submit\)/,
    /inspect\.signature\(subagents\.AgentStage\.submit_all\)/,
    /stop blocked before dispatch/i,
    /write_cell[^.]*constants cell/i,
  ]);
  concepts(author, [
    /Task fields[^.]*agentDir[^.]*not[^.]*profile/i,
    /submit must accept parent, session_handle, and session_name/i,
    /submit_all accepts parent, not session-reuse arguments/i,
    /public exports[^.]*AgentPoolFailureError[^.]*PiSockSessionEnded/i,
    /SchemaValidationError/, /agent_dir_defaults/,
    /runtime source\/revision[^.]*installed distribution identity/i,
    /loaded skill path/i, /package version alone[^.]*not sufficient/i,
    /lifecycle and failure semantics[^.]*source[^.]*validation evidence/i,
    /matching signatures alone cannot prove success-only dormancy/i,
    /required authorized runtime\/skill update/i,
    /(?:not|never)[^.]*translate agentDir to profile/i,
    /(?:not|never)[^.]*silently drop arguments/i,
    /constants cell[^.]*compatibility checks[^.]*runtime\/skill identity/i,
  ]);
  orderedConcepts(stage(5, "Run"), [
    /constants cell[^.]*run_cell/i,
    /revalidate[^.]*compatibility checks[^.]*actually imported module/i,
    /before pool creation or dispatch/i,
    /without launching work/i,
    /execute[^.;]*workflow[^.;]*run_cell/i,
  ]);
});

test("runtime defaults distinguish strict workflow policy from library fallback behavior", () => {
  const defaults = section("Runtime compatibility and defaults");
  concepts(defaults, [
    /runtime C defaults to 8/i,
    /parser falls back to 8 for invalid text/i,
    /clamps integers below 1 to 1/i,
    /procedure[^.]*rejects invalid[^.]*non-positive[^.]*C/i,
    /AgentPool\(\) uses C/i,
    /explicit concurrency[^.]*integer from 1 through C[^.]*not a boolean/i,
    /regardless of queued roster size/i,
    /Task\.timeout=None[^.]*PI_SUBAGENTS_SETTLE_TIMEOUT[^.]*1800 seconds/i,
    /startup separately[^.]*PI_SUBAGENTS_STARTUP_TIMEOUT[^.]*90 seconds/i,
    /pool\.pop\(timeout=None\)[^.]*no waiting deadline/i,
    /explicit positive task and pop timeouts/i,
    /task timeout[^.]*not a queue-wait deadline/i,
    /schema repair defaults to three follow-ups after the initial reply/i,
    /PI_SUBAGENTS_SCHEMA_RETRIES[^.]*0 through 3[^.]*3 for invalid text/i,
    /record effective limits without changing the environment/i,
    /omitted Task\.agentDir[^.]*PI_CODING_SUBAGENT_DIR[^.]*PI_CODING_AGENT_DIR/i,
    /otherwise ~\/\.pi\/agent/i, /no implicit dedicated subagents profile/i,
    /bare explicit agentDir[^.]*~\/\.config\/pi\/profiles/i,
    /model and thinking omissions inherit[^.]*settings[^.]*not a hard-coded model/i,
    /agent_dir_defaults\(\)[^.]*default directory[^.]*not a per-task agentDir override/i,
  ]);
  concepts(section("Model, lifecycle, and replay discipline"), [
    /inherit the selected agent directory\/profile's default/i,
    /PI_SUBAGENTS_CATALOG_TTL[^.]*120 seconds/i,
    /list_models\(refresh=True\)/,
  ]);
});

test("installed skill lag and cached imports require authorized deployment and a fresh kernel", () => {
  concepts(section("Runtime compatibility and defaults"), [
    /repository skill, profile-installed skill, installed Python runtime, and live kernel/i,
    /newer checkout or edited skill[^.]*not change an editable install/i,
    /already-imported module/i, /subagents\.__file__/, /direct_url\.json/,
    /loaded APIs\/source rather than a main or dev label/i,
    /installed skill[^.]*removed arguments[^.]*premature pool close/i,
    /report that lag[^.]*authorized skill deployment[^.]*compatible runtime installation/i,
    /(?:not|never)[^.]*change profiles, configuration, environment variables, or dependencies/i,
    /authorized runtime update[^.]*fresh kernel[^.]*rerun the preflight/i,
    /cached imports[^.]*not acquire new code from a skill edit or disk update/i,
    /never reset an active kernel or hot-reload modules with live pools/i,
    /retain[^.]*namespace[^.]*inspection\/continuation[^.]*block incompatible new work/i,
  ]);
});

test("prompt contracts separate shared resources and gate dependent work", () => {
  concepts(section("Prompt contracts"), [
    /bounded deliverable/i, /stop condition/i, /identity/i, /objective/i, /Task\.cwd/,
    /(?:permitted files|read-only)/i, /forbidden effects/i, /dependencies/i,
    /acceptance checks/i, /timeout/i, /(?:fields|schema)/i, /escalation/i,
    /approved baseline identity/i, /(?:complete or blocked|blocked or complete)/i,
    /passed\/failed\/not-run/i, /(?:not|never)[^.]*release downstream gates/i,
    /(?:not|never).*another owner/i, /(?:not|never).*spawn subagents/i,
    /paths\/lines/i, /blocker/i, /follow-ups/i,
    /(?:not|never).*waiting for another agent/i, /prerequisites.*success/i,
    /validated dictionaries/i, /prose/i, /(?:not|never).*raw JSON/i,
  ]);
  concepts(stage(1, "Prepare"), [
    /ownership[^.]*files[^.]*shared resources/i,
    /outputs/i, /caches/i, /ports/i, /fixtures/i, /background processes/i,
    /exclusive owners or serialization gates/i,
    /read-only[^.]*mutate shared resources/i,
    /(?:effects|resources)[^.]*overlap[^.]*Stage 2/i,
    /otherwise[^.]*Stage 3/i,
  ]);
  concepts(stage(2, "Isolate"), [
    /permission[^.]*worktrees/i, /overlapping effects[^.]*isolation/i,
    /worktrees[^.]*not isolate shared/i, /(?:assign|serializ)[^.]*resources/i,
    /bounded allocation[^.]*budget/i, /(?:allocate lazily|lazy allocation)/i,
    /dispatch-ready[^.]*approved baseline/i,
    /never[^.]*worktree per queued[^.]*eagerly/i,
    /retained failed workspaces[^.]*budget/i,
    /(?:serialize conflicting effects|serializ[^.]*conflicts)/i,
    /(?:repartition|redesign)[^.]*ownership/i,
    /blocked[^.]*stop launching/i, /unaffected ready work[^.]*proceed/i,
    /integration gates/i,
  ]);
  concepts(stage(5, "Run"), [
    /integrate only after[^.]*checks succeed/i,
    /gate[^.]*dependent reviews\/checks[^.]*accepted writer completion/i,
    /serializ[^.]*repo-wide[^.]*shared resources/i,
    /schema[^.]*blocked report[^.]*not acceptance/i,
  ]);
});

test("lifecycle retains unsuccessful sessions and schedules dormant continuations safely", () => {
  concepts(stage(6, "Inspect"), [
    /failed/, /crashed/, /cancelled/, /timed-out/, /schema-exhausted/, /interrupted/,
    /manual inspection/i, /(?:not|never).*close pools.*error handlers/i, /finally/,
    /already died/i, /handle.*diagnostics/i,
  ]);
  const continuation = section("API and continuation contract");
  concepts(continuation, [
    /session_handle=result\.handle/, /parent[^.]*lineage/i, /metadata[^.]*overrides/i,
    /earlier results[^.]*unchanged/i, /SessionReuseError/,
    /(?:most one|single)[^.]*continuation[^.]*session/i,
    /dormancy[^.]*only[^.]*successfully validated/i, /latest[^.]*successful/i,
    /(?:all )?other outcomes[^.]*inspectable/i, /(?:not|never)[^.]*manually unload/i,
    /durable session identity\/path/i, /cached inspection/i, /explicit pool close/i,
    /dormant handle[^.]*not[^.]*start Pi/i, /pi --session/, /capacity[^.]*acquired/i,
    /stable tmux session ID/i, /not[^.]*cached session name/i, /renaming/i,
  ]);
  concepts(section("Failure contract"), [
    /AgentPoolFailureError/, /\.result/, /__cause__/,
    /exactly once/i, /SchemaValidationError/, /PiSockSessionEnded/,
    /AgentPoolTimeoutError/,
    /(?:not|never)[^.]*fabricate success[^.]*exception/i,
    /up to three repair follow-ups/i,
    /(?:not|never)[^.]*orchestration retries[^.]*schema-repair policy/i,
    /unexpected[^.]*interruptions[^.]*propagate/i,
    /pop timeout[^.]*not a task completion/i,
  ]);
});

test("send steers active turns and schedules exclusive retained-session continuations", () => {
  const continuation = section("API and continuation contract");
  concepts(continuation, [
    /handle\.send\(text\)/, /handle\.send_async\(text\)/, /steer[^.]*active/i,
    /settled[^.]*failed[^.]*cancelled/i,
    /scheduled prompt[^.]*requires[^.]*retained session/i,
    /new[^.]*scheduled prompt/i,
    /(?:acknowledgement|receipt)[^.]*not[^.]*agent reply/i,
    /(?:not|never)[^.]*independent completion/i,
    /(?:reopen[^.]*only[^.]*dormant|only[^.]*dormant[^.]*reopen)/i,
    /(?:no|without a)[^.]*retained session[^.]*cannot[^.]*continu/i,
    /dead[^.]*non-dormant[^.]*not[^.]*respawn/i,
    /(?:acknowledgement|receipt)[^.]*handle[^.]*handleId/i,
    /(?:consume|account).{0,160}completion.{0,80}exactly once/i,
    /(?:not mutate|unchanged)[^.]*old result|old result[^.]*unchanged/i,
    /(?:most one|single)[^.]*continuation[^.]*session/i,
    /(?:not|never)[^.]*concurrent follow-ups/i,
    /preserve[^.]*stage[^.]*name/i,
    /preserve[^.]*schema[^.]*timeout[^.]*metadata/i,
    /scheduled sends[^.]*result[^.]*parent[^.]*lineage/i,
    /(?:not|never)[^.]*increment[^.]*rounds|rounds[^.]*unchanged/i,
    /explicit stage submission[^.]*metadata[^.]*schema[^.]*round counter/i,
    /handle\.cancel\(\)/, /(?:removes|cancels)[^.]*queued work/i,
    /(?:abort|cancel)[^.]*starting\/running/i,
    /(?:false|no-op)[^.]*already-terminal/i,
    /cancel[^.]*new continuation handle/i,
    /cancellation[^.]*not unload[^.]*retained session/i,
    /(?:interrupt|timeout)[^.]*not cancel tasks/i,
  ]);
});

test("current dev notebook APIs preserve review and separate deliberate cleanup", () => {
  concepts(stage(3, "Author"), [
    /pi_subagents/, /help\(\)/, /dir\(\)/, /write_cell/, /constants cell/i,
    /(?:not|never)[^.]*construct tasks[^.]*here/i, /Task/, /explicit.*cwd/i,
    /replay/i, /inputs match/i, /(?:not|never).*partial or failed/i,
    /separate.*teardown cell/i, /synchronous.*pool\.close\(\)/,
    /without.*await/i, /at least three.*cells/i,
  ]);
  concepts(stage(4, "Review"), [
    /autonomy/i, /no prompts/i, /skip.*review/i, /request_cell_review/,
    /never executes/i, /(?:no|not).*review\/confirmation flag/i,
    /rejection/i, /scope/i,
  ]);
  const run = stage(5, "Run");
  concepts(run, [
    /run_cell/, /one orchestration consumer/i,
    /(?:execution|validation) fails[^.]*without launching work/i,
    /(?:validat|verif|check)[^.]*approved inputs/i,
  ]);
  orderedConcepts(run, [
    /(?:execute|run)[^.]*constants[^.]*run_cell/i,
    /(?:validat|verif|check)[^.]*successful execution/i,
    /(?:execute|run)[^.;]*workflow[^.;]*run_cell/i,
  ]);
  concepts(stage(7, "Teardown"), [
    /dedicated teardown cell/i, /pool\.close\(\)/, /without.*await/i,
    /PoolSummary/, /subagents\.finish\(\)/, /deliberate cleanup/i,
    /(?:not|never).*cleanup as validation/i,
  ]);
  concepts(section("Model, lifecycle, and replay discipline"), [
    /inherit.*profile.*default/i, /best_model_match/, /with AgentPool/,
    /clean exit/i, /exceptions.*intact/i, /separate teardown/i,
    /interrupts.*not pools/i, /run_all/, /stale outputs/i, /permission/i,
  ]);
  assert.doesNotMatch(skill, /(?:confirm|review)\s*=\s*(?:true|True)/);
  assert.doesNotMatch(skill, /\.(?:ok|unwrap)\b/);
});

test("recursive policy preserves flat default, shared live admission, and local telemetry scope", () => {
  concepts(section("Recursive admission and scope"), [
    /opt-in/i, /maximum depth 1 is flat/i, /maximum 2 permits grandchildren/i,
    /maximum 3/i, /C remains per process/i, /all kernels and descendants/i,
    /live-window cap/i, /same primary voice/i, /immutable root limits and deadline/i,
    /window admissions and dormant reopens, not every conversation turn/i,
    /bounds root admission and waits/i, /failed retained windows stay charged/i,
    /launcher exited/i, /parent-await-child saturation fails fast/i,
    /existing inherited interpreter and source/i, /explicit child environment forwarding/i,
    /no nested installer/i, /incompatibility blocks dispatch/i,
    /owned descendants recursively, never the caller or unrelated panes/i,
    /no cross-process pi-sock child snapshot relay/i,
    /do not add descendant estimates to local totals/i,
  ]);
  concepts(section("Input Contract"), [
    /maximum 1 is flat/i, /imports remain legal at the maximum depth/i,
    /only spawning is blocked/i, /never edit them to bypass admission/i,
  ]);
  concepts(section("Prompt contracts"), [
    /must not spawn subagents unless their task explicitly authorizes bounded recursion/i,
    /primary voice in the root/i,
  ]);
});

test("nested authorization and decreasing fuel prevent depth, fanout, and continuation loops", () => {
  concepts(section("Delegation authorization and fuel"), [
    /capability, not permission/i,
    /explicit parent authorization/i,
    /delegation_jobs_remaining.*delegation_levels_remaining/i,
    /missing.authorization.*missing.invalid budgets.*B=0.*L=0 means no delegation/i,
    /finite B from its approved work plan/i,
    /leaves receive B=0 and L=0/i,
    /task plus its allocated B_child/i,
    /sum of all reserved child allocations.*not exceed/i,
    /L_child at most L-1/i,
    /submission, retry, and scheduled continuation against B/i,
    /do not refund failed or cancelled work/i,
    /continuation preserves spent fuel and round counts/i,
    /metadata alone does not teach a child/i,
    /orchestrators to load this skill/i,
    /strictly narrower independently verifiable deliverable/i,
    /enclosing objective unchanged/i,
    /3C does not create delegation fuel or permission/i,
    /child deadlines cannot exceed the parent's/i,
    /if recovery is uncertain, block new delegation/i,
    /manual Pi.tmux launches, new root identities/i,
    /not extra runtime-enforced capabilities/i,
    /hard backstop/i,
  ]);
  concepts(stage(1, "Prepare"), [/parent authorization and allocated B.L/i, /finite total fuel/i]);
  concepts(section("Prompt contracts"), [/delegated B.L/i, /before creating any pool/i,
    /forbid spawning in leaf assignments/i]);
  assert.ok(skill.split(/\r?\n/).length <= 500, "canonical skill stays below 500 lines");
});

test("fanout branches integrate and clean up by default without unsolicited PRs", () => {
  concepts(section("Delivery and branch lifecycle"), [
    /internal orchestration details, not deliverables/i,
    /do not create PRs unless the user explicitly asks/i,
    /unless the user specifies another end state.*merge every contributing branch/i,
    /intended integration branch, validate, and push it before finishing/i,
    /root owns integration and cleanup/i,
    /ancestor of the published integration tip/i,
    /closing a PR is not a substitute for merging/i,
    /after workers stop, delete only owned temporary fan-out branches from the remote/i,
    /local branches.worktrees when safe, preserving user data/i,
    /never delete main, dev, the integration branch, canonical worktrees, or unrelated work/i,
    /do not discard unmerged work/i,
    /keep blocked branches intact and report the blocker/i,
    /report delivered behavior, not an internal branch roster/i,
  ]);
  concepts(stage(6, "Inspect"), [/delivery and branch lifecycle integration gate/i]);
  concepts(stage(7, "Teardown"), [/cleanup after workers stop/i, /unrelated or unmerged work/i]);
});
