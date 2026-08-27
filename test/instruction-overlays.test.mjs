import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyInstructionOverlay,
} from "../src/instruction-overlays.mjs";
import { MODEL_BY_SLUG } from "../src/model-registry.mjs";

test("Grok 4.6 OAuth distinguishes local files from discovered MCP resources", () => {
  const model = MODEL_BY_SLUG.get("grok-oauth/grok-4.6");
  assert.equal(model?.instructionOverlay, "filesystem-mcp-discipline");

  const instructions = applyInstructionOverlay("Base instructions.", model.instructionOverlay);
  assert.match(instructions, /local filesystem paths as files, never as MCP resource URIs/i);
  assert.match(instructions, /server name and URI returned by MCP.*discovery/i);
  assert.match(instructions, /Never invent an MCP server name such as file/i);
  assert.match(instructions, /unknown server or invalid URI.*do not repeat/is);
  assert.match(instructions, /Keep using read_mcp_resource for valid resources/i);
});
test("Qwen concise progress summaries are useful without exposing hidden reasoning", () => {
  const model = MODEL_BY_SLUG.get("custom/qwen3.8-27b-uncensored");
  assert.equal(model?.instructionOverlay, "concise-progress-summaries");

  const instructions = applyInstructionOverlay("Base instructions.", model.instructionOverlay);
  assert.match(instructions, /Before the first tool call.*one short commentary update/is);
  assert.match(instructions, /material finding, blocker, changed approach, or meaningful milestone/i);
  assert.match(instructions, /Do not narrate each command or tool result/i);
  assert.match(instructions, /Avoid generic repeated status messages/i);
  assert.match(instructions, /without exposing hidden chain-of-thought or private scratch work/i);
});

test("token maxxing activates exactly at seventy percent of auto-compaction", () => {
  const base = {
    enabled: true,
    autoCompact: 100_000,
  };
  assert.equal(tokenMaxxingActive({ ...base, estimatedTokens: 69_999 }), false);
  assert.equal(tokenMaxxingActive({ ...base, estimatedTokens: 70_000 }), true);
  assert.equal(tokenMaxxingActive({ ...base, estimatedTokens: 90_000 }), true);
  assert.equal(tokenMaxxingActive({ ...base, estimatedTokens: 90_000, enabled: false }), false);
  assert.equal(tokenMaxxingActive({ ...base, estimatedTokens: undefined }), false);
});

test("the pressure overlay is terse, recoverable, and can stand alone", () => {
  const inactive = applyTokenMaxxingOverlay("Base instructions.", {
    enabled: true,
    estimatedTokens: 69_999,
    autoCompact: 100_000,
  });
  assert.equal(inactive, "Base instructions.");

  const active = applyTokenMaxxingOverlay("Base instructions.", {
    enabled: true,
    estimatedTokens: 70_000,
    autoCompact: 100_000,
  });
  assert.match(active, /^Base instructions\./u);
  assert.match(active, /Be terse in commentary and final prose/u);
  assert.match(active, /Repeat its named source call only when omitted detail is necessary/u);

  assert.match(
    applyTokenMaxxingOverlay(undefined, { active: true }),
    /^## Context pressure mode/u,
  );
});
