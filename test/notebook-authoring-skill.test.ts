const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const skillPath = "skills/notebook-authoring/SKILL.md";
function readSkill() {
  return fs.readFileSync(path.join(root, skillPath), "utf8");
}
function section(skill: string, heading: string) {
  const start = skill.indexOf(`\n${heading}\n`);
  assert.notEqual(start, -1, heading);
  const tail = skill.slice(start + heading.length + 2);
  const end = tail.search(/\n#{1,2} /);
  return (end < 0 ? tail : tail.slice(0, end)).replace(/\s+/g, " ");
}

test("authoring is a named package skill; separate orchestration filters remain addressable", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.deepEqual(manifest.pi.skills, ["./skills/notebook-authoring", "./skills/pi-subagents"]);
  assert.ok(manifest.files.includes("skills"));
  assert.ok(!fs.existsSync(path.join(root, "skills/notebook-workflow")));
  assert.match(readSkill(), /^---\nname: notebook-authoring\n/);
});

test("discovery is limited to reusable artifacts, not routine kernel use", () => {
  const skill = readSkill();
  const description = skill.split("---")[1].match(/description: ([\s\S]*?)\nmetadata:/)[1]
    .replace(/\s+/g, " ");
  assert.match(description, /creating, editing, repairing, or handing over a reusable/);
  for (const excluded of ["routine kernel analysis", "single throwaway cells", "general Python work",
    "delegation", "orchestration"])
    assert.ok(description.includes(excluded), excluded);
  assert.match(skill, /metadata:\n  type: procedure/);
  for (const heading of ["# Contract", "# Author", "# Replay safely", "# Validate and hand off"])
    assert.ok(skill.includes(heading), heading);
  assert.doesNotMatch(skill, /pi-subagents|pi_subagents|AgentPool|T3|delegate_task|pool\.close/);
});

test("operation guidance distinguishes document writes, live execution and fresh replay", () => {
  const skill = readSkill();
  const state = section(skill, "## State and operations");
  assert.match(state, /write_cell.*[Rr]eplaces.*appends.*past the end/);
  assert.doesNotMatch(state, /[Ii]nserts?\b|[Rr]ebuilds (?:the )?(?:full )?namespace/);
  assert.match(state, /run_to.*run_all.*existing live namespace/);
  assert.match(state, /reset_kernel.*disk.*untouched/);
  assert.match(state, /delete_cell.*namespace.*unchanged/);
  const handoff = section(skill, "# Validate and hand off");
  assert.match(handoff, /reset_kernel.*then.*run_all/);
  assert.match(handoff, /not.*fresh.*environment/);
});

test("cache guidance requires identity and validated completion, not file existence", () => {
  const replay = section(readSkill(), "# Replay safely");
  for (const requirement of ["input content", "configuration", "code/method version",
    "dependency versions", "invalidation", "schema", "atomic", "external effects"])
    assert.ok(replay.includes(requirement), requirement);
  assert.match(replay, /module.*not.*replay-safe/);
  assert.match(replay, /file existence.*not.*completion/);
});

test("reference paths resolve and documentation does not advertise a nonexistent library skill", () => {
  const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
  const library = fs.readFileSync(path.join(root, "docs/notebook-library.md"), "utf8");
  assert.ok(readme.includes(`(${skillPath})`));
  assert.ok(library.includes("../skills/notebook-authoring/SKILL.md"));
  for (const doc of [readme, library]) {
    assert.doesNotMatch(doc, /notebook-workflow/);
    assert.doesNotMatch(doc, /\*\*pycells-library\*\*/);
  }
  const skill = readSkill();
  for (const match of skill.matchAll(/\]\(([^)]+\.md)\)/g))
    assert.ok(fs.existsSync(path.resolve(root, "skills/notebook-authoring", match[1])), match[1]);
});
