import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createCapabilityStore } from "../../src/broker/capabilities.mjs";

function setup(overrides = {}) {
  const clock = { t: 1_000_000 };
  let n = 0;
  const randomBytes = (len) => Buffer.alloc(len, ++n);
  const store = createCapabilityStore({ now: () => clock.t, randomBytes });
  const config = {
    sandboxID: "sbx-test",
    model: "gpt-6-luna",
    ttlMs: 60_000,
    maxCalls: 3,
    maxCallsPerWindow: 10,
    windowMs: 1_000,
    maxConcurrent: 2,
    maxRequestBytes: 100,
    maxResponseBytes: 100,
    maxTotalBytes: 1_000,
    maxRequestDurationMs: 5_000,
    ...overrides,
  };
  const { token, id } = store.issue(config);
  const auth = (extra = {}) => store.authorize({ token, model: "gpt-6-luna", requestBytes: 10, ...extra });
  return { clock, store, token, id, auth, config };
}

function rejects(fn, status) {
  assert.throws(fn, (e) => {
    assert.equal(e.status, status, `expected ${status}, got ${e.status}: ${e.message}`);
    return true;
  });
}

test("stores only a SHA-256 digest of the bearer and never logs it", () => {
  const logs = [];
  const orig = {};
  for (const k of ["log", "error", "warn", "info", "debug"]) {
    orig[k] = console[k];
    console[k] = (...a) => logs.push(a.join(" "));
  }
  let token, store;
  try {
    ({ store, token } = setup());
    const permit = store.authorize({ token, model: "gpt-6-luna", requestBytes: 1 });
    permit.release();
    assert.throws(() => store.authorize({ token: token + "x", model: "gpt-6-luna", requestBytes: 1 }));
  } finally {
    Object.assign(console, orig);
  }
  const state = JSON.stringify(store.describe());
  assert.ok(!state.includes(token));
  assert.ok(state.includes(createHash("sha256").update(token).digest("hex")));
  assert.ok(!logs.join("\n").includes(token));
});

test("forged or arbitrary tokens and sandboxID never authorize", () => {
  const { store, config } = setup();
  rejects(() => store.authorize({ token: "sbx-test", model: "gpt-6-luna", requestBytes: 1 }), 401);
  rejects(() => store.authorize({ token: config.sandboxID + ":forged", model: "gpt-6-luna", requestBytes: 1 }), 401);
  rejects(() => store.authorize({ token: "", model: "gpt-6-luna", requestBytes: 1 }), 401);
  rejects(() => store.authorize({ model: "gpt-6-luna", requestBytes: 1 }), 401);
});

test("issue requires every numeric limit to be positive and finite", () => {
  const { store, config } = setup();
  for (const key of ["ttlMs", "maxCalls", "maxCallsPerWindow", "windowMs", "maxConcurrent", "maxRequestBytes", "maxResponseBytes", "maxTotalBytes", "maxRequestDurationMs"]) {
    for (const bad of [0, -1, NaN, Infinity, undefined, "5"]) {
      assert.throws(() => store.issue({ ...config, [key]: bad }), undefined, `${key}=${String(bad)}`);
    }
  }
});

test("valid bearer is reusable until maxCalls, then rejected", () => {
  const { auth } = setup({ maxCalls: 3 });
  for (let i = 0; i < 3; i++) auth().release();
  rejects(() => auth(), 429);
});

test("wrong model is rejected", () => {
  const { auth } = setup();
  rejects(() => auth({ model: "gpt-other" }), 403);
});

test("expiry and revocation reject", () => {
  const a = setup({ ttlMs: 1_000 });
  a.auth().release();
  a.clock.t += 1_001;
  rejects(() => a.auth(), 401);
  const b = setup();
  b.store.revoke(b.id);
  rejects(() => b.auth(), 401);
});

test("revoke aborts in-flight permit", () => {
  const { store, id, auth } = setup();
  const p = auth();
  store.revoke(id);
  assert.equal(p.signal.aborted, true);
  p.release();
});

test("maxCallsPerWindow within windowMs, recovers after the window", () => {
  const { clock, auth } = setup({ maxCallsPerWindow: 2, windowMs: 1_000, maxCalls: 100 });
  auth().release();
  auth().release();
  rejects(() => auth(), 429);
  clock.t += 1_001;
  auth().release();
});

test("maxConcurrent limits active streams and release frees a slot", () => {
  const { auth } = setup({ maxConcurrent: 2, maxCalls: 100 });
  const p1 = auth();
  const p2 = auth();
  rejects(() => auth(), 429);
  p1.release();
  const p3 = auth();
  p2.release();
  p3.release();
});

test("release is idempotent and cannot underflow the concurrency counter", () => {
  const { auth } = setup({ maxConcurrent: 1, maxCalls: 100 });
  const p1 = auth();
  p1.release();
  p1.release();
  p1.release();
  const p2 = auth();
  rejects(() => auth(), 429);
  p2.release();
});

test("parallel contention admits at most maxConcurrent", async () => {
  const { auth } = setup({ maxConcurrent: 3, maxCalls: 100, maxCallsPerWindow: 100 });
  const results = await Promise.all(
    Array.from({ length: 10 }, async () => {
      try {
        return auth();
      } catch (e) {
        return e;
      }
    }),
  );
  assert.equal(results.filter((r) => typeof r.release === "function").length, 3);
});

test("request bytes are measured per call and per total", () => {
  const { auth } = setup({ maxRequestBytes: 50, maxTotalBytes: 80, maxCalls: 100 });
  rejects(() => auth({ requestBytes: 51 }), 413);
  auth({ requestBytes: 50 }).release();
  rejects(() => auth({ requestBytes: 40 }), 413); // 50+40 > 80
  rejects(() => auth({ requestBytes: -1 }), 400);
  rejects(() => auth({ requestBytes: 1.5 }), 400);
});

test("rejected authorizations do not consume budget", () => {
  const { auth } = setup({ maxCalls: 1, maxRequestBytes: 50 });
  rejects(() => auth({ requestBytes: 51 }), 413);
  auth({ requestBytes: 1 }).release();
});

test("response bytes are enforced incrementally per call and abort + release", () => {
  const { auth } = setup({ maxResponseBytes: 30, maxConcurrent: 1, maxCalls: 100 });
  const p = auth();
  p.chargeResponse(10);
  p.chargeResponse(20);
  assert.throws(() => p.chargeResponse(1), (e) => e.status === 413);
  assert.equal(p.signal.aborted, true);
  const p2 = auth(); // slot released by the failure
  p2.release();
});

test("cumulative maxTotalBytes counts request and response across calls", () => {
  const { auth } = setup({ maxTotalBytes: 100, maxResponseBytes: 100, maxCalls: 100 });
  const p1 = auth({ requestBytes: 10 });
  p1.chargeResponse(50);
  p1.release();
  const p2 = auth({ requestBytes: 10 }); // total 70
  assert.throws(() => p2.chargeResponse(31), (e) => e.status === 413);
  assert.equal(p2.signal.aborted, true);
  rejects(() => auth({ requestBytes: 1 }), 413);
});

test("TTL is enforced during an active stream", () => {
  const { clock, auth } = setup({ ttlMs: 1_000 });
  const p = auth();
  p.chargeResponse(1);
  clock.t += 1_001;
  assert.throws(() => p.chargeResponse(1), (e) => e.status === 401);
  assert.equal(p.signal.aborted, true);
});

test("maxRequestDurationMs is enforced via chargeResponse clock and via timer abort", async () => {
  const a = setup({ maxRequestDurationMs: 100 });
  const p = a.auth();
  a.clock.t += 101;
  assert.throws(() => p.chargeResponse(1), (e) => e.status === 504);
  assert.equal(p.signal.aborted, true);

  const b = setup({ maxRequestDurationMs: 20 });
  const q = b.auth();
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(q.signal.aborted, true);
  q.release();
});

test("chargeResponse rejects invalid byte counts and use after release", () => {
  const { auth } = setup();
  const p = auth();
  assert.throws(() => p.chargeResponse(-1));
  assert.throws(() => p.chargeResponse(1.5));
  const p2 = auth();
  p2.release();
  assert.throws(() => p2.chargeResponse(1));
});
