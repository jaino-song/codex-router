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
