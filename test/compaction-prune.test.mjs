import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  dropCoveredByCompaction,
  encodeCheckpoint,
  finalizeCheckpoint,
  LEGACY_WARNING,
  prepareCompaction,
  renderCheckpoint,
} from "../src/compaction-checkpoint.mjs";

function message(role, text) {
  return {
    type: "message",
    role,
    content: [{ type: `${role === "user" ? "input" : "output"}_text`, text }],
  };
}

function call(id, name = "exec_command", args = "{}") {
  return { type: "function_call", call_id: id, name, arguments: args };
}

function output(id, value) {
  return { type: "function_call_output", call_id: id, output: value };
}

function modelSummary(overrides = {}) {
  return JSON.stringify({
    objective: "Continue the requested task.",
    requirement_refs: ["U001"],
    attempt_refs: ["C001"],
    observation_refs: ["R001"],
    unverified: [],
    unknowns: [],
    blockers: [],
    next_step: "Re-read current state before changing it.",
    ...overrides,
  });
}

function checkpointFrom(items) {
  return finalizeCheckpoint(modelSummary(), prepareCompaction(items));
}

const COVERED = [
  message("user", "Summarize the build failure."),
  call("run-1"),
  output("run-1", JSON.stringify({ output: "boom", exit_code: 1 })),
];

function compactionItem(id, checkpoint) {
  return { type: "compaction", id, encrypted_content: encodeCheckpoint(checkpoint) };
}

test("drops history the newest readable checkpoint covers", () => {
  const input = [
    message("user", "Start the task."),
    message("developer", "Standing instructions."),
    message("assistant", "Working on it."),
    call("run-1"),
    output("run-1", "boom"),
    message("user", "Fix it."),
    compactionItem("cmp_1", checkpointFrom(COVERED)),
    message("user", "Continue."),
  ];
  assert.deepEqual(dropCoveredByCompaction(input), [
    input[0],
    input[1],
    input[5],
    input[6],
    input[7],
  ]);
});

test("keeps the newest two user messages before the boundary", () => {
  const input = [
    message("user", "old ask"),
    message("user", "middle ask"),
    message("user", "newest ask"),
    output("run-9", "covered tool result"),
    compactionItem("cmp_1", checkpointFrom(COVERED)),
    message("user", "after"),
  ];
  assert.deepEqual(dropCoveredByCompaction(input), [input[1], input[2], input[4], input[5]]);
});

test("recognizes a rendered checkpoint message as a boundary", () => {
  const rendered = message("user", renderCheckpoint(checkpointFrom(COVERED)));
  const input = [
    message("user", "before"),
    output("run-2", "covered"),
    rendered,
    message("user", "after"),
  ];
  assert.deepEqual(dropCoveredByCompaction(input), [input[0], rendered, input[3]]);
});

test("recognizes a legacy summary message as a boundary", () => {
  const summary = message("user", `${LEGACY_WARNING}\n\nOld summary.`);
  const input = [
    message("user", "before"),
    output("run-3", "covered"),
    summary,
    message("user", "after"),
  ];
  assert.deepEqual(dropCoveredByCompaction(input), [input[0], summary, input[3]]);
});

test("does not treat an unreadable foreign compaction item as a boundary", () => {
  const input = [
    message("user", "before"),
    output("run-4", "kept"),
    { type: "compaction", id: "cmp_foreign", encrypted_content: "gAAAAABnot-router-issued" },
    message("user", "after"),
  ];
  assert.deepEqual(dropCoveredByCompaction(input), input);
});

test("an earlier checkpoint is dropped with the history it covers", () => {
  const first = checkpointFrom(COVERED);
  const second = checkpointFrom([...COVERED, message("user", "later work")]);
  const input = [
    compactionItem("cmp_1", first),
    output("run-5", "later covered work"),
    compactionItem("cmp_2", second),
    message("user", "after"),
  ];
  assert.deepEqual(dropCoveredByCompaction(input), [input[2], input[3]]);
});

test("is a no-op without a boundary, when the boundary leads, or for non-arrays", () => {
  const plain = [message("user", "hi"), output("run-6", "ok")];
  assert.equal(dropCoveredByCompaction(plain), plain);
  const leads = [compactionItem("cmp_1", checkpointFrom(COVERED)), message("user", "after")];
  assert.equal(dropCoveredByCompaction(leads), leads);
  assert.equal(dropCoveredByCompaction("nope"), "nope");
});

test("dropping is idempotent", () => {
  const input = [
    message("user", "old"),
    output("run-7", "covered"),
    compactionItem("cmp_1", checkpointFrom(COVERED)),
    message("user", "after"),
  ];
  const once = dropCoveredByCompaction(input);
  assert.deepEqual(dropCoveredByCompaction(once), once);
});

test("the routed turn opts in to pruning while the compaction request keeps everything", async () => {
  const source = await readFile(new URL("../src/router.mjs", import.meta.url), "utf8");
  assert.match(
    source,
    /function normalizeRoutedInput\(input, \{ dropCovered = false \} = \{\}\) \{/u,
  );
  assert.match(source, /dropCovered \? dropCoveredByCompaction\(input\) : input/u);
  assert.match(
    source,
    /normalizeRoutedAgentInput\(\s*request,\s*payload\.input,\s*controller\.signal,\s*\{ dropCovered: true \},?\s*\)/u,
  );
  // `summarize` builds the next checkpoint from the covered items, so its own
  // normalization call must stay unpruned.
  const summarizeCall = source.match(
    /const normalized = await normalizeRoutedAgentInput\(request, originalInput, signal\);/u,
  );
  assert.ok(summarizeCall);
  assert.doesNotMatch(summarizeCall[0], /dropCovered/u);
});
