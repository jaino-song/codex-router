import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { setTimeout } from "node:timers/promises";
import {
  adaptHookInput,
  MAX_GROK_PATCH_HOOK_INPUT_BYTES,
  readHookInput,
} from "../src/grok-patch-hook.mjs";
import { GROK_PATCH_HOOK_PREFIX } from "../src/grok-patch-hook-transport.mjs";
import { MAX_STRUCTURED_PATCH_BYTES } from "../src/grok-structured-patch.mjs";

const script = fileURLToPath(new URL("../scripts/grok-patch-hook.mjs", import.meta.url));
const event = (raw) => ({
  hook_event_name: "PreToolUse",
  model: "grok-oauth/grok-4.6",
  tool_name: "apply_patch",
  tool_input: { command: GROK_PATCH_HOOK_PREFIX + raw },
});
const valid = JSON.stringify({ operations: [{ op: "add", path: "hello.txt", lines: ['Привет "world" 🌍', ""] }] });
const patch = '*** Begin Patch\n*** Add File: hello.txt\n+Привет "world" 🌍\n+\n*** End Patch';

async function runCli(chunks, { splitWrites = false } = {}) {
  const child = spawn(process.execPath, [script], { stdio: ["pipe", "pipe", "pipe"] });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  // A bound failure may close stdin before the producer finishes its writes.
  child.stdin.on("error", (error) => { if (error.code !== "EPIPE") throw error; });
  const closed = once(child, "close");
  for (const chunk of chunks) {
    child.stdin.write(chunk);
    if (splitWrites) await setTimeout(10);
  }
  child.stdin.end();
  const [code, signal] = await closed;
  return { code, signal, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() };
}

test("valid operations become exactly the native patch without mutating the event", () => {
  const input = event(valid);
  const before = structuredClone(input);
  assert.deepEqual(adaptHookInput(input), { hookSpecificOutput: {
    hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { command: patch },
  } });
  assert.deepEqual(input, before);
});

test("native patches, malformed event shapes and other routes or tool identities pass unchanged", () => {
  const controls = [
    null, {}, [], { ...event(valid), tool_input: null },
    { ...event(valid), tool_input: { command: 1 } },
    { ...event(valid), tool_input: { command: patch } },
    { ...event(valid), tool_input: { command: ` ${GROK_PATCH_HOOK_PREFIX}${valid}` } },
    { ...event(valid), tool_input: { command: `CODEX_ROUTER_STRUCTURED_PATCH_V2\n${valid}` } },
    ...["grok-oauth/grok-4.5", "grok-4.6", "gpt-6-astra", undefined].map((model) => ({ ...event(valid), model })),
    ...["other.apply_patch", "functions.apply_patch", "functions__apply_patch", "shell", undefined].map((tool_name) => ({ ...event(valid), tool_name })),
  ];
  for (const input of controls) assert.deepEqual(adaptHookInput(input), {});
});

test("invalid and ambiguous operations yield bounded native denial with no executable replacement", () => {
  for (const raw of [
    '{"operations":[]}',
    '{"operations":[],"operations":[{"op":"delete","path":"x"}]}',
    '{"operations":',
    JSON.stringify({ operations: [{ op: "add", path: "x", lines: ["private source\nnot a logical line"] }] }),
    JSON.stringify({ operations: [{ op: "add", path: "x", lines: ["\ud800"] }] }),
  ]) {
    const output = adaptHookInput(event(raw)).hookSpecificOutput;
    assert.equal(output.hookEventName, "PreToolUse");
    assert.equal(output.permissionDecision, "deny");
    assert.equal(Object.hasOwn(output, "updatedInput"), false);
    assert.match(output.permissionDecisionReason, /^Invalid structured apply_patch arguments \([a-z_]+\)\. Correct the structured arguments and retry this tool\.$/u);
    assert.ok(output.permissionDecisionReason.length < 200);
    assert.ok(!output.permissionDecisionReason.includes("private source"));
  }
});

test("argument byte bound is inclusive and multibyte overflows are denied", () => {
  const raw = '{"operations":[{"op":"delete","path":"x"}]}';
  const atBound = raw + " ".repeat(MAX_STRUCTURED_PATCH_BYTES - Buffer.byteLength(raw));
  assert.equal(adaptHookInput(event(atBound)).hookSpecificOutput.permissionDecision, "allow");
  const output = adaptHookInput(event(atBound + "🌍")).hookSpecificOutput;
  assert.equal(output.permissionDecision, "deny");
  assert.match(output.permissionDecisionReason, /arguments_too_large/u);
});

test("stdin preserves Unicode split at every byte boundary", async () => {
  const input = event(valid);
  const bytes = Buffer.from(JSON.stringify(input));
  const chunks = Array.from(bytes, (byte) => Buffer.from([byte]));
  assert.deepEqual(await readHookInput(Readable.from(chunks)), input);
});

test("stdin rejects invalid UTF-8, truncated JSON and already decoded streams", async () => {
  for (const bytes of [Buffer.from([0xff]), Buffer.from([0xe2, 0x82]), Buffer.from('{"private source":')]) {
    await assert.rejects(readHookInput(Readable.from([bytes])));
  }
  await assert.rejects(readHookInput(Readable.from(["{}"])), /byte stream/u);
});

test("event byte bound accepts the boundary and rejects before consuming further input", async () => {
  const bytes = Buffer.from("{}" + " ".repeat(MAX_GROK_PATCH_HOOK_INPUT_BYTES - 2));
  assert.deepEqual(await readHookInput(Readable.from([bytes])), {});
  let consumed = 0;
  async function* source() {
    consumed += 1;
    yield bytes;
    consumed += 1;
    yield Buffer.from(" ");
    consumed += 1;
    throw new Error("must not consume after overflow");
  }
  await assert.rejects(readHookInput(source()), /input bound/u);
  assert.equal(consumed, 2);
});

test("stream failures propagate without pretending to be a codec denial", async () => {
  const failure = new Error("simulated input failure");
  async function* source() {
    yield Buffer.from(JSON.stringify(event(valid)));
    throw failure;
  }
  await assert.rejects(readHookInput(source()), (error) => error === failure);
});

test("unexpected runtime exceptions propagate out of the adapter", () => {
  const failure = new Error("simulated runtime failure");
  assert.throws(() => adaptHookInput({ get tool_input() { throw failure; } }), (error) => error === failure);
});

test("actual CLI preserves UTF-8 split writes and emits one complete native response", async () => {
  const bytes = Buffer.from(JSON.stringify(event(valid)));
  const start = bytes.indexOf(Buffer.from("🌍"));
  const result = await runCli([
    bytes.subarray(0, start + 1), bytes.subarray(start + 1, start + 2),
    bytes.subarray(start + 2, start + 3), bytes.subarray(start + 3),
  ], { splitWrites: true });
  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, JSON.stringify(adaptHookInput(event(valid))) + "\n");
});

test("actual CLI reports semantic codec failures as native denial with a successful process exit", async () => {
  const result = await runCli([Buffer.from(JSON.stringify(event('{"operations":[]}')))]);
  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, "deny");
  assert.equal(Object.hasOwn(JSON.parse(result.stdout).hookSpecificOutput, "updatedInput"), false);
});

test("actual CLI input failures exit nonzero with no output or source-bearing diagnostics", async () => {
  for (const bytes of [
    Buffer.from('{"private source":'), Buffer.from([0xff]),
    Buffer.alloc(MAX_GROK_PATCH_HOOK_INPUT_BYTES + 1, 0x20),
  ]) {
    const result = await runCli([bytes]);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "Structured patch hook failed to process its input.\n");
  }
});

test("actual CLI emits no converted command when terminated before stdin completes", async () => {
  const child = spawn(process.execPath, [script], { stdio: ["pipe", "pipe", "pipe"] });
  const output = [];
  child.stdout.on("data", (chunk) => output.push(chunk));
  const closed = once(child, "close");
  child.stdin.on("error", () => {});
  child.stdin.write(Buffer.from(JSON.stringify(event(valid))));
  await setTimeout(50);
  child.kill("SIGTERM");
  const [code, signal] = await closed;
  assert.equal(code, null);
  assert.equal(signal, "SIGTERM");
  assert.equal(Buffer.concat(output).length, 0);
});
