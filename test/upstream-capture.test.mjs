import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, statSync, mkdirSync, readdirSync, symlinkSync, linkSync, chmodSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  captureUpstreamFailure,
  recordUpstreamFailure,
  UPSTREAM_ERROR_DUMP_ENV,
  UPSTREAM_REQUEST_CAPTURE_ENV,
} from "../src/upstream-capture.mjs";

function withEnv(name, value, run) {
  const previous = process.env[name];
  const restore = () => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  };
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    const result = run();
    if (result?.then) return result.finally(restore);
    restore();
    return result;
  } catch (error) { restore(); throw error; }
}

function withDump(value, run) {
  return withEnv(UPSTREAM_ERROR_DUMP_ENV, value, run);
}

function normalized(body) {
  return {
    provider: { id: "opencode-go" },
    endpoint: { id: "opencode-go" },
    model: {
      slug: "opencode-go/deepseek-v4.1-flash",
      upstreamModel: "deepseek-v4.1-flash",
      requestProfile: "auto-tool-choice",
    },
    responseAdapter: "responses",
    body,
  };
}

function readRecords(file) {
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

test("nothing is captured while the dump variable is unset", () => {
  const directory = mkdtempSync(join(tmpdir(), "upstream-capture-"));
  try {
    const file = join(directory, "errors.jsonl");
    withDump(undefined, () => {
      const upstream = new Response("nope", { status: 400 });
      captureUpstreamFailure({ normalized: normalized(Buffer.from("{}")), upstream, startedAt: Date.now() });
    });
    assert.equal(existsSync(file), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an ok upstream response is never captured by the wrapper", async () => {
  const directory = mkdtempSync(join(tmpdir(), "upstream-capture-"));
  try {
    const file = join(directory, "errors.jsonl");
    await withDump(file, async () => {
      const upstream = new Response("ok", { status: 200 });
      captureUpstreamFailure({ normalized: normalized(Buffer.from("{}")), upstream, startedAt: Date.now() });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(existsSync(file), false);
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a non-2xx upstream response is recorded with its body and without secret headers", async () => {
  const directory = mkdtempSync(join(tmpdir(), "upstream-capture-"));
  try {
    const file = join(directory, "errors.jsonl");
    const requestBody = Buffer.from(JSON.stringify({ input: [1, 2, 3] }));
    const upstream = new Response(JSON.stringify({ model: "deepseek-v4.1-flash" }), {
      status: 400,
      headers: {
        "content-type": "application/json",
        authorization: "Bearer sk-secret-value",
        "x-request-id": "req-abc",
        "retry-after": "7",
        "x-not-diagnostic": "ignored",
      },
    });
    await withDump(file, () =>
      recordUpstreamFailure({
        normalized: normalized(requestBody),
        upstream,
        upstreamClone: upstream.clone(),
        startedAt: Date.now(),
      }),
    );

    const records = readRecords(file);
    assert.equal(records.length, 1);
    const record = records[0];
    assert.equal(record.kind, "upstream-error");
    assert.equal(record.provider, "opencode-go");
    assert.equal(record.upstreamModel, "deepseek-v4.1-flash");
    assert.equal(record.status, 400);
    assert.equal(record.requestBytes, requestBody.length);
    assert.match(record.requestSha256, /^[0-9a-f]{16}$/);
    assert.equal(record.requestCapturePath, undefined);
    assert.equal(record.responseBodyText, JSON.stringify({ model: "deepseek-v4.1-flash" }));
    assert.equal(record.responseBodyTruncated, false);
    assert.equal(record.responseHeaders["x-request-id"], "req-abc");
    assert.equal(record.responseHeaders["retry-after"], "7");
    assert.equal("authorization" in record.responseHeaders, false);
    assert.equal("x-not-diagnostic" in record.responseHeaders, false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the outgoing request body is a second opt-in and is written beside the dump", async () => {
  const directory = mkdtempSync(join(tmpdir(), "upstream-capture-"));
  try {
    const file = join(directory, "errors.jsonl");
    const requestBody = Buffer.from(JSON.stringify({ input: [{ type: "message", content: "hi" }] }));
    const upstream = new Response('{"model":"deepseek-v4.1-flash"}', { status: 400 });
    await withDump(file, () =>
      withEnv(UPSTREAM_REQUEST_CAPTURE_ENV, "1", () =>
        recordUpstreamFailure({
          normalized: normalized(requestBody),
          upstream,
          upstreamClone: upstream.clone(),
          startedAt: Date.now(),
        }),
      ),
    );

    const [record] = readRecords(file);
    assert.ok(record.requestCapturePath, "expected a captured request artifact");
    assert.deepEqual(readFileSync(record.requestCapturePath), requestBody);
    rmSync(record.requestCapturePath, { force: true });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});


test("an existing diagnostic file is hardened before append", async () => {
  const directory = mkdtempSync(join(tmpdir(), "upstream-capture-"));
  const file = join(directory, "errors.jsonl");
  try {
    writeFileSync(file, "", { mode: 0o644 });
    const upstream = new Response("bad", { status: 400 });
    await withDump(file, () => recordUpstreamFailure({ upstream, upstreamClone: upstream.clone() }));
    assert.equal(statSync(file).mode & 0o777, 0o600);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});


async function fixture(run) {
  const directory = mkdtempSync(join(tmpdir(), "upstream-capture-"));
  try { await withDump(join(directory, "errors.jsonl"), () => run(directory, join(directory, "errors.jsonl"))); }
  finally { rmSync(directory, { recursive: true, force: true }); }
}
function failure(text = "bad") { return new Response(text, { status: 400 }); }
function record(upstream = failure(), options = {}, body = Buffer.from("{}")) {
  return recordUpstreamFailure({ normalized: normalized(body), upstream }, options);
}

test("bounded UTF-8 capture reports observed bytes and leaves relay complete", async () => fixture(async (_, file) => {
  const upstream = failure("a😀rest");
  await record(upstream, { maxResponseBytes: 3 });
  const [item] = readRecords(file);
  assert.equal(item.responseBodyText, "a");
  assert.equal(item.responseBodyCapturedBytes, 3);
  assert.equal(item.responseBodyBytes, Buffer.byteLength("a😀rest"));
  assert.equal(item.responseBodyComplete, false);
  assert.equal(item.responseBodyTruncated, true);
  assert.equal(await upstream.text(), "a😀rest");
}));

test("hung capture finishes at its deadline while the original stays readable", async () => fixture(async (_, file) => {
  let source;
  const upstream = failure(new ReadableStream({ start(controller) { source = controller; controller.enqueue(new TextEncoder().encode("prefix")); } }));
  await record(upstream, { timeoutMs: 20 });
  const [item] = readRecords(file);
  assert.equal(item.responseBodyComplete, false);
  assert.equal(item.responseBodyText, "prefix");
  source.close();
  assert.equal(await upstream.text(), "prefix");
}));

test("admission is held through slow filesystem work and drops before clone", async () => fixture(async (_, file) => {
  let unblock;
  let entered;
  const gate = new Promise((resolve) => { unblock = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  const first = record(failure(), { maxInFlight: 1, beforeWrite: () => { entered(); return gate; } });
  await started;
  let clones = 0;
  const second = failure();
  second.clone = () => { clones++; throw new Error("must be dropped before cloning"); };
  await record(second, { maxInFlight: 1 });
  assert.equal(clones, 0);
  await record(second, { maxRetainedBytes: 1536 * 1024 });
  assert.equal(clones, 0, "byte lease must remain held while the first writer is blocked");
  unblock(); await first;
  assert.equal(readRecords(file).length, 1);
  await record(failure("later"));
  assert.equal(readRecords(file).length, 2);
}));

test("the retained-byte budget drops a raw request before cloning", async () => fixture(async () => {
  let clones = 0;
  const upstream = failure();
  upstream.clone = () => { clones++; throw new Error("admission must precede clone"); };
  await withEnv(UPSTREAM_REQUEST_CAPTURE_ENV, "1", () => record(upstream, { maxRetainedBytes: 1 }, Buffer.alloc(64)));
  assert.equal(clones, 0);
}));

test("JSONL rotates once with closed writers and private files", async () => fixture(async (directory, file) => {
  await record();
  const lineSize = statSync(file).size;
  for (let i = 0; i < 5; i++) await record(failure("bad"), { maxDumpBytes: lineSize + 16 });
  assert.deepEqual(readdirSync(directory).sort(), ["errors.jsonl", "errors.jsonl.1"]);
  assert.ok(statSync(file).size <= lineSize + 16);
  assert.ok(statSync(`${file}.1`).size <= lineSize + 16);
  assert.equal(statSync(`${file}.1`).mode & 0o777, 0o600);
  readRecords(file); readRecords(`${file}.1`);
}));

test("dump symlinks and hardlinks are rejected without modifying their target", async () => {
  for (const link of [symlinkSync, linkSync]) await fixture(async (directory, file) => {
    const target = join(directory, "target");
    writeFileSync(target, "protected", { mode: 0o644 });
    link(target, file);
    await record();
    assert.equal(readFileSync(target, "utf8"), "protected");
    assert.equal(statSync(target).mode & 0o777, 0o644);
  });
});

test("existing raw directory is hardened; concurrent writes reserve count and bytes", async () => fixture(async (directory, file) => {
  const rawDir = join(directory, "upstream-error-requests");
  mkdirSync(rawDir, { mode: 0o755 });
  await withEnv(UPSTREAM_REQUEST_CAPTURE_ENV, "true", () => Promise.all(Array.from({ length: 6 }, () => record(failure(), { maxRawFiles: 2, maxRawBytes: 20 }, Buffer.alloc(10, "a")))));
  assert.equal(statSync(rawDir).mode & 0o777, 0o700);
  const files = readdirSync(rawDir);
  assert.equal(files.length, 2);
  assert.ok(files.every((name) => statSync(join(rawDir, name)).size === 10));
  assert.ok(files.every((name) => (statSync(join(rawDir, name)).mode & 0o777) === 0o600));
  assert.equal(readRecords(file).length, 6);
}));

test("unknown occupants and unsafe owned names cannot be deleted to admit raw capture", async () => fixture(async (directory, file) => {
  const rawDir = join(directory, "upstream-error-requests");
  mkdirSync(rawDir);
  const occupant = join(rawDir, "operator-notes.json");
  writeFileSync(occupant, "keep");
  const target = join(directory, "private-target");
  writeFileSync(target, "keep too");
  symlinkSync(target, join(rawDir, "capture-00000000-0000-4000-8000-000000000000.json"));
  await withEnv(UPSTREAM_REQUEST_CAPTURE_ENV, "1", () => record(failure(), { maxRawFiles: 2 }));
  assert.equal(readFileSync(occupant, "utf8"), "keep");
  assert.equal(readdirSync(rawDir).length, 2);
  assert.equal(readRecords(file)[0].requestCapturePath, undefined);
}));

test("a symlink artifact directory is rejected without chmodding its target", async () => fixture(async (directory, file) => {
  const target = join(directory, "other");
  mkdirSync(target, { mode: 0o755 });
  symlinkSync(target, join(directory, "upstream-error-requests"));
  await withEnv(UPSTREAM_REQUEST_CAPTURE_ENV, "1", () => record());
  assert.equal(statSync(target).mode & 0o777, 0o755);
  assert.deepEqual(readdirSync(target), []);
  assert.equal(readRecords(file)[0].requestCapturePath, undefined);
}));

test("expired recognized raw artifacts are pruned while unknown files are retained", async () => fixture(async (directory) => {
  const rawDir = join(directory, "upstream-error-requests");
  mkdirSync(rawDir);
  const old = join(rawDir, "capture-00000000-0000-4000-8000-000000000000.json");
  writeFileSync(old, "old");
  const date = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  utimesSync(old, date, date);
  writeFileSync(join(rawDir, "keep"), "unknown");
  await withEnv(UPSTREAM_REQUEST_CAPTURE_ENV, "1", () => record());
  assert.equal(existsSync(old), false);
  assert.equal(existsSync(join(rawDir, "keep")), true);
}));

test("oversized raw requests are omitted while bounded metadata and headers remain", async () => fixture(async (_, file) => {
  const upstream = new Response("bad", { status: 400, headers: { "x-request-id": "x".repeat(4000), "x-opencode-token": "secret" } });
  await withEnv(UPSTREAM_REQUEST_CAPTURE_ENV, "1", () => record(upstream, {}, Buffer.alloc(24 * 1024 * 1024 + 1)));
  const [item] = readRecords(file);
  assert.equal(item.requestCapturePath, undefined);
  assert.equal(item.responseHeaders["x-request-id"], undefined);
  assert.equal(item.responseHeaders["x-opencode-token"], undefined);
  assert.ok(statSync(file).size < 1024);
}));


test("legacy timestamp artifacts participate in retention and retained files are hardened", async () => fixture(async (directory, file) => {
  const rawDir = join(directory, "upstream-error-requests");
  mkdirSync(rawDir, { mode: 0o755 });
  const expired = join(rawDir, "2026-01-02T03-04-05-006Z-0123abcd.json");
  const retained = join(rawDir, "2026-11-01T03-04-05-006Z-89abcdef.json");
  const unknown = join(rawDir, "2026-11-01T03-04-05-006Z-not-a-digest.json");
  writeFileSync(expired, "old", { mode: 0o644 });
  writeFileSync(retained, "current", { mode: 0o644 });
  writeFileSync(unknown, "operator", { mode: 0o644 });
  const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  utimesSync(expired, old, old);
  await withEnv(UPSTREAM_REQUEST_CAPTURE_ENV, "1", () => record(failure(), { maxRawFiles: 3, maxRawBytes: 24 }));
  assert.equal(existsSync(expired), false);
  assert.equal(readFileSync(retained, "utf8"), "current");
  assert.equal(statSync(retained).mode & 0o777, 0o600);
  assert.equal(statSync(rawDir).mode & 0o777, 0o700);
  assert.equal(readFileSync(unknown, "utf8"), "operator");
  assert.equal(statSync(unknown).mode & 0o777, 0o644);
  assert.ok(readRecords(file)[0].requestCapturePath);
  assert.equal(readdirSync(rawDir).length, 3);
}));

test("legacy artifacts can be evicted for byte budget without touching legacy-looking links", async () => fixture(async (directory, file) => {
  const rawDir = join(directory, "upstream-error-requests");
  mkdirSync(rawDir);
  const legacy = join(rawDir, "2026-11-01T01-02-03-004Z-abcdef12.json");
  const hardlink = join(rawDir, "2026-11-01T01-02-03-004Z-abcdef13.json");
  const symlink = join(rawDir, "2026-11-01T01-02-03-004Z-abcdef14.json");
  const target = join(directory, "target");
  writeFileSync(legacy, "x".repeat(40));
  writeFileSync(target, "protected", { mode: 0o644 });
  linkSync(target, hardlink);
  symlinkSync(target, symlink);
  const protectedBytes = statSync(hardlink).size + Buffer.byteLength(target);
  await withEnv(UPSTREAM_REQUEST_CAPTURE_ENV, "1", () => record(failure(), { maxRawFiles: 3, maxRawBytes: protectedBytes + 10 }));
  assert.equal(existsSync(legacy), false);
  assert.equal(readFileSync(target, "utf8"), "protected");
  assert.equal(statSync(target).mode & 0o777, 0o644);
  assert.equal(readdirSync(rawDir).length, 3);
  assert.ok(readRecords(file)[0].requestCapturePath);
}));
