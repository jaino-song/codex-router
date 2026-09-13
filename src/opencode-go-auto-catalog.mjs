import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { applyModelOverlayPublication, transactModelOverlayMutation } from "./model-overlay-publication.mjs";
import { discoverProviderModels } from "./model-discovery.mjs";
import { CHECKED_IN_MODELS } from "./model-registry.mjs";
import { canonicalProviderId, configuredProviderIds } from "./provider-selection.mjs";
import { discoveryDisabled } from "./discovery-mode.mjs";
import { readControlActivity } from "./control-activity.mjs";
import { assertCallerSecret, callerBaseUrl } from "./caller-auth.mjs";
import { CALLER_SECRET_PATH, INSTALL_MANIFEST_PATH, LAUNCH_AGENTS_DIR, PORTS, PROVIDER_SELECTION_PATH, SOURCE_ROOT, STATE_DIR } from "./paths.mjs";
import { MODEL_PICKER_STATE_PATH } from "./model-picker-state.mjs";
import { USER_MODELS_PATH, userModelEntry } from "./user-models.mjs";
import { writePrivateFile } from "./file-security.mjs";

const SELF = fileURLToPath(import.meta.url);

export const GO_DOCS_URL = "https://opencode.ai/docs/go/";
export const GO_AUTO_CATALOG_SCHEMA_VERSION = 1;
export const GO_AUTO_INTERVAL_SECONDS = 300;
export const GO_AUTO_QUIET_MS = 60_000;
export const GO_AUTO_DOC_TIMEOUT_MS = 10_000;
export const GO_AUTO_DOC_MAX_BYTES = 2 * 1024 * 1024;
export const GO_AUTO_LABEL = "io.github.codex-router.opencode-go-auto-catalog";
export const GO_ENDPOINT_PROVIDERS = Object.freeze({
  "/chat/completions": "opencode-go",
  "/messages": "opencode-go-messages",
  "/responses": "opencode-go-responses",
});

const MAX_STATE_BYTES = 16 * 1024 * 1024;
const MAX_IDS = 20_000;
const GO_PROVIDER = "opencode-go";
const GO_FAMILY = new Set(Object.values(GO_ENDPOINT_PROVIDERS));

function statePath(options = {}) {
  const stateDir = options.stateDir || STATE_DIR;
  const policyPath = options.policyPath || path.join(stateDir, "opencode-go-auto-catalog-policy.json");
  const statusPath = options.statusPath || path.join(stateDir, "opencode-go-auto-catalog-status.json");
  const seenPath = options.seenPath || path.join(stateDir, "opencode-go-auto-catalog-seen.json");
  const lockPath = options.lockPath || path.join(stateDir, "opencode-go-auto-catalog.lock");
  const launchAgentsDir = options.launchAgentsDir || LAUNCH_AGENTS_DIR;
  const plistPath = options.plistPath || path.join(launchAgentsDir, `${GO_AUTO_LABEL}.plist`);
  return { stateDir, policyPath, statusPath, seenPath, lockPath, launchAgentsDir, plistPath };
}

export function goAutoCatalogPaths(options = {}) {
  return statePath(options);
}

function userModelsFile(options, paths) {
  return options.userModelsPath || (paths.stateDir === STATE_DIR ? USER_MODELS_PATH : path.join(paths.stateDir, "user-models.json"));
}

function pickerFile(options, paths) {
  return options.pickerPath || (paths.stateDir === STATE_DIR ? MODEL_PICKER_STATE_PATH : path.join(paths.stateDir, "model-picker.json"));
}

function selectionFile(options, paths) {
  return options.selectionPath || (paths.stateDir === STATE_DIR ? PROVIDER_SELECTION_PATH : path.join(paths.stateDir, "enabled-providers.json"));
}

function installManifestFile(options, paths) {
  return options.installManifestPath || (paths.stateDir === STATE_DIR ? INSTALL_MANIFEST_PATH : path.join(paths.stateDir, "install-manifest.json"));
}

function makeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function readBoundedFile(file, maxBytes = MAX_STATE_BYTES) {
  let stat;
  try {
    stat = lstatSync(file);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw makeError("invalid_state", `Cannot inspect state file ${path.basename(file)}.`);
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) {
    throw makeError("invalid_state", `State file ${path.basename(file)} is not a regular bounded file.`);
  }
  return readFileSync(file, "utf8");
}

function parseObject(text, code) {
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("object required");
    return parsed;
  } catch {
    throw makeError(code, "State JSON is malformed.");
  }
}

function validString(value, { max = 512 } = {}) {
  return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
}

function strictUserModels(file = path.join(STATE_DIR, "user-models.json")) {
  const text = readBoundedFile(file);
  if (text === undefined) return { exists: false, models: [] };
  const parsed = parseObject(text, "invalid_user_models_state");
  if (parsed.version !== 1 || !Array.isArray(parsed.models) || parsed.models.length > MAX_IDS) {
    throw makeError("invalid_user_models_state", "User model state is not version 1.");
  }
  const slugs = new Set();
  const gateways = new Set();
  const models = parsed.models.map((model) => {
    if (!model || typeof model !== "object" || Array.isArray(model)) throw makeError("invalid_user_models_state", "User model entry is malformed.");
    for (const key of ["slug", "gatewayModel", "upstreamModel", "provider"]) {
      if (!validString(model[key])) throw makeError("invalid_user_models_state", "User model identity is malformed.");
    }
    if (slugs.has(model.slug) || gateways.has(model.gatewayModel)) throw makeError("invalid_user_models_state", "User model identities are duplicated.");
    slugs.add(model.slug); gateways.add(model.gatewayModel);
    return model;
  });
  return { exists: true, models };
}

function strictPickerState(file) {
  const text = readBoundedFile(file);
  if (text === undefined) return { exists: false, recognized: false, hidden: [], visible: [], seeded: [], explicit: false };
  const parsed = parseObject(text, "invalid_picker_state");
  if (parsed.version !== 1 || !Array.isArray(parsed.hidden) || parsed.hidden.length > MAX_IDS) throw makeError("invalid_picker_state", "Model picker state is not version 1.");
  const list = (value, required = false) => {
    if (required && !Array.isArray(value)) throw makeError("invalid_picker_state", "Model picker visibility is malformed.");
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > MAX_IDS || value.some((item) => !validString(item))) throw makeError("invalid_picker_state", "Model picker slugs are malformed.");
    if (new Set(value).size !== value.length) throw makeError("invalid_picker_state", "Model picker slugs contain duplicates.");
    return [...new Set(value)];
  };
  const hidden = list(parsed.hidden, true);
  const seeded = list(parsed.seeded);
  const explicit = Array.isArray(parsed.visible);
  const visible = explicit ? list(parsed.visible, true) : seeded.filter((slug) => !hidden.includes(slug));
  if (visible.some((slug) => hidden.includes(slug))) throw makeError("invalid_picker_state", "Model picker state marks a slug both hidden and visible.");
  return { exists: true, recognized: true, hidden, visible: visible.filter((slug) => !hidden.includes(slug)), seeded, explicit };
}

function strictSeenState(file) {
  const text = readBoundedFile(file);
  if (text === undefined) return { exists: false, seen: [] };
  const parsed = parseObject(text, "invalid_seen_state");
  if (parsed.version !== 1 || !Array.isArray(parsed.seen) || parsed.seen.length > MAX_IDS || parsed.seen.some((item) => !validString(item, { max: 1024 }))) throw makeError("invalid_seen_state", "Go catalog history is malformed.");
  if (new Set(parsed.seen).size !== parsed.seen.length) throw makeError("invalid_seen_state", "Go catalog history contains duplicates.");
  return { exists: true, seen: [...parsed.seen] };
}

function writeJson(file, value) {
  writePrivateFile(file, `${JSON.stringify(value, null, 2)}\n`, { directoryMode: 0o700 });
  return file;
}

function readPolicy(file) {
  const text = readBoundedFile(file, 512 * 1024);
  if (text === undefined) return { exists: false, enabled: false };
  try {
    const parsed = parseObject(text, "invalid_policy");
    if (parsed.version !== 1 || typeof parsed.enabled !== "boolean" || !validString(parsed.sourceRoot, { max: 4096 }) || !validString(parsed.stateDir, { max: 4096 })) throw new Error("invalid policy");
    return parsed;
  } catch (error) {
    if (error?.code === "invalid_policy") throw error;
    throw makeError("invalid_policy", "Auto catalog policy is malformed.");
  }
}

function statusError(error) {
  if (error?.code === "docs_duplicate_model") return "duplicate documented model";
  if (error?.code === "docs_missing_protocol") return "official documentation does not expose a supported endpoint table";
  if (error?.code === "docs_unknown_endpoint") return "official documentation contains an unsupported endpoint";
  if (error?.code === "invalid_user_models_state") return "user model state is malformed";
  if (error?.code === "invalid_picker_state") return "model picker state is malformed";
  if (error?.code === "invalid_seen_state") return "catalog history is malformed";
  if (error?.code === "foreign_state_owner") return "state belongs to another source checkout";
  return error?.code || "catalog check failed";
}

function decodeHtml(text) {
  return String(text)
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Math.min(0x10ffff, Number(n))))
    .replace(/&#x([\da-f]+);/gi, (_, n) => String.fromCodePoint(Math.min(0x10ffff, parseInt(n, 16))))
    .replace(/\s+/g, " ")
    .trim();
}

function tableRows(table) {
  return [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((match) => [...match[1].matchAll(/<(?:th|td)\b[^>]*>([\s\S]*?)<\/(?:th|td)>/gi)].map((cell) => decodeHtml(cell[1]))).filter((row) => row.length > 0);
}

function normalizeEndpoint(raw) {
  const source = decodeHtml(raw).replace(/^POST\s+/, "");
  const prefix = "https://opencode.ai/zen/go/v1";
  const endpoint = Object.keys(GO_ENDPOINT_PROVIDERS).find((value) => source === `${prefix}${value}`);
  if (!endpoint) throw makeError("docs_unknown_endpoint", "The official Go table has no exact supported endpoint.");
  return endpoint;
}

function documentedContext(raw) {
  const value = decodeHtml(raw).toLowerCase().replace(/,/g, "").trim();
  const match = value.match(/^(\d+)(?:\s*(k|m))?(?:\s*tokens?)?$/);
  if (!match) return undefined;
  const multiplier = match[2] === "m" ? 1_000_000 : match[2] === "k" ? 1_000 : 1;
  const result = Number(match[1]) * multiplier;
  return Number.isSafeInteger(result) && result > 0 ? result : undefined;
}

function documentedModalities(raw) {
  const value = decodeHtml(raw).toLowerCase();
  const modalities = [];
  if (/\btext\b/.test(value)) modalities.push("text");
  if (/\bimage|vision\b/.test(value)) modalities.push("image");
  return modalities.length ? modalities : undefined;
}

/** Parse the public OpenCode Go endpoint table into an allowlisted protocol map. */
export function parseOfficialGoDocs(html) {
  if (typeof html !== "string" || html.length === 0 || Buffer.byteLength(html, "utf8") > GO_AUTO_DOC_MAX_BYTES) throw makeError("docs_missing_protocol", "The official Go documentation is empty or too large.");
  const tables = [...html.matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/gi)].map((match) => tableRows(match[0]));
  const rows = [];
  for (const table of tables) {
    const header = table[0]?.map((value) => value.toLowerCase()).join(" ") || "";
    if (!/model|model id|id/.test(header) || !/endpoint|api|route|protocol/.test(header)) continue;
    const headers = table[0].map((value) => value.toLowerCase());
    const modelIndex = headers.findIndex((value) => /^(?:model\s+)?id$/.test(value));
    if (modelIndex < 0) continue;
    const endpointIndex = headers.findIndex((value) => /endpoint|api|route|protocol/.test(value));
    const contextIndex = headers.findIndex((value) => /context|max.*token|window/.test(value));
    const inputIndex = headers.findIndex((value) => /input|modal/.test(value));
    const displayIndex = headers.findIndex((value, index) => index !== modelIndex && /display|model\s*name/.test(value));
    for (const row of table.slice(1)) {
      if (row.length <= Math.max(modelIndex, endpointIndex)) continue;
      const modelId = row[modelIndex]?.trim();
      if (!validString(modelId, { max: 512 }) || /model\s*id|model\s*name/i.test(modelId)) continue;
      const endpoint = normalizeEndpoint(row[endpointIndex]);
      if (!GO_ENDPOINT_PROVIDERS[endpoint]) throw makeError("docs_unknown_endpoint", "The official Go table contains an unsupported endpoint.");
      const metadata = {};
      const documentedWindow = contextIndex >= 0 ? documentedContext(row[contextIndex]) : undefined;
      const documentedInput = inputIndex >= 0 ? documentedModalities(row[inputIndex]) : undefined;
      if (documentedWindow) metadata.contextWindow = documentedWindow;
      if (documentedInput) metadata.inputModalities = documentedInput;
      if (displayIndex >= 0 && validString(row[displayIndex], { max: 240 })) metadata.displayName = row[displayIndex];
      rows.push({ modelId, endpoint, providerId: GO_ENDPOINT_PROVIDERS[endpoint], cells: row, metadata });
    }
  }
  if (rows.length === 0) throw makeError("docs_missing_protocol", "The official Go documentation has no supported model endpoint table.");
  const seen = new Set();
  for (const row of rows) {
    if (seen.has(row.modelId)) throw makeError("docs_duplicate_model", "The official Go documentation repeats a model id.");
    seen.add(row.modelId);
  }
  return rows;
}

export async function fetchOfficialGoDocs({ fetchImpl = globalThis.fetch, url = GO_DOCS_URL, timeoutMs = GO_AUTO_DOC_TIMEOUT_MS, maxBytes = GO_AUTO_DOC_MAX_BYTES, signal } = {}) {
  if (url !== GO_DOCS_URL) throw makeError("docs_url_not_allowed", "Only the official OpenCode Go documentation URL is allowed.");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  try {
    const response = await fetchImpl(GO_DOCS_URL, {
      headers: { Accept: "text/html", "User-Agent": "codex-router-opencode-go-auto-catalog/1" },
      redirect: "error",
      signal: combined,
    });
    if (!response?.ok || response.status < 200 || response.status >= 300) throw makeError("docs_fetch_failed", "The official Go documentation could not be read.");
    const declaredLength = Number(response.headers?.get?.("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw makeError("docs_too_large", "The official Go documentation exceeds the bounded size.");
    let bytes = 0;
    if (response.body?.getReader) {
      const reader = response.body.getReader();
      const chunks = [];
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value?.byteLength || 0;
        if (bytes > maxBytes) {
          await reader.cancel().catch(() => {});
          throw makeError("docs_too_large", "The official Go documentation exceeds the bounded size.");
        }
        chunks.push(Buffer.from(next.value));
      }
      return Buffer.concat(chunks).toString("utf8");
    }
    const buffer = response.arrayBuffer ? Buffer.from(await response.arrayBuffer()) : Buffer.from(await response.text(), "utf8");
    if (buffer.byteLength > maxBytes) throw makeError("docs_too_large", "The official Go documentation exceeds the bounded size.");
    return buffer.toString("utf8");
  } catch (error) {
    if (error?.code) throw error;
    if (error?.name === "AbortError" || error?.name === "TimeoutError") throw makeError("docs_timeout", "The official Go documentation request timed out.");
    throw makeError("docs_fetch_failed", "The official Go documentation could not be read.");
  } finally {
    clearTimeout(timer);
  }
}

function strictProviderSelection(file, providers) {
  let text;
  try { text = readBoundedFile(file, 512 * 1024); } catch { return false; }
  if (text === undefined) return true;
  let parsed;
  try { parsed = parseObject(text, "invalid_provider_selection"); } catch { return false; }
  if (parsed.version !== 1 || !Array.isArray(parsed.providers) || parsed.providers.some((id) => !validString(id, { max: 160 }))) return false;
  return parsed.providers.some((id) => canonicalProviderId(id) === GO_PROVIDER) || (providers || []).some((id) => canonicalProviderId(id) === GO_PROVIDER && parsed.providers.includes(id));
}

export function goProviderEligibility({ discoveryDisabledCheck = discoveryDisabled, configuredCheck = configuredProviderIds, selectionPath = path.join(STATE_DIR, "enabled-providers.json") } = {}) {
  if (discoveryDisabledCheck()) return { enabled: false, reason: "discovery_disabled" };
  let configured;
  try { configured = configuredCheck(); } catch { return { enabled: false, reason: "provider_unconfigured" }; }
  if (!configured.some((id) => canonicalProviderId(id) === GO_PROVIDER)) return { enabled: false, reason: "provider_unconfigured" };
  if (!strictProviderSelection(selectionPath, configured)) return { enabled: false, reason: "provider_disabled" };
  return { enabled: true };
}

function normalizeMetadata(discovery, id, endpoint, documented = {}) {
  const source = { ...(discovery?.modelMetadata?.[id] || discovery?.metadata?.[id] || {}), ...(documented || {}) };
  const metadata = {};
  if (validString(source.displayName, { max: 240 })) metadata.displayName = source.displayName;
  if (Number.isSafeInteger(source.contextWindow) && source.contextWindow > 0) {
    metadata.contextWindow = source.contextWindow;
    metadata.autoCompact = Math.max(1, Math.floor(source.contextWindow * 0.85));
  } else if (Number.isSafeInteger(discovery?.contextLengths?.[id]) && discovery.contextLengths[id] > 0) {
    metadata.contextWindow = discovery.contextLengths[id];
    metadata.autoCompact = Math.max(1, Math.floor(discovery.contextLengths[id] * 0.85));
  }
  if (Array.isArray(source.inputModalities) && source.inputModalities.length > 0 && source.inputModalities.every((item) => validString(item, { max: 20 }))) metadata.inputModalities = [...new Set(source.inputModalities)];
  const description = `OpenCode Go model ${id} via documented ${endpoint}; other picker metadata uses conservative defaults and can be edited in the user model file.`;
  metadata.description = description;
  return metadata;
}

function key(providerId, modelId) { return JSON.stringify([providerId, modelId]); }

function findChecked(providerId, upstreamModel) {
  return CHECKED_IN_MODELS.find((model) => model.provider === providerId && model.upstreamModel === upstreamModel && model.listed !== false);
}

function buildPlan({ discovery, docs, currentModels, picker, seen }) {
  const live = [...new Set((discovery?.discovered || []).filter((id) => validString(id)))].sort();
  const byId = new Map(docs.map((row) => [row.modelId, row]));
  const missing = live.filter((id) => !byId.has(id));
  const documentedLive = live.filter((id) => byId.has(id));
  // Go's live catalog can retain legacy aliases that the public page no
  // longer documents. Keep those ids pending, while still adopting the exact
  // documented intersection so one stale alias cannot prevent a new model
  // from being added forever.
  if (documentedLive.length === 0) throw makeError("docs_missing_protocol", "The official Go documentation does not cover a live model id.");
  const currentByKey = new Map(currentModels.filter((model) => GO_FAMILY.has(model.provider)).map((model) => [key(model.provider, model.upstreamModel), model]));
  const currentByUpstream = new Map();
  for (const model of currentModels) {
    if (GO_FAMILY.has(model.provider) && !currentByUpstream.has(model.upstreamModel)) currentByUpstream.set(model.upstreamModel, model);
  }
  const checkedByUpstream = new Map();
  for (const model of CHECKED_IN_MODELS) {
    if (GO_FAMILY.has(model.provider) && model.listed !== false && !checkedByUpstream.has(model.upstreamModel)) checkedByUpstream.set(model.upstreamModel, model);
  }
  const newModels = [];
  const modelSlugs = [];
  const maxPriority = Math.max(0, ...CHECKED_IN_MODELS.map((model) => Number.isInteger(model.priority) ? model.priority : 0), ...currentModels.map((model) => Number.isInteger(model.priority) ? model.priority : 0));
  let priority = maxPriority + 1;
  const nextSeen = new Set(seen);
  const firstActivation = seen.size === 0;
  for (const id of documentedLive) {
    const row = byId.get(id);
    const identityKey = key(row.providerId, id);
    // A previous curation may have routed the same upstream id through a Go
    // protocol variant whose public endpoint was later clarified. Preserve
    // that user-owned entry instead of creating a second model; checked-in
    // presets still prefer the exact documented provider below.
    const existing = currentByKey.get(identityKey) || findChecked(row.providerId, id) || currentByUpstream.get(id) || checkedByUpstream.get(id);
    // A previously adopted user model can be removed deliberately. The seen
    // identity is the durable distinction between "new on this machine" and
    // "the operator already decided not to keep it"; never recreate the latter
    // merely because the provider still lists it.
    if (!existing && seen.has(identityKey)) {
      nextSeen.add(identityKey);
      continue;
    }
    const model = existing || userModelEntry({ providerId: row.providerId, upstreamId: id, priority: priority++, metadata: normalizeMetadata(discovery, id, row.endpoint, row.metadata) });
    if (!existing) newModels.push(model);
    modelSlugs.push(model.slug);
    nextSeen.add(identityKey);
  }
  const hidden = new Set(picker.hidden);
  const visible = new Set(picker.visible);
  const seeded = new Set(picker.seeded);
  const visibilityChanged = [];
  for (const model of [...newModels, ...documentedLive.map((id) => {
    const row = byId.get(id);
    return currentByKey.get(key(row.providerId, id)) || findChecked(row.providerId, id) || currentByUpstream.get(id) || checkedByUpstream.get(id);
  }).filter(Boolean)]) {
    const shouldSeed = firstActivation || !seen.has(key(model.provider, model.upstreamModel));
    if (!shouldSeed || hidden.has(model.slug) || visible.has(model.slug) || seeded.has(model.slug)) continue;
    visible.add(model.slug);
    seeded.add(model.slug);
    visibilityChanged.push(model.slug);
  }
  const nextModels = [...currentModels, ...newModels];
  const nextPicker = {
    hidden: [...hidden].sort(),
    visible: [...visible].filter((slug) => !hidden.has(slug)).sort(),
    seeded: [...seeded].sort(),
    // Preserve legacy implicit visibility until the owning catalog migration
    // can see every selected provider, including unrelated routed models.
    explicit: picker.explicit || !picker.recognized,
  };
  const seenChanged = nextSeen.size !== seen.size;
  const pickerChanged = visibilityChanged.length > 0;
  return { nextModels, nextPicker, nextSeen: [...nextSeen].sort(), newModels, modelSlugs, missingDocs: missing, catalogChanged: newModels.length > 0 || pickerChanged, seenChanged, pickerChanged, firstActivation };
}

function writePicker(file, picker) {
  writeJson(file, { version: 1, hidden: picker.hidden, ...(picker.explicit ? { visible: picker.visible } : {}), seeded: picker.seeded });
}

function normalizeTimestamp(value, fallback) {
  if (Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function latestActivity(activity) {
  const values = [];
  for (const record of [...(activity?.active || []), ...(activity?.recent || [])]) for (const field of ["startedAt", "endedAt", "lastHeadersAt", "lastEventAt", "lastByteAt"]) values.push(record?.[field]);
  return Math.max(...values.map((value) => normalizeTimestamp(value, 0)).filter((value) => value > 0), 0);
}

export async function readProtectedRouterHealth({ fetchImpl = globalThis.fetch, readCallerSecret = () => readFileSync(CALLER_SECRET_PATH, "utf8"), routerPort = PORTS.router, timeoutMs = 3_000 } = {}) {
  let secret;
  try { secret = assertCallerSecret(readCallerSecret().trim()); } catch { return { ok: false, state: "unknown" }; }
  try {
    const response = await fetchImpl(`${callerBaseUrl(routerPort, secret)}/health`, { headers: { Accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body || typeof body !== "object" || Array.isArray(body)) return { ok: false, state: "unknown" };
    return { ...body, ok: body.ok === true };
  } catch { return { ok: false, state: "unknown" }; }
}

export async function observeRouterIdle({ readHealth = readProtectedRouterHealth, readActivity: readActivityImpl = readControlActivity, now = Date.now } = {}) {
  const observedAt = now();
  const health = await readHealth();
  const resources = health?.resources || health?.resourceLimits;
  const inFlightRequests = resources?.inFlightRequests;
  const routerState = typeof health?.router === "string" ? health.router.toLowerCase() : undefined;
  if (health?.ok !== true || (routerState && !["ready", "healthy", "ok"].includes(routerState)) || (health?.degraded && health.degraded.length > 0) || !Number.isSafeInteger(inFlightRequests) || inFlightRequests < 0) return { ok: false, state: "unknown", observedAt };
  const activity = await readActivityImpl();
  if (activity?.ok !== true || !validString(activity.instanceId, { max: 160 }) || !Array.isArray(activity.active) || !Array.isArray(activity.recent)) return { ok: false, state: "unknown", observedAt };
  const latest = latestActivity(activity);
  const activeCount = activity.active.length;
  const busy = inFlightRequests > 0 || activeCount > 0;
  return { ok: true, state: busy ? "busy" : "idle", instanceId: activity.instanceId, inFlightRequests, activeCount, observedAt, latestActivityAt: latest, busy };
}

function equivalentObservation(a, b) {
  const latestEqual = a?.latestActivityAt === b?.latestActivityAt || a?.latestActivityAt === 0 || b?.latestActivityAt === 0;
  return Boolean(a && b && a.instanceId === b.instanceId && a.inFlightRequests === b.inFlightRequests && a.activeCount === b.activeCount && latestEqual);
}

function quietEligible(status, observation, now) {
  const previous = Array.isArray(status?.observations) ? status.observations.at(-1) : undefined;
  if (!observation?.ok || observation.busy) return { ok: false, reason: observation?.state === "busy" ? "router_busy" : "router_unknown", observation };
  if (!equivalentObservation(previous, observation)) return { ok: false, reason: "quiet_window", observation };
  const previousObservedAt = normalizeTimestamp(previous?.observedAt, 0);
  if (!previous || previousObservedAt <= 0 || now - previousObservedAt < GO_AUTO_QUIET_MS) return { ok: false, reason: "quiet_window", observation };
  // `activity.observedAt` is the time the snapshot was read, not a request
  // event. When the router reports no request timestamps, retain the prior
  // observation as the beginning of the quiet window instead of resetting it
  // on every five-minute poll.
  const quietBase = observation.latestActivityAt > 0
    ? Math.max(previous.latestActivityAt || 0, observation.latestActivityAt)
    : (previous.latestActivityAt || previous.observedAt || 0);
  if (now - quietBase < GO_AUTO_QUIET_MS) return { ok: false, reason: "quiet_window", observation };
  return { ok: true, observation };
}

function updateStatus(file, value) {
  try { writeJson(file, { version: 1, ...value }); } catch { /* status is advisory and never blocks rollback */ }
}

async function withUpdaterLock(lockPath, fn, { acquire, release } = {}) {
  if (!acquire) return fn();
  let token;
  try { token = await acquire(lockPath); } catch (error) {
    if (error?.code === "ELOCKED" || error?.code === "EEXIST") return { state: "deferred", reason: "already_running" };
    throw error;
  }
  let released = false;
  const releaseHeld = async () => {
    if (released) return;
    released = true;
    try { await release?.(token); } catch { /* best effort; stale lock expiry remains bounded */ }
  };
  try { return await fn(releaseHeld); } finally { await releaseHeld(); }
}

async function defaultAcquire(lockPath) {
  const lock = await import("proper-lockfile");
  mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  if (!existsSync(lockPath)) writeFileSync(lockPath, "", { mode: 0o600 });
  return lock.lock(lockPath, { retries: 0, stale: 5 * 60_000 });
}

function ownerGuard({ sourceRoot = SOURCE_ROOT, stateDir = STATE_DIR, policyPath, installManifestPath = INSTALL_MANIFEST_PATH } = {}) {
  const canonical = (value) => {
    if (!validString(value, { max: 4096 })) return undefined;
    try { return realpathSync(path.resolve(value)); } catch { return path.resolve(value); }
  };
  const current = canonical(sourceRoot);
  let manifest;
  let manifestText;
  try { manifestText = readBoundedFile(installManifestPath, 2 * 1024 * 1024); }
  catch { throw makeError("invalid_manifest_owner", "Install ownership manifest cannot be read safely."); }
  if (manifestText === undefined) throw makeError("invalid_manifest_owner", "Install ownership manifest is missing.");
  try { manifest = parseObject(manifestText, "invalid_manifest_owner"); }
  catch { throw makeError("invalid_manifest_owner", "Install ownership manifest is malformed."); }
  if (manifest.version !== 1 || !manifest.current || typeof manifest.current !== "object" || !validString(manifest.current.sourceRoot, { max: 4096 }) || !path.isAbsolute(manifest.current.sourceRoot)) throw makeError("invalid_manifest_owner", "Install ownership manifest has no valid current source root.");
  const owner = canonical(manifest?.current?.sourceRoot);
  let policy;
  try { policy = policyPath ? readPolicy(policyPath) : undefined; }
  catch (error) { throw error?.code ? error : makeError("invalid_policy", "Auto catalog policy is malformed."); }
  if ((owner && current && owner !== current) || (policy?.sourceRoot && canonical(policy.sourceRoot) !== current)) throw makeError("foreign_state_owner", "Auto catalog state belongs to another source checkout.");
  return { current, owner };
}

function xmlEscape(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

export function renderLaunchdPlist({ sourceRoot = SOURCE_ROOT, modulePath = path.join(sourceRoot, "src", "opencode-go-auto-catalog.mjs"), nodeBinary = process.execPath, stateDir, policyPath = statePath().policyPath, statusPath = statePath().statusPath, label = GO_AUTO_LABEL, intervalSeconds = GO_AUTO_INTERVAL_SECONDS } = {}) {
  const args = [path.resolve(nodeBinary), path.resolve(modulePath), "--scheduled"];
  const plistArray = args.map((arg) => `<string>${xmlEscape(arg)}</string>`).join("");
  const effectiveStateDir = stateDir || path.dirname(policyPath);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${xmlEscape(label)}</string><key>ProgramArguments</key><array>${plistArray}</array><key>EnvironmentVariables</key><dict><key>MODEL_ROUTER_STATE_DIR</key><string>${xmlEscape(effectiveStateDir)}</string><key>CODEX_ROUTER_SOURCE_ROOT</key><string>${xmlEscape(path.resolve(sourceRoot))}</string></dict><key>RunAtLoad</key><true/><key>StartInterval</key><integer>${Math.max(60, Math.floor(intervalSeconds))}</integer><key>StandardOutPath</key><string>${xmlEscape(statusPath)}.log</string><key>StandardErrorPath</key><string>${xmlEscape(statusPath)}.err.log</string></dict></plist>\n`;
}

function launchctlDefault(args) {
  return execFileSync("/bin/launchctl", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function uid() { return String(process.getuid?.() || 0); }

export async function installGoAutoCatalog({ sourceRoot = SOURCE_ROOT, stateDir = STATE_DIR, paths = {}, launchctl = launchctlDefault, platform = process.platform, allowUnstableSource = false, now = Date.now } = {}) {
  const resolved = { ...statePath({ stateDir, ...paths }) };
  if (platform !== "darwin") throw makeError("unsupported_platform", "OpenCode Go auto catalog requires macOS launchd.");
  if (!path.isAbsolute(sourceRoot)) throw makeError("unstable_source", "The updater source root must be absolute.");
  if (!existsSync(path.join(sourceRoot, "package.json"))) throw makeError("unstable_source", "The updater source root has no package manifest.");
  if (!existsSync(path.join(sourceRoot, "src", "opencode-go-auto-catalog.mjs"))) throw makeError("unstable_source", "The updater source root has no auto catalog module.");
  if (!allowUnstableSource) {
    try {
      const gitMetadata = lstatSync(path.join(sourceRoot, ".git"));
      if (gitMetadata.isFile()) throw makeError("unstable_source", "Refusing to install from a linked or disposable worktree.");
    } catch (error) {
      if (error?.code === "unstable_source") throw error;
      // A packaged stable source can legitimately have no .git directory.
    }
  }
  ownerGuard({ sourceRoot, stateDir, policyPath: resolved.policyPath, installManifestPath: installManifestFile({ sourceRoot }, resolved) });
  const oldPolicyText = readBoundedFile(resolved.policyPath, 512 * 1024);
  const oldPlistText = readBoundedFile(resolved.plistPath, 512 * 1024);
  let wasLoaded = false;
  try { launchctl(["print", `gui/${uid()}/${GO_AUTO_LABEL}`]); wasLoaded = true; } catch { /* no previous job */ }
  const policy = { version: 1, enabled: true, sourceRoot: path.resolve(sourceRoot), stateDir: path.resolve(stateDir), intervalSeconds: GO_AUTO_INTERVAL_SECONDS, installedAt: new Date(now()).toISOString() };
  try {
    writePrivateFile(resolved.plistPath, renderLaunchdPlist({ sourceRoot, modulePath: path.join(sourceRoot, "src", "opencode-go-auto-catalog.mjs"), stateDir: resolved.stateDir, policyPath: resolved.policyPath, statusPath: resolved.statusPath }), { directoryMode: 0o700 });
    writeJson(resolved.policyPath, policy);
    try { launchctl(["bootout", `gui/${uid()}/${GO_AUTO_LABEL}`]); } catch { /* not loaded */ }
    launchctl(["enable", `gui/${uid()}/${GO_AUTO_LABEL}`]);
    launchctl(["bootstrap", `gui/${uid()}`, resolved.plistPath]);
    return { state: "installed", policy, plistPath: resolved.plistPath };
  } catch (error) {
    if (oldPlistText === undefined) { try { unlinkSync(resolved.plistPath); } catch {} } else writePrivateFile(resolved.plistPath, oldPlistText, { directoryMode: 0o700 });
    if (oldPolicyText === undefined) { try { unlinkSync(resolved.policyPath); } catch {} } else writePrivateFile(resolved.policyPath, oldPolicyText, { directoryMode: 0o700 });
    if (wasLoaded && oldPlistText !== undefined) {
      try { launchctl(["bootstrap", `gui/${uid()}`, resolved.plistPath]); }
      catch { throw makeError("install_rollback_failed", "The updater installation failed and its previous launchd job could not be restored."); }
    }
    throw error;
  }
}

export async function disableGoAutoCatalog({ stateDir = STATE_DIR, paths = {}, launchctl = launchctlDefault, platform = process.platform } = {}) {
  const resolved = { ...statePath({ stateDir, ...paths }) };
  if (platform !== "darwin") throw makeError("unsupported_platform", "OpenCode Go auto catalog requires macOS launchd.");
  ownerGuard({ sourceRoot: SOURCE_ROOT, stateDir, policyPath: resolved.policyPath, installManifestPath: installManifestFile({}, resolved) });
  const policy = readPolicy(resolved.policyPath);
  try { launchctl(["bootout", `gui/${uid()}/${GO_AUTO_LABEL}`]); } catch (error) {
    if (policy.enabled) throw makeError("disable_failed", "The launchd updater could not be disabled.");
  }
  try { launchctl(["disable", `gui/${uid()}/${GO_AUTO_LABEL}`]); } catch (error) {
    if (policy.enabled) throw makeError("disable_failed", "The launchd updater could not be disabled.");
  }
  writeJson(resolved.policyPath, { ...policy, enabled: false, disabledAt: new Date().toISOString() });
  return { state: "disabled" };
}

export function statusGoAutoCatalog({ stateDir = STATE_DIR, paths = {}, launchctl, platform = process.platform } = {}) {
  const resolved = { ...statePath({ stateDir, ...paths }) };
  let policy;
  let status;
  try { policy = readPolicy(resolved.policyPath); } catch (error) { policy = { enabled: false, error: statusError(error) }; }
  try { const text = readBoundedFile(resolved.statusPath, 512 * 1024); status = text ? parseObject(text, "invalid_status") : undefined; } catch { status = { state: "unknown", reason: "malformed_status" }; }
  let loaded;
  if (platform === "darwin") { try { (launchctl || launchctlDefault)(["print", `gui/${uid()}/${GO_AUTO_LABEL}`]); loaded = true; } catch { loaded = false; } }
  return { policy, status, loaded, plistPath: resolved.plistPath, stateDir: resolved.stateDir };
}

export async function checkGoAutoCatalog(options = {}) {
  const paths = statePath(options);
  const policy = readPolicy(paths.policyPath);
  if (!policy.enabled) return { state: "disabled", reason: "disabled" };
  try {
    ownerGuard({
      sourceRoot: options.sourceRoot || SOURCE_ROOT,
      stateDir: paths.stateDir,
      policyPath: paths.policyPath,
      installManifestPath: installManifestFile(options, paths),
    });
  } catch (error) {
    const result = { state: "pending", reason: statusError(error), checkedAt: new Date((options.now || Date.now)()).toISOString() };
    updateStatus(paths.statusPath, result);
    return result;
  }
  const eligibility = goProviderEligibility({ discoveryDisabledCheck: options.discoveryDisabledCheck || discoveryDisabled, configuredCheck: options.configuredCheck || configuredProviderIds, selectionPath: selectionFile(options, paths) });
  if (!eligibility.enabled) {
    const result = { state: "skipped", reason: eligibility.reason, checkedAt: new Date((options.now || Date.now)()).toISOString() };
    updateStatus(paths.statusPath, result);
    return result;
  }
  const acquire = options.acquireLock === false ? undefined : options.acquireLock || defaultAcquire;
  const release = options.releaseLock || ((token) => token?.());
  return withUpdaterLock(paths.lockPath, async (releaseUpdaterLock) => {
    const now = options.now || Date.now;
    let discovery;
    let docs;
    try {
      discovery = await (options.discover || discoverProviderModels)(GO_PROVIDER, { refresh: true });
      const fetchedDocs = await (options.fetchDocs || fetchOfficialGoDocs)({});
      docs = Array.isArray(fetchedDocs)
        ? fetchedDocs
        : parseOfficialGoDocs(typeof fetchedDocs === "string" ? fetchedDocs : fetchedDocs?.html);
    } catch (error) {
      const result = { state: "pending", reason: statusError(error), checkedAt: new Date(now()).toISOString() };
      updateStatus(paths.statusPath, result);
      return result;
    }
    let current;
    let picker;
    let seen;
    try {
      current = strictUserModels(userModelsFile(options, paths));
      picker = strictPickerState(pickerFile(options, paths));
      seen = strictSeenState(paths.seenPath);
    } catch (error) {
      const result = { state: "pending", reason: statusError(error), checkedAt: new Date(now()).toISOString() };
      updateStatus(paths.statusPath, result);
      return result;
    }
    let plan;
    try { plan = buildPlan({ discovery, docs, currentModels: current.models, picker, seen: new Set(seen.seen) }); }
    catch (error) {
      const result = { state: "pending", reason: statusError(error), checkedAt: new Date(now()).toISOString() };
      updateStatus(paths.statusPath, result);
      return result;
    }
    const firstObservation = await (options.observeIdle || observeRouterIdle)({ readHealth: options.readHealth || readProtectedRouterHealth, readActivity: options.readActivity || readControlActivity, now });
    const priorStatus = (() => { try { const text = readBoundedFile(paths.statusPath, 512 * 1024); return text ? parseObject(text, "invalid_status") : undefined; } catch { return undefined; } })();
    const baselineObservation = priorStatus?.observations?.at?.(-1) || firstObservation;
    const quiet = quietEligible(priorStatus, firstObservation, now());
    const observations = [...(Array.isArray(priorStatus?.observations) ? priorStatus.observations.slice(-1) : []), firstObservation].slice(-2);
    const pendingDocs = plan.missingDocs || [];
    if (!plan.catalogChanged && !plan.seenChanged) {
      const state = pendingDocs.length ? "pending" : "active";
      const reason = pendingDocs.length ? "missing_documentation" : "no_change";
      updateStatus(paths.statusPath, { state, reason, ...(pendingDocs.length ? { pendingModelIds: pendingDocs } : {}), checkedAt: new Date(now()).toISOString(), observations });
      return { state, reason, plan, observations };
    }
    if (plan.catalogChanged && !quiet.ok) {
      updateStatus(paths.statusPath, { state: "deferred", reason: quiet.reason, checkedAt: new Date(now()).toISOString(), observations });
      return { state: "deferred", reason: quiet.reason, plan, observations };
    }
    if (!plan.catalogChanged && plan.seenChanged) {
      writeJson(paths.seenPath, { version: 1, seen: plan.nextSeen });
      const state = pendingDocs.length ? "pending" : "active";
      const reason = pendingDocs.length ? "missing_documentation" : "history_updated";
      updateStatus(paths.statusPath, { state, reason, ...(pendingDocs.length ? { pendingModelIds: pendingDocs } : {}), checkedAt: new Date(now()).toISOString(), observations });
      return { state, reason, plan, observations };
    }
    const finalObservation = await (options.observeIdle || observeRouterIdle)({ readHealth: options.readHealth || readProtectedRouterHealth, readActivity: options.readActivity || readControlActivity, now });
    if (!quietEligible({ observations: [baselineObservation] }, finalObservation, now()).ok) {
      const result = { state: "deferred", reason: "router_activity_changed", checkedAt: new Date(now()).toISOString(), observations: [firstObservation, finalObservation] };
      updateStatus(paths.statusPath, result);
      return { ...result, plan };
    }
    let deferredInMutation = false;
    let skipPublication = false;
    let deferredReason = "router_activity_changed";
    let appliedPlan = plan;
    try {
      const activationGate = async () => {
        let latestPolicy;
        try { latestPolicy = readPolicy(paths.policyPath); }
        catch { deferredReason = "policy_changed"; return false; }
        if (!latestPolicy.enabled) { deferredReason = "disabled"; return false; }
        const latestEligibility = goProviderEligibility({ discoveryDisabledCheck: options.discoveryDisabledCheck || discoveryDisabled, configuredCheck: options.configuredCheck || configuredProviderIds, selectionPath: selectionFile(options, paths) });
        if (!latestEligibility.enabled) { deferredReason = latestEligibility.reason; return false; }
        const observation = await (options.observeIdle || observeRouterIdle)({ readHealth: options.readHealth || readProtectedRouterHealth, readActivity: options.readActivity || readControlActivity, now });
        if (!quietEligible({ observations: [baselineObservation] }, observation, now()).ok) { deferredReason = "router_activity_changed"; return false; }
        return true;
      };
      const mutate = async () => {
        if (deferredInMutation) return;
        if (!(await activationGate())) { deferredInMutation = true; return; }
        const latestCurrent = strictUserModels(userModelsFile(options, paths));
        const latestPicker = strictPickerState(pickerFile(options, paths));
        const latestSeen = strictSeenState(paths.seenPath);
        const latestPlan = buildPlan({ discovery, docs, currentModels: latestCurrent.models, picker: latestPicker, seen: new Set(latestSeen.seen) });
        const recheck = await (options.observeIdle || observeRouterIdle)({ readHealth: options.readHealth || readProtectedRouterHealth, readActivity: options.readActivity || readControlActivity, now });
        if (!quietEligible({ observations: [baselineObservation] }, recheck, now()).ok) { deferredReason = "router_activity_changed"; deferredInMutation = true; return; }
        appliedPlan = latestPlan;
        // Another updater may have committed this exact live id while this
        // process was outside the overlay lock. Preserve the fresh state and
        // suppress publication/restart for the resulting no-op.
        if (!latestPlan.catalogChanged && !latestPlan.seenChanged) { skipPublication = true; return; }
        if (!latestPlan.catalogChanged && latestPlan.seenChanged) {
          writeJson(paths.seenPath, { version: 1, seen: latestPlan.nextSeen });
          skipPublication = true;
          return;
        }
        writeJson(userModelsFile(options, paths), { version: 1, models: latestPlan.nextModels });
        writePicker(pickerFile(options, paths), latestPlan.nextPicker);
        writeJson(paths.seenPath, { version: 1, seen: latestPlan.nextSeen });
      };
      // The updater lock protects discovery/planning only. Release it before
      // entering the model-overlay transaction: that transaction owns the
      // publication lock and may restart the router, so holding a second
      // updater lock across launchd/restart would create an avoidable lock
      // cycle with other maintenance paths.
      await releaseUpdaterLock?.();
      const publication = options.applyPublication || applyModelOverlayPublication;
      const result = await (options.transact || transactModelOverlayMutation)({
        files: [userModelsFile(options, paths), pickerFile(options, paths), paths.seenPath],
        mutate,
        // `transactModelOverlayMutation` evaluates this callback before its
        // mutation, and later publishes/restarts only after the mutation. A
        // fresh observation here closes the updater's own stale-plan window;
        // mutate repeats the same check under the overlay lock for the tiny
        // interval between this observation and the write.
        restart: async () => {
          if (options.restart === false) return false;
          const gate = await activationGate();
          if (!gate) deferredInMutation = true;
          return gate;
        },
        applyPublication: async (publicationOptions) => (deferredInMutation || skipPublication) ? {} : publication({ ...publicationOptions, restartService: options.restartService, publish: options.publish }),
      });
      const pendingDocs = appliedPlan.missingDocs || [];
      const state = deferredInMutation ? "deferred" : (pendingDocs.length ? "pending" : "active");
      const reason = deferredInMutation
        ? deferredReason
        : pendingDocs.length
          ? (appliedPlan.catalogChanged ? "catalog_updated_pending_documentation" : "missing_documentation")
          : (appliedPlan.catalogChanged ? "catalog_updated" : "history_updated");
      const next = { state, reason, ...(pendingDocs.length ? { pendingModelIds: pendingDocs } : {}), checkedAt: new Date(now()).toISOString(), observations: [firstObservation, finalObservation] };
      updateStatus(paths.statusPath, next);
      return { ...next, plan: appliedPlan, publication: result };
    } catch (error) {
      const result = { state: "error", reason: statusError(error), checkedAt: new Date(now()).toISOString(), observations: [firstObservation, finalObservation] };
      updateStatus(paths.statusPath, result);
      return { ...result, error };
    }
  }, { acquire, release });
}

function usage() { return "Usage: opencode-go-auto-catalog install|disable|status|check|--scheduled"; }

async function main(argv = process.argv.slice(2)) {
  const command = argv[0] || "status";
  try {
    let result;
    if (command === "install") result = await installGoAutoCatalog();
    else if (command === "disable") result = await disableGoAutoCatalog();
    else if (command === "status") result = statusGoAutoCatalog();
    else if (command === "check" || command === "--scheduled") result = await checkGoAutoCatalog();
    else { console.error(usage()); process.exitCode = 2; return; }
    const output = { ...result };
    if (output.plan) {
      output.modelsAdded = output.plan.newModels?.length || 0;
      output.pendingModelCount = output.plan.missingDocs?.length || 0;
      delete output.plan;
    }
    delete output.publication;
    delete output.error;
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    if (result?.state === "error") process.exitCode = 1;
  } catch (error) {
    console.error(statusError(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) await main();
