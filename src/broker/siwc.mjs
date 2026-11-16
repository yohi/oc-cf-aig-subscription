import http from "node:http";
import { createHash, createPublicKey, randomBytes as nodeRandomBytes, timingSafeEqual, verify as cryptoVerify } from "node:crypto";
import { createCredentialStore } from "./credential-store.mjs";

/** Fixed official SIWC values (design §5.3). Not configurable. */
export const AUTH_BASE = "https://auth.openai.com";
export const ISSUER = AUTH_BASE;
export const AUTHORIZE_URL = `${AUTH_BASE}/api/accounts/authorize`;
export const TOKEN_URL = `${AUTH_BASE}/api/accounts/oauth/token`;
// Assumption: the design fixes "OpenAI JWKS" without a URL; the standard
// well-known location on the fixed issuer is used. Same-origin only.
export const JWKS_URL = `${AUTH_BASE}/.well-known/jwks.json`;
export const DYNAMIC_CLIENT_ID = "dynamic_agent_client";
export const AGENT_NAME_HINT = "OC2 Subscription Broker";
export const RESOURCE = "https://api.openai.com/v1";
export const REQUIRED_SCOPES = Object.freeze(["openid", "profile", "email", "offline_access", "resource.invoke", "chatgpt.tokens.use.direct"]);
export const SCOPE = REQUIRED_SCOPES.join(" ");

const CALLBACK_PATH = "/auth/callback";
const CLIENT_ID_RE = /^[A-Za-z0-9._:-]{1,256}$/;
// eslint-disable-next-line no-control-regex
const UNSAFE_TOKEN = /[\u0000- \u007f]/;
const B64URL = /^[A-Za-z0-9_-]+$/;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_EXPIRES_IN_S = 30 * 24 * 3600;

/** Errors carry a fixed code and generic message only: never tokens, codes, URLs or bodies. */
export class SIWCError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SIWCError";
    this.code = code;
  }
}

const fail = (code, message) => {
  throw new SIWCError(code, message);
};

const b64u = (buf) => Buffer.from(buf).toString("base64url");

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function tokenString(v) {
  return typeof v === "string" && v.length > 0 && v.length <= 16384 && !UNSAFE_TOKEN.test(v);
}

function scopesOf(scope) {
  if (typeof scope !== "string") return null;
  return scope.split(" ").filter(Boolean);
}

function hasRequiredScopes(scopes) {
  return Array.isArray(scopes) && REQUIRED_SCOPES.every((s) => scopes.includes(s));
}

async function readJson(res) {
  const text = await res.text();
  if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) fail("invalid_token_response", "auth response too large");
  try {
    return JSON.parse(text);
  } catch {
    fail("invalid_token_response", "auth response is not JSON");
  }
}

/**
 * Official SIWC dynamic-registration credential source. Host-only.
 *
 * `client` injection (all optional): fetch, randomBytes, timeoutMs,
 * refreshSkewMs, loginTimeoutMs, lockPollMs, lockTimeoutMs.
 * There is no API-key, BYOK or alternate-provider path: every renewal failure
 * rejects. If a refresh may have rotated the refresh token without the new
 * set being persisted (crash mid-refresh, save failure), getAccessToken fails
 * with code `reauth_required` until an interactive login succeeds.
 */
export function createSIWCSource({ credentialPath, authBase = AUTH_BASE, client = {}, clock = Date.now } = {}) {
  if (authBase !== AUTH_BASE) throw new SIWCError("invalid_config", "authBase must be the official SIWC origin");
  const fetchImpl = client.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new SIWCError("invalid_config", "fetch implementation required");
  if (typeof clock !== "function") throw new SIWCError("invalid_config", "clock must be a function");
  const randomBytes = client.randomBytes ?? nodeRandomBytes;
  const timeoutMs = client.timeoutMs ?? 15_000;
  const refreshSkewMs = client.refreshSkewMs ?? 5 * 60_000;
  const loginTimeoutMs = client.loginTimeoutMs ?? 10 * 60_000;
  let store;
  try {
    store = createCredentialStore({
      path: credentialPath,
      lockPollMs: client.lockPollMs,
      lockTimeoutMs: client.lockTimeoutMs ?? timeoutMs * 2,
    });
  } catch (e) {
    throw new SIWCError("invalid_config", `credential store unavailable (${e.code ?? "error"})`);
  }

  let jwksCache = null; // { keys, fetchedAt }
  let cached = null; // last known record (with key)
  let inflight = null;
  let needsReauth = false; // set when this process left the store in an uncertain refresh state

  async function timedFetch(url, init, timeoutCode, failCode) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new SIWCError(timeoutCode, "auth request timed out")), timeoutMs);
    try {
      return await fetchImpl(url, { ...init, redirect: "error", signal: ac.signal });
    } catch {
      if (ac.signal.aborted) fail(timeoutCode, "auth request timed out");
      fail(failCode, "auth request failed");
    } finally {
      clearTimeout(timer);
    }
  }

  async function loadJwks(force) {
    if (!force && jwksCache && clock() - jwksCache.fetchedAt < 10 * 60_000) return jwksCache.keys;
    const res = await timedFetch(JWKS_URL, { method: "GET", headers: { accept: "application/json" } }, "jwks_timeout", "jwks_failed");
    if (res.status !== 200) fail("jwks_failed", "JWKS endpoint rejected request");
    const body = await readJson(res);
    if (!body || !Array.isArray(body.keys)) fail("jwks_failed", "JWKS response invalid");
    jwksCache = { keys: body.keys, fetchedAt: clock() };
    return body.keys;
  }

  async function verifyIdToken(idToken, { clientId, nonce, subject }) {
    if (!tokenString(idToken)) fail("invalid_id_token", "ID token missing");
    const parts = idToken.split(".");
    if (parts.length !== 3 || !parts.every((p) => B64URL.test(p))) fail("invalid_id_token", "ID token malformed");
    let header;
    let claims;
    try {
      header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
      claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    } catch {
      fail("invalid_id_token", "ID token malformed");
    }
    if (header?.alg !== "RS256" || typeof header.kid !== "string" || header.crit !== undefined) fail("invalid_id_token", "ID token algorithm not accepted");
    const pick = (keys) => keys.find((k) => k && k.kid === header.kid && k.kty === "RSA" && (k.alg === undefined || k.alg === "RS256") && (k.use === undefined || k.use === "sig"));
    let jwk = pick(await loadJwks(false));
    if (!jwk) jwk = pick(await loadJwks(true));
    if (!jwk) fail("invalid_id_token", "ID token signing key unknown");
    let key;
    try {
      key = createPublicKey({ key: { kty: "RSA", n: jwk.n, e: jwk.e }, format: "jwk" });
    } catch {
      fail("invalid_id_token", "ID token signing key invalid");
    }
    if ((key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) fail("invalid_id_token", "ID token signing key too weak");
    const ok = cryptoVerify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], "base64url"));
    if (!ok) fail("invalid_id_token", "ID token signature invalid");

    const nowS = clock() / 1000;
    if (!claims || typeof claims !== "object") fail("invalid_id_token", "ID token claims invalid");
    if (claims.iss !== ISSUER) fail("invalid_id_token", "ID token issuer mismatch");
    const aud = claims.aud;
    if (typeof aud === "string") {
      if (aud !== clientId) fail("invalid_id_token", "ID token audience mismatch");
    } else if (Array.isArray(aud)) {
      if (!aud.includes(clientId)) fail("invalid_id_token", "ID token audience mismatch");
      if (aud.length > 1 && claims.azp !== clientId) fail("invalid_id_token", "ID token authorized party mismatch");
    } else fail("invalid_id_token", "ID token audience mismatch");
    if (claims.azp !== undefined && claims.azp !== clientId) fail("invalid_id_token", "ID token authorized party mismatch");
    if (!Number.isFinite(claims.exp) || claims.exp <= nowS) fail("invalid_id_token", "ID token expired");
    if (claims.iat !== undefined && (!Number.isFinite(claims.iat) || claims.iat > nowS + 60)) fail("invalid_id_token", "ID token issued in the future");
    if (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf > nowS + 60)) fail("invalid_id_token", "ID token not yet valid");
    if (nonce !== undefined && !safeEqual(claims.nonce, nonce)) fail("invalid_id_token", "ID token nonce mismatch");
    if (typeof claims.sub !== "string" || claims.sub === "") fail("invalid_id_token", "ID token subject missing");
    if (claims.email_verified === false) fail("invalid_id_token", "ID token identity not verified");
    if (subject !== undefined && claims.sub !== subject) fail("identity_mismatch", "ID token identity does not match stored account");
    return claims;
  }

  function validateTokenResponse(body, { requireIdToken }) {
    if (!body || typeof body !== "object") fail("invalid_token_response", "token response invalid");
    if (!tokenString(body.access_token)) fail("invalid_token_response", "token response missing access token");
    if (!tokenString(body.refresh_token)) fail("invalid_token_response", "token response missing rotated refresh token");
    if (typeof body.token_type !== "string" || body.token_type.toLowerCase() !== "bearer") fail("invalid_token_response", "token type not accepted");
    if (!Number.isFinite(body.expires_in) || body.expires_in <= 0 || body.expires_in > MAX_EXPIRES_IN_S) fail("invalid_token_response", "token expiry invalid");
    if (requireIdToken && !tokenString(body.id_token)) fail("invalid_token_response", "token response missing ID token");
    if (body.earliest_refresh_at !== undefined && !Number.isFinite(body.earliest_refresh_at)) fail("invalid_token_response", "earliest_refresh_at invalid");
  }

  async function postToken(form, kind) {
    const res = await timedFetch(
      TOKEN_URL,
      { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: new URLSearchParams(form).toString() },
      `${kind}_timeout`,
      `${kind}_failed`,
    );
    if (res.status !== 200) {
      try {
        await res.body?.cancel();
      } catch {
        /* ignore */
      }
      fail(`${kind}_rejected`, `token endpoint rejected ${kind} (HTTP ${res.status})`);
    }
    return readJson(res);
  }

  // ---------------- login ----------------

  async function beginLogin({ newAccount = false, includeIdTokenHint = false } = {}) {
    let hostId;
    let active;
    try {
      hostId = store.ensureHostId();
      active = newAccount ? null : store.getActive();
    } catch (e) {
      fail("store_error", `credential store unavailable (${e.code ?? "error"})`);
    }
    if (includeIdTokenHint && !active) fail("invalid_option", "id_token_hint requires an existing account");
    const reauth = Boolean(active);
    const state = b64u(randomBytes(32));
    const nonce = b64u(randomBytes(32));
    const verifier = b64u(randomBytes(32));
    const challenge = createHash("sha256").update(verifier).digest("base64url");

    let settle;
    const callback = new Promise((resolve, reject) => {
      settle = { resolve, reject };
    });
    let handled = false;
    const server = http.createServer((req, res) => {
      const u = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method !== "GET" || u.pathname !== CALLBACK_PATH || handled) {
        res.writeHead(404, { "content-type": "text/plain", "cache-control": "no-store" });
        return res.end("not found");
      }
      handled = true;
      settle.resolve({ params: u.searchParams, res });
    });
    server.on("clientError", (_e, socket) => socket.destroy());
    await new Promise((resolve, reject) => {
      server.once("error", () => reject(new SIWCError("callback_listen_failed", "cannot listen on loopback")));
      server.listen(0, "127.0.0.1", resolve);
    });
    const port = server.address().port;
    const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;
    const close = () => {
      server.close();
      server.closeAllConnections?.();
    };
    const timer = setTimeout(() => settle.reject(new SIWCError("login_timeout", "login timed out")), loginTimeoutMs);
    timer.unref?.();

    const params = new URLSearchParams({
      response_type: "code",
      client_id: reauth ? active.client_id : DYNAMIC_CLIENT_ID,
      redirect_uri: redirectUri,
      scope: SCOPE,
      resource: RESOURCE,
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: "S256",
      ext_agent_host_id: hostId,
    });
    if (!reauth) params.set("agent_name_hint", AGENT_NAME_HINT);
    if (includeIdTokenHint) params.set("id_token_hint", active.id_token);
    const url = `${AUTHORIZE_URL}?${params}`;

    async function processCallback(q) {
      if (q.has("error")) fail("authorization_denied", "authorization was not granted");
      if (!safeEqual(q.get("state"), state)) fail("state_mismatch", "callback state mismatch");
      const code = q.get("code");
      if (!tokenString(code)) fail("invalid_callback", "callback missing code");
      const cbClient = q.get("client_id");
      let clientId;
      if (reauth) {
        if (cbClient !== null && cbClient !== active.client_id) fail("client_mismatch", "callback client_id does not match registration");
        clientId = active.client_id;
      } else {
        if (cbClient === null || cbClient === DYNAMIC_CLIENT_ID || !CLIENT_ID_RE.test(cbClient)) fail("invalid_callback", "callback missing issued client_id");
        clientId = cbClient;
      }
      const body = await postToken(
        { grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier, resource: RESOURCE },
        "token",
      );
      validateTokenResponse(body, { requireIdToken: true });
      const scopes = scopesOf(body.scope);
      if (!hasRequiredScopes(scopes)) fail("insufficient_scope", "required SIWC scopes were not granted");
      const claims = await verifyIdToken(body.id_token, { clientId, nonce });
      if (reauth && (claims.iss !== active.issuer || claims.sub !== active.subject)) fail("identity_mismatch", "reauthorized identity does not match stored account");
      const now = clock();
      const record = {
        issuer: claims.iss,
        subject: claims.sub,
        client_id: clientId,
        scopes,
        id_token: body.id_token,
        access_token: body.access_token,
        refresh_token: body.refresh_token,
        token_type: "Bearer",
        expires_at: now + body.expires_in * 1000,
      };
      if (typeof claims.email === "string" && claims.email_verified !== false) record.identity_label = claims.email;
      if (body.earliest_refresh_at !== undefined) record.earliest_refresh_at = body.earliest_refresh_at * 1000;
      let key;
      try {
        key = await store.withLock(async () => store.putAccount(record, { activate: true }));
      } catch (e) {
        fail("store_error", `credential store write failed (${e.code ?? "error"})`);
      }
      cached = { ...record, key };
      needsReauth = false; // fresh token set persisted without refresh marker
      return { issuer: record.issuer, subject: record.subject, identity_label: record.identity_label ?? null };
    }

    const result = (async () => {
      let cb;
      try {
        cb = await callback;
      } finally {
        clearTimeout(timer);
      }
      try {
        const out = await processCallback(cb.params);
        cb.res.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store", "referrer-policy": "no-referrer" });
        cb.res.end("Sign-in complete. You may close this window.");
        return out;
      } catch (e) {
        cb.res.writeHead(400, { "content-type": "text/plain", "cache-control": "no-store", "referrer-policy": "no-referrer" });
        cb.res.end("Sign-in failed.");
        if (e instanceof SIWCError) throw e;
        fail("login_failed", "login failed");
      }
    })().finally(close);
    result.catch(() => {});

    return {
      url,
      port,
      complete: () => result,
      cancel: async () => {
        settle.reject(new SIWCError("login_cancelled", "login cancelled"));
        await result.catch(() => {});
      },
    };
  }

  // ---------------- access token / refresh ----------------

  function usable(rec, now) {
    if (now < rec.expires_at - refreshSkewMs) return true;
    if (Number.isFinite(rec.earliest_refresh_at) && now < rec.earliest_refresh_at) {
      if (now < rec.expires_at) return true;
      fail("token_expired", "access token expired and refresh is not yet permitted");
    }
    return false;
  }

  const reauthRequired = () => fail("reauth_required", "credential state uncertain after refresh; explicit re-login required");

  async function refresh(key) {
    if (needsReauth) reauthRequired();
    try {
      return await store.withLock(async () => {
        const latest = store.getAccount(key);
        if (!latest) fail("not_logged_in", "no SIWC account");
        // Marker seen while WE hold the lock: its writer no longer holds it,
        // so it crashed or failed to save mid-refresh. The stored refresh
        // token may already be consumed by rotation: never reuse it.
        if (latest.refresh_pending_since !== undefined) reauthRequired();
        if (usable(latest, clock())) return { ...latest, key };
        // Durable marker before the POST. Doubles as the writability/safety
        // check: if the store cannot be written, the endpoint is not called
        // and the current refresh token stays valid.
        store.putAccount({ ...latest, refresh_pending_since: clock() });
        let next;
        try {
          const body = await postToken({ grant_type: "refresh_token", refresh_token: latest.refresh_token, client_id: latest.client_id, resource: RESOURCE }, "refresh");
          validateTokenResponse(body, { requireIdToken: false });
          let scopes = latest.scopes;
          if (body.scope !== undefined) {
            scopes = scopesOf(body.scope);
            if (!hasRequiredScopes(scopes)) fail("insufficient_scope", "refreshed grant lacks required SIWC scopes");
          }
          let idToken = latest.id_token;
          if (body.id_token !== undefined) {
            const claims = await verifyIdToken(body.id_token, { clientId: latest.client_id, subject: latest.subject });
            if (claims.iss !== latest.issuer) fail("identity_mismatch", "refreshed identity does not match stored account");
            idToken = body.id_token;
          }
          const now = clock();
          next = {
            ...latest,
            scopes,
            id_token: idToken,
            access_token: body.access_token,
            refresh_token: body.refresh_token,
            token_type: "Bearer",
            expires_at: now + body.expires_in * 1000,
          };
          delete next.earliest_refresh_at;
          if (body.earliest_refresh_at !== undefined) next.earliest_refresh_at = body.earliest_refresh_at * 1000;
        } catch (e) {
          // No validated new token set was obtained: restore the previous
          // record (clears the marker). If even that fails the marker stays
          // and later attempts fail closed with reauth_required.
          try {
            store.putAccount(latest);
          } catch {
            needsReauth = true;
          }
          throw e;
        }
        try {
          store.putAccount(next); // full replacement without marker
        } catch {
          // Rotated set could not be persisted; the old refresh token is
          // probably invalid now. Fail closed; never retry with it.
          needsReauth = true;
          reauthRequired();
        }
        return { ...next, key };
      });
    } catch (e) {
      if (e instanceof SIWCError) throw e;
      fail(e?.code === "lock_timeout" ? "refresh_lock_timeout" : "store_error", `credential refresh failed (${e?.code ?? "error"})`);
    }
  }

  async function getAccessToken() {
    if (needsReauth) reauthRequired();
    if (!cached) {
      let active;
      try {
        active = store.getActive();
      } catch (e) {
        fail("store_error", `credential store unavailable (${e.code ?? "error"})`);
      }
      if (!active) fail("not_logged_in", "no SIWC account; run login");
      cached = active;
    }
    let fresh = false;
    try {
      // A refresh marker may belong to a live refresher (wait for it) or a
      // crashed one (reauth_required): only refresh() can tell, under the lock.
      fresh = cached.refresh_pending_since === undefined && usable(cached, clock());
    } catch (e) {
      // In-memory state may be stale (another process may have renewed);
      // refresh() re-reads the store under the lock and decides from there.
      if (!(e instanceof SIWCError && e.code === "token_expired")) throw e;
    }
    if (fresh) return cached.access_token;
    if (!inflight) {
      const key = cached.key;
      inflight = refresh(key).finally(() => {
        inflight = null;
      });
    }
    cached = await inflight;
    return cached.access_token;
  }

  return { beginLogin, getAccessToken };
}
