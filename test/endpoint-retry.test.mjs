import assert from "node:assert/strict";
import test from "node:test";

import {
  isEndpointLevelRejection,
  isGoEndpointProvider,
  retryEndpointRejectionOnce,
} from "../src/endpoint-retry.mjs";

test("the terse model-only wrapper is an endpoint-level rejection", () => {
  assert.equal(isEndpointLevelRejection(400, '{"model":"deepseek-v4.1-flash"}'), true);
});

test("the opencode endpoint-unavailable body is an endpoint-level rejection", () => {
  assert.equal(
    isEndpointLevelRejection(
      422,
      '{"error":{"type":"server_error","message":"Upstream request failed: Endpoint is unavailable."}}',
    ),
    true,
  );
});

test("actionable and non-endpoint statuses are not retryable", () => {
  assert.equal(isEndpointLevelRejection(200, '{"model":"x"}'), false);
  assert.equal(isEndpointLevelRejection(400, '{"error":{"message":"Invalid base64 data"}}'), false);
  assert.equal(isEndpointLevelRejection(400, '{"model":"x","error":{"message":"no"}}'), false);
  assert.equal(isEndpointLevelRejection(429, '{"model":"x"}'), false);
  assert.equal(isEndpointLevelRejection(400, "not json"), false);
  assert.equal(isEndpointLevelRejection(400, ""), false);
});

test("a retryable rejection is re-sent once and the retry response wins", async () => {
  let calls = 0;
  const response = await retryEndpointRejectionOnce(async () => {
    calls += 1;
    return calls === 1
      ? new Response('{"model":"deepseek-v4.1-flash"}', { status: 400 })
      : new Response('{"ok":true}', { status: 200 });
  });
  assert.equal(calls, 2);
  assert.equal(response.status, 200);
});

test("a non-retryable failure is returned without a second send", async () => {
  let calls = 0;
  const response = await retryEndpointRejectionOnce(async () => {
    calls += 1;
    return new Response('{"error":{"message":"Invalid base64 data"}}', { status: 400 });
  });
  assert.equal(calls, 1);
  assert.equal(response.status, 400);
});

test("a retry that throws leaves the original response intact and readable", async () => {
  let calls = 0;
  const response = await retryEndpointRejectionOnce(async () => {
    calls += 1;
    if (calls === 1) return new Response('{"model":"m"}', { status: 400 });
    throw new Error("transport");
  });
  assert.equal(calls, 2);
  assert.equal(response.status, 400);
  assert.equal(await response.text(), '{"model":"m"}');
});


test("nonmatching status is never cloned or read", async () => {
  const response = new Response("busy", { status: 429 });
  response.clone = () => { throw new Error("must not clone this status"); };
  let clones = 0;
  response.clone = () => { clones++; return new Response("busy"); };
  assert.equal(await retryEndpointRejectionOnce(async () => response), response);
  assert.equal(clones, 0);
});

test("abort during the second attempt propagates", async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(retryEndpointRejectionOnce(async () => {
    if (++calls === 1) return new Response('{"model":"m"}', { status: 400 });
    controller.abort();
    throw controller.signal.reason;
  }, { signal: controller.signal }), { name: "AbortError" });
});


test("Go provider eligibility is an exact canonical family", async () => {
  for (const id of ["opencode-go", "opencode-go-messages", "opencode-go-responses"]) assert.ok(isGoEndpointProvider(id));
  for (const id of ["opencode", "deepseek", "opencode-go-other"]) {
    assert.equal(isGoEndpointProvider(id), false);
    let calls = 0;
    await retryEndpointRejectionOnce(async () => { calls++; return new Response('{"model":"x"}', { status: 400 }); }, { eligible: isGoEndpointProvider(id) });
    assert.equal(calls, 1);
  }
});

test("overflow leaves the original body readable without waiting for tee cancellation", async () => {
  const text = '{"model":"' + "x".repeat(4096) + '"}';
  let calls = 0;
  const result = await retryEndpointRejectionOnce(async () => { calls++; return new Response(text, { status: 400 }); }, { maxBytes: 64 });
  assert.equal(calls, 1);
  assert.equal(await result.text(), text);
});

test("a stalled clone has a deadline and does not consume the original branch", async () => {
  let controller;
  const first = new Response(new ReadableStream({ start(value) { controller = value; value.enqueue(new TextEncoder().encode('{"model":"x"}')); } }), { status: 400 });
  const result = await retryEndpointRejectionOnce(async () => first, { timeoutMs: 20 });
  assert.equal(result, first);
  controller.close();
  assert.equal(await result.text(), '{"model":"x"}');
});

test("a second HTTP failure wins and capture hook failures cannot change responses", async () => {
  for (const capture of [() => { throw new Error("capture"); }, async () => { throw new Error("capture"); }]) {
    let calls = 0;
    const result = await retryEndpointRejectionOnce(async () => ++calls === 1 ? new Response('{"model":"x"}', { status: 400 }) : new Response("quota", { status: 429 }), { capture });
    assert.equal(result.status, 429);
    assert.equal(await result.text(), "quota");
  }
});
