#!/usr/bin/env node
// Guest-only launcher (runs inside the disposable Sandbox).
//   guest-launch --mode=m1|m2 --broker-url=https://host.docker.internal:<port>/v1
//                [--capability-fd=<n>=3>] [--fixture-root=<abs dir>] [--opencode=<abs path>]
//                [-- <opencode args...>]
// The Broker capability is read once from stdin (default) or an inherited
// pipe/socket FD -- never from argv, a file, or the environment -- and placed
// only into the child OpenCode process environment. It is never logged.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { execFile, spawn as nodeSpawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { ENV, parseAcceptanceMode, validateBrokerURL, validateCapability } from "../src/guest/provider.mjs";

export const OPENCODE_VERSION = "2.2.5";
const MAX_CAPABILITY_BYTES = 256;
const VALUE_FLAGS = new Set(["mode", "broker-url", "capability-fd", "fixture-root", "opencode"]);
// Host-only secrets/opt-ins that must never be present in a Guest launcher environment.
const HOST_ONLY_ENV = ["CF_AIG_TOKEN", "CF_AIG_BASE", "OPENAI_API_KEY", "OC_CF_AIG_HOST_ONLY", ENV.capability];
const SECRET_LIKE = /(ocb_[A-Za-z0-9_-]{16,}|\bsk-[A-Za-z0-9_-]{8,})/;

/** Launcher errors describe the problem, never the offending value. */
export class LaunchError extends Error {
  constructor(message) {
    super(message);
    this.name = "LaunchError";
  }
}

export function parseLaunchArgs(argv) {
  const sep = argv.indexOf("--");
  const own = sep === -1 ? argv : argv.slice(0, sep);
  const opencodeArgs = sep === -1 ? [] : argv.slice(sep + 1);
  if (argv.some((a) => SECRET_LIKE.test(a))) throw new LaunchError("secret-like value in arguments refused; use stdin or --capability-fd");
  const flags = {};
  for (const a of own) {
    const m = /^--([a-z-]+)=(.*)$/s.exec(a);
    if (!m) throw new LaunchError("unexpected argument (flags must be --name=value)");
    if (!VALUE_FLAGS.has(m[1])) throw new LaunchError(`unknown option --${m[1]}`);
    flags[m[1]] = m[2];
  }
  let mode;
  let brokerURL;
  try {
    mode = parseAcceptanceMode(flags.mode);
  } catch {
    throw new LaunchError("--mode must be m1 or m2");
  }
  try {
    brokerURL = validateBrokerURL(flags["broker-url"]);
  } catch {
    throw new LaunchError("--broker-url must be the approved Broker /v1 URL");
  }
  let capabilityFd = 0;
  if (flags["capability-fd"] !== undefined) {
    if (!/^[0-9]+$/.test(flags["capability-fd"])) throw new LaunchError("--capability-fd must be an integer >= 3");
    capabilityFd = Number(flags["capability-fd"]);
    if (capabilityFd < 3 || capabilityFd > 1023) throw new LaunchError("--capability-fd must be an integer >= 3");
  }
  const fixtureRoot = flags["fixture-root"];
  if (fixtureRoot !== undefined && (!path.isAbsolute(fixtureRoot) || path.normalize(fixtureRoot) !== fixtureRoot)) {
    throw new LaunchError("--fixture-root must be a normalized absolute path");
  }
  const opencodeBin = flags.opencode ?? "opencode";
  if (flags.opencode !== undefined && !path.isAbsolute(opencodeBin)) throw new LaunchError("--opencode must be an absolute path");
  return { mode, brokerURL, capabilityFd, fixtureRoot, opencodeBin, opencodeArgs };
}

// Credential-like variables are never inherited by the OpenCode child (or the version probe),
// regardless of how the value looks (sentinel-looking values are NOT treated as safe).
// This is a child-env filter only: it does not prove Sandbox-wide credential safety.
const CREDENTIAL_EXACT = new Set(["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "SSH_AUTH_SOCK"]);
const CREDENTIAL_PREFIX = /^(?:GITHUB_|ANTHROPIC_|OPENAI_|CF_|CLOUDFLARE_|AWS_|AZURE_|GOOGLE_|GEMINI_|HF_|NPM_TOKEN)/;
const CREDENTIAL_SUFFIX = /(?:_TOKEN|_SECRET|_PASSWORD|_API_KEY|_APIKEY|_CREDENTIALS)$/;
// Names containing TOKEN with a sentinel marker are also dropped (e.g. MCP_SENTINEL_TOKEN_NAME).
const CREDENTIAL_INFIX = /(?:^|_)(?:TOKEN|SECRET|PASSWORD|CREDENTIALS?)(?:_|$)/;
function isCredentialLike(name) {
  if (name.startsWith("GIT_CONFIG_")) return false;
  const k = name.toUpperCase();
  return CREDENTIAL_EXACT.has(k) || CREDENTIAL_PREFIX.test(k) || CREDENTIAL_SUFFIX.test(k) || CREDENTIAL_INFIX.test(k);
}

function baseEnv(parent) {
  for (const k of HOST_ONLY_ENV) {
    if (Object.hasOwn(parent, k) && parent[k] !== undefined) throw new LaunchError(`${k} must not be present in the Guest launcher environment`);
  }
  return Object.fromEntries(Object.entries(parent).filter(([k, v]) => v !== undefined && !k.startsWith("OC_CF_AIG_") && !isCredentialLike(k)));
}

/** Child-only environment; the launcher's own environment is never modified. */
export function buildChildEnv(parent, { mode, brokerURL, capability, fixtureRoot }) {
  const env = baseEnv(parent);
  env[ENV.mode] = parseAcceptanceMode(mode);
  env[ENV.brokerURL] = validateBrokerURL(brokerURL);
  env[ENV.capability] = validateCapability(capability);
  if (fixtureRoot !== undefined) env[ENV.fixtureRoot] = fixtureRoot;
  return env;
}

function defaultRunVersion(bin, env) {
  return new Promise((resolve, reject) => {
    execFile(bin, ["--version"], { env, timeout: 10_000, maxBuffer: 4096 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
  });
}

export async function verifyOpencodeVersion(bin, { runVersion = defaultRunVersion, env = {} } = {}) {
  let out;
  try {
    out = await runVersion(bin, env);
  } catch {
    throw new LaunchError("could not determine OpenCode version");
  }
  // Accepted outputs (after trimming surrounding whitespace): "2.2.5", "v2.2.5", "opencode v2.2.5" (real Core format).
  const v = OPENCODE_VERSION.replace(/\./g, "\\.");
  if (!new RegExp(`^(?:${v}|v${v}|opencode v${v})$`).test(String(out).trim())) {
    throw new LaunchError(`OpenCode version must be exactly ${OPENCODE_VERSION}`);
  }
}

/** Read the one-shot capability from a pipe/socket FD only (regular files/TTYs refused). */
export async function readCapability(fd) {
  let st;
  try {
    st = fs.fstatSync(fd);
  } catch {
    throw new LaunchError("capability fd is not open");
  }
  if (!st.isFIFO() && !st.isSocket()) throw new LaunchError("capability must arrive over a pipe or socket");
  const stream = fd === 0 ? process.stdin : st.isSocket() ? new net.Socket({ fd, readable: true, writable: false }) : fs.createReadStream("", { fd });
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of stream) {
      size += chunk.length;
      if (size > MAX_CAPABILITY_BYTES) throw new LaunchError("capability too large");
      chunks.push(chunk);
    }
  } finally {
    stream.destroy();
  }
  const raw = Buffer.concat(chunks).toString("utf8").replace(/\n$/, "");
  try {
    return validateCapability(raw);
  } catch {
    throw new LaunchError("capability missing or malformed");
  }
}

export async function launch({ argv = [], env = {}, deps = {} } = {}) {
  const { runVersion = defaultRunVersion, readCapability: read = readCapability, spawn = nodeSpawn } = deps;
  const opts = parseLaunchArgs(argv);
  const versionEnv = baseEnv(env);
  await verifyOpencodeVersion(opts.opencodeBin, { runVersion, env: versionEnv });
  const capability = await read(opts.capabilityFd);
  const childEnv = buildChildEnv(env, { ...opts, capability });
  return await new Promise((resolve, reject) => {
    const child = spawn(opts.opencodeBin, opts.opencodeArgs, {
      env: childEnv,
      stdio: [opts.capabilityFd === 0 ? "ignore" : "inherit", "inherit", "inherit"],
    });
    child.on("error", () => reject(new LaunchError("failed to start OpenCode")));
    child.on("close", (code) => resolve(code ?? 1));
    if (typeof child.kill === "function") {
      for (const sig of ["SIGINT", "SIGTERM"]) process.once(sig, () => child.kill(sig));
    }
  });
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  try {
    process.exitCode = await launch({ argv, env });
  } catch (e) {
    process.stderr.write(`${e instanceof LaunchError ? e.message : "guest-launch failed"}\n`);
    process.exitCode = e instanceof LaunchError ? 2 : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  await main();
}
