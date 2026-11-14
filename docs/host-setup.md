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

## Security properties

The plugin requires a native SIWC OAuth account rather than an API key or legacy Codex login. It pins the Cloudflare Gateway origin, sets `cf-aig-no-wholesale: true`, disables AI Gateway-stored payloads and cache, forces HTTP transport without compression, and rejects direct or off-path session inference.

`cf-aig-collect-log-payload: false` affects only request/response payloads stored in AI Gateway's own logs; it **does not prevent Logpush from exporting request and response bodies**. If external storage of prompt and response bodies is prohibited, **disable Logpush for the target Gateway** and ensure no active Logpush job exports that Gateway's data. Turning off Gateway logging or setting this request header is insufficient to stop Logpush. See [Cloudflare Logpush documentation](https://developers.cloudflare.com/ai-gateway/observability/logging/logpush/).

When Cloudflare Gateway configuration is invalid but host-only opt-in is enabled, setup completes with OpenAI `model.request` and `http.request` hooks that reject requests. This guarantee requires the plugin to remain loaded; a plugin that is missing or fails to load cannot enforce the hooks.

The plugin does not commit or store OAuth access or refresh tokens. At runtime, however, it can access the OpenCode OAuth token and Cloudflare Gateway token. This build is Host-only. **Do not deploy it to the OC2 Docker Sandbox**, where the guest would have access to those credentials. A separate Host-side authenticated bridge would require explicit Owner authorization and validation.

## Checks and limitations

Run the offline checks with:

```sh
npm test
npm run check
```

Unit tests use mocked hooks. They do not establish compatibility with a running OpenCode v2.2.5 instance, OAuth token renewal, streaming or tool-call correctness, all-traffic routing, or subscription billing attribution. Only native HTTP Responses calls issued through Session are enforced. Model discovery and other application traffic are not established as routed through the Gateway.

## Changes requiring an Owner decision

Do not add a Host bridge, modify network policy, deploy into the Sandbox, create further review tasks, or merge changes without a separate Owner decision.
