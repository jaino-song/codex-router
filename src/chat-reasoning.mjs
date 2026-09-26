// Keep the history contract separate from sampling/thinking request profiles.
// Command Code's DeepSeek route uses its normal Provider API parameters; giving
// it the direct DeepSeek profile would also change tool choice and sampling.
// Both hops must agree: the router carries `thinking` parts through LiteLLM,
// then the API forwarder restores the assistant's `reasoning_content` field.
//
// opencode Go resells its DeepSeek Flash family over a plain OpenAI surface, so
// those routes keep `auto-tool-choice` and must not borrow DeepSeek's sampling
// parameters -- but their thinking mode still refuses a continued turn whose
// assistant `reasoning_content` was not replayed, exactly like the direct route.
// Carry and restore those routes' reasoning too, and only their reasoning.
export function usesNativeChatReasoning(model) {
  return (
    model?.requestProfile === "glm-thinking" ||
    model?.requestProfile === "deepseek-thinking" ||
    (model?.provider === "commandcode" &&
      model?.upstreamModel === "deepseek/deepseek-v4-flash") ||
    (model?.provider === "opencode-go" &&
      (model?.upstreamModel === "deepseek-v4-flash" ||
        model?.upstreamModel === "deepseek-v4.1-flash"))
  );
}
