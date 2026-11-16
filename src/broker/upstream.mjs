const GATEWAY_BASE = /^https:\/\/gateway\.ai\.cloudflare\.com\/v1\/[0-9a-f]{32}\/[A-Za-z0-9._-]+$/;
const ROUTE = "/custom-openai-public-probe/v1/responses";
// eslint-disable-next-line no-control-regex
const UNSAFE_VALUE = /[\u0000-\u001f\u007f\s]/;

function headerSafe(value, name) {
  if (typeof value !== "string" || value === "" || UNSAFE_VALUE.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

/**
 * Host-only Cloudflare AI Gateway upstream. The destination, credentials and
 * control headers are fixed here; nothing from the Guest request is forwarded
 * except the validated, rebuilt JSON body.
 */
export function createCloudflareUpstream({ gatewayBase, gatewayToken, credentialSource, fetchImpl = globalThis.fetch }) {
  if (typeof gatewayBase !== "string" || !GATEWAY_BASE.test(gatewayBase) || /\/\.{1,2}$/.test(gatewayBase)) throw new TypeError("invalid gatewayBase");
  headerSafe(gatewayToken, "gatewayToken");
  if (typeof credentialSource?.getAccessToken !== "function") throw new TypeError("credentialSource required");
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl required");
  const url = `${gatewayBase}${ROUTE}`;

  return async function upstream(parsed, signal) {
    if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    let accessTokenPromise = credentialSource.getAccessToken();
    if (signal) {
      let onAbort;
      try {
        accessTokenPromise = await Promise.race([
          accessTokenPromise,
          new Promise((_, reject) => {
            onAbort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
            signal.addEventListener("abort", onAbort, { once: true });
            if (signal.aborted) onAbort();
          }),
        ]);
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    } else {
      accessTokenPromise = await accessTokenPromise;
    }
    const accessToken = headerSafe(accessTokenPromise, "access token");
    const body = { model: parsed.model, input: parsed.input, stream: true, store: false };
    if (parsed.include) body.include = parsed.include;
    if (parsed.instructions !== undefined) body.instructions = parsed.instructions;
    if (parsed.text) body.text = { verbosity: parsed.text.verbosity };
    if (parsed.tools) body.tools = parsed.tools;
    return fetchImpl(url, {
      method: "POST",
      redirect: "manual",
      signal,
      headers: {
        authorization: `Bearer ${accessToken}`,
        "cf-aig-authorization": `Bearer ${gatewayToken}`,
        "cf-aig-no-wholesale": "true",
        "cf-aig-collect-log-payload": "false",
        "cf-aig-skip-cache": "true",
        "content-type": "application/json",
        accept: "text/event-stream",
      },
      body: JSON.stringify(body),
    });
  };
}
