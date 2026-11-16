// Local Guest plugin directory entrypoint (loaded by directory path inside the
// disposable Sandbox only). The Host-only plugin lives in ../index.js.
import { Plugin } from "@opencode/plugin"
import { setupGuest } from "./provider.mjs"

export default Plugin.define({
  id: "oc-cf-aig-guest",
  async setup(ctx) {
    await setupGuest(ctx, process.env)
  },
})
