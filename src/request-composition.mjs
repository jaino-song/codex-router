import { appendFileSync } from "node:fs";

// Prompt diagnostics for routed requests: byte sizes and opaque item ids only,
// never message text. Compaction behavior depends on what a client actually
// replays -- covered history a checkpoint already summarizes, checkpoint
// payloads, and freshly appended turns -- and that composition is invisible
// from the token counters a response reports. Point
// `CODEX_ROUTER_REQUEST_DUMP` at a file path to append one JSON line per
// routed turn and per compaction request; leave it unset for no cost.

export function requestDumpPath() {
  const value = String(process.env.CODEX_ROUTER_REQUEST_DUMP || "").trim();
  return value || undefined;
}

export function jsonBytes(value) {
  if (value === undefined) return undefined;
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
  } catch {
    return undefined;
  }
}

function itemId(item) {
  if (typeof item?.id === "string" && item.id) return item.id;
  if (typeof item?.call_id === "string" && item.call_id) return item.call_id;
  return undefined;
}

export function compositionStats(input) {
  if (!Array.isArray(input)) return undefined;
  const byType = {};
  const detail = [];
  let bytes = 0;
  for (const item of input) {
    const size = jsonBytes(item) ?? 0;
    const type = typeof item?.type === "string" ? item.type : "unknown";
    bytes += size;
    const bucket = (byType[type] ??= { items: 0, bytes: 0 });
    bucket.items += 1;
    bucket.bytes += size;
    const id = itemId(item);
    detail.push(id === undefined ? { type, bytes: size } : { type, id, bytes: size });
  }
  return { count: input.length, bytes, byType, detail };
}

export function dumpRequestComposition(kind, fields) {
  const path = requestDumpPath();
  if (!path) return;
  try {
    appendFileSync(
      path,
      `${JSON.stringify({ at: new Date().toISOString(), kind, ...fields })}\n`,
      "utf8",
    );
  } catch {
    // A diagnostic write must never fail or slow a routed turn.
  }
}
