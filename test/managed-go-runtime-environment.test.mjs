import assert from "node:assert/strict";
import * as fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { loadManagedGoRuntimeEnvironment } from "../src/managed-go-runtime-environment.mjs";

const DUMMY = "fixture<&>\"'Go-value";
const credentialId = "cred_abcdefghijklmnop";
const xml = value => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
const encode = value => Array.isArray(value) ? `<array>${value.map(encode).join("")}</array>` : value && typeof value === "object" ? `<dict>${Object.entries(value).map(([key, item]) => `<key>${xml(key)}</key>${encode(item)}`).join("")}</dict>` : `<string>${xml(value)}</string>`;
function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(process.cwd()), ".managed-go-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateDir = path.join(root, "state"); fs.mkdirSync(stateDir, { mode: 0o700 });
  const plistPath = path.join(root, "router.plist");
  const installManifestPath = path.join(stateDir, "install-manifest.json");
  const credentialStorePath = path.join(stateDir, "provider-credentials.json");
  const poolStatePath = path.join(stateDir, "provider-api-key-pools.json");
  const document = { Label: "io.github.codex-router", ProgramArguments: [process.execPath, path.join(root, "src", "start.mjs")], WorkingDirectory: root, EnvironmentVariables: { MODEL_ROUTER_STATE_DIR: stateDir, CODEX_ROUTER_STATE_DIR: stateDir, KIMI_CODEX_STATE_DIR: stateDir, CODEX_ROUTER_SOURCE_ROOT: root, OPENCODE_API_KEY: DUMMY, OPENCODE_GO_API_KEY: "UNREFERENCED_FIXTURE", OPENROUTER_API_KEY: "FOREIGN_FIXTURE", PATH: "/managed-only" } };
  const save = () => fs.writeFileSync(plistPath, `<?xml version="1.0"?><plist version="1.0">${encode(document)}</plist>`, { mode: 0o600 });
  const store = { schemaVersion: 2, credentials: [{ id: credentialId, providerId: "opencode-go", state: "active", kind: "api_key", secretRef: { type: "environment", providerId: "opencode-go", target: "codex", name: "OPENCODE_API_KEY" } }] };
  const saveStore = () => fs.writeFileSync(credentialStorePath, JSON.stringify(store), { mode: 0o600 });
  fs.writeFileSync(installManifestPath, JSON.stringify({ version: 1, current: { sourceRoot: root } }), { mode: 0o600 });
  fs.writeFileSync(poolStatePath, JSON.stringify({ version: 1, providers: { "opencode-go": { credentials: { [credentialId]: {} } } } }), { mode: 0o600 });
  save(); saveStore();
  return { root, stateDir, plistPath, installManifestPath, credentialStorePath, poolStatePath, document, store, save, saveStore, sourceRoot: root, environment: { PATH: "/inherited", LEGITIMATE: "yes" } };
}
const mac = { skip: process.platform !== "darwin" };

test("real plutil decodes XML and carries only active authoritative Go environment references", mac, t => {
  const f = fixture(t);
  const before = { ...f.environment };
  assert.equal(JSON.stringify(loadManagedGoRuntimeEnvironment(f)) === JSON.stringify({ PATH: "/inherited", LEGITIMATE: "yes", OPENCODE_API_KEY: DUMMY }), true, "filtered environment differs");
  assert.equal(JSON.stringify(f.environment) === JSON.stringify(before), true);
  delete f.document.EnvironmentVariables.CODEX_ROUTER_SOURCE_ROOT; f.save();
  assert.equal(loadManagedGoRuntimeEnvironment(f).OPENCODE_API_KEY === DUMMY, true, "Go credential did not survive");
  for (const mutate of [c => c.state = "inactive", c => c.secretRef.target = "dsh", c => c.providerId = "openrouter", c => c.id = "cred_unreferenced0000"]) {
    const previous = structuredClone(f.store.credentials[0]); mutate(f.store.credentials[0]); f.saveStore();
    assert.equal(JSON.stringify(loadManagedGoRuntimeEnvironment(f)) === JSON.stringify(f.environment), true, "inactive reference was carried");
    f.store.credentials[0] = previous;
  }
});

test("equal inherited Go values are accepted and unequal values fail without exposing either", mac, t => {
  const f = fixture(t);
  assert.equal(loadManagedGoRuntimeEnvironment({ ...f, environment: { OPENCODE_API_KEY: DUMMY } }).OPENCODE_API_KEY === DUMMY, true, "equal inherited credential changed");
  assert.throws(() => loadManagedGoRuntimeEnvironment({ ...f, environment: { OPENCODE_API_KEY: "CONFLICT_FIXTURE" } }), error => error.code === "managed_go_environment_conflict" && !String(error.stack).includes(DUMMY) && !String(error.stack).includes("CONFLICT_FIXTURE"));
});

test("unsafe plist paths, owner, mode, bounded size and replacement fail closed", mac, t => {
  const f = fixture(t);
  for (const mode of [0o644, 0o400, 0o660]) { fs.chmodSync(f.plistPath, mode); assert.throws(() => loadManagedGoRuntimeEnvironment(f), { code: "managed_go_environment_untrusted" }); }
  fs.chmodSync(f.plistPath, 0o600);
  assert.throws(() => loadManagedGoRuntimeEnvironment({ ...f, currentUid: process.getuid() + 1 }), { code: "managed_go_environment_untrusted" });
  fs.writeFileSync(f.plistPath, "x".repeat(2 * 1024 * 1024 + 1)); assert.throws(() => loadManagedGoRuntimeEnvironment(f));
  fs.unlinkSync(f.plistPath); fs.mkdirSync(f.plistPath); assert.throws(() => loadManagedGoRuntimeEnvironment(f)); fs.rmdirSync(f.plistPath);
  const target = path.join(f.root, "target.plist"); f.save(); fs.renameSync(f.plistPath, target); fs.symlinkSync(target, f.plistPath); assert.throws(() => loadManagedGoRuntimeEnvironment(f)); fs.unlinkSync(f.plistPath); fs.renameSync(target, f.plistPath);
  const alias = path.join(f.root, "alias"); fs.symlinkSync(f.root, alias); assert.throws(() => loadManagedGoRuntimeEnvironment({ ...f, plistPath: path.join(alias, "router.plist") }));
  fs.chmodSync(f.root, 0o777); assert.throws(() => loadManagedGoRuntimeEnvironment(f)); fs.chmodSync(f.root, 0o700);
  let replaced = false;
  const originalInode = fs.lstatSync(f.plistPath).ino;
  assert.throws(() => loadManagedGoRuntimeEnvironment({ ...f, filesystem: { ...fs, readSync(...args) { const result = fs.readSync(...args); if (!replaced && fs.fstatSync(args[0]).ino === originalInode) { replaced = true; fs.renameSync(f.plistPath, target); f.save(); } return result; } } }), { code: "managed_go_environment_untrusted" });
});

test("malformed plists and mismatching managed installation locators are rejected", mac, t => {
  const f = fixture(t);
  const baseline = structuredClone(f.document);
  const mutations = [d => d.Label = "foreign", d => d.ProgramArguments.push("extra"), d => d.ProgramArguments[0] = "/wrong/node", d => d.ProgramArguments[1] = "/wrong/start.mjs", d => d.WorkingDirectory = "/wrong", d => d.EnvironmentVariables.MODEL_ROUTER_STATE_DIR = "/wrong", d => delete d.EnvironmentVariables.CODEX_ROUTER_STATE_DIR, d => d.EnvironmentVariables.KIMI_CODEX_STATE_DIR = "/wrong", d => d.EnvironmentVariables.CODEX_ROUTER_SOURCE_ROOT = "/wrong", d => d.EnvironmentVariables.OPENCODE_API_KEY = { nested: DUMMY }];
  for (const mutate of mutations) { Object.assign(f.document, structuredClone(baseline)); mutate(f.document); f.save(); assert.throws(() => loadManagedGoRuntimeEnvironment(f), error => !String(error.stack).includes(DUMMY)); }
  Object.assign(f.document, baseline); f.save();
  fs.writeFileSync(f.installManifestPath, JSON.stringify({ version: 1, current: { sourceRoot: "/wrong" } })); assert.throws(() => loadManagedGoRuntimeEnvironment(f));
  fs.writeFileSync(f.plistPath, `<plist>${DUMMY}`); assert.throws(() => loadManagedGoRuntimeEnvironment(f), error => !String(error.stack).includes(DUMMY));
});

test("environment assertion failures contain only booleans and a fixed message", () => {
  let rendered;
  try { assert.equal(JSON.stringify({ OPENCODE_API_KEY: DUMMY }) === JSON.stringify({ OPENCODE_API_KEY: "different-fixture" }), true, "synthetic environment comparison failed"); }
  catch (error) { rendered = String(error.stack); }
  assert.equal(typeof rendered === "string" && !rendered.includes(DUMMY) && !rendered.includes("different-fixture"), true, "assertion reporting guard failed");
});

test("scheduled bridge uses the trusted loader and leaves its path-only state free of credentials", mac, async t => {
  const f = fixture(t);
  const { runScheduledGoAutoCatalog, renderLaunchdPlist } = await import("../src/opencode-go-auto-catalog.mjs");
  const policyPath = path.join(f.stateDir, "opencode-go-auto-catalog-policy.json");
  fs.writeFileSync(policyPath, JSON.stringify({ version: 1, enabled: true, sourceRoot: f.sourceRoot, stateDir: f.stateDir }), { mode: 0o600 });
  let launched = false;
  const result = await runScheduledGoAutoCatalog({ ...f, discoveryDisabledCheck: () => false,
    loadEnvironment: options => loadManagedGoRuntimeEnvironment({ ...f, ...options }),
    spawnUpdater: async ({ environment }) => { launched = environment.OPENCODE_API_KEY === DUMMY && environment.PATH === f.environment.PATH && !Object.hasOwn(environment, "OPENROUTER_API_KEY"); return { code: 0, signal: null }; },
  });
  assert.equal(result.state === "completed" && launched, true, "trusted auth did not reach child");
  assert.equal(fs.readFileSync(policyPath, "utf8").includes(DUMMY) || renderLaunchdPlist().includes(DUMMY) || JSON.stringify(result).includes(DUMMY), false, "credential persisted outside child environment");
});

test("an absolute Node alias is accepted only for the expected executable identity", mac, t => {
  const f = fixture(t);
  const alias = path.join(f.root, "node-alias");
  fs.symlinkSync(process.execPath, alias);
  f.document.ProgramArguments[0] = alias; f.save();
  assert.equal(loadManagedGoRuntimeEnvironment(f).OPENCODE_API_KEY === DUMMY, true, "same executable alias was rejected");

  const different = path.join(f.root, "different-node");
  fs.writeFileSync(different, "synthetic executable fixture", { mode: 0o755 });
  fs.unlinkSync(alias); fs.symlinkSync(different, alias);
  assert.throws(() => loadManagedGoRuntimeEnvironment(f), { code: "managed_go_environment_untrusted" });
  fs.unlinkSync(alias); fs.symlinkSync(process.execPath, alias);
  let replaced = false;
  assert.throws(() => loadManagedGoRuntimeEnvironment({ ...f, filesystem: { ...fs, statSync(file) {
    const stat = fs.statSync(file);
    if (file === alias && !replaced) { replaced = true; fs.unlinkSync(alias); fs.symlinkSync(different, alias); }
    return stat;
  } } }), { code: "managed_go_environment_untrusted" });
  fs.unlinkSync(alias); fs.symlinkSync(process.execPath, alias);
  f.document.ProgramArguments[0] = path.relative(process.cwd(), alias); f.save();
  assert.throws(() => loadManagedGoRuntimeEnvironment(f), { code: "managed_go_environment_untrusted" });
});
