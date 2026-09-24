import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  compositionStats,
  dumpRequestComposition,
  jsonBytes,
} from "../src/request-composition.mjs";

const DUMP_ENV = "CODEX_ROUTER_REQUEST_DUMP";

function withDumpPath(value, run) {
  const previous = process.env[DUMP_ENV];
  try {
    if (value === undefined) delete process.env[DUMP_ENV];
    else process.env[DUMP_ENV] = value;
    return run();
  } finally {
    if (previous === undefined) delete process.env[DUMP_ENV];
    else process.env[DUMP_ENV] = previous;
  }
}

test("composition stats count items and bytes per type with opaque ids", () => {
  const input = [
    { type: "message", id: "msg_1", role: "user", content: "hello" },
    {
      type: "function_call",
      id: "fc_1",
      call_id: "call_1",
      name: "exec_command",
      arguments: "{}",
    },
    { type: "function_call_output", call_id: "call_1", output: "ok" },
    { type: "message", id: "msg_2", role: "assistant", content: "plain" },
    { type: "compaction", encrypted_content: "kcr2:payload" },
  ];
  const stats = compositionStats(input);
  assert.equal(stats.count, 5);
  assert.equal(stats.bytes, input.reduce((sum, item) => sum + jsonBytes(item), 0));
  assert.deepEqual(
    Object.fromEntries(Object.entries(stats.byType).map(([type, bucket]) => [type, bucket.items])),
    { message: 2, function_call: 1, function_call_output: 1, compaction: 1 },
  );
  assert.deepEqual(
    stats.detail.map((entry) => entry.id),
    ["msg_1", "fc_1", "call_1", "msg_2", undefined],
  );
  assert.equal(
    stats.byType.message.bytes,
    jsonBytes(input[0]) + jsonBytes(input[3]),
  );
});

test("composition stats return undefined for a non-list input", () => {
  assert.equal(compositionStats(undefined), undefined);
  assert.equal(compositionStats("input"), undefined);
  assert.equal(compositionStats(null), undefined);
});

test("the dump stays silent until a path is configured, then appends one line per request", () => {
  const dir = mkdtempSync(join(tmpdir(), "request-composition-"));
  const path = join(dir, "requests.jsonl");
  try {
    withDumpPath(undefined, () => {
      dumpRequestComposition("turn", { model: "m" });
      assert.equal(existsSync(path), false);
    });
    withDumpPath(path, () => {
      dumpRequestComposition("turn", {
        model: "deepseek/deepseek-v4.1-flash",
        incoming: compositionStats([{ type: "message", id: "msg_1" }]),
        upstream: { bodyBytes: 12 },
      });
      dumpRequestComposition("summarize", { model: "deepseek/deepseek-v4.1-flash" });
    });
    const lines = readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      lines.map((line) => line.kind),
      ["turn", "summarize"],
    );
    assert.equal(lines[0].model, "deepseek/deepseek-v4.1-flash");
    assert.equal(lines[0].incoming.count, 1);
    assert.equal(lines[0].incoming.detail[0].id, "msg_1");
    assert.equal(lines[0].upstream.bodyBytes, 12);
    assert.equal(typeof lines[0].at, "string");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unwritable dump path never throws a routed turn", () => {
  const path = join(tmpdir(), "request-composition-missing", "requests.jsonl");
  withDumpPath(path, () => {
    assert.doesNotThrow(() => dumpRequestComposition("turn", { model: "m" }));
  });
});
