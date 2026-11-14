import { Plugin } from "@opencode/plugin"
import { registerGateway } from "./gateway.mjs"

export default Plugin.define({
  id: "oc-cf-aig-subscription",
  async setup(ctx) {
    await registerGateway(ctx)
  },
})
