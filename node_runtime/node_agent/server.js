const http = require("http");
const { spawn } = require("child_process");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const net = require("net");
const https = require("https");
const dns = require("dns");
const { buildDescribe } = require("./describe.js");
const accounting = require("./accounting.js");

const PORT = Number(process.env.NODE_AGENT_PORT || 8085);
const API_KEY = String(process.env.NODE_AGENT_API_KEY || "").trim();
const DEFAULT_TIMEOUT_SEC = Number(process.env.NODE_AGENT_DEFAULT_TIMEOUT_SEC || 900);
const BODY_LIMIT_BYTES = 2 * 1024 * 1024;
const JOBS_ROOT = path.normalize(process.env.NODE_AGENT_JOBS_ROOT || "/opt/netrun/jobs");
const LOCK_FILENAME = ".generation.lock";
const LOG_TAIL_LIMIT = 12000;
const RESPONSE_TAIL_LIMIT = 2000;
const DEFAULT_STALE_JOB_SEC = Math.max(60, Number(process.env.NODE_AGENT_STALE_JOB_SEC || 1800));
const DEFAULT_AUTH_CHECK_SAMPLES = Math.max(1, Number(process.env.NODE_AGENT_AUTH_CHECK_SAMPLES || 3));
const DEFAULT_AUTH_CHECK_TIMEOUT_MS = Math.max(1000, Number(process.env.NODE_AGENT_AUTH_CHECK_TIMEOUT_MS || 5000));
const DEFAULT_INSTANCE_WAIT_MS = Math.max(2000, Number(process.env.NODE_AGENT_INSTANCE_WAIT_MS || 12000));
const DEFAULT_IPV6_EGRESS_URL = String(process.env.NODE_AGENT_IPV6_EGRESS_URL || "https://api64.ipify.org").trim();
const PROXY_ROOT = path.normalize(process.env.NODE_AGENT_PROXY_ROOT || "/opt/netrun/proxyserver");
const PROXY_CFG_ROOT = path.join(PROXY_ROOT, "3proxy");
const CLEANUP_CRON_AFTER_RUN = String(process.env.NODE_AGENT_CLEANUP_CRON_AFTER_RUN || "1").trim() !== "0";
const DEFAULT_FINGERPRINT_PROFILE_VERSION = (
  String(process.env.NODE_AGENT_DEFAULT_FINGERPRINT_PROFILE_VERSION || "v2_android_ipv6_only_dns_custom").trim()
  || "v2_android_ipv6_only_dns_custom"
);
const PRODUCTION_FINGERPRINT_PROFILE_VERSION = (
  String(process.env.NODE_AGENT_FINGERPRINT_PROFILE_VERSION || "v2_android_ipv6_only_dns_custom").trim()
  || "v2_android_ipv6_only_dns_custom"
);
const PRODUCTION_INTENDED_CLIENT_OS_PROFILE = "android_mobile";
const PRODUCTION_REQUIRED_NETWORK_PROFILE = "high_compatibility";
const ALLOWED_IPV6_POLICIES = new Set(["ipv6_only", "strict_dual_stack", "ipv6_required"]);
const _envIpv6Policy = String(process.env.NODE_AGENT_REQUIRED_IPV6_POLICY || "ipv6_only").trim().toLowerCase();
const PRODUCTION_REQUIRED_IPV6_POLICY = ALLOWED_IPV6_POLICIES.has(_envIpv6Policy) ? _envIpv6Policy : "ipv6_only";
const PRODUCTION_IPV6_ROLLOUT_STAGE = "enforced";
const PRODUCTION_CLIENT_OS_PROFILE_ENFORCEMENT = "not_controlled_by_proxy";
const PRODUCTION_EFFECTIVE_CLIENT_PROFILE = "not_controlled_by_proxy";

const SCRIPT_FLAG_CACHE = new Map();
const PARTIAL_PATTERNS = [
  /\bpartial\b/i,
  /\bpartially\b/i,
  /\bincomplete\b/i,
  /\btruncated\b/i,
  /\bonly\s+\d+\s*(?:of|\/)\s*\d+\b/i,
  /\bnot\s+enough\b/i,
];

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function nowIso() {
  return new Date().toISOString();
}

function ensureAuthorized(req) {
  if (!API_KEY) {
    return true;
  }
  const headerKey = String(req.headers["x-api-key"] || "").trim();
  return headerKey === API_KEY;
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > BODY_LIMIT_BYTES) {
        reject(new Error("payload_too_large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf-8");
        const parsed = raw ? JSON.parse(raw) : {};
        resolve(parsed);
      } catch (_error) {
        reject(new Error("invalid_json"));
      }
    });
    req.on("error", reject);
  });
}

function resolveInputPath(baseDir, inputPath) {
  if (!inputPath) {
    return "";
  }
  if (path.isAbsolute(inputPath)) {
    return path.normalize(inputPath);
  }
  return path.resolve(baseDir, inputPath);
}

function toPositiveInt(value, fallback = 0) {
  const num = Number(value);
  if (!Number.isInteger(num) || num <= 0) {
    return fallback;
  }
  return num;
}

function toBool(value, fallback = false) {
  if (value === null || value === undefined) {
    return fallback;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function normalizeStatus(raw) {
  const value = String(raw || "").trim().toLowerCase();
  if (!value) {
    return "unknown";
  }
  if (value === "success" || value === "completed") {
    return "ready";
  }
  return value;
}

function normalizeJobId(input) {
  const raw = String(input ?? "").trim();
  const fallback = `job-${Date.now()}`;
  const value = raw || fallback;
  const sanitized = value.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/^_+|_+$/g, "");
  return sanitized || fallback;
}

function ensurePathInside(baseDir, targetPath) {
  const rel = path.relative(path.resolve(baseDir), path.resolve(targetPath));
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("path_outside_jobs_root");
  }
}

function isPathInside(baseDir, targetPath) {
  const rel = path.relative(path.resolve(baseDir), path.resolve(targetPath));
  return !(rel.startsWith("..") || path.isAbsolute(rel));
}

function containsExplicitPartialState(text) {
  const value = String(text || "");
  if (!value) {
    return false;
  }
  return PARTIAL_PATTERNS.some((pattern) => pattern.test(value));
}

function appendTail(current, chunkText, maxChars = LOG_TAIL_LIMIT) {
  const next = `${current}${chunkText}`;
  if (next.length <= maxChars) {
    return next;
  }
  return next.slice(-maxChars);
}

function makeRunId() {
  return `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code === "EPERM";
  }
}

async function fileExists(filePath) {
  try {
    await fsp.access(filePath, fs.constants.F_OK);
    return true;
  } catch (_error) {
    return false;
  }
}

async function safeUnlink(filePath) {
  try {
    await fsp.unlink(filePath);
  } catch (error) {
    if (!error || error.code !== "ENOENT") {
      throw error;
    }
  }
}

async function readJsonIfExists(filePath) {
  try {
    const content = await fsp.readFile(filePath, "utf-8");
    return JSON.parse(content);
  } catch (_error) {
    return null;
  }
}

async function writeJsonFile(filePath, data) {
  await fsp.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
}

async function readTail(filePath, maxChars = RESPONSE_TAIL_LIMIT) {
  if (!(await fileExists(filePath))) {
    return "";
  }
  const content = await fsp.readFile(filePath, "utf-8");
  return content.slice(-Math.max(0, maxChars));
}

function parseProxyLine(rawLine) {
  const original = String(rawLine || "").trim();
  if (!original || original.startsWith("#")) {
    return null;
  }
  if (/^socks5:\/\//i.test(original)) {
    const line = original.slice(original.indexOf("//") + 2);
    const parsed = parseUserPassHostPort(line, original);
    if (parsed) {
      return parsed;
    }
  }
  return parseLegacyColonProxyLine(original);
}

function parseUserPassHostPort(line, rawLine) {
  if (!line.includes("@")) {
    return null;
  }
  const atPos = line.lastIndexOf("@");
  const creds = line.slice(0, atPos);
  const endpoint = line.slice(atPos + 1);
  const credSep = creds.indexOf(":");
  const endpointSep = endpoint.lastIndexOf(":");
  if (credSep <= 0 || endpointSep <= 0) {
    return null;
  }
  const login = creds.slice(0, credSep).trim();
  const password = creds.slice(credSep + 1).trim();
  const host = endpoint.slice(0, endpointSep).trim();
  const port = Number(endpoint.slice(endpointSep + 1).trim());
  if (!login || !password || !host || !Number.isInteger(port) || port <= 0 || port > 65535) {
    return null;
  }
  return { login, password, host, port, raw_line: rawLine };
}

function parseLegacyColonProxyLine(line) {
  const parts = String(line || "").trim().split(":");
  if (parts.length !== 4) {
    return null;
  }
  const host = String(parts[0] || "").trim();
  const port = Number(String(parts[1] || "").trim());
  const login = String(parts[2] || "").trim();
  const password = String(parts[3] || "").trim();
  if (!host || !login || !password || !Number.isInteger(port) || port <= 0 || port > 65535) {
    return null;
  }
  return {
    login,
    password,
    host,
    port,
    raw_line: `Socks5://${login}:${password}@${host}:${port}`,
  };
}

async function parseProxiesList(filePath) {
  const content = await fsp.readFile(filePath, "utf-8");
  const lines = content.split(/\r?\n/);
  const items = [];
  const seen = new Set();
  let dataLineCount = 0;
  let invalidLineCount = 0;

  for (const line of lines) {
    const trimmed = String(line || "").trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    dataLineCount += 1;
    const parsed = parseProxyLine(trimmed);
    if (!parsed) {
      invalidLineCount += 1;
      continue;
    }
    const key = `${parsed.login}|${parsed.password}|${parsed.host}|${parsed.port}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    items.push(parsed);
  }

  return { content, items, dataLineCount, invalidLineCount };
}

function parseCsv(content) {
  const lines = String(content || "").split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) {
    return [];
  }
  const header = lines[0].split(",").map((v) => v.trim().toLowerCase());
  const rows = [];
  for (let index = 1; index < lines.length; index += 1) {
    const cols = lines[index].split(",").map((v) => v.trim());
    const row = {};
    for (let i = 0; i < header.length; i += 1) {
      row[header[i]] = cols[i] || "";
    }
    rows.push(row);
  }
  return rows;
}

function getFlagValue(args, names) {
  const namesSet = new Set(names);
  for (let i = 0; i < args.length; i += 1) {
    const token = String(args[i] || "");
    if (namesSet.has(token)) {
      return i + 1 < args.length ? String(args[i + 1] || "") : "";
    }
    for (const name of names) {
      if (token.startsWith(`${name}=`)) {
        return token.slice(name.length + 1);
      }
    }
  }
  return "";
}

function getBodyValue(body, snakeKey, camelKey) {
  if (body && body[snakeKey] !== undefined && body[snakeKey] !== null) {
    return body[snakeKey];
  }
  if (body && body[camelKey] !== undefined && body[camelKey] !== null) {
    return body[camelKey];
  }
  const meta = body && typeof body.meta === "object" && body.meta ? body.meta : {};
  if (meta[snakeKey] !== undefined && meta[snakeKey] !== null) {
    return meta[snakeKey];
  }
  if (meta[camelKey] !== undefined && meta[camelKey] !== null) {
    return meta[camelKey];
  }
  return "";
}

function buildProfileDiagnostics(profileInput) {
  const profile = profileInput && typeof profileInput === "object" ? profileInput : {};
  const clientOsProfileEnforcement = String(
    profile.client_os_profile_enforcement
    || profile.clientOsProfileEnforcement
    || "not_controlled_by_proxy"
  ).trim().toLowerCase() || "not_controlled_by_proxy";
  const clientOsProfileRequired = toBool(
    profile.client_os_profile_required ?? profile.clientOsProfileRequired,
    false
  );
  const actualClientProfile = PRODUCTION_EFFECTIVE_CLIENT_PROFILE;
  const effectiveClientProfile = PRODUCTION_EFFECTIVE_CLIENT_PROFILE;
  return {
    requested_fingerprint_profile_version: String(
      profile.requested_fingerprint_profile_version || profile.requestedFingerprintProfileVersion || ""
    ).trim(),
    fingerprint_profile_version: String(profile.fingerprint_profile_version || DEFAULT_FINGERPRINT_PROFILE_VERSION).trim(),
    intended_client_os_profile: String(profile.intended_client_os_profile || "").trim(),
    intended_network_profile: String(profile.intended_network_profile || "").trim(),
    client_os_profile_enforcement: clientOsProfileEnforcement,
    client_os_profile_required: clientOsProfileRequired,
    actual_client_profile: actualClientProfile,
    effective_client_os_profile: effectiveClientProfile,
    effective_network_profile: String(profile.effective_network_profile || "").trim(),
    effective_ipv6_policy: String(profile.effective_ipv6_policy || "").trim(),
    profile_selection_source: String(profile.profile_selection_source || "").trim(),
    profile_selection_reason: String(profile.profile_selection_reason || "").trim(),
    profile_selection_fallback: Boolean(profile.profile_selection_fallback),
    intended_ipv6_policy: String(profile.intended_ipv6_policy || "").trim(),
    ipv6_rollout_stage: String(profile.ipv6_rollout_stage || "").trim(),
  };
}

function normalizeContractValue(value) {
  return String(value || "").trim().toLowerCase();
}

function evaluateProductProfileContract(params, profileDiagnostics) {
  const paramsObject = params && typeof params === "object" ? params : {};
  const profile = profileDiagnostics && typeof profileDiagnostics === "object" ? profileDiagnostics : {};
  const mismatches = [];

  const expectedContract = {
    fingerprint_profile_version: PRODUCTION_FINGERPRINT_PROFILE_VERSION,
    profile_selection_source_disallowed: "fallback_default",
    client_os_profile_enforcement: PRODUCTION_CLIENT_OS_PROFILE_ENFORCEMENT,
    intended_client_os_profile: PRODUCTION_INTENDED_CLIENT_OS_PROFILE,
    actual_client_profile: PRODUCTION_EFFECTIVE_CLIENT_PROFILE,
    effective_client_os_profile: PRODUCTION_EFFECTIVE_CLIENT_PROFILE,
    network_profile: PRODUCTION_REQUIRED_NETWORK_PROFILE,
    ipv6_policy: PRODUCTION_REQUIRED_IPV6_POLICY,
    ipv6_rollout_stage: PRODUCTION_IPV6_ROLLOUT_STAGE,
  };

  const addMismatch = (field, expected, actual) => {
    mismatches.push({
      field,
      expected: String(expected),
      actual: String(actual || ""),
    });
  };

  const requestedVersion = String(profile.requested_fingerprint_profile_version || "").trim();
  const effectiveVersion = String(profile.fingerprint_profile_version || "").trim();
  if (!requestedVersion) {
    addMismatch("fingerprint_profile_version", PRODUCTION_FINGERPRINT_PROFILE_VERSION, "");
  } else if (requestedVersion !== PRODUCTION_FINGERPRINT_PROFILE_VERSION) {
    addMismatch("fingerprint_profile_version", PRODUCTION_FINGERPRINT_PROFILE_VERSION, requestedVersion);
  }
  if (effectiveVersion !== PRODUCTION_FINGERPRINT_PROFILE_VERSION) {
    addMismatch("effective_fingerprint_profile_version", PRODUCTION_FINGERPRINT_PROFILE_VERSION, effectiveVersion);
  }

  if (normalizeContractValue(profile.profile_selection_source) === "fallback_default" || Boolean(profile.profile_selection_fallback)) {
    addMismatch("profile_selection_source", "non_fallback", profile.profile_selection_source || "fallback_default");
  }

  if (normalizeContractValue(profile.client_os_profile_enforcement) !== PRODUCTION_CLIENT_OS_PROFILE_ENFORCEMENT) {
    addMismatch("client_os_profile_enforcement", PRODUCTION_CLIENT_OS_PROFILE_ENFORCEMENT, profile.client_os_profile_enforcement);
  }
  if (normalizeContractValue(profile.intended_client_os_profile) !== PRODUCTION_INTENDED_CLIENT_OS_PROFILE) {
    addMismatch("intended_client_os_profile", PRODUCTION_INTENDED_CLIENT_OS_PROFILE, profile.intended_client_os_profile);
  }
  if (normalizeContractValue(profile.actual_client_profile) !== PRODUCTION_EFFECTIVE_CLIENT_PROFILE) {
    addMismatch("actual_client_profile", PRODUCTION_EFFECTIVE_CLIENT_PROFILE, profile.actual_client_profile);
  }
  if (normalizeContractValue(profile.effective_client_os_profile) !== PRODUCTION_EFFECTIVE_CLIENT_PROFILE) {
    addMismatch("effective_client_os_profile", PRODUCTION_EFFECTIVE_CLIENT_PROFILE, profile.effective_client_os_profile);
  }

  for (const [field, actual] of [
    ["intended_network_profile", profile.intended_network_profile],
    ["effective_network_profile", profile.effective_network_profile],
    ["network_profile", paramsObject.networkProfile],
  ]) {
    if (normalizeContractValue(actual) !== PRODUCTION_REQUIRED_NETWORK_PROFILE) {
      addMismatch(field, PRODUCTION_REQUIRED_NETWORK_PROFILE, actual);
    }
  }

  for (const [field, actual] of [
    ["intended_ipv6_policy", profile.intended_ipv6_policy],
    ["effective_ipv6_policy", profile.effective_ipv6_policy],
    ["ipv6_policy", paramsObject.ipv6Policy],
  ]) {
    if (normalizeContractValue(actual) !== PRODUCTION_REQUIRED_IPV6_POLICY) {
      addMismatch(field, PRODUCTION_REQUIRED_IPV6_POLICY, actual);
    }
  }

  if (normalizeContractValue(profile.ipv6_rollout_stage) !== PRODUCTION_IPV6_ROLLOUT_STAGE) {
    addMismatch("ipv6_rollout_stage", PRODUCTION_IPV6_ROLLOUT_STAGE, profile.ipv6_rollout_stage);
  }

  return {
    ok: mismatches.length === 0,
    error: mismatches.length === 0 ? null : "product_profile_contract_mismatch",
    expected_contract: expectedContract,
    intended: {
      fingerprint_profile_version: requestedVersion,
      client_os_profile: profile.intended_client_os_profile,
      client_os_profile_enforcement: profile.client_os_profile_enforcement,
      network_profile: profile.intended_network_profile,
      ipv6_policy: profile.intended_ipv6_policy,
    },
    effective: {
      fingerprint_profile_version: effectiveVersion,
      client_os_profile: profile.effective_client_os_profile,
      actual_client_profile: profile.actual_client_profile,
      network_profile: profile.effective_network_profile,
      ipv6_policy: profile.effective_ipv6_policy,
      profile_selection_source: profile.profile_selection_source,
      profile_selection_fallback: Boolean(profile.profile_selection_fallback),
      ipv6_rollout_stage: profile.ipv6_rollout_stage,
    },
    applied: {
      client_os_profile: profile.effective_client_os_profile,
      network_profile: paramsObject.networkProfile || "",
      ipv6_policy: paramsObject.ipv6Policy || "",
    },
    mismatches,
  };
}

function withProfileDiagnostics(baseDiagnostics, profileDiagnostics) {
  const base = baseDiagnostics && typeof baseDiagnostics === "object" ? baseDiagnostics : {};
  const profile = profileDiagnostics && typeof profileDiagnostics === "object" ? profileDiagnostics : {};
  return {
    ...base,
    ...profile,
    profile,
  };
}

function hasFlag(args, name) {
  return args.includes(name) || Boolean(getFlagValue(args, [name]));
}

function upsertFlag(args, name, value, aliases = []) {
  const names = new Set([name, ...aliases]);
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    const token = String(args[i] || "");
    let remove = false;
    if (names.has(token)) {
      remove = true;
      i += 1;
    } else {
      for (const n of names) {
        if (token.startsWith(`${n}=`)) {
          remove = true;
          break;
        }
      }
    }
    if (!remove) {
      out.push(token);
    }
  }
  out.push(name, String(value));
  return out;
}

function collectJobParams(body, rawArgs) {
  const startPort = toPositiveInt(
    body.start_port ?? body.startPort ?? getFlagValue(rawArgs, ["--start-port"]),
    0
  );
  const proxyCount = toPositiveInt(
    body.proxy_count ?? body.proxyCount ?? body.quantity ?? getFlagValue(rawArgs, ["--proxy-count"]),
    0
  );
  const ipv6Policy = String(
    body.ipv6_policy ?? body.ipv6Policy ?? getFlagValue(rawArgs, ["--ipv6-policy"]) ?? ""
  ).trim();
  const networkProfile = String(
    body.network_profile ?? body.networkProfile ?? getFlagValue(rawArgs, ["--network-profile"]) ?? ""
  ).trim();
  const requestedFingerprintProfileVersion = String(
    getBodyValue(body, "fingerprint_profile_version", "fingerprintProfileVersion") || ""
  ).trim();
  const requestedSelectionSource = String(
    getBodyValue(body, "profile_selection_source", "profileSelectionSource") || ""
  ).trim();
  const requestedSelectionFallback = toBool(
    getBodyValue(body, "profile_selection_fallback", "profileSelectionFallback"),
    false
  );
  const profileSelectionSource = requestedSelectionSource
    || (requestedFingerprintProfileVersion ? "explicit_payload" : "");
  const profileSelectionFallback = requestedSelectionFallback || profileSelectionSource === "fallback_default";
  const profileSelectionReason = String(
    getBodyValue(body, "profile_selection_reason", "profileSelectionReason") || ""
  ).trim()
    || (profileSelectionFallback ? "fallback_profile_selection_source_disallowed" : "");
  const intendedClientOsProfile = String(
    getBodyValue(body, "intended_client_os_profile", "intendedClientOsProfile")
    || getBodyValue(body, "client_os_profile", "clientOsProfile")
    || "android_mobile"
  ).trim();
  const intendedNetworkProfile = String(
    getBodyValue(body, "intended_network_profile", "intendedNetworkProfile") || networkProfile || "high_compatibility"
  ).trim();
  const clientOsProfileEnforcement = String(
    getBodyValue(body, "client_os_profile_enforcement", "clientOsProfileEnforcement") || "not_controlled_by_proxy"
  ).trim().toLowerCase() || "not_controlled_by_proxy";
  const clientOsProfileRequired = toBool(
    getBodyValue(body, "client_os_profile_required", "clientOsProfileRequired"),
    false
  );
  const intendedIpv6Policy = String(
    getBodyValue(body, "intended_ipv6_policy", "intendedIpv6Policy") || ipv6Policy || "ipv6_only"
  ).trim();
  const effectiveIpv6Policy = String(
    getBodyValue(body, "effective_ipv6_policy", "effectiveIpv6Policy") || ipv6Policy || intendedIpv6Policy
  ).trim();
  const effectiveNetworkProfile = String(
    getBodyValue(body, "effective_network_profile", "effectiveNetworkProfile") || networkProfile || "high_compatibility"
  ).trim();
  const actualClientProfile = PRODUCTION_EFFECTIVE_CLIENT_PROFILE;
  const effectiveClientOsProfile = PRODUCTION_EFFECTIVE_CLIENT_PROFILE;
  const ipv6RolloutStage = String(
    getBodyValue(body, "ipv6_rollout_stage", "ipv6RolloutStage") || "enforced"
  ).trim();
  const profile = buildProfileDiagnostics({
    requested_fingerprint_profile_version: requestedFingerprintProfileVersion,
    fingerprint_profile_version: requestedFingerprintProfileVersion || DEFAULT_FINGERPRINT_PROFILE_VERSION,
    intended_client_os_profile: intendedClientOsProfile,
    intended_network_profile: intendedNetworkProfile,
    client_os_profile_enforcement: clientOsProfileEnforcement,
    client_os_profile_required: clientOsProfileRequired,
    actual_client_profile: actualClientProfile,
    effective_client_os_profile: effectiveClientOsProfile,
    effective_network_profile: effectiveNetworkProfile,
    effective_ipv6_policy: effectiveIpv6Policy,
    profile_selection_source: profileSelectionSource,
    profile_selection_reason: profileSelectionReason,
    profile_selection_fallback: profileSelectionFallback,
    intended_ipv6_policy: intendedIpv6Policy,
    ipv6_rollout_stage: ipv6RolloutStage,
  });
  return {
    startPort,
    proxyCount,
    ipv6Policy: profile.effective_ipv6_policy || ipv6Policy,
    networkProfile: profile.effective_network_profile || networkProfile,
    profile,
  };
}

async function scriptSupportsFlag(scriptPath, flagToken) {
  const key = `${scriptPath}::${flagToken}`;
  if (SCRIPT_FLAG_CACHE.has(key)) {
    return SCRIPT_FLAG_CACHE.get(key);
  }
  try {
    const text = await fsp.readFile(scriptPath, "utf-8");
    const supported = text.includes(flagToken);
    SCRIPT_FLAG_CACHE.set(key, supported);
    return supported;
  } catch (_error) {
    SCRIPT_FLAG_CACHE.set(key, false);
    return false;
  }
}

function buildCfgPathForStartPort(startPort) {
  return path.join(PROXY_CFG_ROOT, `3proxy_${startPort}.cfg`);
}

function buildStartupScriptPath(startPort) {
  return path.join(PROXY_ROOT, `proxy-startup_${startPort}.sh`);
}

async function runCommand(command, args, options = {}) {
  const cwd = options.cwd || process.cwd();
  const timeoutSec = Math.max(1, Number(options.timeoutSec || 10));
  const env = options.env || process.env;
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let timer = null;

    const settle = (payload) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      resolve({
        ...payload,
        stdout,
        stderr,
      });
    };

    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      settle({
        ok: false,
        exitCode: null,
        signal: null,
        timedOut: false,
        error: `spawn_failed:${error.message || String(error)}`,
      });
      return;
    }

    child.stdout.on("data", (chunk) => {
      stdout = appendTail(stdout, chunk.toString("utf-8"), 500000);
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendTail(stderr, chunk.toString("utf-8"), 500000);
    });

    timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch (_error) {}
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch (_error) {}
      }, 1500);
    }, timeoutSec * 1000);

    child.on("error", (error) => {
      settle({
        ok: false,
        exitCode: null,
        signal: null,
        timedOut,
        error: `spawn_failed:${error.message || String(error)}`,
      });
    });

    child.on("close", (exitCode, signal) => {
      if (timedOut) {
        settle({
          ok: false,
          exitCode: exitCode ?? null,
          signal: signal ?? null,
          timedOut: true,
          error: "command_timeout",
        });
        return;
      }
      settle({
        ok: exitCode === 0,
        exitCode: exitCode ?? null,
        signal: signal ?? null,
        timedOut: false,
        error: exitCode === 0 ? null : `command_exit_${exitCode}`,
      });
    });
  });
}

async function collectRunningInstances() {
  const ps = await runCommand("ps", ["-eo", "pid,args"], { timeoutSec: 8 });
  if (!ps.ok) {
    return {
      ok: false,
      error: ps.error || "ps_failed",
      stderr: String(ps.stderr || "").slice(-RESPONSE_TAIL_LIMIT),
      instances: [],
    };
  }

  const lines = String(ps.stdout || "").split(/\r?\n/);
  const instances = [];
  const cfgRegex = /\/[^\s]*3proxy_(\d+)\.cfg/;

  for (const raw of lines) {
    const line = String(raw || "").trim();
    if (!line || line.startsWith("PID ")) {
      continue;
    }
    const splitAt = line.indexOf(" ");
    if (splitAt <= 0) {
      continue;
    }
    const pidText = line.slice(0, splitAt).trim();
    const cmd = line.slice(splitAt + 1).trim();
    const pid = Number(pidText);
    if (!Number.isInteger(pid) || pid <= 0) {
      continue;
    }
    if (!cmd.includes("3proxy")) {
      continue;
    }

    const cfgMatch = cmd.match(cfgRegex);
    const cfgPath = cfgMatch ? path.normalize(cfgMatch[0]) : "";
    let startPort = cfgMatch ? toPositiveInt(cfgMatch[1], 0) : 0;
    if (!startPort) {
      const portFlagMatch = cmd.match(/\s-p(\d+)\b/);
      if (portFlagMatch) {
        startPort = toPositiveInt(portFlagMatch[1], 0);
      }
    }

    instances.push({
      pid,
      cmd,
      cfgPath,
      startPort,
    });
  }

  return {
    ok: true,
    error: null,
    instances,
  };
}

function buildInstanceSummary(instances) {
  const byCfg = new Map();
  const byStartPort = new Map();

  for (const item of instances) {
    const cfgKey = item.cfgPath || "unknown_cfg";
    byCfg.set(cfgKey, (byCfg.get(cfgKey) || 0) + 1);

    const portKey = String(item.startPort || 0);
    byStartPort.set(portKey, (byStartPort.get(portKey) || 0) + 1);
  }

  const duplicateCfg = [];
  for (const [cfgPath, count] of byCfg.entries()) {
    if (count > 1) {
      duplicateCfg.push({ cfgPath, count });
    }
  }

  const duplicateStartPort = [];
  for (const [startPort, count] of byStartPort.entries()) {
    if (Number(startPort) > 0 && count > 1) {
      duplicateStartPort.push({ startPort: Number(startPort), count });
    }
  }

  return {
    count: instances.length,
    duplicateCfg,
    duplicateStartPort,
    duplicateStatePresent: duplicateCfg.length > 0 || duplicateStartPort.length > 0,
  };
}

async function listListeningTcpPorts() {
  const out = new Set();
  const ss = await runCommand("ss", ["-ltnH"], { timeoutSec: 8 });
  if (!ss.ok) {
    return { ok: false, error: ss.error || "ss_failed", ports: out };
  }

  const lines = String(ss.stdout || "").split(/\r?\n/);
  for (const raw of lines) {
    const line = String(raw || "").trim();
    if (!line) {
      continue;
    }
    const fields = line.split(/\s+/);
    const localAddr = fields.length >= 4 ? fields[3] : fields[fields.length - 1];
    if (!localAddr || !localAddr.includes(":")) {
      continue;
    }
    const portToken = localAddr.split(":").pop();
    const port = toPositiveInt(portToken, 0);
    if (port > 0 && port <= 65535) {
      out.add(port);
    }
  }
  return { ok: true, error: null, ports: out };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForInstanceState({ startPort, cfgPath, timeoutMs = DEFAULT_INSTANCE_WAIT_MS }) {
  const deadline = Date.now() + Math.max(2000, timeoutMs);
  while (Date.now() < deadline) {
    const instancesState = await collectRunningInstances();
    if (instancesState.ok) {
      const same = instancesState.instances.filter((item) => {
        if (startPort > 0 && item.startPort === startPort) {
          return true;
        }
        if (cfgPath && item.cfgPath === cfgPath) {
          return true;
        }
        return false;
      });
      if (same.length === 1) {
        return { ok: true, instances: same, allInstances: instancesState.instances };
      }
      if (same.length > 1) {
        return { ok: false, error: "duplicate_instance_state", instances: same };
      }
    }
    await sleep(1000);
  }
  return { ok: false, error: "instance_not_running", instances: [] };
}

function makeExpectedPorts(startPort, proxyCount) {
  const ports = [];
  for (let i = 0; i < proxyCount; i += 1) {
    ports.push(startPort + i);
  }
  return ports;
}

function socks5AuthCheck(item, timeoutMs = DEFAULT_AUTH_CHECK_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const host = String(item.host || "").trim();
    const port = toPositiveInt(item.port, 0);
    const login = String(item.login || "");
    const password = String(item.password || "");
    if (!host || !port || !login || !password) {
      resolve({ ok: false, error: "invalid_proxy_item" });
      return;
    }

    const loginBuffer = Buffer.from(login, "utf-8");
    const passBuffer = Buffer.from(password, "utf-8");
    if (loginBuffer.length <= 0 || loginBuffer.length > 255 || passBuffer.length <= 0 || passBuffer.length > 255) {
      resolve({ ok: false, error: "invalid_credentials_length" });
      return;
    }

    const socket = new net.Socket();
    let done = false;
    let stage = 0;
    let acc = Buffer.alloc(0);

    const finish = (payload) => {
      if (done) {
        return;
      }
      done = true;
      try {
        socket.destroy();
      } catch (_error) {}
      resolve(payload);
    };

    socket.setTimeout(timeoutMs, () => {
      finish({ ok: false, error: "socket_timeout" });
    });

    socket.once("error", (error) => {
      finish({ ok: false, error: `socket_error:${error.message || String(error)}` });
    });

    socket.connect(port, host, () => {
      socket.write(Buffer.from([0x05, 0x01, 0x02]));
    });

    socket.on("data", (chunk) => {
      acc = Buffer.concat([acc, chunk]);
      if (stage === 0 && acc.length >= 2) {
        const v = acc[0];
        const method = acc[1];
        acc = acc.slice(2);
        if (v !== 0x05 || method !== 0x02) {
          finish({ ok: false, error: "auth_method_not_accepted" });
          return;
        }
        stage = 1;
        const authPayload = Buffer.concat([
          Buffer.from([0x01, loginBuffer.length]),
          loginBuffer,
          Buffer.from([passBuffer.length]),
          passBuffer,
        ]);
        socket.write(authPayload);
      }

      if (stage === 1 && acc.length >= 2) {
        const v = acc[0];
        const status = acc[1];
        if (v !== 0x01 || status !== 0x00) {
          finish({ ok: false, error: "auth_failed" });
          return;
        }
        finish({ ok: true, error: null });
      }
    });
  });
}

async function runLocalAuthChecks(items, sampleCount) {
  const samples = (items || []).slice(0, Math.max(1, sampleCount));
  if (!samples.length) {
    return {
      ok: false,
      checked: 0,
      passed: 0,
      failed: 0,
      details: [],
      error: "no_auth_samples",
    };
  }

  const details = [];
  let passed = 0;
  let failed = 0;

  for (const item of samples) {
    const result = await socks5AuthCheck(item, DEFAULT_AUTH_CHECK_TIMEOUT_MS);
    if (result.ok) {
      passed += 1;
    } else {
      failed += 1;
    }
    details.push({
      host: item.host,
      port: item.port,
      login: item.login,
      ok: result.ok,
      error: result.error || null,
    });
  }

  return {
    ok: failed === 0,
    checked: samples.length,
    passed,
    failed,
    details,
    error: failed === 0 ? null : "auth_sample_failed",
  };
}

async function checkIpv6Egress(url, timeoutMs = 8000) {
  const target = String(url || "").trim() || DEFAULT_IPV6_EGRESS_URL;
  return new Promise((resolve) => {
    const req = https.get(
      target,
      {
        timeout: timeoutMs,
        family: 6,
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body = appendTail(body, chunk.toString("utf-8"), 1024);
        });
        res.on("end", () => {
          const ok = Number(res.statusCode || 0) >= 200 && Number(res.statusCode || 0) < 300 && body.trim().length > 0;
          resolve({
            ok,
            statusCode: Number(res.statusCode || 0),
            body: body.trim(),
            error: ok ? null : "ipv6_http_failed",
            target,
          });
        });
      }
    );

    req.on("timeout", () => {
      req.destroy(new Error("timeout"));
    });

    req.on("error", (error) => {
      resolve({
        ok: false,
        statusCode: 0,
        body: "",
        error: `ipv6_error:${error.message || String(error)}`,
        target,
      });
    });
  });
}

// DNS-leak probe. Mirrors checkIpv6Egress shape: never throws, always
// resolves to a flat object that the orchestrator can pass through to
// the bot's health panel verbatim.
//
//   { ok, unbound, resolver_local, resolves, error }
//
// "ok" is the AND of the three sub-probes — a node is DNS-clean iff
// the local unbound service is up, /etc/resolv.conf points at
// 127.0.0.1, and a sample A-query against 127.0.0.1 actually returns.
async function checkDns(timeoutMs = 5000) {
  const result = {
    ok: false,
    unbound: false,
    resolver_local: false,
    resolves: false,
    error: null,
  };
  const errors = [];

  // 1. unbound service active?
  try {
    const out = await runCommand(
      "systemctl",
      ["is-active", "unbound"],
      { timeoutSec: Math.max(1, Math.floor(timeoutMs / 1000)) },
    );
    if (out && out.ok && String(out.stdout || "").trim() === "active") {
      result.unbound = true;
    } else {
      errors.push("unbound_not_active");
    }
  } catch (error) {
    errors.push(`unbound_check_failed:${error.message || String(error)}`);
  }

  // 2. /etc/resolv.conf first nameserver == 127.0.0.1?
  try {
    const raw = await fsp.readFile("/etc/resolv.conf", "utf-8");
    let firstNs = null;
    for (const rawLine of String(raw).split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#") || line.startsWith(";")) continue;
      const match = /^nameserver\s+(\S+)/.exec(line);
      if (match) {
        firstNs = match[1];
        break;
      }
    }
    if (firstNs === "127.0.0.1") {
      result.resolver_local = true;
    } else if (firstNs === null) {
      errors.push("resolver_no_nameserver");
    } else {
      errors.push(`resolver_not_local:${firstNs}`);
    }
  } catch (error) {
    errors.push(`resolver_read_failed:${error.message || String(error)}`);
  }

  // 3. real A-query through the local resolver (Node built-in dns
  //    module — no `dig` dependency).
  try {
    const resolver = new dns.Resolver();
    resolver.setServers(["127.0.0.1"]);
    const queryPromise = new Promise((resolveQuery) => {
      try {
        resolver.resolve4("google.com", (err, addresses) => {
          if (err) {
            resolveQuery({ ok: false, error: `resolve_failed:${err.message || String(err)}` });
            return;
          }
          if (Array.isArray(addresses) && addresses.length > 0) {
            resolveQuery({ ok: true, error: null });
            return;
          }
          resolveQuery({ ok: false, error: "resolve_empty" });
        });
      } catch (syncErr) {
        resolveQuery({ ok: false, error: `resolve_throw:${syncErr.message || String(syncErr)}` });
      }
    });
    const timeoutPromise = new Promise((resolveTimeout) => {
      setTimeout(() => resolveTimeout({ ok: false, error: "resolve_timeout" }), timeoutMs).unref?.();
    });
    const race = await Promise.race([queryPromise, timeoutPromise]);
    if (race && race.ok) {
      result.resolves = true;
    } else if (race && race.error) {
      errors.push(race.error);
    }
    try {
      resolver.cancel();
    } catch (_cancelErr) {
      // best-effort cleanup
    }
  } catch (error) {
    errors.push(`resolve_init_failed:${error.message || String(error)}`);
  }

  result.ok = result.unbound && result.resolver_local && result.resolves;
  result.error = errors.length === 0 ? null : errors[0];
  return result;
}

function shellSingleQuote(value) {
  return `'${String(value || "").replace(/'/g, `'\"'\"'`)}'`;
}

async function cleanupCronStartup(startupScriptPath) {
  if (!CLEANUP_CRON_AFTER_RUN) {
    return { ok: true, skipped: true };
  }
  const safePath = shellSingleQuote(startupScriptPath);
  const script = [
    "if command -v crontab >/dev/null 2>&1; then",
    "  tmp=$(mktemp)",
    "  crontab -l 2>/dev/null | grep -Fv " + safePath + " > \"$tmp\" || true",
    "  crontab \"$tmp\" 2>/dev/null || true",
    "  rm -f \"$tmp\"",
    "fi",
  ].join("\n");

  const out = await runCommand("bash", ["-lc", script], { timeoutSec: 8 });
  return {
    ok: out.ok,
    skipped: false,
    error: out.ok ? null : out.error,
    stderrTail: String(out.stderr || "").slice(-RESPONSE_TAIL_LIMIT),
  };
}

async function buildGeneratorArgs({ rawArgs, scriptPath, startPort, proxyCount, ipv6Policy, networkProfile, proxiesListPath, mapCsvPath }) {
  let args = Array.isArray(rawArgs) ? rawArgs.map((v) => String(v)) : [];

  args = upsertFlag(args, "--start-port", String(startPort));
  args = upsertFlag(args, "--proxy-count", String(proxyCount));

  if (networkProfile) {
    args = upsertFlag(args, "--network-profile", networkProfile);
  }
  if (ipv6Policy) {
    args = upsertFlag(args, "--ipv6-policy", ipv6Policy);
  }

  if (await scriptSupportsFlag(scriptPath, "--backconnect-proxies-file")) {
    args = upsertFlag(args, "--backconnect-proxies-file", proxiesListPath, ["--backconnect_proxies_file", "-f"]);
  }
  if (await scriptSupportsFlag(scriptPath, "--port-ipv6-map-file")) {
    args = upsertFlag(args, "--port-ipv6-map-file", mapCsvPath);
  }
  if (await scriptSupportsFlag(scriptPath, "--runtime-only")) {
    if (!hasFlag(args, "--runtime-only")) {
      args.push("--runtime-only");
    }
  }
  if (await scriptSupportsFlag(scriptPath, "--proxies-type")) {
    args = upsertFlag(args, "--proxies-type", "socks5", ["-t"]);
  }
  if (await scriptSupportsFlag(scriptPath, "--random")) {
    args = upsertFlag(args, "--random", "true");
  }
  if (await scriptSupportsFlag(scriptPath, "--skip-self-check")) {
    args = upsertFlag(args, "--skip-self-check", "true");
  }

  return args;
}

async function loadJobMeta(jobId) {
  const safeJobId = normalizeJobId(jobId);
  const jobDir = path.resolve(JOBS_ROOT, safeJobId);
  ensurePathInside(JOBS_ROOT, jobDir);
  const metadataPath = path.join(jobDir, "job.json");
  const meta = await readJsonIfExists(metadataPath);
  return {
    safeJobId,
    jobDir,
    metadataPath,
    meta,
  };
}

async function listAllJobMeta() {
  await fsp.mkdir(JOBS_ROOT, { recursive: true });
  const entries = await fsp.readdir(JOBS_ROOT, { withFileTypes: true });
  const jobs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const jobId = entry.name;
    const metadataPath = path.join(JOBS_ROOT, jobId, "job.json");
    const meta = await readJsonIfExists(metadataPath);
    if (!meta) {
      continue;
    }
    jobs.push(meta);
  }

  jobs.sort((a, b) => {
    const av = Date.parse(String(a.updatedAt || a.finishedAt || a.startedAt || a.createdAt || 0));
    const bv = Date.parse(String(b.updatedAt || b.finishedAt || b.startedAt || b.createdAt || 0));
    return bv - av;
  });
  return jobs;
}

async function findLatestReadyJobForStartPort(startPort) {
  const jobs = await listAllJobMeta();
  for (const meta of jobs) {
    const status = normalizeStatus(meta.status);
    const sp = toPositiveInt(meta.params?.startPort, 0);
    if (status !== "ready" || sp !== startPort) {
      continue;
    }
    const proxiesListPath = String(meta.output?.proxiesListPath || "").trim();
    if (!proxiesListPath || !(await fileExists(proxiesListPath))) {
      continue;
    }
    try {
      const parsed = await parseProxiesList(proxiesListPath);
      if (parsed.items.length > 0) {
        return { meta, items: parsed.items };
      }
    } catch (_error) {}
  }
  return null;
}

async function buildReconcileReport(staleJobSec = DEFAULT_STALE_JOB_SEC) {
  const jobs = await listAllJobMeta();
  const instancesState = await collectRunningInstances();
  const instances = instancesState.instances || [];
  const summary = buildInstanceSummary(instances);

  const duplicates = {
    cfg: summary.duplicateCfg,
    startPort: summary.duplicateStartPort,
  };

  const nowMs = Date.now();
  const staleJobs = [];
  const readyJobs = [];
  const runningJobs = [];

  for (const job of jobs) {
    const status = normalizeStatus(job.status);
    if (status === "ready") {
      readyJobs.push(job);
    }
    if (status === "running") {
      runningJobs.push(job);
      const updatedAt = Date.parse(String(job.updatedAt || job.startedAt || job.createdAt || ""));
      if (updatedAt > 0 && nowMs - updatedAt > staleJobSec * 1000) {
        staleJobs.push({
          jobId: String(job.jobId || ""),
          status,
          updatedAt: job.updatedAt || null,
          ageSec: Math.floor((nowMs - updatedAt) / 1000),
        });
      }
    }
  }

  const activeStartPorts = new Set(instances.map((x) => Number(x.startPort || 0)).filter((x) => x > 0));
  const cfgWithoutRunningProcess = [];
  const outputMismatches = [];

  for (const job of readyJobs) {
    const startPort = toPositiveInt(job.params?.startPort, 0);
    const jobId = String(job.jobId || "");
    const cfgPath = String(job.output?.cfgPath || "").trim();
    if (startPort > 0 && !activeStartPorts.has(startPort)) {
      cfgWithoutRunningProcess.push({ jobId, startPort, cfgPath });
    }

    const proxiesListPath = String(job.output?.proxiesListPath || "").trim();
    if (!proxiesListPath || !(await fileExists(proxiesListPath))) {
      outputMismatches.push({
        jobId,
        startPort,
        reason: "ready_job_missing_proxies_list",
        proxiesListPath,
      });
      continue;
    }
    try {
      const parsed = await parseProxiesList(proxiesListPath);
      if (!parsed.items.length) {
        outputMismatches.push({
          jobId,
          startPort,
          reason: "ready_job_empty_or_invalid_proxies_list",
          proxiesListPath,
        });
      }
    } catch (_error) {
      outputMismatches.push({
        jobId,
        startPort,
        reason: "ready_job_unreadable_proxies_list",
        proxiesListPath,
      });
    }
  }

  const jobStartPorts = new Set(
    [...readyJobs, ...runningJobs]
      .map((job) => toPositiveInt(job.params?.startPort, 0))
      .filter((x) => x > 0)
  );

  const runningWithoutMatchingJob = [];
  for (const item of instances) {
    const startPort = toPositiveInt(item.startPort, 0);
    if (startPort > 0 && !jobStartPorts.has(startPort)) {
      runningWithoutMatchingJob.push({
        pid: item.pid,
        startPort,
        cfgPath: item.cfgPath,
        cmd: item.cmd,
      });
    }
  }

  const recommendations = [];
  if (duplicates.cfg.length || duplicates.startPort.length) {
    recommendations.push("Resolve duplicate 3proxy processes per cfg/start_port before next generation.");
  }
  if (staleJobs.length) {
    recommendations.push("Mark stale running jobs as failed and requeue with fresh start_port.");
  }
  if (cfgWithoutRunningProcess.length) {
    recommendations.push("Reconcile ready jobs whose cfg/start_port are no longer running.");
  }
  if (runningWithoutMatchingJob.length) {
    recommendations.push("Investigate unmanaged running 3proxy processes without matching job metadata.");
  }
  if (outputMismatches.length) {
    recommendations.push("Rebuild or invalidate jobs where output files are missing/invalid.");
  }

  return {
    generatedAt: nowIso(),
    instances: {
      total: summary.count,
      duplicateStatePresent: summary.duplicateStatePresent,
    },
    duplicates,
    staleJobs,
    cfgWithoutRunningProcess,
    runningWithoutMatchingJob,
    outputMismatches,
    recommendations,
  };
}

async function acquireGenerationLock(lockPath, payload) {
  await fsp.mkdir(path.dirname(lockPath), { recursive: true });
  const ownerToken = makeRunId();
  const record = {
    ...payload,
    ownerToken,
    pid: process.pid,
    acquiredAt: nowIso(),
  };
  const lockBody = `${JSON.stringify(record, null, 2)}\n`;

  const tryAcquire = async () => {
    try {
      const handle = await fsp.open(lockPath, "wx");
      try {
        await handle.writeFile(lockBody, "utf-8");
      } finally {
        await handle.close();
      }
      return true;
    } catch (error) {
      if (error && error.code === "EEXIST") {
        return false;
      }
      throw error;
    }
  };

  if (await tryAcquire()) {
    return { ok: true, lockRecord: record };
  }

  let existingLock = await readJsonIfExists(lockPath);
  if (existingLock && !isProcessAlive(Number(existingLock.pid || 0))) {
    await safeUnlink(lockPath);
    if (await tryAcquire()) {
      return { ok: true, lockRecord: record, staleLockRecovered: true };
    }
    existingLock = await readJsonIfExists(lockPath);
  }
  return { ok: false, existingLock: existingLock || null };
}

async function releaseGenerationLock(lockPath, ownerToken) {
  const existingLock = await readJsonIfExists(lockPath);
  if (!existingLock) {
    return;
  }
  if (String(existingLock.ownerToken || "") !== String(ownerToken || "")) {
    return;
  }
  if (Number(existingLock.pid || 0) !== process.pid) {
    return;
  }
  await safeUnlink(lockPath);
}

function markJobStatus(jobMeta, status, patch = {}) {
  const at = nowIso();
  jobMeta.status = status;
  if (!Array.isArray(jobMeta.statusHistory)) {
    jobMeta.statusHistory = [];
  }
  jobMeta.statusHistory.push({ status, at });
  if (status === "running" && !jobMeta.startedAt) {
    jobMeta.startedAt = at;
  }
  if (status === "success" || status === "ready" || status === "failed" || status === "partial") {
    jobMeta.finishedAt = at;
  }
  jobMeta.result = { ...(jobMeta.result || {}), ...patch };
}

async function writeJobMetadata(metadataPath, jobMeta) {
  jobMeta.updatedAt = nowIso();
  await writeJsonFile(metadataPath, jobMeta);
}

async function runGenerator({
  scriptPath,
  args,
  cwd,
  timeoutSec,
  env,
  stdoutLogPath,
  stderrLogPath,
}) {
  return new Promise((resolve) => {
    const stdoutLog = fs.createWriteStream(stdoutLogPath, { flags: "a" });
    const stderrLog = fs.createWriteStream(stderrLogPath, { flags: "a" });
    let stdoutTail = "";
    let stderrTail = "";
    let timeoutHandle = null;
    let forceKillHandle = null;
    const startedAt = Date.now();
    let settled = false;

    const settle = (payload) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      if (forceKillHandle) {
        clearTimeout(forceKillHandle);
      }
      stdoutLog.end();
      stderrLog.end();
      resolve({
        ...payload,
        durationMs: Date.now() - startedAt,
        stdoutTail,
        stderrTail,
      });
    };

    let child;
    try {
      child = spawn("bash", [scriptPath, ...args], {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      settle({
        ok: false,
        error: `spawn_failed:${error.message || String(error)}`,
        exitCode: null,
        signal: null,
        timedOut: false,
      });
      return;
    }

    stdoutLog.on("error", () => {});
    stderrLog.on("error", () => {});

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString("utf-8");
      stdoutTail = appendTail(stdoutTail, text);
      stdoutLog.write(text);
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf-8");
      stderrTail = appendTail(stderrTail, text);
      stderrLog.write(text);
    });

    let timedOut = false;
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch (_error) {}
      forceKillHandle = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch (_error) {}
      }, 5000);
    }, Math.max(10, Number(timeoutSec) || DEFAULT_TIMEOUT_SEC) * 1000);

    child.on("error", (error) => {
      settle({
        ok: false,
        error: `spawn_failed:${error.message || String(error)}`,
        exitCode: null,
        signal: null,
        timedOut,
      });
    });

    child.on("close", (exitCode, signal) => {
      if (timedOut) {
        settle({
          ok: false,
          error: "generator_timeout",
          exitCode: exitCode ?? null,
          signal: signal ?? null,
          timedOut: true,
        });
        return;
      }
      settle({
        ok: exitCode === 0,
        error: exitCode === 0 ? null : `generator_exit_${exitCode}`,
        exitCode: exitCode ?? null,
        signal: signal ?? null,
        timedOut: false,
      });
    });
  });
}

async function validateGenerationOutput({
  startPort,
  proxyCount,
  cfgPath,
  proxiesListPath,
  mapCsvPath,
  runResult,
  runStartedAtMs,
}) {
  const checks = {
    proxies_file_exists: false,
    proxies_file_non_empty: false,
    proxies_lines_present: false,
    proxies_lines_parseable: false,
    no_explicit_partial_state: false,
    cfg_exists: false,
    instance_running: false,
    no_duplicate_instance: false,
    expected_ports_listening: false,
    auth_sample_ok: false,
    ipv6_egress_ok: false,
  };

  const details = {
    startPort,
    proxyCount,
    cfgPath: String(cfgPath || "").trim(),
    cfgPathExpected: String(cfgPath || "").trim(),
    cfgPathEffective: String(cfgPath || "").trim(),
    proxiesListPath,
    mapCsvPath,
    mapRows: 0,
    listLineCount: 0,
    invalidLineCount: 0,
  };

  if (!(await fileExists(proxiesListPath))) {
    return { ok: false, error: "proxies_list_not_found", checks, details };
  }
  checks.proxies_file_exists = true;

  const listStat = await fsp.stat(proxiesListPath);
  if (!listStat.size) {
    return { ok: false, error: "proxies_list_empty_file", checks, details };
  }
  checks.proxies_file_non_empty = true;

  if (listStat.mtimeMs + 1000 < runStartedAtMs) {
    return {
      ok: false,
      error: "proxies_list_stale_before_run",
      checks,
      details: { ...details, mtimeMs: listStat.mtimeMs, runStartedAtMs },
    };
  }

  const parsedList = await parseProxiesList(proxiesListPath);
  details.listLineCount = parsedList.dataLineCount;
  details.invalidLineCount = parsedList.invalidLineCount;
  if (parsedList.dataLineCount <= 0) {
    return { ok: false, error: "proxies_list_no_lines", checks, details };
  }
  checks.proxies_lines_present = true;

  if (parsedList.invalidLineCount > 0 || parsedList.items.length <= 0) {
    return { ok: false, error: "proxies_list_invalid_lines", checks, details };
  }
  checks.proxies_lines_parseable = true;

  if (
    containsExplicitPartialState(parsedList.content) ||
    containsExplicitPartialState(runResult.stdoutTail) ||
    containsExplicitPartialState(runResult.stderrTail)
  ) {
    return { ok: false, error: "explicit_partial_state_detected", checks, details };
  }
  checks.no_explicit_partial_state = true;

  let mapExists = false;
  let mapRows = [];
  if (await fileExists(mapCsvPath)) {
    mapExists = true;
    const mapContent = await fsp.readFile(mapCsvPath, "utf-8");
    if (containsExplicitPartialState(mapContent)) {
      return { ok: false, error: "explicit_partial_state_detected", checks, details };
    }
    mapRows = parseCsv(mapContent);
    details.mapRows = mapRows.length;
  }

  let effectiveCfgPath = String(cfgPath || "").trim();
  if (!(await fileExists(effectiveCfgPath))) {
    const cfgProbe = await collectRunningInstances();
    if (cfgProbe.ok) {
      const matchesByStartPort = cfgProbe.instances.filter(
        (item) => item.startPort === startPort && String(item.cfgPath || "").trim().length > 0
      );
      if (matchesByStartPort.length === 1) {
        effectiveCfgPath = path.normalize(matchesByStartPort[0].cfgPath);
      } else if (matchesByStartPort.length > 1) {
        return {
          ok: false,
          error: "duplicate_instance_state",
          checks,
          details: {
            ...details,
            instanceMatches: matchesByStartPort.length,
          },
        };
      }
    }
  }
  if (!effectiveCfgPath || !isPathInside(PROXY_CFG_ROOT, effectiveCfgPath)) {
    return { ok: false, error: "cfg_path_outside_proxy_root", checks, details };
  }
  details.cfgPathEffective = effectiveCfgPath;
  details.cfgPath = effectiveCfgPath;
  if (!(await fileExists(effectiveCfgPath))) {
    return { ok: false, error: "cfg_not_found", checks, details };
  }
  checks.cfg_exists = true;

  const instanceState = await waitForInstanceState({
    startPort,
    cfgPath: effectiveCfgPath,
    timeoutMs: DEFAULT_INSTANCE_WAIT_MS,
  });
  if (!instanceState.ok) {
    return {
      ok: false,
      error: instanceState.error || "instance_not_running",
      checks,
      details: {
        ...details,
        instanceMatches: Array.isArray(instanceState.instances) ? instanceState.instances.length : 0,
      },
    };
  }
  checks.instance_running = true;
  checks.no_duplicate_instance = true;

  const listening = await listListeningTcpPorts();
  if (!listening.ok) {
    return {
      ok: false,
      error: "listening_probe_failed",
      checks,
      details: { ...details, listeningProbeError: listening.error },
    };
  }
  const expectedPorts = makeExpectedPorts(startPort, proxyCount);
  const missingPorts = expectedPorts.filter((p) => !listening.ports.has(p));
  if (missingPorts.length > 0) {
    return {
      ok: false,
      error: "ports_not_listening",
      checks,
      details: {
        ...details,
        expectedPortCount: expectedPorts.length,
        missingPorts: missingPorts.slice(0, 100),
      },
    };
  }
  checks.expected_ports_listening = true;

  const authCheck = await runLocalAuthChecks(parsedList.items, DEFAULT_AUTH_CHECK_SAMPLES);
  if (!authCheck.ok) {
    return {
      ok: false,
      error: authCheck.error || "auth_sample_failed",
      checks,
      details: { ...details, authCheck },
    };
  }
  checks.auth_sample_ok = true;

  const ipv6Check = await checkIpv6Egress(DEFAULT_IPV6_EGRESS_URL, 8000);
  if (!ipv6Check.ok) {
    return {
      ok: false,
      error: ipv6Check.error || "ipv6_egress_failed",
      checks,
      details: { ...details, ipv6Check },
    };
  }
  checks.ipv6_egress_ok = true;

  return {
    ok: true,
    effectiveCfgPath,
    mapExists,
    mapRows,
    items: parsedList.items,
    checks,
    details: {
      ...details,
      expectedPortCount: proxyCount,
      authCheck,
      ipv6Check,
    },
  };
}

async function handleGenerate(req, res) {
  if (!ensureAuthorized(req)) {
    sendJson(res, 401, { success: false, status: "failed", error: "unauthorized" });
    return;
  }

  let body;
  try {
    body = await parseJsonBody(req);
  } catch (error) {
    sendJson(res, 400, {
      success: false,
      status: "failed",
      error: String(error.message || "invalid_request"),
    });
    return;
  }

  const rawJobId = String(body.jobId ?? "").trim();
  if (!rawJobId) {
    sendJson(res, 400, {
      success: false,
      status: "failed",
      error: "job_id_required",
    });
    return;
  }
  const jobId = normalizeJobId(rawJobId);
  const generatorScript = String(body.generatorScript || "").trim();
  if (!generatorScript) {
    sendJson(res, 400, {
      success: false,
      status: "failed",
      error: "generatorScript is required",
    });
    return;
  }

  const rawGeneratorArgs = Array.isArray(body.generatorArgs)
    ? body.generatorArgs.map((v) => String(v))
    : [];
  const providedIpv6PolicyFields = [
    ["ipv6Policy", body.ipv6Policy],
    ["ipv6_policy", body.ipv6_policy],
    ["generatorArgs.--ipv6-policy", getFlagValue(rawGeneratorArgs, ["--ipv6-policy"])],
  ];
  for (const [source, value] of providedIpv6PolicyFields) {
    const policy = String(value ?? "").trim();
    if (policy && normalizeContractValue(policy) !== PRODUCTION_REQUIRED_IPV6_POLICY) {
      sendJson(res, 400, {
        success: false,
        status: "failed",
        error: "ipv6_only_required",
        source,
        expected: PRODUCTION_REQUIRED_IPV6_POLICY,
        actual: policy,
      });
      return;
    }
  }
  body.ipv6Policy = PRODUCTION_REQUIRED_IPV6_POLICY;
  body.ipv6_policy = PRODUCTION_REQUIRED_IPV6_POLICY;

  const timeoutSec = Math.max(10, Number(body.timeoutSec || DEFAULT_TIMEOUT_SEC) || DEFAULT_TIMEOUT_SEC);
  const cwd = resolveInputPath(process.cwd(), body.cwd || process.cwd());
  const scriptPath = resolveInputPath(cwd, generatorScript);
  if (!(await fileExists(scriptPath))) {
    sendJson(res, 400, {
      success: false,
      status: "failed",
      error: "generator_script_not_found",
      scriptPath,
    });
    return;
  }

  const params = collectJobParams(body, rawGeneratorArgs);
  const profileDiagnostics = buildProfileDiagnostics(params.profile || {});
  if (!params.startPort) {
    sendJson(res, 400, {
      success: false,
      status: "failed",
      error: "start_port_required_no_fallback",
    });
    return;
  }
  if (!params.proxyCount) {
    sendJson(res, 400, {
      success: false,
      status: "failed",
      error: "proxy_count_required_no_fallback",
    });
    return;
  }
  const contractCheck = evaluateProductProfileContract(params, profileDiagnostics);
  if (!contractCheck.ok) {
    console.error(
      "[node-agent] product_profile_contract_mismatch job_id=%s details=%s",
      jobId,
      JSON.stringify(contractCheck)
    );
    sendJson(res, 400, {
      success: false,
      status: "failed",
      error: "product_profile_contract_mismatch",
      details: contractCheck,
      profile: profileDiagnostics,
    });
    return;
  }
  console.log(
    "[node-agent] generation request job_id=%s start_port=%s proxy_count=%s fingerprint_profile_version=%s "
    + "intended_client_os_profile=%s actual_client_profile=%s effective_client_os_profile=%s "
    + "effective_network_profile=%s effective_ipv6_policy=%s profile_selection_source=%s",
    jobId,
    params.startPort,
    params.proxyCount,
    profileDiagnostics.fingerprint_profile_version,
    profileDiagnostics.intended_client_os_profile,
    profileDiagnostics.actual_client_profile,
    profileDiagnostics.effective_client_os_profile,
    profileDiagnostics.effective_network_profile,
    profileDiagnostics.effective_ipv6_policy,
    profileDiagnostics.profile_selection_source
  );

  const cfgPath = buildCfgPathForStartPort(params.startPort);
  const startupScriptPath = buildStartupScriptPath(params.startPort);

  await fsp.mkdir(JOBS_ROOT, { recursive: true });
  const lockPath = path.join(JOBS_ROOT, LOCK_FILENAME);
  const lockAttempt = await acquireGenerationLock(lockPath, {
    jobId,
    startPort: params.startPort,
    requestedAt: nowIso(),
  });
  if (!lockAttempt.ok) {
    sendJson(res, 200, {
      success: false,
      status: "busy",
      error: "node_busy",
      jobId,
      generatedCount: 0,
      runningJobId: lockAttempt.existingLock ? String(lockAttempt.existingLock.jobId || "") : null,
      profile: profileDiagnostics,
      diagnostics: {
        ...withProfileDiagnostics(
          {
            errorReason: "node_busy",
          },
          profileDiagnostics
        ),
      },
      lock: lockAttempt.existingLock
        ? {
            pid: lockAttempt.existingLock.pid || null,
            acquiredAt: lockAttempt.existingLock.acquiredAt || null,
            startPort: lockAttempt.existingLock.startPort || null,
          }
        : null,
    });
    return;
  }

  const runId = makeRunId();
  const jobDir = path.resolve(JOBS_ROOT, jobId);
  ensurePathInside(JOBS_ROOT, jobDir);
  const proxiesListPath = path.join(jobDir, "proxies.list");
  const mapCsvPath = path.join(jobDir, "map.csv");
  const stdoutLogPath = path.join(jobDir, "stdout.log");
  const stderrLogPath = path.join(jobDir, "stderr.log");
  const metadataPath = path.join(jobDir, "job.json");
  const outputPaths = {
    jobDir,
    proxiesListPath,
    mapCsvPath,
    cfgPath,
    startupScriptPath,
    stdoutLogPath,
    stderrLogPath,
  };

  let jobMeta = null;

  try {
    await fsp.mkdir(jobDir, { recursive: true });

    await safeUnlink(proxiesListPath);
    await safeUnlink(mapCsvPath);
    await safeUnlink(stdoutLogPath);
    await safeUnlink(stderrLogPath);

    jobMeta = {
      jobId,
      runId,
      status: "queued",
      statusHistory: [{ status: "queued", at: nowIso() }],
      createdAt: nowIso(),
      startedAt: null,
      finishedAt: null,
      params: {
        startPort: params.startPort,
        proxyCount: params.proxyCount,
        ipv6Policy: params.ipv6Policy || null,
        networkProfile: params.networkProfile || null,
        fingerprintProfileVersion: profileDiagnostics.fingerprint_profile_version || null,
        intendedClientOsProfile: profileDiagnostics.intended_client_os_profile || null,
        intendedNetworkProfile: profileDiagnostics.intended_network_profile || null,
        clientOsProfileEnforcement: profileDiagnostics.client_os_profile_enforcement || null,
        clientOsProfileRequired: Boolean(profileDiagnostics.client_os_profile_required),
        actualClientProfile: profileDiagnostics.actual_client_profile || null,
        effectiveClientOsProfile: profileDiagnostics.effective_client_os_profile || null,
        effectiveNetworkProfile: profileDiagnostics.effective_network_profile || null,
        effectiveIpv6Policy: profileDiagnostics.effective_ipv6_policy || null,
        profileSelectionSource: profileDiagnostics.profile_selection_source || null,
        profileSelectionReason: profileDiagnostics.profile_selection_reason || null,
        profileSelectionFallback: Boolean(profileDiagnostics.profile_selection_fallback),
        intendedIpv6Policy: profileDiagnostics.intended_ipv6_policy || null,
        ipv6RolloutStage: profileDiagnostics.ipv6_rollout_stage || null,
      },
      generator: {
        scriptPath,
        rawArgs: rawGeneratorArgs,
        effectiveArgs: [],
        cwd,
        timeoutSec,
      },
      output: {
        jobsRoot: JOBS_ROOT,
        ...outputPaths,
      },
      request: {
        rawJobId: body.jobId ?? null,
        providedOutputDir: body.outputDir ?? null,
        providedProxiesListPath: body.proxiesListPath ?? null,
        providedMapCsvPath: body.mapCsvPath ?? null,
        fingerprintProfileVersion: profileDiagnostics.fingerprint_profile_version || null,
        profileSelectionSource: profileDiagnostics.profile_selection_source || null,
      },
      lock: {
        file: lockPath,
        ownerToken: lockAttempt.lockRecord.ownerToken,
        pid: process.pid,
      },
      result: {},
    };
    await writeJobMetadata(metadataPath, jobMeta);

    const instanceStateBefore = await collectRunningInstances();
    if (instanceStateBefore.ok) {
      const matches = instanceStateBefore.instances.filter((x) => x.startPort === params.startPort || x.cfgPath === cfgPath);
      if (matches.length > 1) {
        markJobStatus(jobMeta, "failed", {
          error: "duplicate_state_detected_before_start",
          duplicates: matches,
        });
        await writeJobMetadata(metadataPath, jobMeta);
        sendJson(res, 200, {
          success: false,
          status: "failed",
          jobId,
          runId,
          error: "duplicate_state_detected_before_start",
          generatedCount: 0,
          output: outputPaths,
          details: { duplicates: matches },
          profile: profileDiagnostics,
          diagnostics: {
            ...withProfileDiagnostics(
              {
                errorReason: "duplicate_state_detected_before_start",
                checks: {},
              },
              profileDiagnostics
            ),
          },
          jobDir,
          statusHistory: jobMeta.statusHistory,
        });
        return;
      }
      if (matches.length === 1) {
        const reused = await findLatestReadyJobForStartPort(params.startPort);
        if (reused && Array.isArray(reused.items) && reused.items.length > 0) {
          markJobStatus(jobMeta, "ready", {
            reusedExistingInstance: true,
            reusedFromJobId: reused.meta.jobId || null,
            itemsCount: reused.items.length,
          });
          await writeJobMetadata(metadataPath, jobMeta);
          sendJson(res, 200, {
            success: true,
            status: "ready",
            jobId,
            runId,
            reusedExistingInstance: true,
            reusedFromJobId: reused.meta.jobId || null,
            generatedCount: reused.items.length,
            jobDir,
            proxiesListPath: reused.meta.output?.proxiesListPath || null,
            mapCsvPath: reused.meta.output?.mapCsvPath || null,
            output: {
              ...outputPaths,
              proxiesListPath: reused.meta.output?.proxiesListPath || null,
              mapCsvPath: reused.meta.output?.mapCsvPath || null,
            },
            items: reused.items,
            profile: profileDiagnostics,
            diagnostics: {
              ...withProfileDiagnostics(
                {
                  errorReason: null,
                  checks: {},
                },
                profileDiagnostics
              ),
            },
            statusHistory: jobMeta.statusHistory,
          });
          return;
        }

        markJobStatus(jobMeta, "failed", {
          error: "instance_already_running_without_reusable_job_output",
          runningInstance: matches[0],
        });
        await writeJobMetadata(metadataPath, jobMeta);
        sendJson(res, 200, {
          success: false,
          status: "failed",
          jobId,
          runId,
          error: "instance_already_running_without_reusable_job_output",
          generatedCount: 0,
          output: outputPaths,
          details: { runningInstance: matches[0] },
          profile: profileDiagnostics,
          diagnostics: {
            ...withProfileDiagnostics(
              {
                errorReason: "instance_already_running_without_reusable_job_output",
                checks: {},
              },
              profileDiagnostics
            ),
          },
          jobDir,
          statusHistory: jobMeta.statusHistory,
        });
        return;
      }
    }

    const effectiveArgs = await buildGeneratorArgs({
      rawArgs: rawGeneratorArgs,
      scriptPath,
      startPort: params.startPort,
      proxyCount: params.proxyCount,
      ipv6Policy: params.ipv6Policy,
      networkProfile: params.networkProfile,
      proxiesListPath,
      mapCsvPath,
    });
    jobMeta.generator.effectiveArgs = effectiveArgs;
    await writeJobMetadata(metadataPath, jobMeta);

    markJobStatus(jobMeta, "running");
    await writeJobMetadata(metadataPath, jobMeta);

    const runStartedAtMs = Date.now();
    const generatorEnv = {
      ...process.env,
      JOB_ID: jobId,
      JOB_DIR: jobDir,
      OUTPUT_DIR: jobDir,
      START_PORT: String(params.startPort),
      PROXY_COUNT: String(params.proxyCount),
      IPV6_POLICY: params.ipv6Policy || "",
      NETWORK_PROFILE: params.networkProfile || "",
      CLIENT_OS_PROFILE: profileDiagnostics.effective_client_os_profile || "",
      FINGERPRINT_PROFILE_VERSION: profileDiagnostics.fingerprint_profile_version || "",
      FINGERPRINT_PROFILE_NAME: profileDiagnostics.fingerprint_profile_version || "",
      PROFILE_SELECTION_SOURCE: profileDiagnostics.profile_selection_source || "",
      PROFILE_SELECTION_REASON: profileDiagnostics.profile_selection_reason || "",
      PROFILE_SELECTION_FALLBACK: profileDiagnostics.profile_selection_fallback ? "1" : "0",
      INTENDED_IPV6_POLICY: profileDiagnostics.intended_ipv6_policy || "",
      IPV6_ROLLOUT_STAGE: profileDiagnostics.ipv6_rollout_stage || "",
      PROXIES_LIST_PATH: proxiesListPath,
      MAP_CSV_PATH: mapCsvPath,
      NODE_AGENT_JOB_ID: jobId,
      NODE_AGENT_JOB_DIR: jobDir,
      NODE_AGENT_OUTPUT_DIR: jobDir,
      NODE_AGENT_START_PORT: String(params.startPort),
      NODE_AGENT_PROXY_COUNT: String(params.proxyCount),
      NODE_AGENT_IPV6_POLICY: params.ipv6Policy || "",
      NODE_AGENT_NETWORK_PROFILE: params.networkProfile || "",
      NODE_AGENT_CLIENT_OS_PROFILE: profileDiagnostics.effective_client_os_profile || "",
      NODE_AGENT_FINGERPRINT_PROFILE_VERSION: profileDiagnostics.fingerprint_profile_version || "",
      NODE_AGENT_PROFILE_SELECTION_SOURCE: profileDiagnostics.profile_selection_source || "",
      NODE_AGENT_PROFILE_SELECTION_REASON: profileDiagnostics.profile_selection_reason || "",
      NODE_AGENT_PROFILE_SELECTION_FALLBACK: profileDiagnostics.profile_selection_fallback ? "1" : "0",
      NODE_AGENT_INTENDED_IPV6_POLICY: profileDiagnostics.intended_ipv6_policy || "",
      NODE_AGENT_IPV6_ROLLOUT_STAGE: profileDiagnostics.ipv6_rollout_stage || "",
      NODE_AGENT_PROXIES_LIST_PATH: proxiesListPath,
      NODE_AGENT_MAP_CSV_PATH: mapCsvPath,
    };

    const runResult = await runGenerator({
      scriptPath,
      args: effectiveArgs,
      cwd,
      timeoutSec,
      env: generatorEnv,
      stdoutLogPath,
      stderrLogPath,
    });

    const cronCleanup = await cleanupCronStartup(startupScriptPath);

    jobMeta.result.run = {
      ok: runResult.ok,
      error: runResult.error,
      exitCode: runResult.exitCode,
      signal: runResult.signal,
      timedOut: runResult.timedOut,
      durationMs: runResult.durationMs,
      stdoutTail: runResult.stdoutTail,
      stderrTail: runResult.stderrTail,
    };
    jobMeta.result.cronCleanup = cronCleanup;
    await writeJobMetadata(metadataPath, jobMeta);

    if (!runResult.ok) {
      markJobStatus(jobMeta, "failed", {
        error: runResult.error || "generator_failed",
      });
      await writeJobMetadata(metadataPath, jobMeta);
      sendJson(res, 200, {
        success: false,
        status: "failed",
        jobId,
        runId,
        error: runResult.error || "generator_failed",
        exitCode: runResult.exitCode,
        generatedCount: 0,
        output: outputPaths,
        stderrTail: String(runResult.stderrTail || "").slice(-RESPONSE_TAIL_LIMIT),
        stdoutTail: String(runResult.stdoutTail || "").slice(-RESPONSE_TAIL_LIMIT),
        profile: profileDiagnostics,
        diagnostics: {
          ...withProfileDiagnostics(
            {
              errorReason: runResult.error || "generator_failed",
              stdoutTail: String(runResult.stdoutTail || "").slice(-RESPONSE_TAIL_LIMIT),
              stderrTail: String(runResult.stderrTail || "").slice(-RESPONSE_TAIL_LIMIT),
              checks: {},
            },
            profileDiagnostics
          ),
        },
        jobDir,
        statusHistory: jobMeta.statusHistory,
        logs: { stdout: stdoutLogPath, stderr: stderrLogPath },
      });
      return;
    }

    const validation = await validateGenerationOutput({
      startPort: params.startPort,
      proxyCount: params.proxyCount,
      cfgPath,
      proxiesListPath,
      mapCsvPath,
      runResult,
      runStartedAtMs,
    });
    if (validation.effectiveCfgPath) {
      outputPaths.cfgPath = validation.effectiveCfgPath;
      if (jobMeta && jobMeta.output) {
        jobMeta.output.cfgPath = validation.effectiveCfgPath;
      }
    }
    jobMeta.result.validation = {
      ok: validation.ok,
      error: validation.error || null,
      checks: validation.checks || {},
      details: validation.details || {},
    };
    await writeJobMetadata(metadataPath, jobMeta);
    if (!validation.ok) {
      markJobStatus(jobMeta, "failed", {
        error: validation.error || "validation_failed",
        validation: validation.details || {},
      });
      await writeJobMetadata(metadataPath, jobMeta);
      sendJson(res, 200, {
        success: false,
        status: "failed",
        jobId,
        runId,
        error: validation.error || "validation_failed",
        generatedCount: Array.isArray(validation.items) ? validation.items.length : 0,
        details: validation.details || {},
        checks: validation.checks || {},
        jobDir,
        proxiesListPath,
        mapCsvPath: (await fileExists(mapCsvPath)) ? mapCsvPath : null,
        output: {
          ...outputPaths,
          mapCsvPath: (await fileExists(mapCsvPath)) ? mapCsvPath : null,
        },
        profile: profileDiagnostics,
        diagnostics: {
          ...withProfileDiagnostics(
            {
              errorReason: validation.error || "validation_failed",
              checks: validation.checks || {},
              details: validation.details || {},
              stdoutTail: String(runResult.stdoutTail || "").slice(-RESPONSE_TAIL_LIMIT),
              stderrTail: String(runResult.stderrTail || "").slice(-RESPONSE_TAIL_LIMIT),
            },
            profileDiagnostics
          ),
        },
        statusHistory: jobMeta.statusHistory,
        logs: { stdout: stdoutLogPath, stderr: stderrLogPath },
      });
      return;
    }

    const generatedCount = Array.isArray(validation.items) ? validation.items.length : 0;
    if (generatedCount < params.proxyCount) {
      markJobStatus(jobMeta, "partial", {
        error: "generated_count_mismatch",
        expectedCount: params.proxyCount,
        itemsCount: generatedCount,
        mapRows: validation.mapRows.length,
        checks: validation.checks,
        validation: validation.details,
      });
      await writeJobMetadata(metadataPath, jobMeta);
      sendJson(res, 200, {
        success: false,
        status: "partial",
        jobId,
        runId,
        error: "generated_count_mismatch",
        generatedCount,
        expectedCount: params.proxyCount,
        exitCode: runResult.exitCode,
        params: jobMeta.params,
        jobDir,
        proxiesListPath,
        mapCsvPath: validation.mapExists ? mapCsvPath : null,
        mapRows: validation.mapRows.length,
        items: validation.items,
        checks: validation.checks,
        validation: validation.details,
        output: {
          ...outputPaths,
          mapCsvPath: validation.mapExists ? mapCsvPath : null,
        },
        profile: profileDiagnostics,
        diagnostics: {
          ...withProfileDiagnostics(
            {
              errorReason: "generated_count_mismatch",
              checks: validation.checks,
              details: validation.details,
              stdoutTail: String(runResult.stdoutTail || "").slice(-RESPONSE_TAIL_LIMIT),
              stderrTail: String(runResult.stderrTail || "").slice(-RESPONSE_TAIL_LIMIT),
            },
            profileDiagnostics
          ),
        },
        statusHistory: jobMeta.statusHistory,
        logs: { stdout: stdoutLogPath, stderr: stderrLogPath },
      });
      return;
    }

    markJobStatus(jobMeta, "ready", {
      exitCode: runResult.exitCode,
      itemsCount: generatedCount,
      mapRows: validation.mapRows.length,
      checks: validation.checks,
      validation: validation.details,
    });
    await writeJobMetadata(metadataPath, jobMeta);

    sendJson(res, 200, {
      success: true,
      status: "ready",
      jobId,
      runId,
      exitCode: runResult.exitCode,
      generatedCount,
      expectedCount: params.proxyCount,
      params: jobMeta.params,
      jobDir,
      proxiesListPath,
      mapCsvPath: validation.mapExists ? mapCsvPath : null,
      mapRows: validation.mapRows.length,
      items: validation.items,
      checks: validation.checks,
      validation: validation.details,
      output: {
        ...outputPaths,
        mapCsvPath: validation.mapExists ? mapCsvPath : null,
      },
      profile: profileDiagnostics,
      diagnostics: {
        ...withProfileDiagnostics(
          {
            errorReason: null,
            checks: validation.checks,
            details: validation.details,
            stdoutTail: String(runResult.stdoutTail || "").slice(-RESPONSE_TAIL_LIMIT),
            stderrTail: String(runResult.stderrTail || "").slice(-RESPONSE_TAIL_LIMIT),
          },
          profileDiagnostics
        ),
      },
      statusHistory: jobMeta.statusHistory,
      logs: { stdout: stdoutLogPath, stderr: stderrLogPath },
    });
  } catch (error) {
    if (jobMeta) {
      markJobStatus(jobMeta, "failed", {
        error: `internal_error:${error.message || String(error)}`,
      });
      try {
        await writeJobMetadata(metadataPath, jobMeta);
      } catch (_writeError) {}
    }
    sendJson(res, 500, {
      success: false,
      status: "failed",
      jobId,
      runId,
      error: `internal_error:${error.message || String(error)}`,
      generatedCount: 0,
      profile: profileDiagnostics,
      diagnostics: {
        ...withProfileDiagnostics(
          {
            errorReason: `internal_error:${error.message || String(error)}`,
          },
          profileDiagnostics
        ),
      },
    });
  } finally {
    await releaseGenerationLock(lockPath, lockAttempt.lockRecord.ownerToken);
  }
}

async function buildJobStatusResponse(jobId) {
  const loaded = await loadJobMeta(jobId);
  if (!loaded.meta) {
    return null;
  }
  const meta = loaded.meta;
  const stdoutPath = String(meta.output?.stdoutLogPath || path.join(loaded.jobDir, "stdout.log"));
  const stderrPath = String(meta.output?.stderrLogPath || path.join(loaded.jobDir, "stderr.log"));
  const stdoutTail = await readTail(stdoutPath);
  const stderrTail = await readTail(stderrPath);
  const generatedCount = toPositiveInt(meta.result?.itemsCount, 0);
  const expectedCount = toPositiveInt(meta.params?.proxyCount, 0);
  const profileDiagnostics = buildProfileDiagnostics({
    fingerprint_profile_version: meta.params?.fingerprintProfileVersion || meta.params?.fingerprint_profile_version,
    intended_client_os_profile: meta.params?.intendedClientOsProfile || meta.params?.intended_client_os_profile,
    intended_network_profile: meta.params?.intendedNetworkProfile || meta.params?.intended_network_profile,
    client_os_profile_enforcement: meta.params?.clientOsProfileEnforcement || meta.params?.client_os_profile_enforcement,
    client_os_profile_required: meta.params?.clientOsProfileRequired || meta.params?.client_os_profile_required,
    actual_client_profile: meta.params?.actualClientProfile || meta.params?.actual_client_profile,
    effective_client_os_profile: meta.params?.effectiveClientOsProfile || meta.params?.effective_client_os_profile,
    effective_network_profile: meta.params?.effectiveNetworkProfile || meta.params?.effective_network_profile || meta.params?.networkProfile,
    effective_ipv6_policy: meta.params?.effectiveIpv6Policy || meta.params?.effective_ipv6_policy || meta.params?.ipv6Policy,
    profile_selection_source: meta.params?.profileSelectionSource || meta.params?.profile_selection_source,
    profile_selection_reason: meta.params?.profileSelectionReason || meta.params?.profile_selection_reason,
    profile_selection_fallback: meta.params?.profileSelectionFallback || meta.params?.profile_selection_fallback,
    intended_ipv6_policy: meta.params?.intendedIpv6Policy || meta.params?.intended_ipv6_policy,
    ipv6_rollout_stage: meta.params?.ipv6RolloutStage || meta.params?.ipv6_rollout_stage,
  });
  return {
    success: normalizeStatus(meta.status) === "ready",
    jobId: String(meta.jobId || loaded.safeJobId),
    status: normalizeStatus(meta.status),
    generatedCount,
    expectedCount,
    paths: {
      jobDir: loaded.jobDir,
      metadataPath: loaded.metadataPath,
      proxiesListPath: meta.output?.proxiesListPath || null,
      mapCsvPath: meta.output?.mapCsvPath || null,
      cfgPath: meta.output?.cfgPath || null,
      stdoutLogPath: stdoutPath,
      stderrLogPath: stderrPath,
    },
    output: {
      jobDir: loaded.jobDir,
      proxiesListPath: meta.output?.proxiesListPath || null,
      mapCsvPath: meta.output?.mapCsvPath || null,
      cfgPath: meta.output?.cfgPath || null,
      stdoutLogPath: stdoutPath,
      stderrLogPath: stderrPath,
    },
    profile: profileDiagnostics,
    validation: meta.result?.validation || null,
    diagnostics: {
      ...withProfileDiagnostics(
        {
          errorReason: meta.result?.error || meta.result?.validation?.error || null,
          checks: meta.result?.validation?.checks || {},
          stdoutTail,
          stderrTail,
        },
        profileDiagnostics
      ),
    },
    statusHistory: meta.statusHistory || [],
    stdoutTail,
    stderrTail,
    meta,
  };
}

async function handleJobStatus(req, res, url) {
  if (!ensureAuthorized(req)) {
    sendJson(res, 401, { success: false, status: "failed", error: "unauthorized" });
    return;
  }
  const parts = url.pathname.split("/").filter(Boolean);
  const jobId = parts.length >= 2 ? parts[1] : "";
  if (!jobId) {
    sendJson(res, 400, { success: false, status: "failed", error: "job_id_required" });
    return;
  }

  const payload = await buildJobStatusResponse(jobId);
  if (!payload) {
    sendJson(res, 404, { success: false, status: "failed", error: "job_not_found", jobId });
    return;
  }
  sendJson(res, 200, payload);
}

async function handleJobsList(req, res) {
  if (!ensureAuthorized(req)) {
    sendJson(res, 401, { success: false, status: "failed", error: "unauthorized" });
    return;
  }
  const jobs = await listAllJobMeta();
  const out = jobs.slice(0, 200).map((job) => ({
    jobId: String(job.jobId || ""),
    status: normalizeStatus(job.status),
    createdAt: job.createdAt || null,
    startedAt: job.startedAt || null,
    finishedAt: job.finishedAt || null,
    updatedAt: job.updatedAt || null,
    startPort: toPositiveInt(job.params?.startPort, 0) || null,
    proxyCount: toPositiveInt(job.params?.proxyCount, 0) || null,
    fingerprintProfileVersion: job.params?.fingerprintProfileVersion || job.params?.fingerprint_profile_version || null,
    effectiveNetworkProfile: job.params?.effectiveNetworkProfile || job.params?.networkProfile || null,
    effectiveIpv6Policy: job.params?.effectiveIpv6Policy || job.params?.ipv6Policy || null,
    cfgPath: job.output?.cfgPath || null,
    proxiesListPath: job.output?.proxiesListPath || null,
  }));

  sendJson(res, 200, {
    success: true,
    status: "ready",
    count: out.length,
    items: out,
  });
}

async function handleInstances(req, res) {
  if (!ensureAuthorized(req)) {
    sendJson(res, 401, { success: false, status: "failed", error: "unauthorized" });
    return;
  }
  const state = await collectRunningInstances();
  if (!state.ok) {
    sendJson(res, 500, {
      success: false,
      status: "failed",
      error: state.error || "instance_probe_failed",
      stderrTail: state.stderr || "",
    });
    return;
  }
  const summary = buildInstanceSummary(state.instances);
  sendJson(res, 200, {
    success: true,
    status: "ready",
    total: summary.count,
    duplicateStatePresent: summary.duplicateStatePresent,
    duplicates: {
      cfg: summary.duplicateCfg,
      startPort: summary.duplicateStartPort,
    },
    items: state.instances,
  });
}

async function handleReconcile(req, res) {
  if (!ensureAuthorized(req)) {
    sendJson(res, 401, { success: false, status: "failed", error: "unauthorized" });
    return;
  }
  const report = await buildReconcileReport(DEFAULT_STALE_JOB_SEC);
  sendJson(res, 200, {
    success: true,
    status: "ready",
    report,
  });
}

async function handleHealth(req, res) {
  await fsp.mkdir(JOBS_ROOT, { recursive: true });
  const lockPath = path.join(JOBS_ROOT, LOCK_FILENAME);
  const lock = await readJsonIfExists(lockPath);
  const instancesState = await collectRunningInstances();
  const instances = instancesState.instances || [];
  const summary = buildInstanceSummary(instances);
  const ipv6Check = await checkIpv6Egress(DEFAULT_IPV6_EGRESS_URL, 5000);
  const success = Boolean(instancesState.ok);
  const status = success ? "ready" : "failed";
  const ipv6 = {
    ok: ipv6Check.ok,
    target: ipv6Check.target,
    error: ipv6Check.error,
    statusCode: ipv6Check.statusCode,
    body: ipv6Check.body,
  };
  const instancesPayload = {
    ok: Boolean(instancesState.ok),
    error: instancesState.error || null,
    count: summary.count,
    duplicateStatePresent: summary.duplicateStatePresent,
    duplicateCfg: summary.duplicateCfg,
    duplicateStartPort: summary.duplicateStartPort,
  };

  sendJson(res, 200, {
    success,
    status,
    ok: success,
    service: "proxy-node-agent",
    agentAlive: true,
    timestamp: nowIso(),
    jobsRoot: JOBS_ROOT,
    busy: Boolean(lock),
    activeInstances: summary.count,
    duplicateStatePresent: summary.duplicateStatePresent,
    instances: instancesPayload,
    ipv6,
    ipv6Egress: ipv6,
  });
}

async function handleDescribe(req, res) {
  let healthSnapshot = null;
  try {
    const ipv6Check = await checkIpv6Egress(DEFAULT_IPV6_EGRESS_URL, 5000);
    const ipv6 = {
      ok: ipv6Check.ok,
      target: ipv6Check.target,
      error: ipv6Check.error,
      statusCode: ipv6Check.statusCode,
      body: ipv6Check.body,
    };
    healthSnapshot = { ipv6, ipv6Egress: ipv6 };
  } catch (_err) {
    healthSnapshot = null;
  }
  const payload = await buildDescribe({
    healthSnapshot,
    jobsRoot: JOBS_ROOT,
    proxyRoot: PROXY_ROOT,
  });
  sendJson(res, 200, payload);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
  const pathname = url.pathname;

  if (req.method === "GET" && pathname === "/health") {
    await handleHealth(req, res);
    return;
  }

  if (req.method === "GET" && pathname === "/describe") {
    await handleDescribe(req, res);
    return;
  }

  if (req.method === "POST" && pathname === "/generate") {
    await handleGenerate(req, res);
    return;
  }

  if (req.method === "GET" && pathname === "/jobs") {
    await handleJobsList(req, res);
    return;
  }

  if (req.method === "GET" && /^\/jobs\/[^/]+$/.test(pathname)) {
    await handleJobStatus(req, res, url);
    return;
  }

  if (req.method === "GET" && pathname === "/instances") {
    await handleInstances(req, res);
    return;
  }

  if ((req.method === "GET" || req.method === "POST") && pathname === "/reconcile") {
    await handleReconcile(req, res);
    return;
  }

  if (req.method === "GET" && pathname === "/accounting") {
    if (!ensureAuthorized(req)) {
      return sendJson(res, 401, { success: false, error: "unauthorized" });
    }
    const portsParam = url.searchParams.get("ports") || "";
    const ports = portsParam
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => Number(s))
      .filter((n) => Number.isInteger(n) && n > 0);
    if (ports.length === 0) {
      return sendJson(res, 400, {
        success: false,
        error: "missing_ports",
        detail: "comma-separated ports required",
      });
    }
    try {
      const counters = await accounting.getCountersForPorts(ports);
      return sendJson(res, 200, { success: true, counters });
    } catch (err) {
      return sendJson(res, 500, {
        success: false,
        error: "nftables_error",
        detail: String((err && err.message) || err),
      });
    }
  }

  const accountsActionMatch = /^\/accounts\/(\d+)\/(disable|enable)$/.exec(pathname);
  if (req.method === "POST" && accountsActionMatch) {
    if (!ensureAuthorized(req)) {
      return sendJson(res, 401, { success: false, error: "unauthorized" });
    }
    const port = Number(accountsActionMatch[1]);
    const action = accountsActionMatch[2];
    try {
      const result = action === "disable"
        ? await accounting.disablePort(port)
        : await accounting.enablePort(port);
      return sendJson(res, 200, { success: true, port, ...result });
    } catch (err) {
      if (err && err.code === "PORT_NOT_FOUND") {
        return sendJson(res, 404, { success: false, error: "port_not_found", port });
      }
      return sendJson(res, 500, {
        success: false,
        error: action === "disable" ? "disable_failed" : "enable_failed",
        detail: String((err && err.message) || err),
      });
    }
  }

  sendJson(res, 404, { success: false, status: "failed", error: "not_found" });
});

server.listen(PORT, () => {
  console.log(
    `[node-agent] listening on :${PORT}, jobs_root=${JOBS_ROOT}, proxy_root=${PROXY_ROOT}, cron_cleanup=${CLEANUP_CRON_AFTER_RUN}`
  );
});
