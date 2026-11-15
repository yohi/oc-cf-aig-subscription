import { createHash, randomBytes as nodeRandomBytes } from "node:crypto";

export class CapabilityError extends Error {
  constructor(status, message, code) {
    super(message);
    this.name = "CapabilityError";
    this.status = status;
    this.code = code ?? "capability_error";
  }
}

const NUMERIC_LIMITS = [
  "ttlMs",
  "maxCalls",
  "maxCallsPerWindow",
  "windowMs",
  "maxConcurrent",
  "maxRequestBytes",
  "maxResponseBytes",
  "maxTotalBytes",
  "maxRequestDurationMs",
];

const MAX_TIMER_MS = 2 ** 31 - 1;

function digestOf(token) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function validateConfig(config) {
  if (!config || typeof config !== "object") throw new TypeError("capability config required");
  if (typeof config.sandboxID !== "string" || config.sandboxID === "") throw new TypeError("sandboxID label required");
  if (typeof config.model !== "string" || config.model === "") throw new TypeError("model required");
  for (const key of NUMERIC_LIMITS) {
    const v = config[key];
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
      throw new TypeError(`${key} must be a positive finite number`);
    }
  }
}

/**
 * Capability store. Bearers are held only as SHA-256 digests. sandboxID is a
 * management label and is never used for authorization.
 */
export function createCapabilityStore({ now = Date.now, randomBytes = nodeRandomBytes } = {}) {
  const byDigest = new Map();
  const byId = new Map();

  function issue(config) {
    validateConfig(config);
    const token = `ocb_${Buffer.from(randomBytes(32)).toString("base64url")}`;
    const digest = digestOf(token);
    const id = `cap_${digest.slice(0, 16)}`;
    const issuedAt = now();
    const record = {
      id,
      digest,
      sandboxID: config.sandboxID,
      model: config.model,
      limits: Object.fromEntries(NUMERIC_LIMITS.map((k) => [k, config[k]])),
      expiresAt: issuedAt + config.ttlMs,
      revoked: false,
      calls: 0,
      windowStarts: [],
      active: 0,
      totalBytes: 0,
      permits: new Set(),
    };
    byDigest.set(digest, record);
    byId.set(id, record);
    return { token, id };
  }

  function lookup(token) {
    if (typeof token !== "string" || token === "") throw new CapabilityError(401, "unauthorized", "unauthorized");
    const record = byDigest.get(digestOf(token));
    if (!record || record.revoked || now() >= record.expiresAt) {
      throw new CapabilityError(401, "unauthorized", "unauthorized");
    }
    return record;
  }

  function verify(token) {
    return { id: lookup(token).id };
  }

  function revoke(id) {
    const record = byId.get(id);
    if (!record) return;
    record.revoked = true;
    for (const permit of [...record.permits]) permit.abort(new CapabilityError(401, "revoked", "revoked"));
  }

  function authorize({ token, model, requestBytes }) {
    const record = lookup(token);
    if (model !== record.model) throw new CapabilityError(403, "model not permitted", "model_forbidden");
    if (!Number.isSafeInteger(requestBytes) || requestBytes < 0) {
      throw new CapabilityError(400, "invalid request size", "bad_request_size");
    }
    const { limits } = record;
    if (requestBytes > limits.maxRequestBytes) throw new CapabilityError(413, "request too large", "request_too_large");
    const t = now();
    if (record.calls >= limits.maxCalls) throw new CapabilityError(429, "call budget exhausted", "calls_exhausted");
    record.windowStarts = record.windowStarts.filter((s) => t - s < limits.windowMs);
    if (record.windowStarts.length >= limits.maxCallsPerWindow) {
      throw new CapabilityError(429, "rate limited", "rate_limited");
    }
    if (record.active >= limits.maxConcurrent) throw new CapabilityError(429, "too many concurrent streams", "concurrency");
    if (record.totalBytes + requestBytes > limits.maxTotalBytes) {
      throw new CapabilityError(413, "total byte budget exhausted", "total_bytes");
    }

    // Commit state only after every check passed.
    record.calls += 1;
    record.windowStarts.push(t);
    record.active += 1;
    record.totalBytes += requestBytes;

    const controller = new AbortController();
    const startedAt = t;
    let released = false;
    let responseBytes = 0;
    const timers = [];

    const permit = {
      signal: controller.signal,
      abort(reason) {
        if (!controller.signal.aborted) controller.abort(reason);
        permit.release();
      },
      chargeResponse(bytes) {
        if (!Number.isSafeInteger(bytes) || bytes < 0) throw new TypeError("bytes must be a non-negative integer");
        if (released || controller.signal.aborted) {
          throw new CapabilityError(409, "permit is no longer active", "permit_inactive");
        }
        const n = now();
        let error = null;
        if (record.revoked) error = new CapabilityError(401, "revoked", "revoked");
        else if (n >= record.expiresAt) error = new CapabilityError(401, "capability expired", "expired");
        else if (n - startedAt > limits.maxRequestDurationMs) error = new CapabilityError(504, "request duration exceeded", "duration");
        else {
          responseBytes += bytes;
          record.totalBytes += bytes;
          if (responseBytes > limits.maxResponseBytes) error = new CapabilityError(413, "response too large", "response_too_large");
          else if (record.totalBytes > limits.maxTotalBytes) error = new CapabilityError(413, "total byte budget exhausted", "total_bytes");
        }
        if (error) {
          permit.abort(error);
          throw error;
        }
      },
      release() {
        if (released) return;
        released = true;
        for (const timer of timers) clearTimeout(timer);
        record.permits.delete(permit);
        record.active = Math.max(0, record.active - 1);
      },
    };

    const arm = (ms, error) => {
      const timer = setTimeout(() => permit.abort(error), Math.min(Math.max(ms, 0), MAX_TIMER_MS));
      timer.unref?.();
      timers.push(timer);
    };
    arm(limits.maxRequestDurationMs, new CapabilityError(504, "request duration exceeded", "duration"));
    arm(record.expiresAt - t, new CapabilityError(401, "capability expired", "expired"));
    record.permits.add(permit);
    return permit;
  }

  /** Digest-only view for tests/diagnostics. Never contains raw bearers. */
  function describe() {
    return [...byId.values()].map((r) => ({
      id: r.id,
      digest: r.digest,
      sandboxID: r.sandboxID,
      revoked: r.revoked,
      calls: r.calls,
      active: r.active,
      totalBytes: r.totalBytes,
    }));
  }

  return { issue, authorize, verify, revoke, describe };
}
