// A gateway can restate a provider's rejection down to a body that names only
// the model, and opencode Go balances one logical model across several reseller
// endpoints. One endpoint rejecting a request the others accept is a routing
// artifact of that fan-out, not something the caller can fix by changing the
// request -- and the terse body carries no actionable message to act on. These
// two signatures are exactly the endpoint-level ones; everything else (a real
// validation error, a quota window, a transport failure) keeps its own handling.
const ENDPOINT_UNAVAILABLE = /endpoint is unavailable/i;

function parseJson(bodyText) {
  if (typeof bodyText !== "string" || bodyText === "") return undefined;
  try {
    return JSON.parse(bodyText);
  } catch {
    return undefined;
  }
}

export function isEndpointLevelRejection(status, bodyText) {
  if (status !== 400 && status !== 422) return false;
  const parsed = parseJson(bodyText);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const error = parsed.error;
  if (
    error &&
    typeof error === "object" &&
    !Array.isArray(error) &&
    ENDPOINT_UNAVAILABLE.test(String(error.message || ""))
  ) {
    return true;
  }
  // The terse wrapper: a JSON object whose only key is the echoed model name.
  const keys = Object.keys(parsed);
  return keys.length > 0 && keys.every((key) => key === "model") && typeof parsed.model === "string";
}

// A clone is a tee branch: awaiting cancel can wait for the original branch.
export function cancelBody(body) {
  try { void Promise.resolve(body?.cancel()).catch(() => undefined); } catch {}
}

export async function readBoundedBody(response, {
  maxBytes = 32 * 1024, timeoutMs = 5_000, signal,
} = {}) {
  maxBytes = Number.isFinite(maxBytes) ? Math.max(0, Math.min(maxBytes, 32 * 1024)) : 32 * 1024;
  timeoutMs = Number.isFinite(timeoutMs) ? Math.max(0, Math.min(timeoutMs, 5_000)) : 5_000;
  const reader = response.body?.getReader();
  if (!reader) return { buffer: Buffer.alloc(0), observedBytes: 0, complete: true };
  const chunks = [];
  let captured = 0;
  let observedBytes = 0;
  let complete = false;
  let reason;
  let timer;
  let onAbort;
  const stopped = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("body deadline exceeded")), timeoutMs);
    onAbort = () => reject(signal.reason || new DOMException("Aborted", "AbortError"));
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), stopped]);
      if (done) { complete = true; break; }
      observedBytes += value.byteLength;
      const size = Math.min(value.byteLength, maxBytes - captured);
      // Copy only the retained prefix, never retain a huge backing buffer.
      if (size) chunks.push(Buffer.from(value.subarray(0, size)));
      captured += size;
      if (observedBytes > maxBytes) { reason = "overflow"; break; }
    }
  } catch (error) {
    reason = signal?.aborted ? "aborted" : "incomplete";
    if (signal?.aborted) throw signal.reason || error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    if (!complete) {
      try { void reader.cancel().catch(() => undefined); } catch {}
    }
  }
  return { buffer: Buffer.concat(chunks, captured), observedBytes, complete, reason };
}

export function isGoEndpointProvider(providerId) {
  return ["opencode-go", "opencode-go-messages", "opencode-go-responses"].includes(providerId);
}

function captureSafely(capture, response) {
  try { void Promise.resolve(capture?.(response)).catch(() => undefined); } catch {}
}

// A second HTTP response is authoritative, including quota failures. Only a
// non-abort transport failure falls back to the still-readable first response.
export async function retryEndpointRejectionOnce(sendOnce, {
  signal, eligible = true, capture, ...readOptions
} = {}) {
  const send = async () => {
    signal?.throwIfAborted();
    const response = await sendOnce();
    captureSafely(capture, response);
    if (signal?.aborted) { cancelBody(response.body); signal.throwIfAborted(); }
    return response;
  };
  const first = await send();
  if (!eligible || (first.status !== 400 && first.status !== 422)) return first;
  let body;
  try { body = await readBoundedBody(first.clone(), { ...readOptions, signal }); }
  catch (error) { if (signal?.aborted) { cancelBody(first.body); throw error; } return first; }
  if (!body.complete || !isEndpointLevelRejection(first.status, body.buffer.toString("utf8"))) return first;
  try {
    const second = await send();
    cancelBody(first.body);
    return second;
  } catch (error) {
    if (signal?.aborted || error?.name === "AbortError") { cancelBody(first.body); throw error; }
    return first;
  }
}
