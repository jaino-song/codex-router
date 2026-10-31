import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { openPort } from "./port-pool.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = mkdtempSync(path.join(os.tmpdir(), "codex-router-endpoint-retry-"));
const stateDir = path.join(root, "state");
const credentialStorePath = path.join(stateDir, "provider-credentials.json");
const poolStatePath = path.join(stateDir, "provider-api-key-pools.json");
const internalKey = "test-endpoint-retry-internal-key-length";
process.env.CODEX_HOME = path.join(root, "codex");
process.env.CODEX_ROUTER_STATE_DIR = stateDir;
process.env.MODEL_ROUTER_PROVIDER_CREDENTIAL_STORE = credentialStorePath;
process.env.MODEL_ROUTER_PROVIDER_CREDENTIAL_MIGRATIONS = path.join(stateDir, "migrations", "provider-credentials");
process.env.MODEL_ROUTER_API_KEY_POOL_PATH = poolStatePath;

const { addEnvironmentCredentialToPool } = await import("../src/provider-api-key-control.mjs");

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

async function waitForHealth(baseUrl, child, stderr) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`forwarder exited: ${stderr()}`);
    try {
      const response = await fetch(`${baseUrl}/health`, {
        headers: { Authorization: `Bearer ${internalKey}` },
      });
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`forwarder never became healthy: ${stderr()}`);
}

const TERSE = JSON.stringify({ model: "deepseek-v4.1-flash" });
const SUCCESS = JSON.stringify({
  id: "chatcmpl_endpoint_retry",
  object: "chat.completion",
  model: "deepseek-v4.1-flash",
  choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
});

const userModelsPath = path.join(root, "user-models.json");
const fixtureModel = (provider, upstreamModel, supportedEndpoints) => ({
  slug: `${provider}/${upstreamModel}`, provider, upstreamModel,
  gatewayModel: `${provider}-fixture-${upstreamModel}`, listed: false,
  displayName: "Retry fixture", description: "Loopback-only test fixture", priority: 500,
  defaultEffort: "high", reasoningLevels: [{ effort: "high", description: "Adaptive reasoning" }],
  contextWindow: 131072, autoCompact: 110000, inputModalities: ["text"], compHash: "retry-fixture-v1",
  ...(supportedEndpoints ? { supportedEndpoints } : {}),
});
writeFileSync(userModelsPath, JSON.stringify({ version: 1, models: [
  fixtureModel("opencode-go", "embed", ["/embeddings"]), fixtureModel("openrouter", "chat"),
] }));

// `responses` is the ordered list of upstream replies; any request past the
// list repeats the last one.
async function forwardOnce(replies, options = {}) {
  let releaseEOF;
  const eofGate = new Promise((resolve) => { releaseEOF = resolve; });
  let eofReleased = false;
  const dumpPath = path.join(root, `errors-${Date.now()}-${Math.random()}.jsonl`);
  let calls = 0;
  const upstream = http.createServer((request, response) => {
    const index = Math.min(calls, replies.length - 1);
    calls += 1;
    request.resume();
    request.once("end", async () => {
      const reply = replies[index];
      response.writeHead(reply.status, { "Content-Type": reply.sse ? "text/event-stream" : "application/json" });
      if (reply.sse) {
        response.write(reply.body);
        await eofGate;
        eofReleased = true;
        response.end("data: [DONE]\n\n");
      } else response.end(reply.body);
    });
  });
  const upstreamPort = await listen(upstream);
  const forwarderPort = await openPort();
  const child = spawn(process.execPath, [path.join(repoRoot, "src", "api-forwarder.mjs")], {
    cwd: repoRoot,
    env: {
      ...process.env,
      MODEL_ROUTER_USER_MODELS: userModelsPath,
      OPENROUTER_API_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`,
      OPENROUTER_API_KEY: "LOOPBACK_TEST_OPENROUTER_KEY",
      MODEL_ROUTER_TARGET: "codex",
      MODEL_ROUTER_INTERNAL_KEY: internalKey,
      MODEL_ROUTER_API_PORT: String(forwarderPort),
      MODEL_ROUTER_STATE_DIR: stateDir,
      MODEL_ROUTER_PROVIDER_CREDENTIAL_STORE: credentialStorePath,
      MODEL_ROUTER_API_KEY_POOL_PATH: poolStatePath,
      MODEL_ROUTER_QUIET: "1",
      CODEX_ROUTER_UPSTREAM_ERROR_DUMP: dumpPath,
      OPENCODE_GO_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`,
      OPENCODE_GO_API_KEY: "ENDPOINT_RETRY_KEY",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.setEncoding("utf8");
  let errors = "";
  child.stderr.on("data", (chunk) => { errors += chunk; });

  try {
    const baseUrl = `http://127.0.0.1:${forwarderPort}`;
    await waitForHealth(baseUrl, child, () => errors);
    const response = await fetch(`${baseUrl}/v1/${options.route || "chat/completions"}`, {
      signal: AbortSignal.timeout(5000),
      method: "POST",
      headers: { Authorization: `Bearer ${internalKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: options.route === "embeddings" ? "opencode-go-fixture-embed" : options.nonGo ? "openrouter-fixture-chat" : "opencode-go-deepseek-v4-1-flash",
        messages: [{ role: "user", content: "test" }],
        stream: options.streaming || undefined,
        input: options.route === "embeddings" ? "test" : undefined,
      }),
    });
    let body;
    if (options.streaming) {
      const reader = response.body.getReader();
      let timeout;
      try {
        const first = await Promise.race([
          reader.read(), new Promise((_, reject) => {
            timeout = setTimeout(() => reject(new Error("first chunk blocked on upstream EOF")), 1500);
          }),
        ]);
        assert.equal(eofReleased, false, "upstream EOF must still be held");
        assert.ok(first.value.length);
        releaseEOF();
        while (!(await reader.read()).done) {}
      } finally { clearTimeout(timeout); releaseEOF(); }
    } else body = await response.text();
    const expectedFailures = options.route === "embeddings" || options.nonGo ? 1
      : replies.length === 1 && replies[0].status >= 300 ? 2
        : replies.filter((reply) => reply.status >= 300).length;
    let records = [];
    for (let i = 0; i < 100; i++) {
      try {
        const text = readFileSync(dumpPath, "utf8").trim();
        records = text ? text.split("\n").map(JSON.parse) : [];
        if (records.length >= expectedFailures) break;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return { status: response.status, calls, body, records };
  } finally {
    releaseEOF();
    child.kill("SIGTERM");
    if (child.exitCode === null) await new Promise((resolve) => child.once("exit", resolve));
    await new Promise((resolve) => upstream.close(resolve));
  }
}

test.after(() => rmSync(root, { recursive: true, force: true }));

test.before(async () => {
  await addEnvironmentCredentialToPool("opencode-go", "OPENCODE_GO_API_KEY", {
    credentialStorePath,
    poolStatePath,
  });
});

test("a terse endpoint-level rejection is re-sent once and the retry's success is relayed", async () => {
  const result = await forwardOnce([
    { status: 400, body: TERSE },
    { status: 200, body: SUCCESS },
  ]);
  assert.equal(result.status, 200);
  assert.equal(result.body, SUCCESS);
  assert.deepEqual(result.records.map((r) => r.status), [400]);
  assert.equal(result.calls, 2, "the terse rejection should be sent twice");
});

test("a terse rejection that persists is relayed after exactly one re-send", async () => {
  const result = await forwardOnce([{ status: 400, body: TERSE }]);
  assert.equal(result.status, 400);
  assert.equal(result.calls, 2, "the retry must be bounded to a single re-send");
});


test("successful retry streams a first chunk while upstream EOF is held", async () => {
  const result = await forwardOnce([
    { status: 400, body: TERSE },
    { status: 200, sse: true, body: 'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n' },
  ], { streaming: true });
  assert.equal(result.calls, 2);
  assert.deepEqual(result.records.map((r) => r.status), [400]);
});

test("the second HTTP failure is authoritative and each attempt is captured once", async () => {
  const result = await forwardOnce([{ status: 400, body: TERSE }, { status: 422, body: '{"error":"different"}' }]);
  assert.equal(result.status, 422);
  assert.equal(result.body, '{"error":"different"}');
  assert.deepEqual(result.records.map((r) => r.status), [400, 422]);
});

test("embeddings send one request even for the endpoint signature", async () => {
  const result = await forwardOnce([{ status: 400, body: TERSE }], { route: "embeddings" });
  assert.equal(result.status, 400);
  assert.equal(result.calls, 1);
  assert.deepEqual(result.records.map((r) => r.status), [400]);
});


test("another provider never replays the Go endpoint signature", async () => {
  const result = await forwardOnce([{ status: 400, body: TERSE }], { nonGo: true });
  assert.equal(result.status, 400);
  assert.equal(result.calls, 1);
  assert.equal(result.records.length, 1);
});
