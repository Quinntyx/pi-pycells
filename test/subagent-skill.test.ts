import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const skill = readFileSync(new URL("../skills/pi-subagents/SKILL.md", import.meta.url), "utf8");
const workflow = readFileSync(
  new URL("../skills/pi-subagents/references/implementation-workflow.md", import.meta.url), "utf8");
const combined = `${skill}
${workflow}`;
const prose = combined.toLowerCase().replace(/\s+/g, " ");

function section(title: string, document = combined): string {
  const marker = `\n${title}\n`;
  const start = document.indexOf(marker);
  assert.notEqual(start, -1, `missing ${title}`);
  const tail = document.slice(start + marker.length);
  const next = tail.search(/\n#{1,2} /);
  return next === -1 ? tail : tail.slice(0, next);
}

test("subagent skill is a standalone bounded-width procedure without demonstrations", () => {
  assert.match(skill, /^---\nname: pi-subagents\ndescription: "Use when /);
  assert.match(skill, /metadata:\n  type: procedure\n---\n\n# Contract/);
  assert.ok(skill.split("\n").length < 500);
  assert.ok(skill.split("\n").every((line) => line.length <= 100));
  for (const document of [skill, workflow]) {
    assert.ok(document.split("\n").every((line) => line.length <= 100));
    assert.ok(!document.includes("```"));
    assert.ok(!/\b(?:subagents|pi_subagents)\.agent\b|\bfrom pi_subagents import[^\n]*\bagent\b/.test(document));
  }
  for (const title of ["## Input Contract", "## Output Contract", "# Entrypoint"])
    assert.ok(skill.includes(title));
});


test("individual delegation is the default and counts do not imply a workflow", () => {
  const select = section("## Stage 1: Select the delegation mode", skill)
    .toLowerCase().replace(/\s+/g, " ");
  for (const term of ["default to lightweight delegation", "does not request a workflow",
      "agent count alone", "user explicitly requests a workflow", "scope is large enough",
      "do not expand a request for n agents to 2c tasks", "total-launch cap"])
    assert.ok(select.includes(term), term);
  const contract = section("## Input Contract", skill).toLowerCase();
  assert.ok(!contract.includes("forgejo"));
  assert.ok(!contract.includes("review cap"));
});

test("one agent uses one pool, stage and Task without implementation workflow requirements", () => {
  const prepare = section("## Stage 2: Prepare only what this work needs", skill)
    .toLowerCase().replace(/\s+/g, " ");
  assert.ok(prepare.includes("import agentpool and task from pi_subagents"));
  assert.ok(prepare.includes("agentpool is the launch entrypoint for both individual agents"));
  const single = section("## Stage 3: Spin up individual subagents", skill)
    .toLowerCase().replace(/\s+/g, " ");
  for (const term of ["one agentpool with concurrency one", "slots one", "one task",
      "stage.submit", "retain the returned handle", "no additional build/review/merge stages",
      "submit exactly the requested n", "no mandatory five-cycle", "await handle", "pool.pop",
      "same outcome twice", "start-only or background", "without waiting or closing the pool",
      "new handle", "do not close the pool between turns"])
    assert.ok(single.includes(term), term);
});

test("implementation protocol is progressively loaded only in selected workflow mode", () => {
  const dispatch = section("## Stage 4: Run a selected workflow", skill)
    .toLowerCase().replace(/\s+/g, " ");
  assert.ok(dispatch.includes("references/implementation-workflow.md"));
  assert.ok(dispatch.includes("only within that selected mode"));
  assert.ok(dispatch.includes("requested non-implementation workflow"));
  assert.ok(dispatch.includes("do not import build ci"));
  assert.ok(!skill.includes("## Stage 2: Establish CI before fan-out"));
  assert.ok(!skill.includes("## Stage 5: Balanced mechanical merge and CI gate"));
  assert.match(workflow, /conditional workflow policy, not general AgentPool requirements/);
  const initial = section("## Stage 3: Author and submit the initial cohort", workflow)
    .toLowerCase().replace(/\s+/g, " ");
  assert.ok(initial.includes("preserve an explicit requested builder count n"));
  assert.ok(initial.includes("smaller power-of-two cohort or return to lightweight delegation"));
});

test("lightweight completion retains active sessions and closes only its finished pool", () => {
  const finish = section("## Stage 5: Report, retain or close", skill)
    .toLowerCase().replace(/\s+/g, " ");
  for (const term of ["if agents are active", "follow-up is expected", "failure recovery",
      "no continuation is needed", "close that pool explicitly", "invalidates its handles",
      "do not close unrelated pools globally", "cleanup needs separate authorization"])
    assert.ok(finish.includes(term), term);
});

test("builders explore subsystems in worktrees rather than implementing file allowlists", () => {
  assert.ok(prose.includes("decompose by cohesive subsystems"));
  assert.ok(prose.includes("builders choose their own files, interfaces and design"));
  assert.ok(prose.includes("isolation is the default"));
  assert.ok(prose.includes("worktree ownership replaces per-file ownership"));
  assert.ok(prose.includes("do not prescribe implementation interfaces"));
  assert.ok(prose.includes("do not invent a delivery deadline"));
});

test("initial 2C Build items use submit_all without a maintained ready-frontier quota", () => {
  const author = section("## Stage 3: Author and submit the initial cohort");
  assert.match(author, /2C initial Build items/);
  assert.match(author, /build\.submit_all/);
  assert.match(author, /not 2C simultaneously running/);
  assert.ok(prose.includes("not maintain a predictive 2c frontier"));
  assert.ok(prose.includes("do not refill") || prose.includes("or refill merely"));
  assert.ok(prose.includes("live admission remains c"));
});

test("Forgejo test CI must be green before fan-out and cover temporary branches", () => {
  const ci = section("## Stage 2: Establish CI before fan-out").toLowerCase();
  for (const term of ["git.quinntyx.dev", "forgejo actions", "test discovery",
      ".forgejo/workflows", ".github/workflows", "runner", "every temporary build and merge branch",
      "exact commit", "builders' baseline", "infrastructure blockers"])
    assert.ok(ci.includes(term), term);
  assert.ok(prose.includes("ensure ci actually runs those tests"));
  assert.ok(prose.includes("missing, queued, running, skipped"));
});

test("intermediate review is explicitly scoped and loose while CI remains mandatory", () => {
  const review = section("## Stage 4: Intermediate review and repair").toLowerCase();
  for (const term of ["intermediate", "ignore bugs outside", "relatively loose", "critical logic",
      "races", "deadlocks", "crashing exceptions", "nits", "ci remains a hard gate",
      "original builder", "default cap is five"])
    assert.ok(review.replace(/\s+/g, " ").includes(term), term);
});

test("merge reduction uses same-depth buckets and repair only for actual merge or CI failure", () => {
  const merge = section("## Stage 5: Balanced mechanical merge and CI gate")
    .toLowerCase().replace(/\s+/g, " ");
  for (const term of ["same depth", "ordinary git merge", "depth d+1", "flat",
      "do not spawn merge agents by default", "textual conflicts", "ci failure after merge",
      "semantic incompatibility", "build repair", "five-cycle", "no intermediate agent pass",
      "atomically claim", "no merge orphans", "equal-depth siblings", "never carry a",
      "all n original contributors", "depth log2(n)"])
    assert.ok(merge.includes(term), term);
});

test("final review covers the whole tree with an independent five-cycle gate", () => {
  const final = section("## Stage 6: Final review and integration").toLowerCase();
  assert.ok(final.includes("final review"));
  assert.ok(final.includes("stricter project-wide standards"));
  assert.ok(final.includes("default final review/repair cap is five"));
  assert.ok(final.includes("separately from intermediate cycles"));
  assert.ok(final.includes("target ci green"));
  assert.ok(final.includes("never force-push"));
});

test("large worktree counts are allowed and all remote/local recovery nodes survive until completion", () => {
  const retention = section("## Stage 7: Retention, cleanup and handoff")
    .toLowerCase().replace(/\s+/g, " ");
  for (const term of ["entire workflow", "do not delete", "4c-1", "authorized",
      "not a reason to lower c", "sccache", "only then", "remote branches", "unmerged",
      "blocked requested subsystem", "retain recoverable state"])
    assert.ok(retention.includes(term), term);
});

test("saved-cell review, explicit kernels, nonrecursive leaves and native compaction remain required", () => {
  for (const term of ["explicit kernel selection", "review the saved", "finite inherited delegation fuel",
      "leaves have zero delegation fuel", "native compaction", "deduplicate submission"])
    assert.ok(prose.includes(term), term);
  assert.ok(prose.includes(
    "read-only agents may share immutable inputs without worktrees, ci setup or git mutation"));
});

test("retained handle, failure and replay contracts remain explicit", () => {
  for (const term of ["session_handle=result.handle", "agentpoolfailureerror", "pisocksessionended",
      "inspect a dormant", "success-only dormancy", "do not blindly", "run_all"])
    assert.ok(prose.includes(term) || (term === "inspect a dormant" && prose.includes("inspecting a dormant")), term);
});

// Only power-of-two cohorts belong to the documented balanced merge protocol.
function reduceNodes(n: number) {
  assert.ok(Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0, "power of two required");
  let nodes = Array.from({ length: n }, (_, i) => ({ leaves: new Set([i]), depth: 0 }));
  let merges = 0;
  while (nodes.length > 1) {
    const next: typeof nodes = [];
    for (let i = 0; i < nodes.length; i += 2) {
      const left = nodes[i]!, right = nodes[i + 1]!;
      assert.equal(left.depth, right.depth);
      for (const leaf of left.leaves) assert.ok(!right.leaves.has(leaf));
      next.push({ leaves: new Set([...left.leaves, ...right.leaves]), depth: left.depth + 1 });
      merges++;
    }
    nodes = next;
  }
  assert.deepEqual([...nodes[0]!.leaves].sort((a, b) => a - b),
    Array.from({ length: n }, (_, i) => i));
  assert.equal(merges, n - 1);
  assert.equal(nodes[0]!.depth, Math.log2(n));
  return { merges, worktrees: n + merges };
}

test("power-of-two cohorts reduce without orphan handling and preserve all contributors", () => {
  for (let n = 1; n <= 1024; n *= 2) reduceNodes(n);
  for (const C of [1, 2, 4, 8, 16, 32, 64])
    assert.equal(reduceNodes(2 * C).worktrees, 4 * C - 1);
  for (const n of [0, -1, 3, 5, 6, 24, 3.5]) assert.throws(() => reduceNodes(n));
  assert.ok(prose.includes("positive powers of two"));
  assert.ok(!/lowest-depth orphan|orphan carry|cross-depth carries/.test(workflow));
});


test("configuration docs preserve the reference and describe installed SDK sources", () => {
  const config = readFileSync(new URL("../docs/configuration.md", import.meta.url), "utf8");
  for (const heading of ["## What it does", "## How it works", "## Usage", "## Environment variables",
    "### Execution", "### Tool policy", "### Routing, recovery, sessions", "### Paths and library",
    "### pi-subagents provisioning", "### Fixed limits (not configurable)"]) {
    assert.ok(config.includes(heading), heading);
  }
  assert.ok(config.includes("Installed SDK source, or managed remote `dev` cache"));
  assert.ok(!config.includes("~/docs/src/pi-subagents"));
});
