import assert from "node:assert/strict";
import { CHECKED_IN_MODELS } from "../src/model-registry.mjs";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  GO_AUTO_QUIET_MS,
  GO_AUTO_INTERVAL_SECONDS,
  checkGoAutoCatalog,
  disableGoAutoCatalog,
  fetchOfficialGoInventory,
  goProviderEligibility,
  installGoAutoCatalog,
  observeRouterIdle,
  parseOfficialGoInventory,
  renderLaunchdPlist,
} from "../src/opencode-go-auto-catalog.mjs";
import { transactModelOverlayMutation } from "../src/model-overlay-publication.mjs";

const protocolRoutes = {
  "chat-completions": "https://opencode.ai/inference/go/openai/v1/chat/completions",
  responses: "https://opencode.ai/inference/go/openai/v1/responses",
  messages: "https://opencode.ai/inference/go/anthropic/v1/messages",
  "generate-content": "https://opencode.ai/inference/go/google/v1beta",
};

function inventory(rows) {
  return JSON.stringify({ data: rows.map(([id, endpoint]) => {
    const protocol = Object.keys(protocolRoutes).find(key => protocolRoutes[key] === endpoint);
    assert.ok(protocol, `fixture protocol required for ${endpoint}`);
    const base_url = protocol === "generate-content" ? endpoint : endpoint.slice(0, -({ "chat-completions": "/chat/completions", responses: "/responses", messages: "/messages" }[protocol].length));
    return { id, name: id, limit: { context: 131072, output: 8192 }, modalities: { input: ["text"], output: ["text"] }, api: { [protocol]: { base_url, sdk: "@ai-sdk/test-fixture" } } };
  }) });
}

function publicInventory() {
  return { data: [{
    id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash",
    limit: { context: 1000000, output: 384000 },
    modalities: { input: ["text", "image/jpeg", "image/png", "image/gif", "image/webp"], output: ["text"] },
    api: { "chat-completions": { base_url: "https://opencode.ai/inference/go/openai/v1", sdk: "@ai-sdk/openai-compatible" } },
  }] };
}

test("public JSON inventory replaces the removed HTML endpoint table", () => {
  const snapshot = parseOfficialGoInventory(JSON.stringify(publicInventory()));
  assert.equal(snapshot.rows[0].modelId, "deepseek-v4.1-flash");
  assert.equal(snapshot.rows[0].metadata.contextWindow, 1000000);
});

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

test("inventory accepts only exact public protocol tuples", () => {
  const snapshot = parseOfficialGoInventory(inventory([
    ["chat-model", protocolRoutes["chat-completions"]],
    ["messages-model", protocolRoutes.messages],
    ["responses-model", protocolRoutes.responses],
  ]));
  assert.deepEqual(snapshot.rows.map(row => [row.modelId, row.providerId, row.endpoint]), [
    ["chat-model", "opencode-go", protocolRoutes["chat-completions"]],
    ["messages-model", "opencode-go-messages", protocolRoutes.messages],
    ["responses-model", "opencode-go-responses", protocolRoutes.responses],
  ]);
  assert.deepEqual(snapshot.discovered, ["chat-model", "messages-model", "responses-model"]);
  assert.throws(() => parseOfficialGoInventory(inventory([["same", protocolRoutes.responses], ["same", protocolRoutes.responses]])), /repeats|duplicate/i);
  assert.throws(() => parseOfficialGoInventory("<p>Model ID only</p>"), /malformed/i);
});

test("inventory fetch is bounded, rejects redirects, and sends no credentials", async () => {
  let request;
  const payload = JSON.stringify(publicInventory());
  const result = await fetchOfficialGoInventory({ fetchImpl: async (url, options) => { request = { url, options }; return new Response(payload, { headers: { "content-type": "application/json; charset=utf-8" } }); } });
  assert.equal(result, payload);
  assert.equal(request.url, "https://opencode.ai/inference/go/v1/models");
  assert.equal(request.options.redirect, "error");
  assert.equal(request.options.credentials, undefined);
  assert.equal(request.options.headers.Accept, "application/json");
  assert.equal(Object.hasOwn(request.options.headers, "Authorization"), false);
  await assert.rejects(fetchOfficialGoInventory({ fetchImpl: async () => new Response("x", { headers: { "content-type": "application/json", "content-length": "200" } }), maxBytes: 20 }), /bounded|large/i);
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
    fetchInventory: async () => inventory([["new-chat", "https://opencode.ai/inference/go/openai/v1/chat/completions"], ["new-messages", "https://opencode.ai/inference/go/anthropic/v1/messages"], ["new-responses", "https://opencode.ai/inference/go/openai/v1/responses"]]),
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
  assert.deepEqual(models.find(model => model.upstreamModel === "new-chat").inputModalities, ["text"]);
  const loaded = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", `
    import {MODELS} from ${JSON.stringify(new URL("../src/model-registry.mjs", import.meta.url).href)};
    console.log(JSON.stringify(MODELS.map(model => model.slug)));
  `], { env: { ...process.env, CODEX_HOME: p.root, MODEL_ROUTER_STATE_DIR: p.stateDir, MODEL_ROUTER_USER_MODELS: p.userModelsPath }, encoding: "utf8" }));
  for (const model of models.filter(model => model.upstreamModel.startsWith("new-"))) assert.ok(loaded.includes(model.slug), `${model.slug} must load in a fresh registry`);

});

test("busy router, unknown health, and no-op checks defer without restarting", async () => {
  const p = tempPaths();
  Object.assign(p, { policyPath: path.join(p.stateDir, "policy.json"), statusPath: path.join(p.stateDir, "status.json"), seenPath: path.join(p.stateDir, "seen.json"), lockPath: path.join(p.stateDir, "lock"), pickerPath: path.join(p.stateDir, "picker.json"), userModelsPath: path.join(p.stateDir, "user-models.json") });
  mkdirSync(p.stateDir, { recursive: true, mode: 0o700 }); policy(p);
  const base = { ...p, configuredCheck: () => ["opencode-go"], discoveryDisabledCheck: () => false, fetchInventory: async () => inventory([["new", "https://opencode.ai/inference/go/openai/v1/responses"]]), now: () => Date.now(), transact: async () => { throw new Error("should not transact"); } };
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
  const result = await checkGoAutoCatalog({ ...p, sourceRoot: process.cwd(), configuredCheck: () => ["opencode-go"], discoveryDisabledCheck: () => false, fetchInventory: async () => inventory([["gap", "https://opencode.ai/inference/go/openai/v1/chat/completions"]]), readHealth: async () => ({ ok: true, resources: { inFlightRequests: 0 } }), readActivity: async () => activity, now: () => now, transact: async () => { throw new Error("should not transact"); } });
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
  const result = await checkGoAutoCatalog({ ...p, sourceRoot: process.cwd(), configuredCheck: () => ["opencode-go"], discoveryDisabledCheck: () => false, fetchInventory: async () => inventory([["gate-race", "https://opencode.ai/inference/go/openai/v1/responses"]]), readHealth: async () => ({ ok: true, resources: { inFlightRequests: 0 } }), readActivity: async () => { observations += 1; return observations === 3 ? { ok: false } : activity; }, now: () => now, transact: (transaction) => transactModelOverlayMutation({ ...transaction, lock: false }), applyPublication: async () => { throw new Error("must not publish"); } });
  assert.equal(result.state, "deferred");
  for (const [name, bytes] of before) assert.equal(existsSync(path.join(p.stateDir, name)) ? readFileSync(path.join(p.stateDir, name)).toString() : null, bytes?.toString() || null);
});

test("valid unsupported protocols stay pending while supported inventory rows activate", async () => {
  const p = tempPaths();
  Object.assign(p, { policyPath: path.join(p.stateDir, "policy.json"), statusPath: path.join(p.stateDir, "status.json"), seenPath: path.join(p.stateDir, "seen.json"), lockPath: path.join(p.stateDir, "lock"), pickerPath: path.join(p.stateDir, "picker.json"), userModelsPath: path.join(p.stateDir, "user-models.json") });
  mkdirSync(p.stateDir, { recursive: true, mode: 0o700 }); policy(p);
  const now = Date.now(); const activity = { ok: true, version: 1, instanceId: "router-1", observedAt: now - GO_AUTO_QUIET_MS - 1_000, active: [], recent: [] };
  status(p, { instanceId: "router-1", inFlightRequests: 0, activeCount: 0, observedAt: activity.observedAt, latestActivityAt: activity.observedAt });
  writeFileSync(p.pickerPath, JSON.stringify({ version: 1, hidden: ["other/hidden"], seeded: [] }));
  let published = 0;
  const options = { ...p, sourceRoot: process.cwd(), configuredCheck: () => ["opencode-go"], discoveryDisabledCheck: () => false, fetchInventory: async () => inventory([["legacy-alias", protocolRoutes["generate-content"]], ["documented", "https://opencode.ai/inference/go/openai/v1/chat/completions"]]), readHealth: async () => ({ ok: true, resources: { inFlightRequests: 0 } }), readActivity: async () => activity, now: () => now, transact: (transaction) => transactModelOverlayMutation({ ...transaction, lock: false }), applyPublication: async () => { published += 1; } };
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
  const options = { ...p, sourceRoot: process.cwd(), configuredCheck: () => ["opencode-go"], discoveryDisabledCheck: () => false, fetchInventory: async () => inventory([["rollback-me", "https://opencode.ai/inference/go/openai/v1/responses"]]), readHealth: async () => ({ ok: true, resources: { inFlightRequests: 0 } }), readActivity: async () => activity, now: () => now, transact: (transaction) => transactModelOverlayMutation({ ...transaction, lock: false }), applyPublication: async () => { publications += 1; if (publications === 1) {
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

test("disabled or unconfigured Go is skipped before the public fetch", async () => {
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


test("inventory rejects credentials, cross-origin and noncanonical endpoint URLs", () => {
  for (const base_url of [
    "https://user@opencode.ai/inference/go/openai/v1", "https://opencode.ai:443/inference/go/openai/v1",
    "https://example.com/inference/go/openai/v1", "https://opencode.ai/inference/go/openai/v1?secret=x",
    "https://opencode.ai/inference/go/openai/v1#x", "https://opencode.ai/inference/go/openai/v1/",
    "https://opencode.ai/zen/go/v1", "https://opencode.ai/inference/go/openai/other", "http://opencode.ai/inference/go/openai/v1",
  ]) {
    const payload = publicInventory(); payload.data[0].api["chat-completions"].base_url = base_url;
    assert.throws(() => parseOfficialGoInventory(JSON.stringify(payload)), /endpoint/i);
  }
  const payload = publicInventory();
  payload.data[0].api.responses = { base_url: "https://opencode.ai/inference/go/anthropic/v1", sdk: "test" };
  assert.throws(() => parseOfficialGoInventory(JSON.stringify(payload)), /endpoint/i);
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
    fetchInventory: async () => inventory([["history", "https://opencode.ai/inference/go/openai/v1/chat/completions"]]),
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
      fetchInventory: async () => inventory([[preset.upstreamModel, "https://opencode.ai/inference/go/openai/v1/responses"]]),
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
    fetchInventory: async () => inventory(["new.foo", "new-foo"].map(id => [id, "https://opencode.ai/inference/go/openai/v1/chat/completions"])),
    transact: async () => { assert.fail("colliding models cannot mutate state"); },
  });
  assert.equal(result.state, "pending"); assert.equal(result.reason, "model_identity_collision");
  for (const file of ["user-models.json", "model-picker.json", "opencode-go-auto-catalog-seen.json"]) assert.equal(existsSync(path.join(p.stateDir, file)), false);
});

function checkFixture() {
  const p = tempPaths();
  Object.assign(p, { policyPath: path.join(p.stateDir, "policy.json"), statusPath: path.join(p.stateDir, "status.json"), seenPath: path.join(p.stateDir, "seen.json"), pickerPath: path.join(p.stateDir, "picker.json"), userModelsPath: path.join(p.stateDir, "user-models.json") });
  mkdirSync(p.stateDir, { recursive: true, mode: 0o700 }); policy(p);
  const now = Date.now();
  status(p, { instanceId: "router-1", inFlightRequests: 0, activeCount: 0, observedAt: now - GO_AUTO_QUIET_MS - 1000, latestActivityAt: 0 });
  return { ...p, configuredCheck: () => ["opencode-go"], discoveryDisabledCheck: () => false, ...idleSeams(now), now: () => now,
    transact: transaction => transactModelOverlayMutation({ ...transaction, lock: false }), applyPublication: async () => {},
  };
}

test("canonical inventory maps only supported metadata and leaves Google pending", () => {
  const payload = publicInventory();
  const makeModel = (id, name, limit, protocol, base_url) => ({ ...structuredClone(payload.data[0]), id, name, limit, api: { [protocol]: { base_url, sdk: "@ai-sdk/fixture" } } });
  payload.data.push(
    makeModel("gpt-6-luna", "GPT 6 Luna", { context: 1050000, input: 922000, output: 128000 }, "responses", "https://opencode.ai/inference/go/openai/v1"),
    makeModel("claude-haiku-5-5", "Claude Haiku 5.5", { context: 200000, output: 64000 }, "messages", "https://opencode.ai/inference/go/anthropic/v1"),
    makeModel("gemini-4-argon", "Gemini 4 Argon", { context: 1000000, output: 64000 }, "generate-content", protocolRoutes["generate-content"]),
  );
  const snapshot = parseOfficialGoInventory(JSON.stringify(payload));
  assert.deepEqual(snapshot.discovered, payload.data.map(model => model.id));
  assert.deepEqual(snapshot.rows.map(row => row.providerId), ["opencode-go", "opencode-go-responses", "opencode-go-messages"]);
  assert.deepEqual(snapshot.rows[0].metadata, { displayName: "DeepSeek V4.1 Flash", contextWindow: 1000000, inputModalities: ["text", "image"] });
  assert.equal(snapshot.rows[1].metadata.contextWindow, 1050000);
  assert.equal(Object.hasOwn(snapshot.rows[1].metadata, "output"), false);
  payload.data[0].modalities = { input: ["text", "audio/wav"], output: ["audio/wav"] };
  assert.deepEqual(parseOfficialGoInventory(JSON.stringify(payload)).rows[0].metadata.inputModalities, ["text"]);
});

test("consumed inventory metadata fails closed on malformed values", () => {
  const mutations = [
    value => { delete value.data; }, value => { value.data = {}; }, value => { value.data = [null]; },
    value => { value.data[0].id = ""; }, value => { value.data[0].id = "x".repeat(513); },
    value => { value.data[0].id = "https://evil.example/model"; }, value => { value.data[0].id = "injected\nmodel"; },
    value => { value.data[0].name = "x".repeat(241); }, value => { value.data[0].name = {}; },
    value => { value.data[0].limit.context = 0; }, value => { value.data[0].limit.context = 1.5; },
    value => { value.data[0].limit.output = "128000"; }, value => { value.data[0].limit.output = -1; },
    value => { value.data[0].limit.input = Number.MAX_SAFE_INTEGER + 1; }, value => { delete value.data[0].limit; },
    value => { value.data[0].modalities.input = ["image"]; }, value => { value.data[0].modalities.input = [null]; },
    value => { value.data[0].modalities.output = "text"; }, value => { value.data[0].modalities.output = []; },
    value => { value.data[0].api = []; }, value => { value.data[0].api = {}; },
    value => { value.data[0].api["chat-completions"].sdk = {}; }, value => { delete value.data[0].api["chat-completions"].sdk; },
    value => { value.data[0].api = { unknown: { base_url: "https://opencode.ai/inference/go/openai/v1", sdk: "test" } }; },
    value => { value.data[0].api = JSON.parse('{"__proto__":{"base_url":"https://evil.example","sdk":"test"}}'); },
  ];
  for (const mutate of mutations) {
    const payload = publicInventory(); mutate(payload);
    assert.throws(() => parseOfficialGoInventory(JSON.stringify(payload)), error => ["inventory_invalid", "inventory_unknown_endpoint"].includes(error.code));
  }
  for (const text of ["null", "[]", "{", "", JSON.stringify({ data: [] }) + "x"]) assert.throws(() => parseOfficialGoInventory(text), /malformed/i);
});

test("fetch rejects non-2xx, non-JSON, streamed oversize and invalid URL before adoption", async () => {
  for (const status of [302, 400, 401, 500]) {
    await assert.rejects(fetchOfficialGoInventory({ fetchImpl: async () => new Response("{}", { status, headers: { "content-type": "application/json" } }) }), { code: "inventory_fetch_failed" });
  }
  for (const type of ["text/html", "text/plain", "application/jsonp", ""]) {
    await assert.rejects(fetchOfficialGoInventory({ fetchImpl: async () => new Response("{}", { headers: { "content-type": type } }) }), { code: "inventory_content_type" });
  }
  await assert.rejects(fetchOfficialGoInventory({ fetchImpl: async () => new Response("x".repeat(21), { headers: { "content-type": "application/json" } }), maxBytes: 20 }), { code: "inventory_too_large" });
  await assert.rejects(fetchOfficialGoInventory({ url: "https://evil.example/models", fetchImpl: async () => assert.fail("invalid URL cannot fetch") }), { code: "inventory_url_not_allowed" });
  let cancelled = false;
  await assert.rejects(fetchOfficialGoInventory({ maxBytes: 4, fetchImpl: async () => ({ ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), body: { getReader: () => ({ read: async () => ({ done: false, value: new Uint8Array(5) }), cancel: async () => { cancelled = true; } }) } }) }), { code: "inventory_too_large" });
  assert.equal(cancelled, true);
});

test("fetch timeout is bounded for the response and its body", async () => {
  // A live fetch observes AbortSignal for both its request and body stream.
  for (const duringBody of [false, true]) {
    const fetchImpl = async (_url, { signal }) => {
      const waitForAbort = () => new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("timeout", "AbortError")), { once: true }));
      if (!duringBody) return waitForAbort();
      return { ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), body: { getReader: () => ({ read: waitForAbort }) } };
    };
    // Keep the test alive because the production deadline timer is unref'ed.
    const keepAlive = setInterval(() => {}, 1000);
    try { await assert.rejects(fetchOfficialGoInventory({ fetchImpl, timeoutMs: 5 }), { code: "inventory_timeout" }); }
    finally { clearInterval(keepAlive); }
  }
});

test("eligibility gates prevent every inventory request", async () => {
  const cases = [
    { policyEnabled: false, expected: "disabled" },
    { discoveryDisabledCheck: () => true, expected: "discovery_disabled" },
    { configuredCheck: () => [], expected: "provider_unconfigured" },
    { selection: ["deepseek"], expected: "provider_disabled" },
  ];
  for (const gate of cases) {
    const options = checkFixture();
    if (gate.policyEnabled === false) policy(options, false);
    if (gate.selection) writeFileSync(path.join(options.stateDir, "enabled-providers.json"), JSON.stringify({ version: 1, providers: gate.selection }));
    const result = await checkGoAutoCatalog({ ...options, ...gate, fetchImpl: async () => assert.fail("gate must run before fetch"), fetchInventory: async () => assert.fail("gate must run before inventory") });
    assert.equal(result.reason, gate.expected);
  }
});

test("one public snapshot drives adoption and hostile unused metadata never enters the registry", async () => {
  const options = checkFixture();
  const payload = publicInventory();
  const model = payload.data[0]; model.id = "snapshot-test-model";
  const injection = "REMOTE_INSTRUCTION https://evil.example/payload";
  Object.assign(model, { description: injection, provider: injection, requestProfile: injection, reasoningLevels: injection, supportedEndpoints: [injection] });
  Object.assign(model.api["chat-completions"], { sdk: injection, compatibility: { system: injection }, capabilities: { instructions: injection, tools: injection } });
  let fetches = 0;
  let publications = 0;
  const checkOptions = { ...options,
    discover: async () => assert.fail("credential-backed discovery is retired for this updater"),
    fetchDocs: async () => assert.fail("HTML docs must never be fetched"),
    fetchImpl: async (url, request) => {
      fetches += 1;
      assert.equal(url, "https://opencode.ai/inference/go/v1/models");
      assert.equal(Object.hasOwn(request.headers, "Authorization"), false);
      return new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } });
    },
    applyPublication: async () => { publications += 1; },
  };
  const result = await checkGoAutoCatalog(checkOptions);
  assert.equal(result.state, "active"); assert.equal(fetches, 1); assert.equal(publications, 1);
  const saved = readFileSync(options.userModelsPath, "utf8");
  assert.equal(saved.includes(injection), false);
  const adopted = JSON.parse(saved).models[0];
  assert.equal(adopted.contextWindow, 1000000); assert.equal(adopted.autoCompact, 850000);
  assert.deepEqual(adopted.inputModalities, ["text", "image"]);
  assert.equal(adopted.displayName, "DeepSeek V4.1 Flash");
  assert.equal(adopted.provider, "opencode-go");
  assert.equal(Object.hasOwn(adopted, "api"), false);
  const again = await checkGoAutoCatalog(checkOptions);
  assert.equal(again.reason, "no_change"); assert.equal(fetches, 2); assert.equal(publications, 1);
  assert.equal(readFileSync(options.userModelsPath, "utf8"), saved);
});

test("unsupported-only inventory is pending without mutating files or marking history", async () => {
  const options = checkFixture();
  const result = await checkGoAutoCatalog({ ...options, fetchInventory: async () => inventory([["gemini-4-argon", protocolRoutes["generate-content"]]]), transact: async () => assert.fail("unsupported-only rows cannot mutate") });
  assert.equal(result.state, "pending");
  assert.deepEqual(result.plan.missingDocs, ["gemini-4-argon"]);
  for (const file of [options.userModelsPath, options.pickerPath, options.seenPath]) assert.equal(existsSync(file), false);
  assert.equal(GO_AUTO_INTERVAL_SECONDS, 300);
});

test("invalid inventory produces pending status without publishing or partial adoption", async () => {
  const options = checkFixture();
  const payload = publicInventory();
  payload.data.push({ ...structuredClone(payload.data[0]), id: "bad-entry", limit: { context: -1, output: 1 } });
  const result = await checkGoAutoCatalog({ ...options, fetchInventory: async () => JSON.stringify(payload), transact: async () => assert.fail("invalid inventory cannot mutate") });
  assert.equal(result.state, "pending"); assert.equal(result.reason, "inventory_invalid");
  for (const file of [options.userModelsPath, options.pickerPath, options.seenPath]) assert.equal(existsSync(file), false);
});


test("fresh overlay state wins over the earlier inventory plan under the transaction lock", async () => {
  const options = checkFixture();
  const model = { slug: "opencode-go/concurrent", gatewayModel: "opencode-go-concurrent", upstreamModel: "concurrent", provider: "opencode-go", contextWindow: 65536, displayName: "Concurrent operator edit" };
  let publications = 0;
  const result = await checkGoAutoCatalog({ ...options,
    fetchInventory: async () => inventory([[model.upstreamModel, protocolRoutes["chat-completions"]]]),
    transact: async transaction => {
      // A different overlay writer finishes after planning but before this
      // transaction obtains the overlay lock. The updater must replan.
      writeFileSync(options.userModelsPath, JSON.stringify({ version: 1, models: [model] }));
      writeFileSync(options.pickerPath, JSON.stringify({ version: 1, hidden: [model.slug], visible: [], seeded: [model.slug] }));
      writeFileSync(options.seenPath, JSON.stringify({ version: 1, seen: [JSON.stringify([model.provider, model.upstreamModel])] }));
      return transactModelOverlayMutation({ ...transaction, lock: false });
    },
    applyPublication: async () => { publications += 1; },
  });
  assert.equal(result.state, "active"); assert.equal(publications, 0);
  assert.deepEqual(JSON.parse(readFileSync(options.userModelsPath, "utf8")).models, [model]);
  assert.deepEqual(JSON.parse(readFileSync(options.pickerPath, "utf8")).hidden, [model.slug]);
});
