export const QWEN_FINAL_ANSWER_TOOL = "__codex_router_submit_final";

const TOOL_RESULT_TYPES = new Set([
  "function_call_output",
  "custom_tool_call_output",
  "local_shell_call_output",
  "computer_call_output",
]);

const CONTINUATION_INSTRUCTION =
  "The previous tool call finished. Continue the user's task now. " +
  "You must make exactly one function call: call the next task tool if more work is needed, " +
  `or call ${QWEN_FINAL_ANSWER_TOOL} with the complete final answer if the task is fully done. ` +
  "Do not return prose outside a function call.";

const FINAL_ANSWER_TOOL = {
  type: "function",
  name: QWEN_FINAL_ANSWER_TOOL,
  description: "Submit the complete final answer only when the user's task is fully finished.",
  parameters: {
    type: "object",
    properties: { answer: { type: "string" } },
    required: ["answer"],
    additionalProperties: false,
  },
  strict: true,
};

function isFunctionTool(tool) {
  return tool?.type === "function" && typeof tool.name === "string" && tool.name;
}

function lastInputWasToolResult(input) {
  if (!Array.isArray(input) || input.length === 0) return false;
  const last = input.at(-1);
  return Boolean(last && TOOL_RESULT_TYPES.has(last.type));
}

export function applyQwenToolContinuation(payload) {
  if (
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    payload.tool_choice === "none" ||
    !lastInputWasToolResult(payload.input) ||
    !Array.isArray(payload.tools) ||
    !payload.tools.some(isFunctionTool)
  ) {
    return { active: false, payload };
  }

  return {
    active: true,
    payload: {
      ...payload,
      // MLX can otherwise treat a post-tool turn as an ordinary assistant turn
      // and stop after narrating the next step. Requiring one call makes the
      // continuation explicit while the private final-answer tool preserves a
      // normal assistant response when no more task tools are needed.
      input: [
        ...payload.input,
        {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: CONTINUATION_INSTRUCTION }],
        },
      ],
      tools: [
        ...payload.tools.filter((tool) => tool?.name !== QWEN_FINAL_ANSWER_TOOL),
        FINAL_ANSWER_TOOL,
      ],
      tool_choice: "required",
      parallel_tool_calls: false,
    },
  };
}
