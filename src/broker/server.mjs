import https from "node:https";
import { once } from "node:events";
import { BROKER_MODEL, PolicyError } from "./policy.mjs";

const DEFAULT_LIMITS = { maxBodyBytes: 1024 * 1024, maxHeaderBytes: 8192, bodyReadTimeoutMs: 15_000, headersTimeoutMs: 10_000 };
const TERMINAL_FAILURE = new Set(["response.failed", "response.incomplete", "error"]);

function sendJson(res, status, error, code) {
  if (res.headersSent) return res.destroy();
  const body = JSON.stringify({ error: { message: error, code } });
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body), connection: "close" });
  res.end(body);
}

function bearerOf(req) {
  const m = /^Bearer ([^\s]+)$/.exec(String(req.headers.authorization ?? ""));
  return m ? m[1] : undefined;
}

/** Reads the body with a finite wall-clock deadline; a stalled client is disconnected. */
async function readBody(req, max, timeoutMs) {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > max) throw new PolicyError(413, "request too large", "request_too_large");
  const chunks = [];
  let size = 0;
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new PolicyError(408, "request body timeout", "request_timeout"));
      req.destroy();
    }, timeoutMs);
  });
  const read = (async () => {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > max) throw new PolicyError(413, "request too large", "request_too_large");
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, size);
  })();
  read.catch(() => {});
  try {
    return await Promise.race([read, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** Incremental SSE validator: returns validated events, throws on invalid framing. */
function createSseValidator() {
  let carry = "";
  let buffer = "";
  let completed = false;
  const decoder = new TextDecoder("utf-8", { fatal: true });

  function parseEvent(block) {
    let event;
    const data = [];
    let comments = 0;
    for (const line of block.split("\n")) {
      if (line === "") continue;
      if (line.startsWith(":")) { comments++; continue; }
      const idx = line.indexOf(":");
      const field = idx === -1 ? line : line.slice(0, idx);
      const value = idx === -1 ? "" : line.slice(idx + 1).replace(/^ /, "");
      if (field === "event") event = value;
      else if (field === "data") data.push(value);
      else if (field === "id" || field === "retry") continue;
      else throw new Error("invalid SSE field");
    }
    if (data.length === 0) {
      if (event !== undefined || comments === 0) throw new Error("SSE event without data");
      return { type: null, text: `${block}\n\n` };
    }
    let json;
    try { json = JSON.parse(data.join("\n")); } catch { throw new Error("SSE data is not JSON"); }
    if (json === null || typeof json !== "object" || typeof json.type !== "string") throw new Error("SSE data lacks type");
    if (event !== undefined && event !== json.type) throw new Error("SSE event/type mismatch");
    return { type: json.type, text: `${block}\n\n` };
  }

  return {
    push(bytes) {
      let text;
      try { text = decoder.decode(bytes, { stream: true }); } catch { throw new Error("invalid UTF-8"); }
      let normalized = (carry + text).replace(/\r\n/g, "\n");
      carry = normalized.endsWith("\r") ? "\r" : "";
      if (carry) normalized = normalized.slice(0, -1);
      buffer += normalized;
      const events = [];
      for (;;) {
        const end = buffer.indexOf("\n\n");
        if (end === -1) break;
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (completed && block.trim() !== "" && !block.split("\n").every((l) => l === "" || l.startsWith(":"))) {
          throw new Error("data after response.completed");
        }
        if (block.trim() === "") continue;
        const ev = parseEvent(block);
        if (ev.type && TERMINAL_FAILURE.has(ev.type)) throw new Error(`upstream ${ev.type}`);
        if (ev.type === "response.completed") completed = true;
        events.push(ev);
      }
      return events;
    },
    finish() {
      try { decoder.decode(); } catch { throw new Error("invalid UTF-8"); }
      if (carry !== "" || buffer.trim() !== "") throw new Error("truncated SSE event");
      if (!completed) throw new Error("stream ended without response.completed");
    },
  };
}

export function createBrokerServer({ capabilities, parseRequest, upstream, limits = {}, tls }) {
  if (!tls?.cert || !tls?.key) throw new TypeError("Broker HTTPS certificate and key are required");
  const lim = { ...DEFAULT_LIMITS, ...limits };

  async function handleResponses(req, res) {
    const token = bearerOf(req);
    if (!token) return sendJson(res, 401, "unauthorized", "unauthorized");
    try {
      capabilities.verify(token);
    } catch (e) {
      return sendJson(res, e.status ?? 401, "unauthorized", "unauthorized");
    }

    let body;
    try {
      body = await readBody(req, lim.maxBodyBytes, lim.bodyReadTimeoutMs);
    } catch (e) {
      return sendJson(res, e.status ?? 400, e.message, e.code);
    }

    let permit;
    try {
      permit = capabilities.authorize({ token, model: BROKER_MODEL, requestBytes: body.length });
    } catch (e) {
      return sendJson(res, e.status ?? 401, e.status === 401 ? "unauthorized" : e.message, e.code ?? "unauthorized");
    }

    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      permit.release();
    };
    const ac = new AbortController();
    const abort = () => {
      if (!ac.signal.aborted) ac.abort();
      // A stalled client must not keep the handler (and Permit) alive once aborted.
      if (res.headersSent && !res.destroyed) res.destroy();
    };
    permit.signal?.addEventListener("abort", abort, { once: true });
    if (permit.signal?.aborted) abort();
    res.on("close", () => {
      if (!res.writableFinished) abort();
    });

    let reader;
    let succeeded = false;
    try {
      let parsed;
      try {
        parsed = parseRequest({ method: req.method, pathname: "/v1/responses", headers: req.headers, body, limits: lim });
      } catch (e) {
        if (e instanceof PolicyError) return sendJson(res, e.status, e.message, e.code);
        return sendJson(res, 400, "invalid request", "invalid_request");
      }

      let upstreamRes;
      try {
        upstreamRes = await upstream(parsed, ac.signal);
      } catch {
        abort();
        return sendJson(res, 502, "upstream unavailable", "upstream_error");
      }
      if (!upstreamRes || !upstreamRes.ok || !upstreamRes.body) {
        abort();
        upstreamRes?.body?.cancel().catch(() => {});
        return sendJson(res, 502, "upstream error", "upstream_error");
      }

      reader = upstreamRes.body.getReader();
      ac.signal.addEventListener("abort", () => { reader.cancel().catch(() => {}); }, { once: true });
      if (ac.signal.aborted) reader.cancel().catch(() => {});
      const validator = createSseValidator();
      const send = async (text) => {
        if (!res.headersSent) {
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "close" });
        }
        if (!res.write(text)) await Promise.race([once(res, "drain"), once(res, "close")]);
        if (res.destroyed) throw new Error("client disconnected");
      };

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        permit.chargeResponse(value.byteLength);
        for (const ev of validator.push(value)) await send(ev.text);
      }
      if (ac.signal.aborted) throw new Error("aborted");
      validator.finish();
      succeeded = true;
      res.end();
    } catch {
      if (!succeeded) {
        abort();
        reader?.cancel().catch(() => {});
        if (!res.headersSent) sendJson(res, 502, "upstream stream failed", "stream_failed");
        else res.destroy();
      }
    } finally {
      release();
    }
  }

  const server = https.createServer({ cert: tls.cert, key: tls.key }, async (req, res) => {
    try {
      const { pathname } = new URL(req.url, "http://localhost");
      if (pathname === "/health") {
        if (req.method !== "GET") return sendJson(res, 405, "method not allowed", "method_not_allowed");
        res.writeHead(200, { "content-type": "application/json" });
        return res.end('{"status":"ok"}');
      }
      if (pathname === "/v1/models") {
        if (req.method !== "GET") return sendJson(res, 405, "method not allowed", "method_not_allowed");
        const token = bearerOf(req);
        try { capabilities.verify(token); } catch { return sendJson(res, 401, "unauthorized", "unauthorized"); }
        const body = JSON.stringify({ object: "list", data: [{ id: BROKER_MODEL, object: "model" }] });
        res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
        return res.end(body);
      }
      if (pathname === "/v1/responses") {
        if (req.method !== "POST") return sendJson(res, 405, "method not allowed", "method_not_allowed");
        return await handleResponses(req, res);
      }
      return sendJson(res, 404, "not found", "not_found");
    } catch {
      sendJson(res, 500, "internal error", "internal_error");
    }
  });
  // Finite pre-authentication / request deadlines (Node defaults can be disabled by callers).
  server.headersTimeout = lim.headersTimeoutMs;
  server.requestTimeout = Math.max(lim.bodyReadTimeoutMs, lim.headersTimeoutMs) + 1000;
  server.connectionsCheckingInterval = Math.min(1000, Math.max(50, Math.floor(lim.headersTimeoutMs / 2)));
  return server;
}
