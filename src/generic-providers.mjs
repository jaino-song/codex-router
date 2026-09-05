import { promises as dns } from "node:dns";
import { isIP } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Agent, fetch as undiciFetch } from "undici";

import { withAtomicStateLock } from "./atomic-state-lock.mjs";
import {
  GENERIC_PROVIDER_SCHEMA_VERSION,
  GENERIC_PROVIDERS_PATH,
  genericProviderRuntimeDescriptor,
  isPrivateGenericProviderAddress,
  isPrivateGenericProviderHostname,
  parseGenericProviderDocument,
  readGenericProviders as readGenericProviderState,
  redactGenericProvider as redactGenericProviderState,
  validateGenericProvider,
  validateGenericProviderHeaders,
} from "./generic-provider-state.mjs";
import { providerCatalogIdentityFingerprint } from "./model-catalog-cache.mjs";
import { PROVIDERS } from "./model-registry.mjs";
import { readProviderCredentialStore } from "./provider-credential-store.mjs";
import { resolveGenericProviderCredentialReference } from "./provider-credentials.mjs";

export {
  GENERIC_PROVIDER_ADAPTERS,
  GENERIC_PROVIDER_SCHEMA_VERSION,
  GENERIC_PROVIDERS_PATH,
} from "./generic-provider-state.mjs";
export { genericProviderConfigured } from "./generic-provider-readiness.mjs";
import { writePrivateJson } from "./file-security.mjs";
import { fetchUntrustedModelCatalog } from "./untrusted-model-discovery.mjs";

const MAX_RESPONSE_BYTES = 64 * 1024;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function unavailable(message) {
  const error = new Error(message);
  error.status = 503;
  return error;
}

export function readGenericProviders() {
  return readGenericProviderState({ reservedProviderIds: PROVIDERS });
}

export function redactGenericProvider(provider) {
  return redactGenericProviderState(provider, { reservedProviderIds: PROVIDERS });
}

export function listGenericProviders({ redacted = true } = {}) {
  const providers = readGenericProviders();
  return providers.map((provider) => redacted ? redactGenericProvider(provider) : provider);
}

export function getGenericProvider(id, { redacted = false } = {}) {
  const provider = readGenericProviders().find((entry) => entry.id === text(id));
  if (!provider) throw new Error(`Unknown generic provider: ${id}`);
  return redacted ? redactGenericProvider(provider) : provider;
}

function saveProviders(providers) {
  writePrivateJson(
    GENERIC_PROVIDERS_PATH,
    { version: GENERIC_PROVIDER_SCHEMA_VERSION, providers },
    { directoryMode: 0o700 },
  );
}

function mutateProviders(mutator) {
  return withAtomicStateLock(GENERIC_PROVIDERS_PATH, () => {
    const current = readGenericProviders();
    const next = mutator(current.map((provider) => ({ ...provider, headers: { ...provider.headers } })));
    if (!Array.isArray(next)) throw new Error("Generic provider mutation returned an invalid list.");
    const validated = parseGenericProviderDocument(
      { version: GENERIC_PROVIDER_SCHEMA_VERSION, providers: next },
      { reservedProviderIds: PROVIDERS },
    ).providers;
    saveProviders(validated);
    return validated;
  });
}

export function addGenericProvider(input) {
  const provider = validateGenericProvider(input, { reservedProviderIds: PROVIDERS });
  const providers = mutateProviders((current) => {
    if (current.some((entry) => entry.id === provider.id)) {
      throw new Error(`Generic provider ${provider.id} already exists.`);
    }
    return [...current, provider];
  });
  return redactGenericProvider(providers.find((entry) => entry.id === provider.id));
}

export function updateGenericProvider(id, patch) {
  const providerId = text(id);
  let updated;
  mutateProviders((current) => {
    const existing = current.find((entry) => entry.id === providerId);
    if (!existing) throw new Error(`Unknown generic provider: ${id}`);
    updated = validateGenericProvider(
      { ...existing, ...patch, id: existing.id },
      { existingId: existing.id, reservedProviderIds: PROVIDERS },
    );
    return current.map((entry) => entry.id === existing.id ? updated : entry);
  });
  return redactGenericProvider(updated);
}

export function removeGenericProvider(id) {
  const providerId = text(id);
  const next = mutateProviders((providers) => {
    if (!providers.some((entry) => entry.id === providerId)) {
      throw new Error(`Unknown generic provider: ${id}`);
    }
    return providers.filter((entry) => entry.id !== providerId);
  });
  return { removed: providerId, remaining: next.length };
}

export function setGenericProviderEnabled(id, enabled) {
  if (typeof enabled !== "boolean") throw new Error("enabled must be a boolean.");
  return updateGenericProvider(id, { enabled });
}

export function genericProviderDescriptor(providerOrId) {
  const provider = typeof providerOrId === "string"
    ? getGenericProvider(providerOrId)
    : validateGenericProvider(providerOrId, {
        existingId: providerOrId.id,
        reservedProviderIds: PROVIDERS,
      });
  return genericProviderRuntimeDescriptor(provider);
}

async function lookupHost(hostname) {
  try {
    const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
    return addresses.map((entry) => entry.address);
  } catch (error) {
    throw new Error(`Could not resolve provider host ${hostname}: ${errorMessage(error)}`);
  }
}

function destinationUrl(provider, requestPath) {
  const suffix = String(requestPath || "");
  if (!suffix.startsWith("/") || suffix.startsWith("//") || /^[a-z][a-z\d+.-]*:/i.test(suffix)) {
    throw new Error("Generic provider request paths must be relative to the configured baseUrl.");
  }
  const endpoint = new URL(provider.baseUrl);
  const target = new URL(`${provider.baseUrl}${suffix}`);
  if (target.origin !== endpoint.origin || target.username || target.password) {
    throw new Error("Generic provider request cannot change the configured origin.");
  }
  const basePath = endpoint.pathname.endsWith("/") ? endpoint.pathname : `${endpoint.pathname}/`;
  if (!target.pathname.startsWith(basePath)) {
    throw new Error("Generic provider request cannot escape the configured baseUrl path.");
  }
  return target;
}

async function validateResolvedDestination(endpoint, provider, lookup = lookupHost) {
  if (isPrivateGenericProviderHostname(endpoint.hostname) && !provider.allowPrivate) {
    throw new Error("Provider host is private or loopback; set allowPrivate=true explicitly.");
  }
  const resolved = await lookup(endpoint.hostname);
  if (!resolved.length) throw new Error(`Provider host ${endpoint.hostname} has no addresses.`);
  if (!provider.allowPrivate && resolved.some(isPrivateGenericProviderAddress)) {
    throw new Error("Provider host resolved to a private or link-local address; set allowPrivate=true explicitly.");
  }
  return resolved;
}

function safeHeaderEntries(headers) {
  const values = headers instanceof Headers ? [...headers.entries()] : Object.entries(headers || {});
  return validateGenericProviderHeaders(
    Object.fromEntries(values.map(([name, value]) => [name, String(value ?? "")])),
  );
}

function credentialSecret(provider) {
  if (!provider.credentialRef) return undefined;
  const entry = readProviderCredentialStore().credentials.find((candidate) => candidate.id === provider.credentialRef);
  if (!entry || entry.state !== "active") return undefined;
  if (entry.providerType !== "generic") return undefined;
  if (entry.providerId !== provider.id) return undefined;
  if (entry.kind !== "api_key") return undefined;
  return resolveGenericProviderCredentialReference(provider.id, entry.secretRef)?.value;
}

/**
 * Capture one credential-bound discovery attempt without exposing its secret.
 * The returned loader closes over the raw headers while callers receive only
 * the redacted descriptor and an installation-keyed identity fingerprint.
 */
export function genericProviderDiscoverySnapshot(id) {
  const provider = getGenericProvider(id);
  if (!provider.enabled) throw new Error(`Generic provider ${provider.id} is disabled.`);
  const secret = credentialSecret(provider);
  if (provider.credentialRef && !secret) {
    throw new Error(`Credential ${provider.credentialRef} is unavailable for generic provider ${provider.id}.`);
  }
  const headers = { ...provider.headers };
  if (secret) headers.Authorization = `Bearer ${secret}`;
  const headerPairs = Object.entries(headers)
    .map(([name, value]) => [String(name).toLowerCase(), String(value)])
    .sort(([left], [right]) => left.localeCompare(right));
  const identityFingerprint = providerCatalogIdentityFingerprint([
    "generic",
    provider.id,
    provider.baseUrl,
    provider.adapter,
    headerPairs,
  ]);
  const descriptor = genericProviderDescriptor(provider);
  return Object.freeze({
    descriptor,
    identityFingerprint,
    fetchCatalog: ({
      fetchImpl = globalThis.fetch,
      timeoutMs = 30_000,
      resolveHost,
      proxyResolvesDestination,
    } = {}) => fetchUntrustedModelCatalog(`${provider.baseUrl}/models`, {
      fetchImpl,
      headers,
      timeoutMs,
      allowPrivate: provider.allowPrivate,
      ...(resolveHost ? { resolveHost } : {}),
      ...(proxyResolvesDestination !== undefined ? { proxyResolvesDestination } : {}),
    }),
  });
}

function requestSignal(signal, timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return signal;
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function createDestinationDispatcher(endpoint, provider, timeoutMs) {
  const lookup = (hostname, options, callback) => {
    lookupHost(hostname)
      .then((addresses) => {
        if (!provider.allowPrivate && addresses.some(isPrivateGenericProviderAddress)) {
          throw new Error("Provider host resolved to a private or link-local address.");
        }
        if (options?.all) {
          callback(null, addresses.map((address) => ({ address, family: isIP(address) })));
        } else {
          const address = addresses[0];
          callback(null, address, isIP(address));
        }
      })
      .catch((error) => callback(error));
  };
  return new Agent({
    allowH2: false,
    pipelining: 1,
    // Discovery and `providers generic test` are bounded. A generation request
    // passes zero and lives exactly as long as its caller: an arbitrary
    // ten-second body timeout would cut off healthy streamed model output.
    headersTimeout: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 0,
    bodyTimeout: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 0,
    connect: { lookup },
  });
}

function mergeRequestHeaders(requestHeaders, staticHeaders) {
  const result = { ...requestHeaders };
  for (const [name, value] of Object.entries(staticHeaders)) {
    const lower = name.toLowerCase();
    for (const existing of Object.keys(result)) {
      if (existing.toLowerCase() === lower) delete result[existing];
    }
    result[name] = value;
  }
  return result;
}

async function boundedResponseBody(response, maxBytes = MAX_RESPONSE_BYTES) {
  const contentLength = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error(`Generic provider response exceeds the ${maxBytes}-byte limit.`);
  }
  if (!response.body) {
    if (typeof response.text === "function") {
      const value = await response.text();
      if (Buffer.byteLength(value, "utf8") > maxBytes) throw new Error("Generic provider response exceeds the read limit.");
      return value;
    }
    return "";
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`Generic provider response exceeds the ${maxBytes}-byte limit.`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function requestGenericProvider(
  id,
  requestPath,
  { fetchImpl = undiciFetch, lookup = lookupHost, timeoutMs = 10_000, ...init } = {},
) {
  const provider = getGenericProvider(id);
  if (!provider.enabled) throw unavailable(`Generic provider ${provider.id} is disabled.`);
  const endpoint = destinationUrl(provider, requestPath);
  await validateResolvedDestination(endpoint, provider, lookup);
  const requestHeaders = safeHeaderEntries(init.headers);
  // Static provider headers are operator-owned routing metadata. A caller can
  // add ordinary content-negotiation headers, but cannot replace tenant or
  // gateway selection chosen in the protected provider descriptor.
  const headers = mergeRequestHeaders(requestHeaders, provider.headers);
  const secret = credentialSecret(provider);
  if (provider.credentialRef && !secret) {
    throw unavailable(`The bound credential is unavailable for generic provider ${provider.id}.`);
  }
  if (secret) headers.Authorization = `Bearer ${secret}`;
  const useDispatcher = fetchImpl === undiciFetch;
  const dispatcher = useDispatcher ? createDestinationDispatcher(endpoint, provider, timeoutMs) : undefined;
  try {
    const response = await fetchImpl(endpoint.toString(), {
      ...init,
      headers,
      redirect: "manual",
      signal: requestSignal(init.signal, timeoutMs),
      ...(dispatcher ? { dispatcher } : {}),
    });
    if (REDIRECT_STATUSES.has(response.status)) {
      await Promise.resolve(response.body?.cancel?.()).catch(() => undefined);
      throw new Error("Generic provider redirects are disabled.");
    }
    return { response, endpoint: endpoint.toString(), dispatcher };
  } catch (error) {
    await dispatcher?.close().catch(() => undefined);
    throw error;
  }
}

export async function testGenericProvider(id, { fetchImpl = undiciFetch, lookup = lookupHost, timeoutMs = 10_000 } = {}) {
  const { response, endpoint, dispatcher } = await requestGenericProvider(id, "/models", {
    fetchImpl,
    lookup,
    timeoutMs,
    method: "GET",
    headers: { Accept: "application/json" },
  });
  try {
    await boundedResponseBody(response);
    return {
      ok: response.ok,
      status: response.status,
      endpoint,
      ...(response.ok ? { message: "Provider endpoint is reachable." } : { message: "Provider endpoint returned an error." }),
    };
  } finally {
    await dispatcher?.close().catch(() => undefined);
  }
}

function parseHeader(raw) {
  const separator = String(raw).indexOf("=");
  if (separator < 1) throw new Error("Headers must use Name=Value syntax.");
  return [String(raw).slice(0, separator), String(raw).slice(separator + 1)];
}

function optionValue(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function optionValues(args, name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name) values.push(args[index + 1]);
  }
  return values;
}

function cliUsage() {
  throw new Error(
    "Usage: providers generic list [--json] | add ID --name NAME --base-url URL " +
      "[--adapter openai-chat|openai-responses|openai-completions] [--header Name=Value] " +
      "[--credential-ref cred_ID] [--description TEXT] [--allow-private] | edit ID [options] | show ID [--json] | " +
      "enable ID | disable ID | remove ID | test ID [--json]. Descriptor mutations also accept --no-apply only while no curated routes exist. " +
      "Use `providers generic credential ID status|set|remove` to manage its protected key.",
  );
}

export async function runGenericProviderCli(args = process.argv.slice(3), { output = process.stdout } = {}) {
  const action = args[0] || "list";
  const json = args.includes("--json");
  const print = (value) => output.write(`${json ? JSON.stringify(value, null, 2) : value}\n`);
  if (action === "list") {
    const providers = listGenericProviders({ redacted: true });
    print(json ? { providers } : providers.map((provider) =>
      `${provider.enabled ? "SHOW" : "HIDE"} ${provider.id.padEnd(20)} ${provider.displayName} (${provider.adapter})`,
    ).join("\n"));
    return providers;
  }
  if (["add", "edit"].includes(action)) {
    const id = text(args[1]);
    if (!id) cliUsage();
    const patch = { id };
    for (const [flag, field] of [
      ["--name", "displayName"],
      ["--base-url", "baseUrl"],
      ["--adapter", "adapter"],
      ["--credential-ref", "credentialRef"],
      ["--description", "description"],
    ]) {
      const value = optionValue(args, flag);
      if (value !== undefined) patch[field] = value;
    }
    if (args.includes("--allow-private")) patch.allowPrivate = true;
    if (args.includes("--public-only")) patch.allowPrivate = false;
    const headerValues = optionValues(args, "--header").filter((value) => value !== undefined);
    if (headerValues.length) patch.headers = Object.fromEntries(headerValues.map(parseHeader));
    const provider = action === "add" ? addGenericProvider(patch) : updateGenericProvider(id, patch);
    print(json ? { provider } : `${action === "add" ? "Added" : "Updated"} generic provider ${provider.id}.`);
    return provider;
  }
  if (action === "show") {
    const provider = getGenericProvider(args[1], { redacted: true });
    print(json ? { provider } : JSON.stringify(provider, null, 2));
    return provider;
  }
  if (action === "remove") {
    const result = removeGenericProvider(args[1]);
    print(json ? result : `Removed generic provider ${result.removed}.`);
    return result;
  }
  if (action === "enable" || action === "disable") {
    const provider = setGenericProviderEnabled(args[1], action === "enable");
    print(json ? { provider } : `${provider.id} is now ${provider.enabled ? "enabled" : "disabled"}.`);
    return provider;
  }
  if (action === "test") {
    const result = await testGenericProvider(args[1]);
    print(json ? result : `${result.message} HTTP ${result.status}.`);
    return result;
  }
  cliUsage();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runGenericProviderCli(process.argv.slice(2)).catch((error) => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  });
}
