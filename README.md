# oc-cf-aig-subscription

Host-only OpenCode v2.2.5 integration for routing subscription-based model requests through Cloudflare AI Gateway. The plugin reuses native ChatGPT OAuth and Claude Code configuration; it does not provide BYOK or Cloudflare Unified Billing fallback.

> **Status:** MVP with offline tests only. It has not been tested against a running OpenCode v2.2.5 instance or inside the OC2 Docker Sandbox. Do not deploy it to the Sandbox: doing so would expose `CF_AIG_TOKEN` and the native OpenCode OAuth session to the guest.

## Quick start

See [Host setup and limitations](docs/host-setup.md) for prerequisites, configuration, security properties, and known limitations.

Run the offline checks with:

```sh
npm test
npm run check
```

## Scope

- **ChatGPT Plus / Pro:** Reuses OpenCode's built-in `Sign in with ChatGPT` / `chatgpt-token-sharing` OAuth integration. The plugin routes the `openai` provider's Responses requests through the tested Cloudflare Custom Provider `custom-openai-public-probe`.
- **Claude Pro:** Uses the existing OpenCode `claude-agent` and Claude Code's standard `ANTHROPIC_BASE_URL` / `ANTHROPIC_CUSTOM_HEADERS` configuration.
- No Neon Functions, Workers, Codex credential imports, OpenCode source modifications, or automatic API-key fallback.

## Versioned source references

- [OpenCode session integration](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/plugin/src/promise/session.ts)
- [OpenCode plugin integration](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/plugin/src/promise/integration.ts)
- [OpenCode credential schema](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/schema/src/credential.ts)
- [OpenCode providers documentation](https://opencode.ai/docs/providers)
