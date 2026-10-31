import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { cancelBody, readBoundedBody } from "./endpoint-retry.mjs";

export const UPSTREAM_ERROR_DUMP_ENV = "CODEX_ROUTER_UPSTREAM_ERROR_DUMP";
export const UPSTREAM_REQUEST_CAPTURE_ENV = "CODEX_ROUTER_CAPTURE_UPSTREAM_REQUESTS";
const MAX_REQUEST_BYTES = 24 * 1024 * 1024;
const SECRET_HEADER = /(authorization|cookie|api[-_]?key|secret|token)/i;
const DIAGNOSTIC_HEADER = /^(content-type|date|server|via|retry-after(-ms)?|request-id|x-request-id|x-amzn-requestid|cf-ray|x-ratelimit-.*|ratelimit-.*|x-opencode.*|x-zen.*|x-deepseek.*|openai-.*)$/i;
const OWNED_NAME = /^capture-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/;
const lanes = new Map();
let active = 0;
let retained = 0;

export function upstreamErrorDumpPath() {
  return String(process.env[UPSTREAM_ERROR_DUMP_ENV] || "").trim() || undefined;
}
export function upstreamRequestCaptureEnabled() {
  return /^(1|true)$/i.test(String(process.env[UPSTREAM_REQUEST_CAPTURE_ENV] || "").trim());
}
const digest = (value) => createHash("sha256").update(value).digest("hex").slice(0, 16);
const bounded = (value) => typeof value === "string" ? value.slice(0, 256) : undefined;
function limit(value, maximum) {
  return Number.isFinite(value) ? Math.max(0, Math.min(value, maximum)) : maximum;
}
function headersFit(headers) {
  let bytes = 0;
  for (const [name, value] of headers || []) {
    bytes += Buffer.byteLength(name) + Buffer.byteLength(value);
    if (bytes > 64 * 1024) return false;
  }
  return true;
}
function headersFor(headers) {
  const result = {};
  let bytes = 0;
  for (const [name, value] of headers || []) {
    if (SECRET_HEADER.test(name) || !DIAGNOSTIC_HEADER.test(name)) continue;
    const entryBytes = Buffer.byteLength(name) + Buffer.byteLength(value);
    if (entryBytes > 1024 || bytes + entryBytes > 8192) continue;
    result[name] = value;
    bytes += entryBytes;
  }
  return result;
}
function serialize(key, task) {
  const previous = lanes.get(key) || Promise.resolve();
  const current = previous.catch(() => undefined).then(task);
  lanes.set(key, current);
  return current.finally(() => { if (lanes.get(key) === current) lanes.delete(key); });
}
function owned(stat, directory = false) {
  if (typeof process.getuid !== "function" || stat.uid !== process.getuid() ||
      (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) {
    throw new Error("unsafe diagnostic target");
  }
}
function same(a, b) { return a.dev === b.dev && a.ino === b.ino; }
async function statIfPresent(file) {
  try { return await fs.lstat(file); } catch (error) { if (error.code === "ENOENT") return; throw error; }
}
// No truncating open: even platforms without O_NOFOLLOW must verify the opened
// identity before chmod or write. O_NONBLOCK prevents FIFO substitution hangs.
async function openPrivate(file, exclusive = false) {
  const before = await statIfPresent(file);
  if (before) owned(before);
  if (exclusive && before) throw new Error("diagnostic collision");
  const flags = constants.O_WRONLY | constants.O_APPEND | (constants.O_NOFOLLOW || 0) |
    (constants.O_NONBLOCK || 0) | (!before ? constants.O_CREAT | constants.O_EXCL : 0);
  const handle = await fs.open(file, flags, 0o600);
  try {
    const opened = await handle.stat();
    const after = await fs.lstat(file);
    owned(opened); owned(after);
    if (!same(opened, after) || (before && !same(before, opened))) throw new Error("diagnostic identity changed");
    await handle.chmod(0o600);
    return handle;
  } catch (error) { await handle.close(); throw error; }
}
async function privateDirectory(directory) {
  try { await fs.mkdir(directory, { mode: 0o700 }); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  const before = await fs.lstat(directory);
  owned(before, true);
  const handle = await fs.open(directory, constants.O_RDONLY | (constants.O_DIRECTORY || 0) | (constants.O_NOFOLLOW || 0));
  try {
    const opened = await handle.stat();
    owned(opened, true);
    if (!same(before, opened) || !same(opened, await fs.lstat(directory))) throw new Error("directory identity changed");
    await handle.chmod(0o700);
    return opened;
  } finally { await handle.close(); }
}
async function checkDirectory(directory, identity) {
  const current = await fs.lstat(directory);
  owned(current, true);
  if (!same(current, identity)) throw new Error("directory changed");
}
async function rawArtifact(dumpPath, buffer, options) {
  const parent = await fs.realpath(path.dirname(dumpPath));
  const directory = path.join(parent, "upstream-error-requests");
  // All dumps sharing this directory share a retention lane. The lane remains
  // held through create/write/close, so pending writes reserve their disk usage.
  return serialize(directory, async () => {
    const identity = await privateDirectory(directory);
    const files = [];
    let count = 0;
    let bytes = 0;
    for (const name of await fs.readdir(directory)) {
      const file = path.join(directory, name);
      const stat = await fs.lstat(file);
      if (!stat.isFile() && !stat.isSymbolicLink()) return;
      count++;
      bytes += stat.size;
      // Unknown occupants consume budget but are never deleted or chmodded.
      if (OWNED_NAME.test(name) && stat.isFile() && stat.nlink === 1 && stat.uid === process.getuid()) {
        files.push({ file, stat });
      }
    }
    files.sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs);
    const maxFiles = limit(options.maxRawFiles, 16);
    const maxBytes = limit(options.maxRawBytes, 64 * 1024 * 1024);
    for (const item of files) {
      const expired = Date.now() - item.stat.mtimeMs > 7 * 24 * 60 * 60 * 1000;
      if (!expired && count + 1 <= maxFiles && bytes + buffer.length <= maxBytes) continue;
      await checkDirectory(directory, identity);
      const current = await fs.lstat(item.file);
      owned(current);
      if (!same(current, item.stat)) throw new Error("artifact changed");
      await fs.unlink(item.file);
      count--; bytes -= item.stat.size;
    }
    if (count + 1 > maxFiles || bytes + buffer.length > maxBytes) return;
    await checkDirectory(directory, identity);
    const file = path.join(directory, `capture-${randomUUID()}.json`);
    const handle = await openPrivate(file, true);
    try {
      await checkDirectory(directory, identity);
      await handle.writeFile(buffer);
    } catch (error) {
      await handle.close();
      // Do not unlink a path that another process may have replaced.
      throw error;
    }
    await handle.close();
    return file;
  });
}
async function appendRecord(file, line, options) {
  const parent = await fs.realpath(path.dirname(file));
  file = path.join(parent, path.basename(file));
  return serialize(file, async () => {
    await options.beforeWrite?.();
    const maxBytes = limit(options.maxDumpBytes, 1024 * 1024);
    if (Buffer.byteLength(line) > maxBytes) return;
    const backup = `${file}.1`;
    const existingBackup = await statIfPresent(backup);
    if (existingBackup) {
      owned(existingBackup);
      if (existingBackup.size > maxBytes) throw new Error("existing diagnostic exceeds limit");
      const verified = await openPrivate(backup);
      await verified.close();
    }
    let handle = await openPrivate(file);
    let size;
    try { size = (await handle.stat()).size; } finally { await handle.close(); }
    if (size > maxBytes) throw new Error("existing diagnostic exceeds limit");
    if (size + Buffer.byteLength(line) > maxBytes) {
      // Every owned handle is closed before rotation. Verify the backup before
      // replacing it, even though rename itself would not follow a symlink.
      const previous = await statIfPresent(backup);
      if (previous) {
        const verified = await openPrivate(backup);
        await verified.close();
        await fs.unlink(backup);
      }
      const verified = await openPrivate(file);
      await verified.close();
      await fs.rename(file, backup);
    }
    handle = await openPrivate(file);
    try { await handle.writeFile(line, "utf8"); } finally { await handle.close(); }
  });
}

// Admission and the clone happen synchronously, before the relay can consume
// the response. Options are internal test seams, never payload/env settings.
export function captureUpstreamFailure(args = {}, options = {}) {
  return recordUpstreamFailure(args, options);
}
export function recordUpstreamFailure({ normalized, upstream, upstreamClone, startedAt } = {}, options = {}) {
  try {
    const configuredPath = upstreamErrorDumpPath();
    const dumpPath = configuredPath ? path.resolve(configuredPath) : undefined;
    if (!dumpPath || !upstream || upstream.ok !== false || !headersFit(upstream.headers)) return Promise.resolve();
    const body = normalized?.body;
    const requestBytes = typeof body === "string" ? Buffer.byteLength(body) : body?.byteLength;
    const raw = upstreamRequestCaptureEnabled() && Number.isFinite(requestBytes) && requestBytes <= MAX_REQUEST_BYTES;
    // Include retained input, its possible encoded copy, the response prefix,
    // bounded metadata, JSON escaping and the serialized line in this lease.
    const reservation = 1024 * 1024 + (raw ? (typeof body === "string" ? 3 : 2) * requestBytes : 0);
    if (active >= limit(options.maxInFlight, 8) || retained + reservation > limit(options.maxRetainedBytes, 64 * 1024 * 1024)) return Promise.resolve();
    active++; retained += reservation;
    let clone;
    let snapshot;
    let requestBuffer;
    try {
      clone = upstreamClone || upstream.clone();
      requestBuffer = raw ? Buffer.from(body) : undefined;
      snapshot = {
        at: new Date().toISOString(), kind: "upstream-error",
        provider: bounded(normalized?.provider?.id), endpoint: bounded(normalized?.endpoint?.id),
        model: bounded(normalized?.model?.slug), upstreamModel: bounded(normalized?.model?.upstreamModel),
        requestProfile: bounded(normalized?.model?.requestProfile), responseAdapter: bounded(normalized?.responseAdapter),
        status: upstream.status, durationMs: Number.isFinite(startedAt) ? Date.now() - startedAt : undefined,
        requestBytes, requestSha256: Number.isFinite(requestBytes) && requestBytes <= MAX_REQUEST_BYTES ? digest(body) : undefined,
        responseHeaders: headersFor(upstream.headers),
      };
    } catch {
      cancelBody(clone?.body);
      active--; retained -= reservation;
      return Promise.resolve();
    }
    return (async () => {
      const result = await readBoundedBody(clone, { maxBytes: options.maxResponseBytes ?? 32 * 1024, timeoutMs: options.timeoutMs ?? 5_000 });
      // Streaming decode omits an incomplete UTF-8 suffix at the cutoff.
      const responseBodyText = new TextDecoder().decode(result.buffer, { stream: !result.complete });
      let requestCapturePath;
      if (requestBuffer) {
        try { requestCapturePath = await rawArtifact(dumpPath, requestBuffer, options); } catch {}
      }
      const record = { ...snapshot, requestCapturePath,
        responseBodyBytes: result.observedBytes, responseBodyCapturedBytes: result.buffer.length,
        responseBodyComplete: result.complete, responseBodyTruncated: !result.complete,
        responseBodySha256: digest(result.buffer), responseBodyText,
      };
      const line = `${JSON.stringify(record)}\n`;
      if (Buffer.byteLength(line) <= 256 * 1024) await appendRecord(dumpPath, line, options);
    })().catch(() => undefined).finally(() => { active--; retained -= reservation; });
  } catch { return Promise.resolve(); }
}
