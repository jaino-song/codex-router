import assert from "node:assert/strict";
import { CHECKED_IN_MODELS } from "../src/model-registry.mjs";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  GO_AUTO_QUIET_MS,
  checkGoAutoCatalog,
  disableGoAutoCatalog,
  fetchOfficialGoDocs,
  goProviderEligibility,
  installGoAutoCatalog,
  observeRouterIdle,
  parseOfficialGoDocs,
  renderLaunchdPlist,
} from "../src/opencode-go-auto-catalog.mjs";
import { transactModelOverlayMutation } from "../src/model-overlay-publication.mjs";

function html(rows) {
  return `<table><thead><tr><th>Model ID</th><th>Endpoint</th></tr></thead><tbody>${rows.map(([id, endpoint]) => `<tr><td>${id}</td><td>${endpoint}</td></tr>`).join("")}</tbody></table>`;
}

function tempPaths() {
  const root = mkdtempSync(path.join(os.tmpdir(), "go-auto-catalog-"));
  return {
    root,
    stateDir: path.join(root, "state"),
    launchAgentsDir: path.join(root, "LaunchAgents"),
  };
}

function policy(paths, enabled = true) {
  writeFileSync(paths.policyPath, `${JSON.stringify({ version: 1, enabled, sourceRoot: process.cwd(), stateDir: paths.stateDir })}\n`);
  if (!existsSync(path.join(paths.stateDir, "install-manifest.json"))) writeFileSync(path.join(paths.stateDir, "install-manifest.json"), JSON.stringify({ version: 1, current: { sourceRoot: process.cwd() } }));
}

function status(paths, observation) {
  writeFileSync(paths.statusPath, `${JSON.stringify({ version: 1, state: "deferred", observations: [observation] })}\n`);
}

function idleSeams(now) {
  const activity = { ok: true, version: 1, instanceId: "router-1", observedAt: now - GO_AUTO_QUIET_MS - 1_000, active: [], recent: [] };
  const health = { ok: true, resources: { inFlightRequests: 0 } };
  return { readHealth: async () => health, readActivity: async () => activity };
}

test("official docs accept only the three exact Go protocol endpoints", () => {
  const rows = parseOfficialGoDocs(html([
    ["chat-model", "https://opencode.ai/zen/go/v1/chat/completions"],
    ["messages-model", "POST https://opencode.ai/zen/go/v1/messages"],
    ["responses-model", "https://opencode.ai/zen/go/v1/responses"],
  ]));
  assert.deepEqual(rows.map((row) => [row.modelId, row.providerId]), [
    ["chat-model", "opencode-go"],
    ["messages-model", "opencode-go-messages"],
    ["responses-model", "opencode-go-responses"],
  ]);
  assert.throws(() => parseOfficialGoDocs(html([["bad", "https://example.com/zen/go/v1/responses"]])), /endpoint/i);
  assert.throws(() => parseOfficialGoDocs(html([["same", "https://opencode.ai/zen/go/v1/responses"], ["same", "https://opencode.ai/zen/go/v1/responses"]])), /repeats|duplicate/i);
  assert.throws(() => parseOfficialGoDocs("<p>Model ID only</p>"), /table|protocol/i);
});

test("docs fetch is bounded, rejects redirects, and sends no credentials", async () => {
  let request;
  const response = { ok: true, status: 200, headers: new Headers({ "content-length": "20" }), text: async () => "<table></table>" };
  const result = await fetchOfficialGoDocs({ fetchImpl: async (url, options) => { request = { url, options }; return response; } });
  assert.equal(result, "<table></table>");
  assert.equal(request.url, "https://opencode.ai/docs/go/");
  assert.equal(request.options.redirect, "error");
  assert.equal(request.options.credentials, undefined);
  assert.equal(Object.hasOwn(request.options.headers, "Authorization"), false);
  await assert.rejects(fetchOfficialGoDocs({ fetchImpl: async () => ({ ok: true, status: 200, headers: new Headers({ "content-length": "200" }), text: async () => "x" }), maxBytes: 20 }), /bounded|large/i);
});

test("all three newly documented protocols are adopted while existing state is preserved", async () => {
  const p = tempPaths();
  p.policyPath = path.join(p.stateDir, "policy.json");
  p.statusPath = path.join(p.stateDir, "status.json");
  p.seenPath = path.join(p.stateDir, "seen.json");
  p.lockPath = path.join(p.stateDir, "lock");
  p.pickerPath = path.join(p.stateDir, "picker.json");
  p.userModelsPath = path.join(p.stateDir, "user-models.json");
  mkdirSync(p.stateDir, { recursive: true, mode: 0o700 });
  policy(p);
  const now = Date.now();
  const old = { slug: "opencode-go/old", gatewayModel: "opencode-go-old", upstreamModel: "old", provider: "opencode-go", listed: true, displayName: "User edit", description: "keep", priority: 1 };
  writeFileSync(p.userModelsPath, JSON.stringify({ version: 1, models: [old] }));
  const activity = { ok: true, version: 1, instanceId: "router-1", observedAt: now - GO_AUTO_QUIET_MS - 1_000, active: [], recent: [] };
  status(p, { instanceId: "router-1", inFlightRequests: 0, activeCount: 0, observedAt: activity.observedAt, latestActivityAt: activity.observedAt });
  let restarted = 0;
  let published = 0;
  const result = await checkGoAutoCatalog({
    ...p,
    pickerPath: p.pickerPath,
    sourceRoot: process.cwd(),
    configuredCheck: () => ["opencode-go"],
    discoveryDisabledCheck: () => false,
    discover: async () => ({ discovered: ["new-chat", "new-messages", "new-responses"], modelMetadata: {} }),
    fetchDocs: async () => html([["new-chat", "https://opencode.ai/zen/go/v1/chat/completions"], ["new-messages", "https://opencode.ai/zen/go/v1/messages"], ["new-responses", "https://opencode.ai/zen/go/v1/responses"]]),
    readHealth: async () => ({ ok: true, resources: { inFlightRequests: 0 } }),
    readActivity: async () => activity,
    observeIdle: observeRouterIdle,
    now: () => now,
    transact: async (transaction) => transactModelOverlayMutation({ ...transaction, lock: false, restart: async () => { const requested = await transaction.restart(); if (requested) restarted += 1; return requested; } }),
    applyPublication: async () => { published += 1; },
  });
  assert.equal(result.state, "active");
  assert.equal(restarted, 1);
  assert.equal(published, 1);
  const models = JSON.parse(readFileSync(p.userModelsPath, "utf8")).models;
  assert.equal(models.find((model) => model.slug === old.slug).description, "keep");
  assert.deepEqual(new Set(models.filter((model) => model.upstreamModel.startsWith("new-")).map((model) => model.provider)), new Set(["opencode-go", "opencode-go-messages", "opencode-go-responses"]));
  assert.equal(JSON.parse(readFileSync(p.pickerPath, "utf8")).visible.length, 3);
});

test("busy router, unknown health, and no-op checks defer without restarting", async () => {
  const p = tempPaths();
  Object.assign(p, { policyPath: path.join(p.stateDir, "policy.json"), statusPath: path.join(p.stateDir, "status.json"), seenPath: path.join(p.stateDir, "seen.json"), lockPath: path.join(p.stateDir, "lock"), pickerPath: path.join(p.stateDir, "picker.json"), userModelsPath: path.join(p.stateDir, "user-models.json") });
  mkdirSync(p.stateDir, { recursive: true, mode: 0o700 }); policy(p);
  const base = { ...p, configuredCheck: () => ["opencode-go"], discoveryDisabledCheck: () => false, discover: async () => ({ discovered: ["new"], modelMetadata: {} }), fetchDocs: async () => html([["new", "https://opencode.ai/zen/go/v1/responses"]]), now: () => Date.now(), transact: async () => { throw new Error("should not transact"); } };
  let result = await checkGoAutoCatalog({ ...base, readHealth: async () => ({ ok: true, resources: { inFlightRequests: 1 } }), readActivity: async () => ({ ok: true, instanceId: "r", observedAt: Date.now(), active: [{}], recent: [] }) });
  assert.equal(result.state, "deferred");
  result = await checkGoAutoCatalog({ ...base, readHealth: async () => ({ ok: false }), readActivity: async () => ({ ok: false }) });
  assert.equal(result.state, "deferred");
});

test("idle observations tolerate advancing snapshot timestamps when no request is active", async () => {
  let observedAt = 10_000;
  const readHealth = async () => ({ ok: true, resources: { inFlightRequests: 0 } });
  const readActivity = async () => ({ ok: true, version: 1, instanceId: "router-1", observedAt: observedAt += 5_000, active: [], recent: [] });
  const first = await observeRouterIdle({ readHealth, readActivity, now: () => observedAt });
  const second = await observeRouterIdle({ readHealth, readActivity, now: () => observedAt });
  assert.equal(first.latestActivityAt, 0);
  assert.equal(second.latestActivityAt, 0);
  assert.equal(first.instanceId, second.instanceId);
  assert.equal(first.inFlightRequests, 0);
});

test("idle activation still requires a sixty-second gap between persisted observations", async () => {
  const p = tempPaths();
  Object.assign(p, { policyPath: path.join(p.stateDir, "policy.json"), statusPath: path.join(p.stateDir, "status.json"), seenPath: path.join(p.stateDir, "seen.json"), lockPath: path.join(p.stateDir, "lock"), pickerPath: path.join(p.stateDir, "picker.json"), userModelsPath: path.join(p.stateDir, "user-models.json") });
  mkdirSync(p.stateDir, { recursive: true, mode: 0o700 }); policy(p);
  const now = Date.now(); const activity = { ok: true, version: 1, instanceId: "router-1", observedAt: now - 1_000, active: [], recent: [] };
  status(p, { instanceId: "router-1", inFlightRequests: 0, activeCount: 0, observedAt: now - 1_000, latestActivityAt: 0 });
  const result = await checkGoAutoCatalog({ ...p, sourceRoot: process.cwd(), configuredCheck: () => ["opencode-go"], discoveryDisabledCheck: () => false, discover: async () => ({ discovered: ["gap"], modelMetadata: {} }), fetchDocs: async () => html([["gap", "https://opencode.ai/zen/go/v1/chat/completions"]]), readHealth: async () => ({ ok: true, resources: { inFlightRequests: 0 } }), readActivity: async () => activity, now: () => now, transact: async () => { throw new Error("should not transact"); } });
  assert.equal(result.state, "deferred");
  assert.equal(result.reason, "quiet_window");
});

test("a failed final gate cannot be followed by a mutation after a healthy recheck", async () => {
  const p = tempPaths();
  Object.assign(p, { policyPath: path.join(p.stateDir, "policy.json"), statusPath: path.join(p.stateDir, "status.json"), seenPath: path.join(p.stateDir, "seen.json"), lockPath: path.join(p.stateDir, "lock"), pickerPath: path.join(p.stateDir, "picker.json"), userModelsPath: path.join(p.stateDir, "user-models.json") });
  mkdirSync(p.stateDir, { recursive: true, mode: 0o700 }); policy(p);
  const now = Date.now(); const activity = { ok: true, version: 1, instanceId: "router-1", observedAt: now - GO_AUTO_QUIET_MS - 1_000, active: [], recent: [] };
  status(p, { instanceId: "router-1", inFlightRequests: 0, activeCount: 0, observedAt: activity.observedAt, latestActivityAt: activity.observedAt });
  const before = ["user-models.json", "picker.json", "seen.json"].map((name) => [name, existsSync(path.join(p.stateDir, name)) ? readFileSync(path.join(p.stateDir, name)) : null]);
  let observations = 0;
  const result = await checkGoAutoCatalog({ ...p, sourceRoot: process.cwd(), configuredCheck: () => ["opencode-go"], discoveryDisabledCheck: () => false, discover: async () => ({ discovered: ["gate-race"], modelMetadata: {} }), fetchDocs: async () => html([["gate-race", "https://opencode.ai/zen/go/v1/responses"]]), readHealth: async () => ({ ok: true, resources: { inFlightRequests: 0 } }), readActivity: async () => { observations += 1; return observations === 3 ? { ok: false } : activity; }, now: () => now, transact: (transaction) => transactModelOverlayMutation({ ...transaction, lock: false }), applyPublication: async () => { throw new Error("must not publish"); } });
  assert.equal(result.state, "deferred");
  for (const [name, bytes] of before) assert.equal(existsSync(path.join(p.stateDir, name)) ? readFileSync(path.join(p.stateDir, name)).toString() : null, bytes?.toString() || null);
});

test("undocumented legacy live ids remain pending while documented ids still activate", async () => {
  const p = tempPaths();
  Object.assign(p, { policyPath: path.join(p.stateDir, "policy.json"), statusPath: path.join(p.stateDir, "status.json"), seenPath: path.join(p.stateDir, "seen.json"), lockPath: path.join(p.stateDir, "lock"), pickerPath: path.join(p.stateDir, "picker.json"), userModelsPath: path.join(p.stateDir, "user-models.json") });
  mkdirSync(p.stateDir, { recursive: true, mode: 0o700 }); policy(p);
  const now = Date.now(); const activity = { ok: true, version: 1, instanceId: "router-1", observedAt: now - GO_AUTO_QUIET_MS - 1_000, active: [], recent: [] };
  status(p, { instanceId: "router-1", inFlightRequests: 0, activeCount: 0, observedAt: activity.observedAt, latestActivityAt: activity.observedAt });
  writeFileSync(p.pickerPath, JSON.stringify({ version: 1, hidden: ["other/hidden"], seeded: [] }));
  let published = 0;
  const options = { ...p, sourceRoot: process.cwd(), configuredCheck: () => ["opencode-go"], discoveryDisabledCheck: () => false, discover: async () => ({ discovered: ["legacy-alias", "documented"], modelMetadata: {} }), fetchDocs: async () => html([["documented", "https://opencode.ai/zen/go/v1/chat/completions"]]), readHealth: async () => ({ ok: true, resources: { inFlightRequests: 0 } }), readActivity: async () => activity, now: () => now, transact: (transaction) => transactModelOverlayMutation({ ...transaction, lock: false }), applyPublication: async () => { published += 1; } };
  const result = await checkGoAutoCatalog(options);
  assert.equal(result.state, "pending");
  assert.deepEqual(result.plan.missingDocs, ["legacy-alias"]);
  assert.equal(published, 1);
  assert.equal(Object.hasOwn(JSON.parse(readFileSync(p.pickerPath, "utf8")), "visible"), false);
  const visibility = execFileSync(process.execPath, ["--input-type=module", "-e", `
    import {effectiveVisibleModels,migrateLegacyVisibleModels} from ${JSON.stringify(new URL("../src/model-picker-state.mjs", import.meta.url).href)};
    const slugs=["other/visible","other/hidden"];
    migrateLegacyVisibleModels(slugs);
    console.log(JSON.stringify([...effectiveVisibleModels(slugs)]));
  `], { env: { ...process.env, MODEL_ROUTER_STATE_DIR: p.stateDir, CODEX_HOME: p.root, MODEL_ROUTER_MODEL_PICKER_STATE: p.pickerPath }, encoding: "utf8" });
  assert.deepEqual(JSON.parse(visibility), ["other/visible"]);

  assert.match(readFileSync(p.statusPath, "utf8"), /missing|pending/i);
  const again = await checkGoAutoCatalog(options);
  assert.equal(again.reason, "missing_documentation");
  assert.equal(published, 1, "persisted history must remain readable and avoid a second publication");
  writeFileSync(p.userModelsPath, JSON.stringify({ version: 1, models: [] }));
  const afterRemoval = await checkGoAutoCatalog(options);
  assert.equal(afterRemoval.reason, "missing_documentation");
  assert.deepEqual(JSON.parse(readFileSync(p.userModelsPath, "utf8")).models, []);
  assert.equal(published, 1, "an operator removal must not trigger re-adoption");


});

test("publication failure rolls all three updater files back", async () => {
  const p = tempPaths();
  Object.assign(p, { policyPath: path.join(p.stateDir, "policy.json"), statusPath: path.join(p.stateDir, "status.json"), seenPath: path.join(p.stateDir, "seen.json"), lockPath: path.join(p.stateDir, "lock"), pickerPath: path.join(p.stateDir, "picker.json"), userModelsPath: path.join(p.stateDir, "user-models.json") });
  mkdirSync(p.stateDir, { recursive: true, mode: 0o700 }); policy(p);
  const originalUser = { version: 1, models: [{ slug: "opencode-go/existing", gatewayModel: "opencode-go-existing", upstreamModel: "existing", provider: "opencode-go", listed: true }] };
  const originalPicker = { version: 1, hidden: [], visible: [], seeded: [] };
  const originalSeen = { version: 1, seen: [] };
  writeFileSync(p.userModelsPath, JSON.stringify(originalUser)); writeFileSync(p.pickerPath, JSON.stringify(originalPicker)); writeFileSync(p.seenPath, JSON.stringify(originalSeen));
  const now = Date.now(); const activity = { ok: true, version: 1, instanceId: "router-1", observedAt: now - GO_AUTO_QUIET_MS - 1_000, active: [], recent: [] };
  status(p, { instanceId: "router-1", inFlightRequests: 0, activeCount: 0, observedAt: activity.observedAt, latestActivityAt: activity.observedAt });
  let publications = 0;
  const options = { ...p, sourceRoot: process.cwd(), configuredCheck: () => ["opencode-go"], discoveryDisabledCheck: () => false, discover: async () => ({ discovered: ["rollback-me"], modelMetadata: {} }), fetchDocs: async () => html([["rollback-me", "https://opencode.ai/zen/go/v1/responses"]]), readHealth: async () => ({ ok: true, resources: { inFlightRequests: 0 } }), readActivity: async () => activity, now: () => now, transact: (transaction) => transactModelOverlayMutation({ ...transaction, lock: false }), applyPublication: async () => { publications += 1; if (publications === 1) {
    const concurrent = await checkGoAutoCatalog(options);
    assert.equal(concurrent.reason, "already_running", "another updater must not observe uncommitted model state");
    throw new Error("simulated publication failure");
  } } };
  const result = await checkGoAutoCatalog(options);
  assert.equal(result.state, "error");
  assert.deepEqual(JSON.parse(readFileSync(p.userModelsPath, "utf8")), originalUser);
  assert.deepEqual(JSON.parse(readFileSync(p.pickerPath, "utf8")), originalPicker);
  assert.deepEqual(JSON.parse(readFileSync(p.seenPath, "utf8")), originalSeen);
  assert.equal(publications, 2);
  status(p, { instanceId: "router-1", inFlightRequests: 0, activeCount: 0, observedAt: activity.observedAt, latestActivityAt: activity.observedAt });
  const retry = await checkGoAutoCatalog(options);
  assert.equal(retry.state, "active");
  assert.ok(JSON.parse(readFileSync(p.userModelsPath, "utf8")).models.some(model => model.upstreamModel === "rollback-me"));
  assert.ok(JSON.parse(readFileSync(p.seenPath, "utf8")).seen.some(identity => JSON.parse(identity)[1] === "rollback-me"));
});

test("disabled or unconfigured Go is skipped before discovery", async () => {
  assert.deepEqual(goProviderEligibility({ discoveryDisabledCheck: () => true, configuredCheck: () => ["opencode-go"] }), { enabled: false, reason: "discovery_disabled" });
  assert.deepEqual(goProviderEligibility({ discoveryDisabledCheck: () => false, configuredCheck: () => ["deepseek"] }), { enabled: false, reason: "provider_unconfigured" });
});

test("installation renders escaped launchd manifest and rolls back on bootstrap failure", async () => {
  const p = tempPaths();
  mkdirSync(p.stateDir, { recursive: true, mode: 0o700 });
  const source = path.join(p.root, "stable source & root");
  mkdirSync(path.join(source, "src"), { recursive: true, mode: 0o700 }); writeFileSync(path.join(source, "package.json"), "{}"); writeFileSync(path.join(source, "src", "opencode-go-auto-catalog.mjs"), "export {};\n");
  writeFileSync(path.join(p.stateDir, "install-manifest.json"), JSON.stringify({ version: 1, current: { sourceRoot: source } }));
  const plist = renderLaunchdPlist({ sourceRoot: source, modulePath: path.join(source, "src", "auto.mjs"), nodeBinary: "/usr/local/bin/node" });
  assert.match(plist, /stable source &amp; root/);
  assert.match(plist, /<string>--scheduled<\/string>/);
  if (process.platform === "darwin") {
    const plistPath = path.join(p.root, "generated.plist");
    writeFileSync(plistPath, plist);
    execFileSync("/usr/bin/plutil", ["-lint", plistPath], { stdio: "pipe" });
  }
  let calls = [];
  await assert.rejects(installGoAutoCatalog({ ...p, sourceRoot: source, paths: { policyPath: path.join(p.stateDir, "policy.json"), statusPath: path.join(p.stateDir, "status.json"), seenPath: path.join(p.stateDir, "seen.json"), launchAgentsDir: p.launchAgentsDir, plistPath: path.join(p.launchAgentsDir, "auto.plist") }, platform: "darwin", allowUnstableSource: true, launchctl: (args) => { calls.push(args); if (args[0] === "bootstrap") throw new Error("no bootstrap"); } }), /bootstrap/i);
  assert.equal(existsSync(path.join(p.launchAgentsDir, "auto.plist")), false);
  assert.ok(calls.some((args) => args[0] === "bootstrap"));
});

test("disable does not claim success when launchd refuses bootout", async () => {
  const p = tempPaths();
  Object.assign(p, { policyPath: path.join(p.stateDir, "policy.json"), statusPath: path.join(p.stateDir, "status.json"), seenPath: path.join(p.stateDir, "seen.json"), lockPath: path.join(p.stateDir, "lock") });
  mkdirSync(p.stateDir, { recursive: true, mode: 0o700 }); policy(p);
  await assert.rejects(disableGoAutoCatalog({ stateDir: p.stateDir, paths: { policyPath: p.policyPath }, platform: "darwin", launchctl: () => { throw new Error("busy"); } }), /disabled/i);
});


test("official table uses Model ID instead of the preceding display name", () => {
  const rows = parseOfficialGoDocs('<table><tr><th>Model</th><th>Model ID</th><th>Endpoint</th><th>AI SDK Package</th></tr><tr><td>Example Display Name</td><td>example-id</td><td>https://opencode.ai/zen/go/v1/responses</td><td>sdk</td></tr></table>');
  assert.equal(rows[0].modelId, "example-id");
  for (const endpoint of ["https://user@opencode.ai/zen/go/v1/responses", "see https://opencode.ai/zen/go/v1/responses here", "https://opencode.ai/zen/go/v1/RESPONSES", "https://opencode.ai:443/zen/go/v1/responses"]) {
    assert.throws(() => parseOfficialGoDocs(html([["example-id", endpoint]])), /endpoint/i);
  }
});

test("policy cannot redirect activation to a different state directory", async () => {
  const p = tempPaths();
  p.policyPath = path.join(p.stateDir, "policy.json");
  mkdirSync(p.stateDir, { recursive: true, mode: 0o700 });
  policy(p);
  writeFileSync(p.policyPath, JSON.stringify({ version: 1, enabled: true, sourceRoot: process.cwd(), stateDir: p.root }));
  const result = await checkGoAutoCatalog({ ...p, discover: async () => { throw new Error("must not discover"); } });
  assert.equal(result.state, "pending");
  assert.equal(result.reason, "state belongs to another source checkout");
  assert.equal(existsSync(path.join(p.stateDir, "user-models.json")), false);
});


test("history-only updates use the overlay transaction without publishing or rewriting model choices", async () => {
  const p = tempPaths();
  Object.assign(p, { policyPath: path.join(p.stateDir, "policy.json"), seenPath: path.join(p.stateDir, "seen.json"), pickerPath: path.join(p.stateDir, "picker.json"), userModelsPath: path.join(p.stateDir, "user-models.json") });
  mkdirSync(p.stateDir, { recursive: true, mode: 0o700 }); policy(p);
  const model = { slug: "opencode-go/history", gatewayModel: "opencode-go-history", upstreamModel: "history", provider: "opencode-go" };
  const userText = JSON.stringify({ version: 1, models: [model] });
  const pickerText = JSON.stringify({ version: 1, hidden: [model.slug], visible: [], seeded: [model.slug] });
  writeFileSync(p.userModelsPath, userText); writeFileSync(p.pickerPath, pickerText);
  let transactions = 0;
  const result = await checkGoAutoCatalog({ ...p, sourceRoot: process.cwd(), configuredCheck: () => ["opencode-go"], discoveryDisabledCheck: () => false,
    discover: async () => ({ discovered: ["history"] }), fetchDocs: async () => html([["history", "https://opencode.ai/zen/go/v1/chat/completions"]]),
    readHealth: async () => ({ ok: false }), readActivity: async () => ({ ok: false }),
    transact: transaction => { transactions += 1; return transactModelOverlayMutation({ ...transaction, lock: false }); },
    applyPublication: async () => { assert.fail("history does not require publication"); },
  });
  assert.equal(result.reason, "history_updated"); assert.equal(transactions, 1);
  assert.equal(readFileSync(p.userModelsPath, "utf8"), userText); assert.equal(readFileSync(p.pickerPath, "utf8"), pickerText);
  assert.equal(JSON.parse(readFileSync(p.seenPath, "utf8")).seen.length, 1);
});


test("disable checks a loaded job even when its saved policy is already disabled", async () => {
  const p = tempPaths(); p.policyPath = path.join(p.stateDir, "policy.json");
  mkdirSync(p.stateDir, { recursive: true, mode: 0o700 }); policy(p, false);
  const calls = [];
  await assert.rejects(disableGoAutoCatalog({ stateDir: p.stateDir, paths: { policyPath: p.policyPath }, platform: "darwin", launchctl: args => {
    calls.push(args[0]);
    if (args[0] === "bootout") throw new Error("permission denied");
  } }), /disabled/i);
  assert.deepEqual(calls, ["print", "bootout"]);
});


test("existing user route takes priority over a documented preset on another Go protocol", async () => {
  const preset = CHECKED_IN_MODELS.find(model => model.provider === "opencode-go-responses" && model.listed !== false);
  assert.ok(preset);
  for (const hidden of [false, true]) {
    const p = tempPaths();
    Object.assign(p, { policyPath: path.join(p.stateDir, "policy.json"), seenPath: path.join(p.stateDir, "seen.json"), pickerPath: path.join(p.stateDir, "picker.json"), userModelsPath: path.join(p.stateDir, "user-models.json") });
    mkdirSync(p.stateDir, { recursive: true, mode: 0o700 }); policy(p);
    const custom = { ...preset, provider: "opencode-go", slug: "opencode-go/my-custom-route", gatewayModel: "opencode-go-my-custom-route" };
    const userText = JSON.stringify({ version: 1, models: [custom] });
    const pickerText = JSON.stringify({ version: 1, hidden: hidden ? [custom.slug] : [], visible: hidden ? [] : [custom.slug], seeded: [custom.slug] });
    writeFileSync(p.userModelsPath, userText); writeFileSync(p.pickerPath, pickerText);
    const result = await checkGoAutoCatalog({ ...p, configuredCheck: () => ["opencode-go"], discoveryDisabledCheck: () => false,
      discover: async () => ({ discovered: [preset.upstreamModel] }), fetchDocs: async () => html([[preset.upstreamModel, "https://opencode.ai/zen/go/v1/responses"]]),
      readHealth: async () => ({ ok: false }), readActivity: async () => ({ ok: false }),
      transact: transaction => transactModelOverlayMutation({ ...transaction, lock: false }),
      applyPublication: async () => { assert.fail("existing route does not need publication"); },
    });
    assert.equal(result.reason, "history_updated");
    assert.deepEqual(result.plan.modelSlugs, [custom.slug]);
    assert.equal(readFileSync(p.userModelsPath, "utf8"), userText);
    assert.equal(readFileSync(p.pickerPath, "utf8"), pickerText);
  }
});


test("distinct live IDs that collapse to one gateway cannot be falsely adopted", async () => {
  const p = tempPaths(); p.policyPath = path.join(p.stateDir, "policy.json");
  mkdirSync(p.stateDir, { recursive: true, mode: 0o700 }); policy(p);
  const result = await checkGoAutoCatalog({ ...p, configuredCheck: () => ["opencode-go"], discoveryDisabledCheck: () => false,
    discover: async () => ({ discovered: ["new.foo", "new-foo"] }), fetchDocs: async () => html(["new.foo", "new-foo"].map(id => [id, "https://opencode.ai/zen/go/v1/chat/completions"])),
    transact: async () => { assert.fail("colliding models cannot mutate state"); },
  });
  assert.equal(result.state, "pending"); assert.equal(result.reason, "model_identity_collision");
  for (const file of ["user-models.json", "model-picker.json", "opencode-go-auto-catalog-seen.json"]) assert.equal(existsSync(path.join(p.stateDir, file)), false);
});
