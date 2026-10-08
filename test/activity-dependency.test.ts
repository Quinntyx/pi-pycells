const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));

test("pi-activity tracks dev as a runtime dependency, not optional or peer-only", () => {
  assert.equal(manifest.dependencies["pi-activity"],
    "git+https://git.quinntyx.dev/quinntyx/pi-activity.git#dev");
  assert.equal(manifest.peerDependencies?.["pi-activity"], undefined);
  assert.equal(manifest.optionalDependencies?.["pi-activity"], undefined);
});

test("Pi loads the bundled activity API before the transport and notebook extension", () => {
  assert.ok(manifest.bundledDependencies.includes("pi-activity"));
  const extensions = manifest.pi.extensions;
  const activity = extensions.indexOf("./node_modules/pi-activity/extensions/index.ts");
  assert.ok(activity >= 0 && activity < extensions.indexOf("./node_modules/pi-sock/index.ts"));
  assert.ok(activity < extensions.indexOf("./src/index.ts"));
});

test("lockfile pins and bundles pi-activity consistently with the manifest", () => {
  const bundled = lock.packages["node_modules/pi-activity"];
  assert.deepEqual(lock.packages[""].dependencies, manifest.dependencies);
  assert.match(bundled.resolved,
    /^git\+https:\/\/git\.quinntyx\.dev\/quinntyx\/pi-activity\.git#[a-f0-9]{40}$/);
  assert.equal(bundled.inBundle, true);
});

test("project npm policy permits only directly declared Git dependencies", () => {
  const config = fs.readFileSync(path.join(root, ".npmrc"), "utf8");
  assert.match(config, /^allow-git=root$/m);
});
