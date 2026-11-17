#!/usr/bin/env node
// Foreground, Host-only Broker entrypoint. No daemon/systemd registration.
//   host-broker login --credential-path=<abs> [--new-account] [--id-token-hint]
//   host-broker serve --credential-path=<abs> --gateway-base=<url> --port=<n>
//                     --sandbox-label=<label> --capability-fd=<n>=3>
//                     --tls-cert=<abs> --tls-key=<abs> <quotas...>
// CF_AIG_TOKEN is read from the environment only. Binds 127.0.0.1 only.
import fs from "node:fs";
import path from "node:path";
import { createSecureContext } from "node:tls";
import { pathToFileURL } from "node:url";
import { createSIWCSource, SIWCError } from "../src/broker/siwc.mjs";
import { createCapabilityStore } from "../src/broker/capabilities.mjs";
import { parseBrokerRequest, BROKER_MODEL } from "../src/broker/policy.mjs";
import { createCloudflareUpstream } from "../src/broker/upstream.mjs";
import { createBrokerServer } from "../src/broker/server.mjs";

export const BIND_HOST = "127.0.0.1";
const GATEWAY_BASE = /^https:\/\/gateway\.ai\.cloudflare\.com\/v1\/[0-9a-f]{32}\/[A-Za-z0-9._-]+$/;
// eslint-disable-next-line no-control-regex
const UNSAFE_VALUE = /[\u0000-\u001f\u007f\s]/;
const LABEL = /^[A-Za-z0-9._-]{1,64}$/;
const MAX_TLS_FILE_BYTES = 1024 * 1024;

const QUOTAS = [
  ["ttlMs", "ttl-ms", "OC_CF_AIG_QUOTA_TTL_MS"],
  ["maxCalls", "max-calls", "OC_CF_AIG_QUOTA_MAX_CALLS"],
  ["maxCallsPerWindow", "max-calls-per-window", "OC_CF_AIG_QUOTA_MAX_CALLS_PER_WINDOW"],
  ["windowMs", "window-ms", "OC_CF_AIG_QUOTA_WINDOW_MS"],
  ["maxConcurrent", "max-concurrent", "OC_CF_AIG_QUOTA_MAX_CONCURRENT"],
  ["maxRequestBytes", "max-request-bytes", "OC_CF_AIG_QUOTA_MAX_REQUEST_BYTES"],
  ["maxResponseBytes", "max-response-bytes", "OC_CF_AIG_QUOTA_MAX_RESPONSE_BYTES"],
  ["maxTotalBytes", "max-total-bytes", "OC_CF_AIG_QUOTA_MAX_TOTAL_BYTES"],
  ["maxRequestDurationMs", "max-request-duration-ms", "OC_CF_AIG_QUOTA_MAX_REQUEST_DURATION_MS"],
];
const COMMON_VALUE_FLAGS = { "credential-path": "OC_CF_AIG_CREDENTIAL_PATH" };
const SERVE_VALUE_FLAGS = {
  "gateway-base": "OC_CF_AIG_GATEWAY_BASE",
  port: "OC_CF_AIG_BROKER_PORT",
  "sandbox-label": "OC_CF_AIG_SANDBOX_LABEL",
  "capability-fd": "OC_CF_AIG_CAPABILITY_FD",
  "tls-cert": "OC_CF_AIG_TLS_CERT",
  "tls-key": "OC_CF_AIG_TLS_KEY",
  ...Object.fromEntries(QUOTAS.map(([, flag, env]) => [flag, env])),
};
const LOGIN_BOOL_FLAGS = new Set(["new-account", "id-token-hint"]);

/** Config errors name the offending settings only, never their values. */
export class ConfigError extends Error {
  constructor(problems) {
    super(`invalid host-broker configuration: ${problems.join("; ")}`);
    this.name = "ConfigError";
    this.problems = problems;
  }
}

function parseFlags(args, valueFlags, boolFlags, problems) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const m = /^--([a-z0-9-]+)(?:=(.*))?$/s.exec(a);
    if (!m) {
      problems.push("unexpected positional argument");
      continue;
    }
    const [, name, inline] = m;
    if (boolFlags.has(name)) {
      if (inline !== undefined) problems.push(`--${name} takes no value`);
      out[name] = true;
    } else if (Object.hasOwn(valueFlags, name)) {
      const v = inline ?? args[++i];
      if (v === undefined) problems.push(`--${name} requires a value`);
      else out[name] = v;
    } else if (name === "gateway-token" || name === "cf-aig-token") {
      problems.push("gateway token must come from CF_AIG_TOKEN environment, not arguments");
      if (inline === undefined) i++;
    } else {
      problems.push(`unknown option --${name}`);
    }
  }
  return out;
}

function positiveInt(raw, name, problems, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (raw === undefined || raw === "") {
    problems.push(`missing ${name}`);
    return undefined;
  }
  if (!/^[0-9]+$/.test(raw)) {
    problems.push(`${name} must be a positive integer`);
    return undefined;
  }
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    problems.push(`${name} out of range`);
    return undefined;
  }
  return n;
}

/**
 * Validate Host-only runtime config from argv (without node/script) and env.
 * Fail closed: any missing or unsafe setting throws ConfigError.
 */
export function parseConfig({ argv = [], env = {} } = {}) {
  const problems = [];
  const [mode, ...rest] = argv;
  if (mode !== "login" && mode !== "serve") throw new ConfigError(["mode must be 'login' or 'serve'"]);
  if (typeof env.OPENAI_API_KEY === "string" && env.OPENAI_API_KEY !== "") {
    problems.push("OPENAI_API_KEY must not be set (no BYOK/API-key fallback)");
  }
  const valueFlags = mode === "serve" ? { ...COMMON_VALUE_FLAGS, ...SERVE_VALUE_FLAGS } : COMMON_VALUE_FLAGS;
  const flags = parseFlags(rest, valueFlags, mode === "login" ? LOGIN_BOOL_FLAGS : new Set(), problems);
  const pick = (flag) => flags[flag] ?? env[valueFlags[flag]];

  const credentialPath = pick("credential-path");
  if (!credentialPath) problems.push("missing credential path (--credential-path / OC_CF_AIG_CREDENTIAL_PATH)");
  else if (!path.isAbsolute(credentialPath) || path.normalize(credentialPath) !== credentialPath) problems.push("credential path must be a normalized absolute path");

  if (mode === "login") {
    if (problems.length) throw new ConfigError(problems);
    return { mode, credentialPath, newAccount: Boolean(flags["new-account"]), includeIdTokenHint: Boolean(flags["id-token-hint"]) };
  }

  const gatewayBase = pick("gateway-base");
  if (!gatewayBase) problems.push("missing gateway base (--gateway-base / OC_CF_AIG_GATEWAY_BASE)");
  else if (!GATEWAY_BASE.test(gatewayBase) || /\/\.{1,2}$/.test(gatewayBase)) problems.push("gateway base must be a Cloudflare AI Gateway base URL");

  const gatewayToken = env.CF_AIG_TOKEN;
  if (!gatewayToken) problems.push("missing CF_AIG_TOKEN environment variable");
  else if (UNSAFE_VALUE.test(gatewayToken)) problems.push("CF_AIG_TOKEN contains unsafe characters");

  const port = positiveInt(pick("port"), "port (--port / OC_CF_AIG_BROKER_PORT)", problems, { min: 1, max: 65535 });
  const capabilityFd = positiveInt(pick("capability-fd"), "capability fd (--capability-fd / OC_CF_AIG_CAPABILITY_FD)", problems, { min: 3, max: 1023 });

  const sandboxLabel = pick("sandbox-label");
  if (!sandboxLabel) problems.push("missing sandbox label (--sandbox-label / OC_CF_AIG_SANDBOX_LABEL)");
  else if (!LABEL.test(sandboxLabel)) problems.push("sandbox label has invalid characters");

  const tlsCertPath = pick("tls-cert");
  if (!tlsCertPath) problems.push("missing TLS certificate (--tls-cert / OC_CF_AIG_TLS_CERT)");
  else if (!path.isAbsolute(tlsCertPath) || path.normalize(tlsCertPath) !== tlsCertPath) problems.push("TLS certificate path must be a normalized absolute path");
  const tlsKeyPath = pick("tls-key");
  if (!tlsKeyPath) problems.push("missing TLS private key (--tls-key / OC_CF_AIG_TLS_KEY)");
  else if (!path.isAbsolute(tlsKeyPath) || path.normalize(tlsKeyPath) !== tlsKeyPath) problems.push("TLS private-key path must be a normalized absolute path");

  const quotas = {};
  for (const [key, flag, envName] of QUOTAS) quotas[key] = positiveInt(pick(flag), `quota --${flag} / ${envName}`, problems);

  if (problems.length) throw new ConfigError(problems);
  return { mode, host: BIND_HOST, credentialPath, gatewayBase, gatewayToken, port, capabilityFd, sandboxLabel, tlsCertPath, tlsKeyPath, quotas };
}

function readTlsFile(filePath, { privateKey = false } = {}) {
  let fd;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_CLOEXEC);
    const info = fs.fstatSync(fd);
    if (!info.isFile() || info.size <= 0 || info.size > MAX_TLS_FILE_BYTES) {
      throw new ConfigError([privateKey ? "TLS private key must be a bounded regular file" : "TLS certificate must be a bounded regular file"]);
    }
    if (privateKey && (info.mode & 0o077) !== 0) {
      throw new ConfigError(["TLS private key must not be accessible to group or other users"]);
    }
    return fs.readFileSync(fd);
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError([privateKey ? "TLS private key is missing or unsafe" : "TLS certificate is missing or unsafe"]);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function loadTlsMaterial(config) {
  if (config.tlsCertPath === config.tlsKeyPath) throw new ConfigError(["TLS certificate and private key must be separate files"]);
  const cert = readTlsFile(config.tlsCertPath);
  const key = readTlsFile(config.tlsKeyPath, { privateKey: true });
  try {
    createSecureContext({ cert, key });
  } catch {
    throw new ConfigError(["TLS certificate and private key are invalid or do not match"]);
  }
  return { cert, key };
}

/**
 * Start the Broker in the foreground. Verifies the SIWC account first so a
 * missing/expired login refuses to serve. Returns {server, capability, stop}.
 * The capability token is returned to the caller only; never logged.
 */
export async function startServe(config, { fetch: fetchImpl = globalThis.fetch } = {}) {
  const tls = loadTlsMaterial(config);
  const credentialSource = createSIWCSource({ credentialPath: config.credentialPath, client: { fetch: fetchImpl } });
  await credentialSource.getAccessToken();
  const upstream = createCloudflareUpstream({ gatewayBase: config.gatewayBase, gatewayToken: config.gatewayToken, credentialSource, fetchImpl });
  const capabilities = createCapabilityStore();
  const capability = capabilities.issue({ sandboxID: config.sandboxLabel, model: BROKER_MODEL, ...config.quotas });
  const server = createBrokerServer({ capabilities, parseRequest: parseBrokerRequest, upstream, limits: { maxBodyBytes: config.quotas.maxRequestBytes }, tls });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, BIND_HOST, resolve);
  });
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    capabilities.revoke(capability.id);
    await new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  };
  return { server, capability, stop };
}

export async function runLogin(config, { stderr = process.stderr, createSource = createSIWCSource } = {}) {
  // Refuse before any callback listener exists.
  if (config.includeIdTokenHint && !stderr.isTTY) {
    throw new SIWCError("refused", "id_token_hint URL is sensitive; refusing to write it to a non-terminal");
  }
  const source = createSource({ credentialPath: config.credentialPath });
  const { url, complete } = await source.beginLogin({ newAccount: config.newAccount, includeIdTokenHint: config.includeIdTokenHint });
  stderr.write(`Open this URL in a browser that can reach the loopback callback (SSH -L forward if remote):\n${url}\n`);
  await complete();
  stderr.write("SIWC login complete.\n");
}

/**
 * Serve and hand the capability to the launcher over an inherited FIFO/socket
 * FD only (regular files would persist the bearer). On handoff failure the
 * broker is stopped and the call rejects.
 */
export async function runServe(config, { stderr = process.stderr, signals = true, startServe: start = startServe, fetch: fetchImpl } = {}) {
  let st;
  try {
    st = fs.fstatSync(config.capabilityFd);
  } catch {
    throw new ConfigError(["capability fd is not open"]);
  }
  if (!st.isFIFO() && !st.isSocket()) throw new ConfigError(["capability fd must be a pipe or socket"]);
  const broker = await start(config, fetchImpl ? { fetch: fetchImpl } : undefined);
  try {
    fs.writeSync(config.capabilityFd, `${broker.capability.token}\n`);
  } catch {
    await broker.stop();
    try {
      fs.closeSync(config.capabilityFd);
    } catch {
      /* already closed */
    }
    throw new SIWCError("capability_handoff_failed", "capability handoff failed; broker stopped");
  }
  fs.closeSync(config.capabilityFd);
  stderr.write(`host-broker listening on ${BIND_HOST}:${broker.server.address().port} (foreground; Ctrl-C to stop)\n`);
  if (signals) {
    const shutdown = () => {
      broker.stop().then(() => process.exit(0), () => process.exit(1));
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  }
  return broker;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  let config;
  try {
    config = parseConfig({ argv, env });
  } catch (e) {
    process.stderr.write(`${e instanceof ConfigError ? e.message : "invalid configuration"}\n`);
    process.exitCode = 2;
    return;
  }
  try {
    if (config.mode === "login") await runLogin(config);
    else await runServe(config);
  } catch (e) {
    const code = e?.code ? ` (${e.code})` : "";
    const msg = e instanceof SIWCError || e instanceof ConfigError ? e.message : "host-broker failed";
    process.stderr.write(`${msg}${code}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  await main();
}
