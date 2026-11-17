// Guest-only OpenCode provider for the disposable Sandbox. Talks exclusively to
// the Host Broker with a limited, Broker-minted capability. It never reads Host
// OAuth/Cloudflare credentials, never loads the Host plugin and never executes
// tools outside the Guest fixture root.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

export const PROVIDER_ID = "oc-cf-aig";
export const MODEL_ID = "gpt-6-luna";
export const PROVIDER_PACKAGE = "@opencode/ai/providers/openai/responses";
export const GUEST_NAMESPACE = "guest";
export const GUEST_TOOL = "read_file";
export const GUEST_TOOL_ID = `${GUEST_NAMESPACE}_${GUEST_TOOL}`;
export const GUEST_TOOL_DESCRIPTION = "Read an approved disposable Guest fixture";
export const READ_FILE_SCHEMA = Object.freeze({
  type: "object",
  properties: Object.freeze({ path: Object.freeze({ type: "string" }) }),
  required: Object.freeze(["path"]),
  additionalProperties: false,
});
export const MAX_FIXTURE_BYTES = 64 * 1024;

export const ENV = Object.freeze({
  mode: "OC_CF_AIG_ACCEPTANCE_MODE",
  brokerURL: "OC_CF_AIG_BROKER_URL",
  capability: "OC_CF_AIG_BROKER_CAPABILITY",
  fixtureRoot: "OC_CF_AIG_GUEST_FIXTURE_ROOT",
});

const MODES = new Set(["m1", "m2"]);
const BROKER_HOSTS = new Set(["host.docker.internal", "127.0.0.1"]);
const CAPABILITY = /^ocb_[A-Za-z0-9_-]{43}$/;
// Headers a Guest request must never carry towards the Broker (Host-only policy/auth or upstream steering).
const FORBIDDEN_HEADER = /^(authorization$|cf-aig-|x-api-key$|api-key$|cookie$|openai-|x-openai-|anthropic-|x-forwarded-|forwarded$|proxy-|x-real-ip$|x-target|x-upstream|x-original-url$)/i;

const deepFreeze = (value) => {
  if (value && typeof value === "object") {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
};

export function parseAcceptanceMode(value) {
  if (typeof value !== "string" || !MODES.has(value)) {
    throw new Error("OC_CF_AIG_ACCEPTANCE_MODE must be exactly m1 or m2 (acceptance mode missing or invalid)");
  }
  return value;
}

let frozenMode;
/** Process-lifetime latch: the first valid mode wins; any later different value is refused. */
export function freezeAcceptanceMode(value) {
  const mode = parseAcceptanceMode(value);
  if (frozenMode === undefined) frozenMode = mode;
  else if (frozenMode !== mode) throw new Error("acceptance mode is immutable (frozen) for this Guest process");
  return frozenMode;
}

export function validateBrokerURL(value) {
  const fail = () => new Error("Broker URL must be https://<host.docker.internal|127.0.0.1>:<port>/v1");
  if (typeof value !== "string" || value === "") throw fail();
  let url;
  try {
    url = new URL(value);
  } catch {
    throw fail();
  }
  if (
    url.protocol !== "https:" || !BROKER_HOSTS.has(url.hostname) || url.port === "" ||
    url.username || url.password || url.search || url.hash || !/^\/v1\/?$/.test(url.pathname) ||
    /[?#]/.test(value)
  ) throw fail();
  return `${url.origin}/v1`;
}

export function validateCapability(value) {
  if (typeof value !== "string" || !CAPABILITY.test(value)) {
    throw new Error("Broker capability missing or not a Broker-minted ocb_ bearer");
  }
  return value;
}

export function buildProviderInfo({ brokerURL, capability }) {
  return deepFreeze({
    id: PROVIDER_ID,
    name: "OC2 Host Broker",
    activation: "enabled",
    package: PROVIDER_PACKAGE,
    // apiKey is the limited Guest->Broker bearer only; never a native OpenAI/BYOK credential.
    settings: { baseURL: validateBrokerURL(brokerURL), apiKey: validateCapability(capability), transport: "http", encoding: "none" },
  });
}

export function buildModelInfo() {
  return deepFreeze({
    id: MODEL_ID,
    modelID: MODEL_ID,
    providerID: PROVIDER_ID,
    name: MODEL_ID,
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    variants: [],
    time: { released: 0 },
    cost: [],
    status: "active",
    enabled: true,
    // OpenCode schema defaults, not proven effective model limits.
    limit: { context: 200000, output: 32000 },
    // F-001/A: literal false so the native SDK omits prompt_cache_key.
    compatibility: { supportsPromptCacheKey: false },
    settings: { compaction: { type: "summary" } },
  });
}

const fixtureError = (message) => new Error(`fixture read refused: ${message}`);

/** Read-only, bounded UTF-8 reader confined to one disposable fixture root. Symlinks are never followed. */
export function createFixtureReader({ root, maxBytes = MAX_FIXTURE_BYTES, beforeOpen } = {}) {
  if (typeof root !== "string" || !path.isAbsolute(root)) throw new Error("Guest fixture root must be an absolute directory");
  let realRoot;
  let rootFd;
  try {
    realRoot = fs.realpathSync(root);
    rootFd = fs.openSync(realRoot, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    if (!fs.fstatSync(rootFd).isDirectory()) throw new Error("not a directory");
  } catch {
    if (rootFd !== undefined) fs.closeSync(rootFd);
    throw new Error("Guest fixture root must be an existing absolute directory");
  }
  return async function readFixture(input) {
    if (input === null || typeof input !== "object" || Array.isArray(input)) throw fixtureError("invalid input");
    const keys = Object.keys(input);
    if (keys.length !== 1 || keys[0] !== "path" || typeof input.path !== "string") throw fixtureError("input must be {path:string}");
    const rel = input.path;
    if (rel === "" || rel.includes("\0") || path.isAbsolute(rel) || rel.split(/[\\/]/).some((s) => s === "..")) {
      throw fixtureError("path must be relative to the fixture root");
    }
    const target = path.resolve(realRoot, rel);
    if (!target.startsWith(realRoot + path.sep)) throw fixtureError("path escapes the fixture root");
    const segments = path.relative(realRoot, target).split(path.sep);
    const directoryHandles = [];
    let parentFd = rootFd;
    let handle;
    try {
      for (const segment of segments.slice(0, -1)) {
        const directoryPath = path.join("/proc/self/fd", String(parentFd), segment);
        let directory;
        try {
          directory = await fsp.open(
            directoryPath,
            fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
          );
        } catch {
          throw fixtureError("fixture not readable");
        }
        directoryHandles.push(directory);
        parentFd = directory.fd;
      }
      // The opened directory descriptors pin each traversed component. The
      // final name is resolved from that descriptor, never from the mutable root path.
      if (typeof beforeOpen === "function") await beforeOpen();
      const targetPath = path.join("/proc/self/fd", String(parentFd), segments.at(-1));
      try {
        handle = await fsp.open(targetPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      } catch {
        throw fixtureError("fixture not readable");
      }
      const st = await handle.stat();
      if (!st.isFile()) throw fixtureError("not a regular file");
      if (st.size > maxBytes) throw fixtureError("fixture too large");
      const buf = Buffer.alloc(st.size);
      const { bytesRead } = await handle.read(buf, 0, st.size, 0);
      let content;
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(buf.subarray(0, bytesRead));
      } catch {
        throw fixtureError("fixture is not UTF-8 text");
      }
      return { content };
    } finally {
      await handle?.close();
      await Promise.all(directoryHandles.map((directory) => directory.close()));
    }
  };
}

/**
 * PR2-F-002 primary allowlist for the oc-cf-aig context hook.
 * m1: no tools at all. m2: exactly {read_file: <original guest_read_file definition object>}.
 */
export function applyPrimaryToolAllowlist(event, mode, { m2Ready = true } = {}) {
  parseAcceptanceMode(mode);
  if (mode === "m1") {
    event.tools = {};
    return event;
  }
  if (!m2Ready) throw new Error("M2 BLOCKED: guest_read_file is not registered in this Guest process");
  const tools = event.tools ?? {};
  if (!Object.hasOwn(tools, GUEST_TOOL_ID)) throw new Error("M2 BLOCKED: guest_read_file missing from the context tool map");
  if (Object.hasOwn(tools, GUEST_TOOL)) throw new Error("M2 BLOCKED: read_file collision with a pre-existing tool");
  const original = tools[GUEST_TOOL_ID];
  if (!original || original.description !== GUEST_TOOL_DESCRIPTION || !isDeepStrictEqual(original.input, READ_FILE_SCHEMA)) {
    throw new Error("M2 BLOCKED: guest_read_file schema/identity mismatch");
  }
  event.tools = { [GUEST_TOOL]: original };
  return event;
}

function assertHeaders(headers) {
  for (const name of Object.keys(headers ?? {})) {
    if (FORBIDDEN_HEADER.test(name)) throw new Error(`Guest request header ${name.toLowerCase()} is forbidden`);
  }
}

function assertBrokerHttpRequest(request, brokerURL, capability) {
  const url = new URL(request.url);
  if (url.search || url.hash || `${url.origin}${url.pathname}` !== `${brokerURL}/responses` || request.method !== "POST") {
    throw new Error("Guest request blocked: only POST to the Broker /v1/responses is allowed");
  }
  if (request.headers.get("authorization") !== `Bearer ${capability}`) {
    throw new Error("Guest request blocked: bearer must be the Broker capability");
  }
  for (const [name] of request.headers) {
    if (name !== "authorization" && FORBIDDEN_HEADER.test(name)) throw new Error(`Guest request header ${name} is forbidden`);
  }
}

const refuseOtherProvider = (event) => {
  if (event?.model?.providerID !== PROVIDER_ID) {
    throw new Error("Guest refused a non-oc-cf-aig model request (no provider fallback)");
  }
};

/** Register the Guest provider, mode-gated tool and scoped request guards. Throws on invalid input. */
export async function registerGuestProvider(ctx, { brokerURL, capability, mode, fixtureRoot } = {}) {
  const url = validateBrokerURL(brokerURL);
  const bearer = validateCapability(capability);
  const fixedMode = parseAcceptanceMode(mode);
  const info = buildProviderInfo({ brokerURL: url, capability: bearer });
  const model = buildModelInfo();

  await ctx.provider.transform((editor) => {
    if (editor.get(PROVIDER_ID)) throw new Error("provider oc-cf-aig already defined; refusing to merge");
    editor.add({ info, models: [model] });
  });

  let m2Ready = false;
  if (fixedMode === "m2") {
    let reader;
    try {
      reader = createFixtureReader({ root: fixtureRoot });
    } catch {
      reader = undefined; // M2 BLOCKED; the context hook fails closed below. M1 is never affected.
    }
    if (reader) {
      await ctx.tool.transform((editor) => {
        editor.namespace({ name: GUEST_NAMESPACE, description: "Disposable Sandbox-only tools" });
        editor.add({
          name: GUEST_TOOL,
          description: GUEST_TOOL_DESCRIPTION,
          input: READ_FILE_SCHEMA,
          options: { namespace: GUEST_NAMESPACE, codemode: false },
          execute: async (input) => reader(input),
        });
      });
      const registered = await ctx.tool.list();
      m2Ready = registered.some((t) => t.id === GUEST_TOOL_ID && t.name === GUEST_TOOL);
    }
  }

  await ctx.session.hook("context", (event) => {
    if (event?.model?.id !== MODEL_ID) throw new Error("Guest refused: only oc-cf-aig/gpt-6-luna model is selectable");
    applyPrimaryToolAllowlist(event, fixedMode, { m2Ready });
    // Proven suppression: the native SDK lowers options.maxTokens to max_output_tokens, which the Broker rejects.
    if (event.options && typeof event.options === "object") delete event.options.maxTokens;
  }, { providerID: PROVIDER_ID });

  await ctx.session.hook("model.request", (event) => {
    refuseOtherProvider(event);
    if (event.kind !== "primary") throw new Error("Guest refused: only primary requests are in M1/M2 scope");
    if (event.model.id !== MODEL_ID) throw new Error("Guest refused: only oc-cf-aig/gpt-6-luna model is selectable");
    if (event.baseURL !== undefined && validateBrokerURL(event.baseURL) !== url) throw new Error("Guest refused: baseURL is not the Broker");
    assertHeaders(event.headers);
  });

  await ctx.session.hook("http.request", (event) => {
    refuseOtherProvider(event);
    assertBrokerHttpRequest(event.request, url, bearer);
  });
}

async function installRefusal(ctx, reason) {
  const refuse = () => {
    throw new Error(`Guest startup refused (${reason}); all model requests blocked`);
  };
  await ctx.session.hook("model.request", refuse);
  await ctx.session.hook("http.request", refuse);
}

/**
 * Plugin entry logic. Reads only the Guest's own process-local OC_CF_AIG_* variables.
 * Any invalid setting or registration failure registers no provider/tool and STOPs Guest
 * initialization by throwing. Refusal hooks are installed first as defense in depth only
 * (whether Core keeps them after a failed setup is NOT_VERIFIED).
 */
export async function setupGuest(ctx, env = process.env, { freezeMode = freezeAcceptanceMode } = {}) {
  let mode;
  let brokerURL;
  let capability;
  try {
    mode = freezeMode(env[ENV.mode]);
    brokerURL = validateBrokerURL(env[ENV.brokerURL]);
    capability = validateCapability(env[ENV.capability]);
  } catch {
    await installRefusal(ctx, "invalid Guest configuration");
    throw new Error("Guest initialization STOP: invalid or missing Guest configuration");
  }
  const fixtureRoot = mode === "m2" ? env[ENV.fixtureRoot] : undefined;
  try {
    await registerGuestProvider(ctx, { brokerURL, capability, mode, fixtureRoot });
  } catch {
    await installRefusal(ctx, "Guest provider registration failed");
    throw new Error("Guest initialization STOP: Guest provider registration failed");
  }
}
