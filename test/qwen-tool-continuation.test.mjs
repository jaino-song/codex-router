import assert from "node:assert/strict";
import test from "node:test";

import {
  applyQwenToolContinuation,
  QWEN_FINAL_ANSWER_TOOL,
} from "../src/qwen-tool-continuation.mjs";

const REAL_TOOL = {
  type: "function",
  name: "exec_command",
  description: "Run a command.",
  parameters: {
    type: "object",
    properties: { cmd: { type: "string" } },
    required: ["cmd"],
    additionalProperties: false,
  },
};

test("Qwen tool continuation forces one next action after a tool result", () => {
  const original = {
    model: "qwen3.8-27b-uncensored",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "fix it" }] },
      { type: "function_call", call_id: "call-1", name: "exec_command", arguments: "{}" },
      { type: "function_call_output", call_id: "call-1", output: "ok" },
    ],
    tools: [REAL_TOOL],
    tool_choice: "auto",
    parallel_tool_calls: true,
  };

  const result = applyQwenToolContinuation(original);

  assert.equal(result.active, true);
  assert.equal(result.payload.tool_choice, "required");
  assert.equal(result.payload.parallel_tool_calls, false);
  assert.equal(result.payload.tools.at(-1).name, QWEN_FINAL_ANSWER_TOOL);
  assert.equal(result.payload.input.at(-1).role, "developer");
  assert.match(result.payload.input.at(-1).content[0].text, /previous tool call finished/i);
  assert.deepEqual(original.tools, [REAL_TOOL]);
  assert.equal(original.input.length, 3);
});

test("Qwen tool continuation leaves user turns and tool-disabled requests unchanged", () => {
  const userTurn = {
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }],
    tools: [REAL_TOOL],
    tool_choice: "auto",
  };
  const toolDisabled = {
    input: [{ type: "function_call_output", call_id: "call-1", output: "ok" }],
    tools: [REAL_TOOL],
    tool_choice: "none",
  };

  assert.deepEqual(applyQwenToolContinuation(userTurn), { active: false, payload: userTurn });
  assert.deepEqual(applyQwenToolContinuation(toolDisabled), { active: false, payload: toolDisabled });
});
