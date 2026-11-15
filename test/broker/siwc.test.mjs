import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createHash, generateKeyPairSync, createSign } from "node:crypto";
import { createSIWCSource, SIWCError } from "../../src/broker/siwc.mjs";
import { createCredentialStore } from "../../src/broker/credential-store.mjs";

const AUTH = "https://auth.openai.com";
const AUTHORIZE = `${AUTH}/api/accounts/authorize`;
const TOKEN = `${AUTH}/api/accounts/oauth/token`;
const JWKS = `${AUTH}/.well-known/jwks.json`;
const SCOPE = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const RESOURCE = "https://api.openai.com/v1";
const ISSUED = "issued-client-7f3a";
const T0 = 1_900_000_000_000;

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
const JWK = { ...publicKey.export({ format: "jwk" }), kid: "kid-1", alg: "RS256", use: "sig" };

const b64u = (b) => Buffer.from(b).toString("base64url");
function signJwt(payload, { key = privateKey, kid = "kid-1", alg = "RS256" } = {}) {
  const head = b64u(JSON.stringify({ alg, kid, typ: "JWT" }));
  const body = b64u(JSON.stringify(payload));
  if (alg !== "RS256") return `${head}.${body}.${b64u("sig")}`;
  const s = createSign("RSA-SHA256");
  s.update(`${head}.${body}`);
  return `${head}.${body}.${b64u(s.sign(key))}`;
}

function idClaims(nonce, extra = {}) {
  return {
    iss: AUTH,
    aud: ISSUED,
    sub: "user-123",
    email: "owner@example.test",
    nonce,
    iat: Math.floor(T0 / 1000),
    exp: Math.floor(T0 / 1000) + 3600,
    ...extra,
  };
}

function tmpCred() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "oc2-siwc-")));
  return path.join(root, "store", "siwc.json");
}

/** Mock official endpoints. Never touches the network. */
function mockAuth({ idToken, tokenStatus = 200, tokenBody, refreshBody, refreshStatus = 200, refreshDelayMs = 0, hangRefresh = false } = {}) {
  const calls = { token: [], refresh: [], jwks: 0, other: [] };
  let refreshN = 0;
  const fetch = async (url, init = {}) => {
    const u = String(url);
    if (u === JWKS) {
      calls.jwks++;
      return Response.json({ keys: [JWK] });
    }
    if (u === TOKEN && init.method === "POST") {
      const form = new URLSearchParams(String(init.body));
      if (form.get("grant_type") === "refresh_token") {
        calls.refresh.push(form);
        if (hangRefresh) {
          return new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(init.signal.reason ?? new Error("aborted"))));
        }
        if (refreshDelayMs) await new Promise((r) => setTimeout(r, refreshDelayMs));
        refreshN++;
        const body = typeof refreshBody === "function" ? refreshBody(refreshN, form) : refreshBody ?? {
          access_token: `access-${refreshN + 1}`,
          refresh_token: `refresh-${refreshN + 1}`,
          token_type: "Bearer",
          expires_in: 3600,
          scope: SCOPE,
        };
        return Response.json(body, { status: refreshStatus });
      }
      calls.token.push(form);
      const body = tokenBody ?? {
        access_token: "access-1",
        refresh_token: "refresh-1",
        id_token: typeof idToken === "function" ? idToken(calls) : idToken,
        token_type: "Bearer",
        expires_in: 3600,
        scope: SCOPE,
      };
      return Response.json(typeof body === "function" ? body(calls) : body, { status: tokenStatus });
    }
    calls.other.push(u);
    throw new Error("unexpected network access");
  };
  return { fetch, calls };
}

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = "";
      res.on("data", (d) => (data += d));
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    }).on("error", reject);
  });
}

let nowMs = T0;
const clock = () => nowMs;

function source(credentialPath, auth, extra = {}) {
  return createSIWCSource({ credentialPath, authBase: AUTH, clock, client: { fetch: auth.fetch, timeoutMs: 200, lockPollMs: 5, ...extra } });
}

/** Perform a full mocked login; nonce of the issued ID token tracks the authorize URL. */
async function login(credentialPath, { claims = {}, callbackExtra = {}, beginOpts, auth: givenAuth, sign = {} } = {}) {
  let nonce;
  const auth = givenAuth ?? mockAuth({ idToken: () => signJwt(idClaims(nonce, claims), sign) });
  const src = source(credentialPath, auth);
  const { url, port, complete } = await src.beginLogin(beginOpts);
  const u = new URL(url);
  nonce = u.searchParams.get("nonce");
  const q = new URLSearchParams({ code: "auth-code-1", state: u.searchParams.get("state"), client_id: ISSUED, ...callbackExtra });
  for (const [k, v] of Object.entries(callbackExtra)) if (v === null) q.delete(k);
  const done = complete();
  done.catch(() => {});
  const res = await get(`http://127.0.0.1:${port}/auth/callback?${q}`);
  return { src, auth, url: u, port, done, res };
}

function assertNoSecret(err, secrets = ["access-1", "refresh-1", "auth-code-1"]) {
  const text = `${err?.message}\n${err?.stack}`;
  for (const s of secrets) assert.ok(!text.includes(s), `secret ${s} leaked`);
}

test("first login: dynamic_agent_client, fixed agent_name_hint, stable Host ID, 6 scopes, resource, loopback callback, PKCE/state/nonce", async () => {
  nowMs = T0;
  const cred = tmpCred();
  const { url, port, done, auth, res } = await login(cred);
  await done;
  assert.equal(res.status, 200);
  assert.equal(`${url.origin}${url.pathname}`, AUTHORIZE);
  const p = url.searchParams;
  assert.equal(p.get("client_id"), "dynamic_agent_client");
  assert.equal(p.get("agent_name_hint"), "OC2 Subscription Broker");
  assert.equal(p.get("response_type"), "code");
  assert.equal(p.get("scope"), SCOPE);
  assert.equal(p.get("resource"), RESOURCE);
  assert.equal(p.get("redirect_uri"), `http://127.0.0.1:${port}/auth/callback`);
  assert.equal(p.get("code_challenge_method"), "S256");
  assert.ok(p.get("state").length >= 32 && p.get("nonce").length >= 32);
  assert.notEqual(p.get("state"), p.get("nonce"));
  assert.ok(!p.has("id_token_hint"));
  const store = createCredentialStore({ path: cred });
  assert.equal(p.get("ext_agent_host_id"), store.load().ext_agent_host_id);
  assert.match(p.get("ext_agent_host_id"), /^urn:uuid:[0-9a-f-]{36}$/);

  assert.equal(auth.calls.token.length, 1);
  const form = auth.calls.token[0];
  assert.equal(form.get("grant_type"), "authorization_code");
  assert.equal(form.get("client_id"), ISSUED, "issued client_id, never the dynamic placeholder");
  assert.equal(form.get("code"), "auth-code-1");
  assert.equal(form.get("redirect_uri"), p.get("redirect_uri"));
  assert.equal(form.get("resource"), RESOURCE);
  assert.equal(createHash("sha256").update(form.get("code_verifier")).digest("base64url"), p.get("code_challenge"));

  const acct = store.getActive();
  assert.equal(acct.client_id, ISSUED);
  assert.equal(acct.subject, "user-123");
  assert.equal(acct.issuer, AUTH);
  assert.equal(acct.refresh_token, "refresh-1");
  assert.equal(acct.expires_at, T0 + 3600_000);
  assert.deepEqual([...acct.scopes].sort(), SCOPE.split(" ").sort());
  assert.equal(fs.statSync(cred).mode & 0o777, 0o600);
  assert.equal(auth.calls.other.length, 0);
});

test("Host ID persists across logins and source restarts", async () => {
  nowMs = T0;
  const cred = tmpCred();
  const a = await login(cred);
  await a.done;
  const b = await login(cred, { beginOpts: { newAccount: true } });
  await b.done;
  assert.equal(a.url.searchParams.get("ext_agent_host_id"), b.url.searchParams.get("ext_agent_host_id"));
});

test("login listens on 127.0.0.1 before returning the URL and only accepts /auth/callback", async () => {
  nowMs = T0;
  const auth = mockAuth({ idToken: "x" });
  const src = source(tmpCred(), auth);
  const { port, complete } = await src.beginLogin();
  const p = complete();
  p.catch(() => {});
  const res = await get(`http://127.0.0.1:${port}/other`);
  assert.equal(res.status, 404);
  assert.equal(auth.calls.token.length, 0);
  await get(`http://127.0.0.1:${port}/auth/callback?error=access_denied`);
  await assert.rejects(p, SIWCError);
});

for (const [name, opts] of [
  ["state mismatch", { callbackExtra: { state: "attacker-state" } }],
  ["missing issued client_id", { callbackExtra: { client_id: null } }],
  ["dynamic placeholder as issued client_id", { callbackExtra: { client_id: "dynamic_agent_client" } }],
  ["missing code", { callbackExtra: { code: null } }],
]) {
  test(`callback rejected: ${name}; no token exchange`, async () => {
    nowMs = T0;
    const cred = tmpCred();
    const { done, auth } = await login(cred, opts);
    await assert.rejects(done, (e) => e instanceof SIWCError && (assertNoSecret(e), true));
    assert.equal(auth.calls.token.length, 0);
    assert.equal(createCredentialStore({ path: cred }).getActive(), null);
  });
}

for (const [name, opts] of [
  ["wrong issuer", { claims: { iss: "https://evil.example" } }],
  ["wrong audience", { claims: { aud: "someone-else" } }],
  ["audience array without azp match", { claims: { aud: [ISSUED, "x"], azp: "x" } }],
  ["wrong nonce", { claims: { nonce: "replayed" } }],
  ["expired", { claims: { exp: Math.floor(T0 / 1000) - 10 } }],
  ["missing subject", { claims: { sub: "" } }],
  ["unverified email identity", { claims: { email_verified: false } }],
  ["signature by unknown key", { sign: { key: other.privateKey } }],
  ["unknown kid", { sign: { kid: "kid-unknown" } }],
  ["alg none", { sign: { alg: "none" } }],
  ["alg HS256", { sign: { alg: "HS256" } }],
]) {
  test(`ID token rejected: ${name}; no credentials activated`, async () => {
    nowMs = T0;
    const cred = tmpCred();
    const { done } = await login(cred, opts);
    await assert.rejects(done, (e) => e instanceof SIWCError && (assertNoSecret(e), true));
    assert.equal(createCredentialStore({ path: cred }).getActive(), null);
  });
}

test("grant check: missing chatgpt.tokens.use.direct scope is rejected", async () => {
  nowMs = T0;
  const cred = tmpCred();
  let nonce;
  const auth = mockAuth({
    tokenBody: () => ({
      access_token: "access-1",
      refresh_token: "refresh-1",
      id_token: signJwt(idClaims(nonce)),
      token_type: "Bearer",
      expires_in: 3600,
      scope: "openid profile email offline_access resource.invoke",
    }),
  });
  const src = source(cred, auth);
  const { url, port, complete } = await src.beginLogin();
  const u = new URL(url);
  nonce = u.searchParams.get("nonce");
  const p = complete();
  p.catch(() => {});
  await get(`http://127.0.0.1:${port}/auth/callback?code=auth-code-1&state=${u.searchParams.get("state")}&client_id=${ISSUED}`);
  await assert.rejects(p, (e) => e instanceof SIWCError && e.code === "insufficient_scope");
  assert.equal(createCredentialStore({ path: cred }).getActive(), null);
});

test("token endpoint rejection during exchange fails closed without echoing body", async () => {
  nowMs = T0;
  const cred = tmpCred();
  const auth = mockAuth({ tokenStatus: 400, tokenBody: { error: "invalid_grant", error_description: "access-1 refresh-1" } });
  const { done } = await login(cred, { auth });
  await assert.rejects(done, (e) => e instanceof SIWCError && (assertNoSecret(e), true));
});

test("reauth uses issued client_id + stable Host ID, omits agent_name_hint, optional id_token_hint never logged", async () => {
  nowMs = T0;
  const cred = tmpCred();
  const first = await login(cred);
  await first.done;
  const stored = createCredentialStore({ path: cred }).getActive();

  const seen = [];
  const orig = {};
  for (const m of ["log", "info", "warn", "error", "debug"]) {
    orig[m] = console[m];
    console[m] = (...a) => seen.push(a.join(" "));
  }
  const handles = [];
  try {
    const plain = await first.src.beginLogin();
    handles.push(plain);
    const pu = new URL(plain.url).searchParams;
    assert.equal(pu.get("client_id"), ISSUED);
    assert.ok(!pu.has("agent_name_hint"));
    assert.ok(!pu.has("id_token_hint"));
    assert.equal(pu.get("ext_agent_host_id"), first.url.searchParams.get("ext_agent_host_id"));

    const hinted = await first.src.beginLogin({ includeIdTokenHint: true });
    handles.push(hinted);
    const hu = new URL(hinted.url).searchParams;
    assert.equal(hu.get("id_token_hint"), stored.id_token);
    assert.notEqual(hu.get("state"), pu.get("state"));
  } finally {
    Object.assign(console, orig);
    for (const h of handles) await h.cancel();
  }
  assert.ok(!seen.join("\n").includes(stored.id_token), "id_token_hint logged");
});

test("reauth completes for the same identity and replaces the token set", async () => {
  nowMs = T0;
  const cred = tmpCred();
  const first = await login(cred);
  await first.done;
  const again = await login(cred);
  await again.done;
  assert.equal(again.url.searchParams.get("client_id"), ISSUED);
  assert.equal(again.auth.calls.token[0].get("client_id"), ISSUED);
});

test("reauth with a different identity is rejected and does not overwrite the account", async () => {
  nowMs = T0;
  const cred = tmpCred();
  const first = await login(cred);
  await first.done;
  const before = fs.readFileSync(cred, "utf8");
  const second = await login(cred, { claims: { sub: "intruder-999" } });
  await assert.rejects(second.done, (e) => e instanceof SIWCError && e.code === "identity_mismatch");
  assert.equal(fs.readFileSync(cred, "utf8"), before);
});

async function loggedIn() {
  nowMs = T0;
  const cred = tmpCred();
  const l = await login(cred);
  await l.done;
  return cred;
}

test("getAccessToken returns cached access token while fresh, without network", async () => {
  const cred = await loggedIn();
  const auth = mockAuth();
  const src = source(cred, auth);
  assert.equal(await src.getAccessToken(), "access-1");
  assert.equal(auth.calls.refresh.length + auth.calls.token.length + auth.calls.jwks, 0);
});

test("refresh near expiry: refresh_token grant with issued client_id + resource, no scope override; rotating set atomically replaced", async () => {
  const cred = await loggedIn();
  const auth = mockAuth();
  const src = source(cred, auth);
  nowMs = T0 + 3600_000 - 60_000;
  assert.equal(await src.getAccessToken(), "access-2");
  const f = auth.calls.refresh[0];
  assert.equal(f.get("grant_type"), "refresh_token");
  assert.equal(f.get("refresh_token"), "refresh-1");
  assert.equal(f.get("client_id"), ISSUED);
  assert.equal(f.get("resource"), RESOURCE);
  assert.ok(!f.has("scope"));
  const acct = createCredentialStore({ path: cred }).getActive();
  assert.equal(acct.refresh_token, "refresh-2");
  assert.equal(acct.access_token, "access-2");
  assert.equal(acct.expires_at, nowMs + 3600_000);
  assert.equal(fs.statSync(cred).mode & 0o777, 0o600);
  nowMs += 3600_000 - 60_000;
  assert.equal(await src.getAccessToken(), "access-3");
  assert.equal(auth.calls.refresh[1].get("refresh_token"), "refresh-2", "latest rotated refresh token used");
});

test("earliest_refresh_at defers refresh while the access token is still valid", async () => {
  const cred = await loggedIn();
  const store = createCredentialStore({ path: cred });
  const acct = store.getActive();
  store.putAccount({ ...acct, earliest_refresh_at: T0 + 3600_000 - 10_000 });
  const auth = mockAuth();
  nowMs = T0 + 3600_000 - 60_000;
  assert.equal(await source(cred, auth).getAccessToken(), "access-1");
  assert.equal(auth.calls.refresh.length, 0);
});

for (const [name, opts, code] of [
  ["invalid_grant 400", { refreshStatus: 400, refreshBody: { error: "invalid_grant", error_description: "refresh-1" } }, "refresh_rejected"],
  ["401", { refreshStatus: 401, refreshBody: { error: "unauthorized" } }, "refresh_rejected"],
  ["timeout", { hangRefresh: true }, "refresh_timeout"],
  ["missing rotated refresh token", { refreshBody: { access_token: "access-2", token_type: "Bearer", expires_in: 3600 } }, "invalid_token_response"],
  ["non-bearer token type", { refreshBody: { access_token: "access-2", refresh_token: "r2", token_type: "mac", expires_in: 3600 } }, "invalid_token_response"],
  ["reduced scopes", { refreshBody: { access_token: "access-2", refresh_token: "r2", token_type: "Bearer", expires_in: 3600, scope: "openid" } }, "insufficient_scope"],
]) {
  test(`refresh failure (${name}) fails closed: no stale token, no BYOK, store unchanged, no secret in error`, async () => {
    const cred = await loggedIn();
    const before = fs.readFileSync(cred, "utf8");
    const auth = mockAuth(opts);
    const prevKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-should-never-be-used";
    try {
      nowMs = T0 + 3600_000 + 1;
      await assert.rejects(source(cred, auth).getAccessToken(), (e) => {
        assert.ok(e instanceof SIWCError);
        assert.equal(e.code, code);
        assertNoSecret(e, ["access-1", "refresh-1", "sk-should-never-be-used"]);
        return true;
      });
    } finally {
      if (prevKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prevKey;
    }
    assert.equal(fs.readFileSync(cred, "utf8"), before);
    assert.equal(auth.calls.other.length, 0);
  });
}

test("expired token while refresh is deferred by earliest_refresh_at fails closed", async () => {
  const cred = await loggedIn();
  const store = createCredentialStore({ path: cred });
  store.putAccount({ ...store.getActive(), earliest_refresh_at: T0 + 7200_000 });
  nowMs = T0 + 3600_000 + 1;
  await assert.rejects(source(cred, mockAuth()).getAccessToken(), (e) => e.code === "token_expired");
});

test("not logged in: getAccessToken rejects", async () => {
  nowMs = T0;
  await assert.rejects(source(tmpCred(), mockAuth()).getAccessToken(), (e) => e instanceof SIWCError && e.code === "not_logged_in");
});

test("concurrent refresh in one process is single-flight", async () => {
  const cred = await loggedIn();
  const auth = mockAuth({ refreshDelayMs: 30 });
  const src = source(cred, auth);
  nowMs = T0 + 3600_000 - 1000;
  const tokens = await Promise.all(Array.from({ length: 5 }, () => src.getAccessToken()));
  assert.deepEqual(tokens, Array(5).fill("access-2"));
  assert.equal(auth.calls.refresh.length, 1);
});

test("concurrent refresh across independent sources (process lock) refreshes once and both see the rotated set", async () => {
  const cred = await loggedIn();
  const auth = mockAuth({ refreshDelayMs: 40 });
  const a = source(cred, auth);
  const b = source(cred, auth);
  nowMs = T0 + 3600_000 - 1000;
  const [ta, tb] = await Promise.all([a.getAccessToken(), b.getAccessToken()]);
  assert.equal(ta, "access-2");
  assert.equal(tb, "access-2");
  assert.equal(auth.calls.refresh.length, 1);
});

test("refreshed id_token for another subject is rejected", async () => {
  const cred = await loggedIn();
  const auth = mockAuth({
    refreshBody: () => ({
      access_token: "access-2",
      refresh_token: "refresh-2",
      token_type: "Bearer",
      expires_in: 3600,
      id_token: signJwt({ ...idClaims(undefined), sub: "intruder", iat: Math.floor(nowMs / 1000), exp: Math.floor(nowMs / 1000) + 3600 }),
    }),
  });
  nowMs = T0 + 3600_000 - 1000;
  await assert.rejects(source(cred, auth).getAccessToken(), (e) => e.code === "identity_mismatch");
});

test("createSIWCSource refuses non-official authBase and missing fetch", () => {
  assert.throws(() => createSIWCSource({ credentialPath: tmpCred(), authBase: "https://evil.example", client: { fetch: async () => {} } }), SIWCError);
  assert.throws(() => createSIWCSource({ credentialPath: tmpCred(), authBase: "http://auth.openai.com", client: { fetch: async () => {} } }), SIWCError);
  assert.throws(() => createSIWCSource({ credentialPath: tmpCred(), client: { fetch: "nope" } }), SIWCError);
});

test("stale in-memory state is re-read under lock before failing token_expired", async () => {
  const cred = await loggedIn();
  const store = createCredentialStore({ path: cred });
  const acct = store.getActive();
  store.putAccount({ ...acct, earliest_refresh_at: T0 + 7200_000 });
  const auth = mockAuth();
  const src = source(cred, auth);
  nowMs = T0;
  assert.equal(await src.getAccessToken(), "access-1");
  // Another process renews the token set.
  store.putAccount({ ...acct, access_token: "access-other-proc", refresh_token: "refresh-other-proc", expires_at: T0 + 36_000_000, earliest_refresh_at: T0 + 30_000_000 });
  nowMs = T0 + 3600_000 + 1;
  assert.equal(await src.getAccessToken(), "access-other-proc");
  assert.equal(auth.calls.refresh.length, 0);
});
