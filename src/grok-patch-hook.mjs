import {
  compileStructuredPatchArguments,
  MAX_STRUCTURED_PATCH_BYTES,
  StructuredPatchError,
} from "./grok-structured-patch.mjs";
import { GROK_PATCH_HOOK_PREFIX } from "./grok-patch-hook-transport.mjs";

// JSON escaping can expand the 1 MiB argument string sixfold. Reserve room
// for the native event metadata as well; reject the complete event above 8 MiB.
export const MAX_GROK_PATCH_HOOK_INPUT_BYTES = MAX_STRUCTURED_PATCH_BYTES * 8;

// This adapter only serializes. Native apply_patch still validates the patch
// and enforces its permissions. If this hook fails or is absent, the original
// prefixed envelope cannot be a native patch; this is not a general guarantee
// that the client's hook failures deny arbitrary native tool invocations.
export function adaptHookInput(event) {
  const command = event?.tool_input?.command;
  if (event?.model !== "grok-oauth/grok-4.6" || event?.tool_name !== "apply_patch" ||
      typeof command !== "string" || !command.startsWith(GROK_PATCH_HOOK_PREFIX)) return {};
  try {
    const patch = compileStructuredPatchArguments(command.slice(GROK_PATCH_HOOK_PREFIX.length));
    return { hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: { command: patch },
    } };
  } catch (error) {
    if (!(error instanceof StructuredPatchError)) throw error;
    // Only a bounded codec identifier enters feedback, never argument text or
    // arbitrary exception messages. The client may separately echo the command.
    const code = typeof error.code === "string" && /^[a-z_]{1,64}$/u.test(error.code)
      ? error.code : "invalid_arguments";
    return { hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `Invalid structured apply_patch arguments (${code}). Correct the structured arguments and retry this tool.`,
    } };
  }
}

export async function readHookInput(stream) {
  // A fixed byte buffer also bounds bookkeeping when stdin arrives one byte
  // at a time. Decode only after accumulation so split Unicode stays intact.
  const input = Buffer.allocUnsafe(MAX_GROK_PATCH_HOOK_INPUT_BYTES);
  let bytes = 0;
  for await (const chunk of stream) {
    if (!(chunk instanceof Uint8Array)) throw new TypeError("hook input must be a byte stream");
    if (chunk.byteLength > input.length - bytes) throw new Error("hook event exceeds input bound");
    input.set(chunk, bytes);
    bytes += chunk.byteLength;
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(input.subarray(0, bytes));
  return JSON.parse(text);
}
