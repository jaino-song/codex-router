// Keep the history contract separate from sampling/thinking request profiles.
// Command Code's DeepSeek route uses its normal Provider API parameters; giving
// it the direct DeepSeek profile would also change tool choice and sampling.
// Both hops must agree: the router carries `thinking` parts through LiteLLM,
// then the API forwarder restores the assistant's `reasoning_content` field.
export function usesNativeChatReasoning(model) {
  return (
    model?.requestProfile === "glm-thinking" ||
    model?.requestProfile === "deepseek-thinking" ||
    (model?.provider === "commandcode" &&
      model?.upstreamModel === "deepseek/deepseek-v4-flash")
  );
}
