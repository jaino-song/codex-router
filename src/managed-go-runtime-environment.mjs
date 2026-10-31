import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { INSTALL_MANIFEST_PATH, LAUNCH_AGENT_PATH, SERVICE_LABEL, SOURCE_ROOT, STATE_DIR } from "./paths.mjs";
import { providerApiKeyServiceEnvironment } from "./provider-api-key-service-environment.mjs";

const MAX_PLIST_BYTES = 2 * 1024 * 1024;
const REGISTRY_PATH = fileURLToPath(new URL("../config/opencode/opencode.json", import.meta.url));
const STATE_FIELDS = ["MODEL_ROUTER_STATE_DIR", "CODEX_ROUTER_STATE_DIR", "KIMI_CODEX_STATE_DIR"];

function failure(code = "managed_go_environment_untrusted") {
  const error = new Error("Managed Go runtime environment could not be verified.");
  error.code = code;
  return error;
}

function sameFile(a, b) {
  return ["dev", "ino", "uid", "mode", "size", "mtimeMs", "ctimeMs"].every(key => a[key] === b[key]);
}

// Check every component without following links. Root-owned ancestors are
// permitted; writable directories and links can redirect an otherwise private
// final file and are never trusted. Recheck the same identities after reading.
function trustedParents(file, filesystem, currentUid) {
  const parents = [];
  for (let directory = path.dirname(file); ; directory = path.dirname(directory)) {
    const stat = filesystem.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || ![0, currentUid].includes(stat.uid) || (stat.mode & 0o022)) throw failure();
    parents.push([directory, stat]);
    if (path.dirname(directory) === directory) break;
  }
  return () => {
    for (const [directory, stat] of parents) {
      const next = filesystem.lstatSync(directory);
      // Directory contents can change legitimately; identity, owner and mode
      // must remain stable, but their timestamps and size need not.
      if (!["dev", "ino", "uid", "mode"].every(key => stat[key] === next[key])) throw failure();
    }
  };
}

function trustedRead(file, filesystem, currentUid) {
  if (!path.isAbsolute(file) || path.normalize(file) !== file) throw failure();
  const verifyParents = trustedParents(file, filesystem, currentUid);
  const stat = filesystem.lstatSync(file);
  const valid = value => value.isFile() && !value.isSymbolicLink() && value.uid === currentUid && (value.mode & 0o7777) === 0o600 && value.size <= MAX_PLIST_BYTES;
  if (!valid(stat)) throw failure();
  const fd = filesystem.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const opened = filesystem.fstatSync(fd);
    if (!valid(opened) || !sameFile(stat, opened) || !sameFile(opened, filesystem.lstatSync(file))) throw failure();
    verifyParents();
    const buffer = Buffer.alloc(opened.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = filesystem.readSync(fd, buffer, length, buffer.length - length, length);
      if (count === 0) break;
      length += count;
    }
    if (length !== opened.size || !sameFile(opened, filesystem.fstatSync(fd)) || !sameFile(opened, filesystem.lstatSync(file))) throw failure();
    verifyParents();
    return buffer.subarray(0, length);
  } finally { filesystem.closeSync(fd); }
}

function goCredentialNames() {
  const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8"));
  if (registry.version !== 1 || !Array.isArray(registry.providers)) throw failure();
  const names = new Set();
  for (const provider of registry.providers) {
    if (provider.id !== "opencode-go" && provider.variantOf !== "opencode-go") continue;
    if (!Array.isArray(provider.credential?.environment)) throw failure();
    for (const name of provider.credential.environment) {
      if (typeof name !== "string" || !/^[A-Z][A-Z0-9_]{0,99}$/.test(name)) throw failure();
      names.add(name);
    }
  }
  if (!names.size) throw failure();
  return [...names];
}

// plutil sees the verified snapshot on stdin, never a path it can reopen or a
// key on argv. Its output is bounded and its diagnostics are never propagated.
function plistReader(input) {
  const run = args => execFileSync("/usr/bin/plutil", args, { input, encoding: "utf8", maxBuffer: MAX_PLIST_BYTES, timeout: 5_000, stdio: ["pipe", "pipe", "ignore"] });
  run(["-lint", "-s", "-"]);
  return (key, optional = false) => {
    let type;
    try { type = run(["-type", key, "-"]).trim(); }
    catch (error) {
      // A valid plist's absent key exits 1. Other command failures (including
      // timeout and output bounds) must not masquerade as an optional absence.
      if (optional && error.status === 1 && !error.signal && !error.code) return undefined;
      throw failure();
    }
    if (key === "ProgramArguments") {
      if (type !== "array") throw failure();
      try { return JSON.parse(run(["-extract", key, "json", "-o", "-", "-"])); } catch { throw failure(); }
    }
    if (type !== "string") throw failure();
    return run(["-extract", key, "raw", "-o", "-", "-n", "-"]);
  };
}

export function loadManagedGoRuntimeEnvironment({
  environment = process.env,
  plistPath = LAUNCH_AGENT_PATH,
  sourceRoot = SOURCE_ROOT,
  stateDir = STATE_DIR,
  nodeBinary = process.execPath,
  installManifestPath = INSTALL_MANIFEST_PATH,
  poolStatePath,
  credentialStorePath,
  filesystem = fs,
  currentUid = process.getuid?.(),
} = {}) {
  try {
    if (!Number.isInteger(currentUid) || !path.isAbsolute(nodeBinary)) throw failure();
    const source = filesystem.realpathSync(sourceRoot);
    const state = filesystem.realpathSync(stateDir);
    const manifest = JSON.parse(trustedRead(installManifestPath, filesystem, currentUid).toString("utf8"));
    if (manifest.version !== 1 || manifest.current?.sourceRoot !== source) throw failure();
    const read = plistReader(trustedRead(plistPath, filesystem, currentUid));
    const args = read("ProgramArguments");
    if (read("Label") !== SERVICE_LABEL || !Array.isArray(args) || args.length !== 2 || args[0] !== nodeBinary || args[1] !== path.join(source, "src", "start.mjs") || read("WorkingDirectory") !== source) throw failure();
    for (const name of STATE_FIELDS) if (read(`EnvironmentVariables.${name}`) !== state) throw failure();
    const optionalSource = read("EnvironmentVariables.CODEX_ROUTER_SOURCE_ROOT", true);
    if (optionalSource !== undefined && optionalSource !== source) throw failure();
    const candidates = Object.create(null);
    for (const name of goCredentialNames()) {
      const value = read(`EnvironmentVariables.${name}`, true);
      if (value === undefined) continue;
      if (typeof value !== "string") throw failure();
      candidates[name] = value;
    }
    // This existing policy is the sole authority for active pool references.
    // Supplying candidates rather than process.env prevents source fallback.
    const filtered = providerApiKeyServiceEnvironment({ environment: candidates, poolStatePath, credentialStorePath });
    const merged = { ...environment };
    for (const [name, value] of Object.entries(filtered)) {
      if (Object.hasOwn(environment, name) && environment[name] !== value) throw failure("managed_go_environment_conflict");
      merged[name] = value;
    }
    return merged;
  } catch (error) {
    throw failure(error?.code === "managed_go_environment_conflict" ? error.code : undefined);
  }
}
