import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const skill = readFileSync(new URL("../skills/pi-subagents/SKILL.md", import.meta.url), "utf8");
const prose = skill.toLowerCase().replace(/\s+/g, " ");

function section(title: string): string {
  const marker = `\n${title}\n`;
  const start = skill.indexOf(marker);
  assert.notEqual(start, -1, `missing ${title}`);
  const tail = skill.slice(start + marker.length);
  const next = tail.search(/\n#{1,2} /);
  return next === -1 ? tail : tail.slice(0, next);
}

test("subagent skill is a standalone bounded-width procedure without demonstrations", () => {
  assert.match(skill, /^---\nname: pi-subagents\ndescription: "Use when /);
  assert.match(skill, /metadata:\n  type: procedure\n---\n\n# Contract/);
  assert.ok(skill.split("\n").length < 500);
  assert.ok(skill.split("\n").every((line) => line.length <= 100));
  assert.ok(!skill.includes("```"));
  for (const title of ["## Input Contract", "## Output Contract", "# Entrypoint"])
    assert.ok(skill.includes(title));
});

test("builders explore subsystems in worktrees rather than implementing file allowlists", () => {
  assert.ok(prose.includes("decompose by cohesive subsystems"));
  assert.ok(prose.includes("builders choose their own files, interfaces and design"));
  assert.ok(prose.includes("isolation is the default"));
  assert.ok(prose.includes("worktree ownership replaces per-file ownership"));
  assert.ok(prose.includes("do not prescribe implementation interfaces"));
  assert.ok(prose.includes("do not invent a delivery deadline"));
});

test("initial 3C Build items use submit_all without a maintained ready-frontier quota", () => {
  const author = section("## Stage 3: Author and submit the initial cohort");
  assert.match(author, /3C initial Build items/);
  assert.match(author, /build\.submit_all/);
  assert.match(author, /not 3C simultaneously running/);
  assert.ok(prose.includes("not maintain a predictive 3c frontier"));
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
      "atomically claim", "quiescent", "one orphan carry at a level", "multiple levels"])
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
  for (const term of ["entire workflow", "do not delete", "6c-1", "authorized",
      "not a reason to lower c", "sccache", "only then", "remote branches", "unmerged",
      "blocked requested subsystem", "retain recoverable state"])
    assert.ok(retention.includes(term), term);
});

test("saved-cell review, explicit kernels, nonrecursive leaves and native compaction remain required", () => {
  for (const term of ["explicit kernel selection", "review the saved", "finite inherited delegation fuel",
      "leaves have zero delegation fuel", "native compaction", "deduplicate submission"])
    assert.ok(prose.includes(term), term);
  assert.ok(prose.includes("for read-only work"));
});

test("retained handle, failure and replay contracts remain explicit", () => {
  for (const term of ["session_handle=result.handle", "agentpoolfailureerror", "pisocksessionended",
      "inspect a dormant", "success-only dormancy", "do not blindly", "run_all"])
    assert.ok(prose.includes(term) || (term === "inspect a dormant" && prose.includes("inspecting a dormant")), term);
});

// Exercise the documented binary reduction, including quiescent odd carries.
function reduceNodes(n: number) {
  const buckets = new Map<number, Set<number>[]>();
  buckets.set(0, Array.from({ length: n }, (_, i) => new Set([i])));
  let merges = 0, crossDepth = 0;
  const carryLevels = new Set<number>();
  while ([...buckets.values()].reduce((sum, nodes) => sum + nodes.length, 0) > 1) {
    const levels = [...buckets.keys()].sort((a, b) => a - b);
    const same = levels.find((depth) => buckets.get(depth)!.length >= 2);
    let leftDepth: number, rightDepth: number;
    if (same !== undefined) leftDepth = rightDepth = same;
    else {
      const ready = levels.filter((depth) => buckets.get(depth)!.length);
      [leftDepth, rightDepth] = ready;
      assert.ok(!carryLevels.has(rightDepth));
      carryLevels.add(rightDepth);
      crossDepth++;
    }
    const left = buckets.get(leftDepth)!.pop()!;
    const right = buckets.get(rightDepth)!.pop()!;
    for (const leaf of left) assert.ok(!right.has(leaf));
    const merged = new Set([...left, ...right]);
    const depth = Math.max(leftDepth, rightDepth) + 1;
    if (!buckets.has(depth)) buckets.set(depth, []);
    buckets.get(depth)!.push(merged);
    merges++;
  }
  const root = [...buckets.values()].find((nodes) => nodes.length)![0];
  assert.deepEqual([...root].sort((a, b) => a - b), Array.from({ length: n }, (_, i) => i));
  assert.equal(merges, n - 1);
  return { merges, crossDepth, worktrees: n + merges };
}

test("balanced reduction terminates and preserves every contributor for odd and even cohorts", () => {
  for (let n = 1; n <= 512; n++) reduceNodes(n);
  for (const C of [1, 2, 4, 7, 24]) assert.equal(reduceNodes(3 * C).worktrees, 6 * C - 1);
  assert.equal(reduceNodes(21).crossDepth, 2);
});
