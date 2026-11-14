# oc-cf-aig-subscription

OpenCode **v2.2.5** integration for subscription-based model requests through **Cloudflare AI Gateway**. The implementation intentionally avoids BYOK and Cloudflare Unified Billing fallback.

**Status:** Host-only MVP with offline tests. **Not yet tested against a running OpenCode v2.2.5 or inside OC2 Docker Sandbox.** Do not deploy to the Sandbox: it would expose `CF_AIG_TOKEN` and the native OpenCode OAuth session inside the guest. A separate Host-side authenticated bridge would need explicit Owner authorization and validation.

## Scope

- **ChatGPT Plus / Pro:** Reuse OpenCode's built-in `Sign in with ChatGPT` / `chatgpt-token-sharing` OAuth integration. Plugin restricts the `openai` provider's Responses requests to the already-tested Cloudflare Custom Provider `custom-openai-public-probe`.
- **Claude Pro:** Use the existing OpenCode `claude-agent` + Claude Code's standard `ANTHROPIC_BASE_URL` / `ANTHROPIC_CUSTOM_HEADERS` configuration. No duplicate Claude authentication code.
- No Neon Functions, Workers, Codex credential imports, OpenCode source modification, or automatic API-key fallback.

## Security

The plugin requires a native SIWC OAuth account (not an API key or legacy Codex login), pins the Cloudflare Gateway origin, sets `cf-aig-no-wholesale: true`, disables Gateway payload logging/cache, forces HTTP transport with no compression, and rejects direct or off-path session inference. No actual OAuth access/refresh token is committed or stored by the plugin. **The runtime does have access to the OpenCode OAuth token and Cloudflare Gateway token; this build is Host-only.**

## Host-only setup (not for Docker Sandbox)

1. Establish an OpenCode v2.2.5 native OpenAI account with `/connect` → OpenAI → **Sign in with ChatGPT**; do not choose a legacy Codex login. No `OPENAI_API_KEY`.
2. Configure the pre-existing Cloudflare AI Gateway Custom Provider `openai-public-probe` to use `https://api.openai.com` (already proven at the HTTP PoC level).
3. Supply these variables only in the **host** OpenCode server process (do not put secrets in any tracked file):

```sh
export CF_AIG_BASE='https://gateway.ai.cloudflare.com/v1/<ACCOUNT_ID>/subscription-poc'
# Set CF_AIG_TOKEN securely from a private environment source.
export OC_CF_AIG_HOST_ONLY=1
```

4. Load this directory via `opencode.jsonc` as an absolute-path plugin, and restart OpenCode:

```json
{ "plugins": ["/absolute/path/to/oc-cf-aig-subscription"] }
```

The `OC_CF_AIG_HOST_ONLY` flag is an **explicit opt-in, not proof of host isolation**; the actual runtime must independently be trusted and verified to be outside the Sandbox.

## Checks and limitations

```sh
npm test
npm run check
```

Unit tests use mocked hooks. They do **not** establish OpenCode v2.2.5 end-to-end compatibility, OAuth token renewal, streaming/tool-call correctness, all traffic routing, or subscription billing attribution. Only native HTTP Responses calls issued through Session are enforced. Do not infer that model discovery and other app traffic are routed.

**Checkpoint:** Do not add a Host bridge, modify network policy, deploy into Sandbox, create further review tasks, or merge changes without a separate Owner decision.

## Versioned source references

- https://github.com/anomalyco/opencode/blob/v2.2.5/packages/plugin/src/promise/session.ts
- https://github.com/anomalyco/opencode/blob/v2.2.5/packages/plugin/src/promise/integration.ts
- https://github.com/anomalyco/opencode/blob/v2.2.5/packages/schema/src/credential.ts
- https://opencode.ai/docs/providers
