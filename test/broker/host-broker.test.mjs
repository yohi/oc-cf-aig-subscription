import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseConfig, ConfigError, startServe } from "../../bin/host-broker.mjs";
import { createCredentialStore } from "../../src/broker/credential-store.mjs";

const BIN = fileURLToPath(new URL("../../bin/host-broker.mjs", import.meta.url));
const GATEWAY = `https://gateway.ai.cloudflare.com/v1/${"0123456789abcdef".repeat(2)}/my-gw`;
const CF_SECRET = "cf-secret-token-zzzz";

function credPath() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "oc2-bin-")));
  return path.join(root, "store", "siwc.json");
}

const QUOTA_ARGS = [
  "--ttl-ms=60000",
  "--max-calls=3",
  "--max-calls-per-window=2",
  "--window-ms=60000",
  "--max-concurrent=1",
  "--max-request-bytes=65536",
  "--max-response-bytes=1048576",
  "--max-total-bytes=2097152",
  "--max-request-duration-ms=120000",
];

function serveArgv(cred, extra = []) {
  return ["serve", `--credential-path=${cred}`, `--gateway-base=${GATEWAY}`, "--port=18431", "--sandbox-label=test-sbx", "--capability-fd=3", ...QUOTA_ARGS, ...extra];
}

const baseEnv = { CF_AIG_TOKEN: CF_SECRET };

test("serve: complete config validates; binds loopback only; token only from env", () => {
  const cred = credPath();
  const c = parseConfig({ argv: serveArgv(cred), env: baseEnv });
  assert.equal(c.mode, "serve");
  assert.equal(c.host, "127.0.0.1");
  assert.equal(c.port, 18431);
  assert.equal(c.credentialPath, cred);
  assert.equal(c.gatewayBase, GATEWAY);
  assert.equal(c.gatewayToken, CF_SECRET);
  assert.equal(c.capabilityFd, 3);
  assert.deepEqual(c.quotas, {
    ttlMs: 60000,
    maxCalls: 3,
    maxCallsPerWindow: 2,
    windowMs: 60000,
    maxConcurrent: 1,
    maxRequestBytes: 65536,
    maxResponseBytes: 1048576,
    maxTotalBytes: 2097152,
    maxRequestDurationMs: 120000,
  });
});

test("serve: env equivalents are accepted", () => {
  const cred = credPath();
  const env = {
    CF_AIG_TOKEN: CF_SECRET,
    OC_CF_AIG_CREDENTIAL_PATH: cred,
    OC_CF_AIG_GATEWAY_BASE: GATEWAY,
    OC_CF_AIG_BROKER_PORT: "18432",
    OC_CF_AIG_SANDBOX_LABEL: "sbx",
    OC_CF_AIG_CAPABILITY_FD: "4",
    OC_CF_AIG_QUOTA_TTL_MS: "1",
    OC_CF_AIG_QUOTA_MAX_CALLS: "1",
    OC_CF_AIG_QUOTA_MAX_CALLS_PER_WINDOW: "1",
    OC_CF_AIG_QUOTA_WINDOW_MS: "1",
    OC_CF_AIG_QUOTA_MAX_CONCURRENT: "1",
    OC_CF_AIG_QUOTA_MAX_REQUEST_BYTES: "1",
    OC_CF_AIG_QUOTA_MAX_RESPONSE_BYTES: "1",
    OC_CF_AIG_QUOTA_MAX_TOTAL_BYTES: "1",
    OC_CF_AIG_QUOTA_MAX_REQUEST_DURATION_MS: "1",
  };
  const c = parseConfig({ argv: ["serve"], env });
  assert.equal(c.port, 18432);
  assert.equal(c.capabilityFd, 4);
});

const missingCases = [
  ["credential path", (a) => a.filter((x) => !x.startsWith("--credential-path")), {}],
  ["gateway base", (a) => a.filter((x) => !x.startsWith("--gateway-base")), {}],
  ["port", (a) => a.filter((x) => !x.startsWith("--port")), {}],
  ["sandbox label", (a) => a.filter((x) => !x.startsWith("--sandbox-label")), {}],
  ["capability fd", (a) => a.filter((x) => !x.startsWith("--capability-fd")), {}],
  ["CF_AIG_TOKEN", (a) => a, { CF_AIG_TOKEN: undefined }],
  ...QUOTA_ARGS.map((q) => [`quota ${q.split("=")[0]}`, (a) => a.filter((x) => x !== q), {}]),
];
for (const [name, edit, envPatch] of missingCases) {
  test(`serve refuses missing ${name}`, () => {
    const env = { ...baseEnv, ...envPatch };
    for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k];
    assert.throws(() => parseConfig({ argv: edit(serveArgv(credPath())), env }), (e) => {
      assert.ok(e instanceof ConfigError);
      assert.ok(!e.message.includes(CF_SECRET));
      return true;
    });
  });
}

for (const [name, extra, env] of [
  ["relative credential path", ["--credential-path=rel/siwc.json"], baseEnv],
  ["non-Cloudflare gateway base", ["--gateway-base=https://evil.example/v1/x/y"], baseEnv],
  ["port 0", ["--port=0"], baseEnv],
  ["port out of range", ["--port=70000"], baseEnv],
  ["non-integer quota", ["--max-calls=1.5"], baseEnv],
  ["zero quota", ["--ttl-ms=0"], baseEnv],
  ["negative quota", ["--max-total-bytes=-1"], baseEnv],
  ["capability fd 1 (stdout)", ["--capability-fd=1"], baseEnv],
  ["token passed as argument", [`--gateway-token=${CF_SECRET}`], baseEnv],
  ["host override", ["--host=0.0.0.0"], baseEnv],
  ["unknown flag", ["--retry=3"], baseEnv],
  ["OPENAI_API_KEY present (no BYOK)", [], { ...baseEnv, OPENAI_API_KEY: "sk-nope" }],
  ["unsafe CF_AIG_TOKEN", [], { CF_AIG_TOKEN: "bad token" }],
]) {
  test(`serve refuses ${name}`, () => {
    assert.throws(() => parseConfig({ argv: serveArgv(credPath(), extra), env }), (e) => {
      assert.ok(e instanceof ConfigError);
      assert.ok(!e.message.includes(CF_SECRET) && !e.message.includes("sk-nope"));
      return true;
    });
  });
}

test("login: needs only a credential path; refuses missing one and unknown modes", () => {
  const cred = credPath();
  const c = parseConfig({ argv: ["login", `--credential-path=${cred}`, "--new-account"], env: {} });
  assert.equal(c.mode, "login");
  assert.equal(c.newAccount, true);
  assert.equal(c.includeIdTokenHint, false);
  assert.throws(() => parseConfig({ argv: ["login"], env: {} }), ConfigError);
  assert.throws(() => parseConfig({ argv: ["daemon"], env: {} }), ConfigError);
  assert.throws(() => parseConfig({ argv: [], env: {} }), ConfigError);
  assert.throws(() => parseConfig({ argv: ["login", `--credential-path=${cred}`, "--port=1"], env: {} }), ConfigError);
});

test("CLI exits non-zero on missing config without echoing secrets", () => {
  const r = spawnSync(process.execPath, [BIN, "serve", "--port=18433"], {
    env: { PATH: process.env.PATH, CF_AIG_TOKEN: CF_SECRET },
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /credential/i);
  assert.ok(!r.stderr.includes(CF_SECRET) && !r.stdout.includes(CF_SECRET));
});

test("startServe refuses to listen without a SIWC account", async () => {
  const c = parseConfig({ argv: serveArgv(credPath()), env: baseEnv });
  await assert.rejects(startServe({ ...c, port: 0 }, { fetch: async () => assert.fail("network") }), (e) => e.code === "not_logged_in");
});

test("startServe binds 127.0.0.1 only, mints a capability and serves /health (offline)", async () => {
  const cred = credPath();
  const store = createCredentialStore({ path: cred });
  store.ensureHostId();
  store.putAccount(
    {
      issuer: "https://auth.openai.com",
      subject: "user-1",
      client_id: "issued",
      scopes: ["openid", "profile", "email", "offline_access", "resource.invoke", "chatgpt.tokens.use.direct"],
      id_token: "id",
      access_token: "acc",
      refresh_token: "ref",
      token_type: "Bearer",
      expires_at: Date.now() + 3600_000,
    },
    { activate: true },
  );
  const c = parseConfig({ argv: serveArgv(cred), env: baseEnv });
  const broker = await startServe({ ...c, port: 0 }, { fetch: async () => assert.fail("no upstream call expected") });
  try {
    const addr = broker.server.address();
    assert.equal(addr.address, "127.0.0.1");
    assert.match(broker.capability.token, /^ocb_/);
    const res = await new Promise((resolve, reject) =>
      http.get(`http://127.0.0.1:${addr.port}/health`, (r) => {
        r.resume();
        r.on("end", () => resolve(r.statusCode));
      }).on("error", reject),
    );
    assert.equal(res, 200);
  } finally {
    await broker.stop();
  }
});
