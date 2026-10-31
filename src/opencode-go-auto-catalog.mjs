import { execFileSync, spawn } from "node:child_process";
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
import { constants as osConstants } from "node:os";
import { fileURLToPath } from "node:url";

import { applyModelOverlayPublication, transactModelOverlayMutation } from "./model-overlay-publication.mjs";
import { CHECKED_IN_MODELS, MODEL_SLUG_ALIASES } from "./model-registry.mjs";
import { canonicalProviderId, configuredProviderIds } from "./provider-selection.mjs";
import { discoveryDisabled } from "./discovery-mode.mjs";
import { readControlActivity } from "./control-activity.mjs";
import { assertCallerSecret, callerBaseUrl } from "./caller-auth.mjs";
import { CALLER_SECRET_PATH, INSTALL_MANIFEST_PATH, LAUNCH_AGENTS_DIR, PORTS, PROVIDER_SELECTION_PATH, SOURCE_ROOT, STATE_DIR } from "./paths.mjs";
import { MODEL_PICKER_STATE_PATH } from "./model-picker-state.mjs";
import { USER_MODELS_PATH, userModelEntry } from "./user-models.mjs";
import { writePrivateFile } from "./file-security.mjs";
import { loadManagedGoRuntimeEnvironment } from "./managed-go-runtime-environment.mjs";

const SELF = fileURLToPath(import.meta.url);

export const GO_MODELS_URL = "https://opencode.ai/inference/go/v1/models";
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
    if (parsed.version !== 1 || typeof parsed.enabled !== "boolean" || !validString(parsed.sourceRoot, { max: 4096 }) || !validString(parsed.stateDir, { max: 4096 }) || !path.isAbsolute(parsed.sourceRoot) || !path.isAbsolute(parsed.stateDir)) throw new Error("invalid policy");
    return parsed;
  } catch (error) {
    if (error?.code === "invalid_policy") throw error;
    throw makeError("invalid_policy", "Auto catalog policy is malformed.");
  }
}

function statusError(error) {
  if (error?.code === "inventory_duplicate_model") return "duplicate inventory model";
  if (error?.code === "invalid_user_models_state") return "user model state is malformed";
  if (error?.code === "invalid_picker_state") return "model picker state is malformed";
  if (error?.code === "invalid_seen_state") return "catalog history is malformed";
  if (error?.code === "foreign_state_owner") return "state belongs to another source checkout";
  const allowed = new Set([
    "invalid_state", "invalid_policy", "invalid_manifest_owner",
    "inventory_invalid", "inventory_unknown_endpoint", "inventory_url_not_allowed",
    "inventory_fetch_failed", "inventory_content_type", "inventory_too_large", "inventory_timeout",
    "model_identity_collision", "unsupported_platform", "unstable_source",
    "install_rollback_failed", "disable_failed",
  ]);
  return allowed.has(error?.code) ? error.code : "catalog check failed";
}

const GO_API_TUPLES = Object.freeze({
  "chat-completions": { baseUrl: "https://opencode.ai/inference/go/openai/v1", endpoint: "/chat/completions" },
  responses: { baseUrl: "https://opencode.ai/inference/go/openai/v1", endpoint: "/responses" },
  messages: { baseUrl: "https://opencode.ai/inference/go/anthropic/v1", endpoint: "/messages" },
  "generate-content": { baseUrl: "https://opencode.ai/inference/go/google/v1beta" },
});

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function inventoryError() {
  return makeError("inventory_invalid", "The public Go inventory metadata is malformed.");
}

function positiveLimit(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function validateModalities(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64 || value.some(item => typeof item !== "string" || (item !== "text" && !/^[a-z][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/.test(item)) || item.length > 160)) throw inventoryError();
  return value;
}

/** A single validated public snapshot supplies both live ids and protocol rows. */
export function parseOfficialGoInventory(payload) {
  let inventory;
  try {
    if (typeof payload !== "string" || Buffer.byteLength(payload, "utf8") > GO_AUTO_DOC_MAX_BYTES) throw inventoryError();
    inventory = JSON.parse(payload);
  } catch { throw inventoryError(); }
  if (!record(inventory) || !Array.isArray(inventory.data) || inventory.data.length > MAX_IDS) throw inventoryError();
  const discovered = [];
  const rows = [];
  const seen = new Set();
  for (const model of inventory.data) {
    if (!record(model) || !validString(model.id) || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(model.id) || !validString(model.name, { max: 240 })) throw inventoryError();
    if (seen.has(model.id)) throw makeError("inventory_duplicate_model", "The public Go inventory repeats a model id.");
    seen.add(model.id);
    if (!record(model.limit) || !positiveLimit(model.limit.context) || !positiveLimit(model.limit.output) || (model.limit.input !== undefined && !positiveLimit(model.limit.input))) throw inventoryError();
    if (!record(model.modalities)) throw inventoryError();
    const input = validateModalities(model.modalities.input);
    validateModalities(model.modalities.output);
    if (!record(model.api) || Object.keys(model.api).length === 0 || Object.keys(model.api).length > 16) throw inventoryError();
    let route;
    for (const [protocol, api] of Object.entries(model.api)) {
      // Exact source strings reject URL normalization tricks, credentials,
      // query/fragment suffixes, alternate origins, and unexpected paths.
      const tuple = Object.hasOwn(GO_API_TUPLES, protocol) ? GO_API_TUPLES[protocol] : undefined;
      if (!tuple || !record(api) || api.base_url !== tuple.baseUrl || !validString(api.sdk, { max: 240 })) throw makeError("inventory_unknown_endpoint", "The public Go inventory contains an unsupported endpoint tuple.");
      // sdk, compatibility, and capabilities are never executed or copied.
      // The first supported protocol in the inventory determines the row.
      if (!route && tuple.endpoint) route = { endpoint: `${tuple.baseUrl}${tuple.endpoint}`, providerId: GO_ENDPOINT_PROVIDERS[tuple.endpoint] };
    }
    discovered.push(model.id);
    if (!route) continue; // Known Google protocol remains pending; never guess a chat route.
    const inputModalities = [...new Set(input.flatMap(item => item === "text" ? ["text"] : item.startsWith("image/") ? ["image"] : []))];
    rows.push({ modelId: model.id, ...route, metadata: { displayName: model.name, contextWindow: model.limit.context, inputModalities } });
  }
  return { discovered, rows };
}

export async function fetchOfficialGoInventory({ fetchImpl = globalThis.fetch, url = GO_MODELS_URL, timeoutMs = GO_AUTO_DOC_TIMEOUT_MS, maxBytes = GO_AUTO_DOC_MAX_BYTES, signal } = {}) {
  if (url !== GO_MODELS_URL) throw makeError("inventory_url_not_allowed", "Only the public OpenCode Go inventory URL is allowed.");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  try {
    const response = await fetchImpl(GO_MODELS_URL, {
      headers: { Accept: "application/json", "User-Agent": "codex-router-opencode-go-auto-catalog/1" },
      redirect: "error",
      signal: combined,
    });
    if (!response?.ok || !Number.isInteger(response.status) || response.status < 200 || response.status >= 300) throw makeError("inventory_fetch_failed", "The public Go inventory could not be read.");
    const contentType = response.headers?.get?.("content-type")?.split(";", 1)[0].trim().toLowerCase();
    if (contentType !== "application/json") throw makeError("inventory_content_type", "The public Go inventory must be JSON.");
    const declaredLength = Number(response.headers?.get?.("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw makeError("inventory_too_large", "The public Go inventory exceeds the bounded size.");
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
          throw makeError("inventory_too_large", "The public Go inventory exceeds the bounded size.");
        }
        chunks.push(Buffer.from(next.value));
      }
      return Buffer.concat(chunks).toString("utf8");
    }
    const buffer = response.arrayBuffer ? Buffer.from(await response.arrayBuffer()) : Buffer.from(await response.text(), "utf8");
    if (buffer.byteLength > maxBytes) throw makeError("inventory_too_large", "The public Go inventory exceeds the bounded size.");
    return buffer.toString("utf8");
  } catch (error) {
    if (error?.name === "AbortError" || error?.name === "TimeoutError") throw makeError("inventory_timeout", "The public Go inventory request timed out.");
    if (error?.code) throw error;
    throw makeError("inventory_fetch_failed", "The public Go inventory could not be read.");
  } finally {
    clearTimeout(timer);
  }
}

// Retain the module's original export names for callers during the transition.
// Both now accept only JSON inventory, never the retired HTML table.
export const parseOfficialGoDocs = parseOfficialGoInventory;
export const fetchOfficialGoDocs = fetchOfficialGoInventory;

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
  if (Array.isArray(source.inputModalities)) {
    const supported = source.inputModalities.filter(item => item === "text" || item === "image");
    metadata.inputModalities = supported.length ? [...new Set(supported)] : ["text"];
  }
  const description = `OpenCode Go model ${id} via public inventory endpoint ${endpoint}; other picker metadata uses conservative defaults and can be edited in the user model file.`;
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
  // Valid protocols without a supported router adapter remain pending while
  // supported rows from the same validated snapshot can still activate.
  const currentByKey = new Map(currentModels.filter((model) => GO_FAMILY.has(model.provider)).map((model) => [key(model.provider, model.upstreamModel), model]));
  const currentByUpstream = new Map();
  for (const model of currentModels) {
    if (GO_FAMILY.has(model.provider) && !currentByUpstream.has(model.upstreamModel)) currentByUpstream.set(model.upstreamModel, model);
  }
  const checkedByUpstream = new Map();
  for (const model of CHECKED_IN_MODELS) {
    if (GO_FAMILY.has(model.provider) && model.listed !== false && !checkedByUpstream.has(model.upstreamModel)) checkedByUpstream.set(model.upstreamModel, model);
  }
  const reservedSlugs = new Set([...CHECKED_IN_MODELS, ...currentModels].map(model => model.slug));
  for (const slug of MODEL_SLUG_ALIASES.keys()) reservedSlugs.add(slug);
  const reservedGateways = new Set([...CHECKED_IN_MODELS, ...currentModels].map(model => model.gatewayModel));
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
    // presets use the documented provider when no user route exists.
    const existing = currentByKey.get(identityKey) || currentByUpstream.get(id) || findChecked(row.providerId, id) || checkedByUpstream.get(id);
    // A previously adopted user model can be removed deliberately. The seen
    // identity is the durable distinction between "new on this machine" and
    // "the operator already decided not to keep it"; never recreate the latter
    // merely because the provider still lists it.
    if (!existing && seen.has(identityKey)) {
      nextSeen.add(identityKey);
      continue;
    }
    const model = existing || userModelEntry({ providerId: row.providerId, upstreamId: id, priority: priority++, metadata: normalizeMetadata(discovery, id, row.endpoint, row.metadata) });
    if (!existing) {
      if (reservedSlugs.has(model.slug) || reservedGateways.has(model.gatewayModel)) throw makeError("model_identity_collision", "A discovered model conflicts with an existing route identity.");
      reservedSlugs.add(model.slug);
      reservedGateways.add(model.gatewayModel);
      newModels.push(model);
    }
    modelSlugs.push(model.slug);
    nextSeen.add(identityKey);
  }
  const hidden = new Set(picker.hidden);
  const visible = new Set(picker.visible);
  const seeded = new Set(picker.seeded);
  const visibilityChanged = [];
  for (const model of [...newModels, ...documentedLive.map((id) => {
    const row = byId.get(id);
    return currentByKey.get(key(row.providerId, id)) || currentByUpstream.get(id) || findChecked(row.providerId, id) || checkedByUpstream.get(id);
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
  if (policy?.stateDir && canonical(policy.stateDir) !== canonical(stateDir)) throw makeError("foreign_state_owner", "Auto catalog policy belongs to another state directory.");
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
  const loaded = () => { try { launchctl(["print", `gui/${uid()}/${GO_AUTO_LABEL}`]); return true; } catch { return false; } };
  if (loaded()) {
    try { launchctl(["bootout", `gui/${uid()}/${GO_AUTO_LABEL}`]); }
    catch { throw makeError("disable_failed", "The launchd updater could not be disabled."); }
  }
  try { launchctl(["disable", `gui/${uid()}/${GO_AUTO_LABEL}`]); }
  catch { throw makeError("disable_failed", "The launchd updater could not be disabled."); }
  if (loaded()) throw makeError("disable_failed", "The launchd updater is still loaded.");
  writeJson(resolved.policyPath, { ...policy, version: 1, sourceRoot: SOURCE_ROOT, stateDir: path.resolve(stateDir), enabled: false, disabledAt: new Date().toISOString() });
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
  return withUpdaterLock(paths.lockPath, async () => {
    const now = options.now || Date.now;
    let discovery;
    let docs;
    try {
      const payload = await (options.fetchInventory || fetchOfficialGoInventory)({ fetchImpl: options.fetchImpl });
      const snapshot = parseOfficialGoInventory(payload);
      discovery = { discovered: snapshot.discovered };
      docs = snapshot.rows;
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
    const finalObservation = await (options.observeIdle || observeRouterIdle)({ readHealth: options.readHealth || readProtectedRouterHealth, readActivity: options.readActivity || readControlActivity, now });
    if (plan.catalogChanged && !quietEligible({ observations: [baselineObservation] }, finalObservation, now()).ok) {
      const result = { state: "deferred", reason: "router_activity_changed", checkedAt: new Date(now()).toISOString(), observations: [firstObservation, finalObservation] };
      updateStatus(paths.statusPath, result);
      return { ...result, plan };
    }
    let deferredInMutation = false;
    let skipPublication = false;
    let deferredReason = "router_activity_changed";
    let appliedPlan = plan;
    try {
      const refreshPlan = () => buildPlan({ discovery, docs, currentModels: strictUserModels(userModelsFile(options, paths)).models, picker: strictPickerState(pickerFile(options, paths)), seen: new Set(strictSeenState(paths.seenPath).seen) });
      const activationGate = async (requireIdle = true) => {
        let latestPolicy;
        try { latestPolicy = readPolicy(paths.policyPath); }
        catch { deferredReason = "policy_changed"; return false; }
        if (!latestPolicy.enabled) { deferredReason = "disabled"; return false; }
        try { ownerGuard({ sourceRoot: options.sourceRoot || SOURCE_ROOT, stateDir: paths.stateDir, policyPath: paths.policyPath, installManifestPath: installManifestFile(options, paths) }); }
        catch { deferredReason = "policy_changed"; return false; }
        const latestEligibility = goProviderEligibility({ discoveryDisabledCheck: options.discoveryDisabledCheck || discoveryDisabled, configuredCheck: options.configuredCheck || configuredProviderIds, selectionPath: selectionFile(options, paths) });
        if (!latestEligibility.enabled) { deferredReason = latestEligibility.reason; return false; }
        if (!requireIdle) return true;
        const observation = await (options.observeIdle || observeRouterIdle)({ readHealth: options.readHealth || readProtectedRouterHealth, readActivity: options.readActivity || readControlActivity, now });
        if (!quietEligible({ observations: [baselineObservation] }, observation, now()).ok) { deferredReason = "router_activity_changed"; return false; }
        return true;
      };
      const mutate = async () => {
        if (deferredInMutation) return;
        const latestPlan = refreshPlan();
        if (!(await activationGate(latestPlan.catalogChanged))) { deferredInMutation = true; return; }
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
      // Keep the updater lock until publication or rollback has completed so
      // another check cannot plan against this transaction's temporary files.
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
          appliedPlan = refreshPlan();
          const gate = await activationGate(appliedPlan.catalogChanged);
          if (!gate) deferredInMutation = true;
          return gate && appliedPlan.catalogChanged && options.restart !== false;
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
      return { ...result, error: makeError("catalog_update_failed", "Catalog update failed.") };
    }
  }, { acquire, release });
}

// The scheduled parent transports auth once. This fixed command enters the
// ordinary updater directly, whose lock remains held through publication and
// rollback. It cannot recurse into managed-environment extraction.
export const GO_MANAGED_CHILD_COMMAND = "--managed-environment-child";
const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];

export function spawnManagedGoUpdater({ environment, spawnImpl = spawn, signalSource = process } = {}) {
  return new Promise(resolve => {
    let child;
    try {
      child = spawnImpl(process.execPath, [SELF, GO_MANAGED_CHILD_COMMAND], {
        env: environment,
        // Provider errors may contain credentials. Neither channel is relayed,
        // parsed, persisted, or attached to an error from this parent.
        stdio: ["ignore", "ignore", "ignore"],
      });
    } catch { resolve({ code: 1, signal: null, failed: true }); return; }
    const handlers = new Map(FORWARDED_SIGNALS.map(signal => [signal, () => { try { child.kill(signal); } catch { /* wait for close */ } }]));
    for (const [signal, handler] of handlers) signalSource.on(signal, handler);
    let failed = false;
    child.once("error", () => { failed = true; });
    // No short deadline: killing an updater in publication would release the
    // single-flight lock before a transaction had finished or rolled back.
    child.once("close", (code, signal) => {
      for (const [name, handler] of handlers) signalSource.removeListener(name, handler);
      resolve({ code, signal, ...(failed ? { failed: true } : {}) });
    });
  });
}

export async function runScheduledGoAutoCatalog(options = {}) {
  const paths = statePath(options);
  const now = options.now || Date.now;
  const pending = (reason, extra = {}) => {
    const result = { state: "pending", reason, checkedAt: new Date(now()).toISOString(), ...extra };
    updateStatus(paths.statusPath, result);
    return result;
  };
  const gate = () => {
    const policy = readPolicy(paths.policyPath);
    if (!policy.enabled) return { state: "disabled", reason: "disabled" };
    if ((options.discoveryDisabledCheck || discoveryDisabled)()) return { state: "skipped", reason: "discovery_disabled" };
    if (!strictProviderSelection(selectionFile(options, paths), [...GO_FAMILY])) return { state: "skipped", reason: "provider_disabled" };
    ownerGuard({ sourceRoot: options.sourceRoot || SOURCE_ROOT, stateDir: paths.stateDir, policyPath: paths.policyPath, installManifestPath: installManifestFile(options, paths) });
    return undefined;
  };
  let environment;
  try {
    const stopped = gate();
    if (stopped) return stopped;
    environment = (options.loadEnvironment || loadManagedGoRuntimeEnvironment)({
      environment: options.environment || process.env,
      sourceRoot: options.sourceRoot || SOURCE_ROOT,
      stateDir: paths.stateDir,
      installManifestPath: installManifestFile(options, paths),
    });
    const changed = gate();
    if (changed) return changed;
  } catch (error) {
    return pending(error?.code === "managed_go_environment_conflict" ? "managed_go_environment_conflict" : "managed_go_environment_untrusted");
  }
  let outcome;
  try { outcome = await (options.spawnUpdater || spawnManagedGoUpdater)({ environment }); }
  catch { return pending("managed_updater_child_failed", { exitCode: 1 }); }
  if (outcome?.signal) {
    const signal = Object.hasOwn(osConstants.signals, outcome.signal) ? outcome.signal : undefined;
    return pending("managed_updater_child_interrupted", { exitCode: 1, ...(signal ? { signal } : {}) });
  }
  if (outcome?.failed || outcome?.code !== 0) {
    const exitCode = Number.isInteger(outcome?.code) && outcome.code > 0 && outcome.code <= 255 ? outcome.code : 1;
    return pending("managed_updater_child_failed", { exitCode });
  }
  // The child's ordinary status file holds catalog/idle evidence. The parent
  // returns only a fixed outcome, never the child's potentially secret output.
  return { state: "completed", reason: "updater_child_completed" };
}

function usage() { return "Usage: opencode-go-auto-catalog install|disable|status|check|--scheduled"; }

async function main(argv = process.argv.slice(2)) {
  const command = argv[0] || "status";
  try {
    let result;
    if (command === "install") result = await installGoAutoCatalog();
    else if (command === "disable") result = await disableGoAutoCatalog();
    else if (command === "status") result = statusGoAutoCatalog();
    else if (command === "--scheduled") result = await runScheduledGoAutoCatalog();
    else if (command === "check" || command === GO_MANAGED_CHILD_COMMAND) result = await checkGoAutoCatalog();
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
    if (result?.signal && Object.hasOwn(osConstants.signals, result.signal)) process.kill(process.pid, result.signal);
    else if (result?.exitCode) process.exitCode = result.exitCode;
    else if (result?.state === "error") process.exitCode = 1;
  } catch (error) {
    console.error(command === GO_MANAGED_CHILD_COMMAND ? "managed_updater_child_failed" : statusError(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) await main();
