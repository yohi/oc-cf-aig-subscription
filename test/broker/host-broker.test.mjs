import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import https from "node:https";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseConfig, ConfigError, startServe, runLogin, runServe } from "../../bin/host-broker.mjs";
import { createCredentialStore } from "../../src/broker/credential-store.mjs";
import { createTlsFixture } from "./tls-fixtures.mjs";

const BIN = fileURLToPath(new URL("../../bin/host-broker.mjs", import.meta.url));
const GATEWAY = `https://gateway.ai.cloudflare.com/v1/${"0123456789abcdef".repeat(2)}/my-gw`;
const CF_SECRET = "cf-secret-token-zzzz";
const TLS = createTlsFixture();
after(() => TLS.cleanup());

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
  return ["serve", `--credential-path=${cred}`, `--gateway-base=${GATEWAY}`, "--port=18431", "--sandbox-label=test-sbx", "--capability-fd=3", `--tls-cert=${TLS.cert}`, `--tls-key=${TLS.key}`, ...QUOTA_ARGS, ...extra];
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
  assert.equal(c.tlsCertPath, TLS.cert);
  assert.equal(c.tlsKeyPath, TLS.key);
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
    OC_CF_AIG_TLS_CERT: TLS.cert,
    OC_CF_AIG_TLS_KEY: TLS.key,
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
  assert.equal(c.tlsCertPath, TLS.cert);
  assert.equal(c.tlsKeyPath, TLS.key);
});

const missingCases = [
  ["credential path", (a) => a.filter((x) => !x.startsWith("--credential-path")), {}],
  ["gateway base", (a) => a.filter((x) => !x.startsWith("--gateway-base")), {}],
  ["port", (a) => a.filter((x) => !x.startsWith("--port")), {}],
  ["sandbox label", (a) => a.filter((x) => !x.startsWith("--sandbox-label")), {}],
  ["capability fd", (a) => a.filter((x) => !x.startsWith("--capability-fd")), {}],
  ["TLS certificate", (a) => a.filter((x) => !x.startsWith("--tls-cert")), {}],
  ["TLS private key", (a) => a.filter((x) => !x.startsWith("--tls-key")), {}],
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
  ["relative TLS certificate path", ["--tls-cert=relative.pem"], baseEnv],
  ["relative TLS private-key path", ["--tls-key=relative.key"], baseEnv],
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

test("startServe refuses an unsafe TLS private key before reading SIWC credentials", async () => {
  const cred = credPath();
  const unsafeKey = path.join(path.dirname(cred), "unsafe-server.key");
  fs.mkdirSync(path.dirname(unsafeKey), { recursive: true });
  fs.copyFileSync(TLS.key, unsafeKey);
  fs.chmodSync(unsafeKey, 0o644);
  const c = parseConfig({ argv: serveArgv(cred, [`--tls-key=${unsafeKey}`]), env: baseEnv });
  await assert.rejects(
    startServe({ ...c, port: 0 }, { fetch: async () => assert.fail("must reject TLS key before network") }),
    (error) => error instanceof ConfigError && /TLS private key/.test(error.message),
  );
});

test("startServe refuses a symlinked TLS certificate before reading SIWC credentials", async () => {
  const cred = credPath();
  const linkedCert = path.join(path.dirname(cred), "linked-server.pem");
  fs.mkdirSync(path.dirname(linkedCert), { recursive: true });
  fs.symlinkSync(TLS.cert, linkedCert);
  const c = parseConfig({ argv: serveArgv(cred, [`--tls-cert=${linkedCert}`]), env: baseEnv });
  await assert.rejects(
    startServe({ ...c, port: 0 }, { fetch: async () => assert.fail("must reject TLS certificate before network") }),
    (error) => error instanceof ConfigError && /TLS certificate is missing or unsafe/.test(error.message),
  );
});

test("startServe refuses a TLS private key that does not match the leaf certificate", async () => {
  const cred = credPath();
  const other = createTlsFixture();
  try {
    const c = parseConfig({ argv: serveArgv(cred, [`--tls-key=${other.key}`]), env: baseEnv });
    await assert.rejects(
      startServe({ ...c, port: 0 }, { fetch: async () => assert.fail("must reject mismatched key before network") }),
      (error) => error instanceof ConfigError && /invalid or do not match/.test(error.message),
    );
  } finally {
    other.cleanup();
  }
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
      https.get({ hostname: "127.0.0.1", port: addr.port, path: "/health", ca: TLS.ca, servername: "host.docker.internal" }, (r) => {
        r.resume();
        r.on("end", () => resolve(r.statusCode));
      }).on("error", reject),
    );
    assert.equal(res, 200);
  } finally {
    await broker.stop();
  }
});

function seedAccount(cred) {
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
}

function mkfifo() {
  const p = path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "oc2-fifo-"))), "cap");
  const r = spawnSync("mkfifo", ["-m", "600", p]);
  assert.equal(r.status, 0, "mkfifo available");
  const reader = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  const writer = fs.openSync(p, fs.constants.O_WRONLY);
  return { reader, writer };
}

test("login: id_token_hint refusal on non-TTY happens before the callback server starts", async () => {
  let began = false;
  const writes = [];
  await assert.rejects(
    runLogin(
      { mode: "login", credentialPath: credPath(), newAccount: false, includeIdTokenHint: true },
      { stderr: { isTTY: false, write: (s) => writes.push(s) }, createSource: () => ({ beginLogin: async () => ((began = true), { url: "x", complete: async () => {}, cancel: async () => {} }) }) },
    ),
    (e) => e.code === "refused",
  );
  assert.equal(began, false);
  assert.equal(writes.join(""), "");
});

test("serve: refuses a regular-file capability fd before listening", async () => {
  const cred = credPath();
  seedAccount(cred);
  const filePath = path.join(path.dirname(path.dirname(cred)), "cap.txt");
  const fd = fs.openSync(filePath, "w", 0o600);
  let started = false;
  try {
    const c = parseConfig({ argv: serveArgv(cred), env: baseEnv });
    await assert.rejects(
      runServe({ ...c, port: 0, capabilityFd: fd }, { signals: false, startServe: async () => ((started = true), assert.fail("must not start")) }),
      (e) => e instanceof ConfigError,
    );
  } finally {
    fs.closeSync(fd);
  }
  assert.equal(started, false);
  assert.equal(fs.readFileSync(filePath, "utf8"), "");
});

test("serve: hands the capability over a FIFO fd only, then closes it", async () => {
  const cred = credPath();
  seedAccount(cred);
  const { reader, writer } = mkfifo();
  const c = parseConfig({ argv: serveArgv(cred), env: baseEnv });
  const writes = [];
  const broker = await runServe({ ...c, port: 0, capabilityFd: writer }, { signals: false, stderr: { write: (s) => writes.push(s) }, fetch: async () => assert.fail("network") });
  try {
    const buf = Buffer.alloc(256);
    const n = fs.readSync(reader, buf, 0, 256, null);
    const token = buf.subarray(0, n).toString().trim();
    assert.equal(token, broker.capability.token);
    assert.throws(() => fs.fstatSync(writer), "writer fd closed after handoff");
    assert.ok(!writes.join("").includes(token), "capability not logged");
  } finally {
    await broker.stop();
    fs.closeSync(reader);
  }
});

test("serve: capability write failure stops the broker and rejects", async () => {
  const cred = credPath();
  seedAccount(cred);
  const { reader, writer } = mkfifo();
  fs.closeSync(reader); // no reader => EPIPE on write
  const c = parseConfig({ argv: serveArgv(cred), env: baseEnv });
  let broker;
  await assert.rejects(
    runServe(
      { ...c, port: 0, capabilityFd: writer },
      {
        signals: false,
        stderr: { write() {} },
        startServe: async (cfg) => (broker = await startServe(cfg, { fetch: async () => assert.fail("network") })),
      },
    ),
    (e) => e.code === "capability_handoff_failed",
  );
  assert.ok(broker, "broker had started");
  assert.equal(broker.server.listening, false, "broker stopped after failed handoff");
  try {
    fs.closeSync(writer);
  } catch {
    /* already closed */
  }
});

test("serve: rejected shutdown is handled and exits unsuccessfully", async () => {
  const { reader, writer } = mkfifo();
  const c = parseConfig({ argv: serveArgv(credPath()), env: baseEnv });
  const exits = [];
  const unhandled = [];
  const originalExit = process.exit;
  const onUnhandled = (reason) => unhandled.push(reason);
  process.exit = (code) => exits.push(code);
  process.on("unhandledRejection", onUnhandled);
  try {
    await runServe(
      { ...c, port: 0, capabilityFd: writer },
      {
        stderr: { write() {} },
        startServe: async () => ({
          capability: { token: "test-capability", id: "test-id" },
          server: { address: () => ({ port: 12345 }) },
          stop: async () => { throw new Error("shutdown failed"); },
        }),
      },
    );
    process.emit("SIGINT");
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(exits, [1]);
    assert.deepEqual(unhandled, []);
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
    process.exit = originalExit;
    fs.closeSync(reader);
  }
});
