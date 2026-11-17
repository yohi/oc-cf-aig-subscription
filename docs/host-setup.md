# Host Setup and Limitations

This document describes how to configure the plugin on the OpenCode host, its security properties, and what the current tests do not verify.

## Prerequisites

1. Establish an OpenCode v2.2.5 native OpenAI account with `/connect` → OpenAI → **Sign in with ChatGPT**. Do not choose a legacy Codex login, and do not configure `OPENAI_API_KEY`.
2. Configure the pre-existing Cloudflare AI Gateway Custom Provider `openai-public-probe` to use `https://api.openai.com`. This configuration has been proven at the HTTP PoC level.

## Configure the host process

Provide these variables only to the **host** OpenCode server process. Do not put secrets in tracked files:

```sh
export CF_AIG_BASE='https://gateway.ai.cloudflare.com/v1/<ACCOUNT_ID>/subscription-poc'
# Set CF_AIG_TOKEN securely from a private environment source.
export OC_CF_AIG_HOST_ONLY=1
```

Load this directory as an absolute-path plugin in `opencode.jsonc`, then restart OpenCode:

```json
{ "plugins": ["/absolute/path/to/oc-cf-aig-subscription"] }
```

`OC_CF_AIG_HOST_ONLY` is an explicit opt-in, not proof of host isolation. Verify independently that the runtime is outside the Sandbox.

## OC2 Guest-to-Host Broker TLS

The OC2 Guest Provider uses a separate Host Broker contract. It accepts HTTPS
only at `host.docker.internal` or `127.0.0.1`; it does not use this Host-only
plugin's Cloudflare Gateway route. The Broker remains bound to `127.0.0.1`.

Create a dedicated CA on an offline machine. Keep its encrypted private key and
the passphrase offline; distribute only the public CA certificate:

```sh
umask 077
openssl req -x509 -newkey rsa:3072 -sha256 -days 3650 \
  -subj "/CN=OC2 Broker Private CA" \
  -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
  -addext "keyUsage=critical,keyCertSign,cRLSign" \
  -addext "subjectKeyIdentifier=hash" \
  -addext "authorityKeyIdentifier=keyid:always,issuer" \
  -keyout oc2-broker-ca.key \
  -out oc2-broker-ca.pem
```

Generate the Broker leaf private key and CSR on the Host:

```sh
TLS_DIR="$HOME/.config/oc-cf-aig/tls"
install -d -m 700 "$TLS_DIR"
umask 077
openssl req -new -newkey rsa:3072 -nodes \
  -subj "/CN=host.docker.internal" \
  -keyout "$TLS_DIR/broker.key" \
  -out "$TLS_DIR/broker.csr"
chmod 600 "$TLS_DIR/broker.key"
```

Transfer only `broker.csr` to the offline CA operator. Issue the leaf with
these extensions:

```ini
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectKeyIdentifier=hash
authorityKeyIdentifier=keyid,issuer
subjectAltName=DNS:host.docker.internal,IP:127.0.0.1
```

The offline signer runs:

```sh
openssl x509 -req -in broker.csr \
  -CA oc2-broker-ca.pem -CAkey oc2-broker-ca.key -CAcreateserial \
  -days 365 -extfile broker.ext -out broker.crt
```

Keep `oc2-broker-ca.key` offline. Return `broker.crt` to the Host and place the
public `oc2-broker-ca.pem` where the operator can provide it to `oc2`. The
Broker leaf key must remain a regular Host-only file with mode `0600`. Start
`host-broker serve` with `--tls-cert "$TLS_DIR/broker.crt"` and
`--tls-key "$TLS_DIR/broker.key"`; the options also accept the path variables
`OC_CF_AIG_TLS_CERT` and `OC_CF_AIG_TLS_KEY`. Pass only the public CA
certificate to dotfiles-ai with `--host-broker-ca-cert`.

Do not copy either private key to dotfiles-ai, the Guest, a Sandbox, or a
repository. Do not disable TLS verification or fall back to HTTP. For the full
Sandbox launch procedure and capability handoff, see
[Sandbox acceptance](sandbox-acceptance.md). Renew the leaf before expiry; CA
rotation requires updating the public CA input and creates a distinct OC2
Runtime Identity.

## Security properties

The plugin requires a native SIWC OAuth account rather than an API key or legacy Codex login. It pins the Cloudflare Gateway origin, sets `cf-aig-no-wholesale: true`, disables AI Gateway-stored payloads and cache, forces HTTP transport without compression, and rejects direct or off-path session inference.

`cf-aig-collect-log-payload: false` affects only request/response payloads stored in AI Gateway's own logs; it **does not prevent Logpush from exporting request and response bodies**. If external storage of prompt and response bodies is prohibited, **disable Logpush for the target Gateway** and ensure no active Logpush job exports that Gateway's data. Turning off Gateway logging or setting this request header is insufficient to stop Logpush. See [Cloudflare Logpush documentation](https://developers.cloudflare.com/ai-gateway/observability/logging/logpush/).

When Cloudflare Gateway configuration is invalid but host-only opt-in is enabled, setup completes with OpenAI `model.request` and `http.request` hooks that reject requests. This guarantee requires the plugin to remain loaded; a plugin that is missing or fails to load cannot enforce the hooks.

The Host-only Gateway plugin does not commit or store OAuth access or refresh tokens, but can access the OpenCode OAuth token and Cloudflare Gateway token at runtime. **Do not deploy this plugin to the OC2 Docker Sandbox.** The separately authorized Guest-to-Host Broker is a distinct runtime: the Guest receives only a public CA certificate and a limited Broker capability, not these Host credentials. Its live Sandbox behavior still requires the acceptance procedure below.

## Checks and limitations

Run the offline checks with:

```sh
npm test
npm run check
```

Unit tests use mocked hooks. They do not establish compatibility with a running OpenCode v2.2.5 instance, OAuth token renewal, streaming or tool-call correctness, all-traffic routing, or subscription billing attribution. Only native HTTP Responses calls issued through Session are enforced. Model discovery and other application traffic are not established as routed through the Gateway.

## Changes requiring an Owner decision

Do not extend the Broker contract, modify network policy, deploy into the Sandbox, create further review tasks, or merge changes without a separate Owner decision.
