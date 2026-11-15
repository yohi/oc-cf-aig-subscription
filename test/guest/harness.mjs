// Minimal offline stand-in for the parts of OpenCode Core that a Guest plugin
// touches (provider/tool editors, scoped session hooks, context tool map and
// identity-based dispatch). It is a TEST DOUBLE: it does not prove Core
// v2.2.5 behaviour, only that the Guest plugin honours the documented contract.
import assert from "node:assert/strict";

export const DEFAULT_TOOL_NAMES = ["bash", "read", "edit", "write", "execute"];
const FORBIDDEN_CTX = ["integration", "credential", "aisdk", "mcp", "shell"];

export function createFakeCore({ withOpenAI = true, preRegister = [] } = {}) {
  const providers = new Map();
  if (withOpenAI) providers.set("openai", { provider: { id: "openai", name: "OpenAI", activation: "auto", package: "@opencode/ai/providers/openai" }, models: new Map() });
  const tools = new Map();
  const namespaces = new Map();
  const definitions = new Map(); // tool id -> stable context definition object
  const idByDefinition = new WeakMap();
  const hooks = [];
  const calls = { providerTransform: 0, toolTransform: 0, forbidden: [] };

  const defineTool = (id, info) => {
    tools.set(id, { ...info, id });
    const def = { description: info.description, input: info.input };
    definitions.set(id, def);
    idByDefinition.set(def, id);
  };
  for (const name of DEFAULT_TOOL_NAMES) {
    defineTool(name, { name, description: `default ${name}`, input: { type: "object" }, execute: async () => { throw new Error(`HOST/default tool ${name} executed`); } });
  }
  for (const t of preRegister) defineTool(t.id, t);

  const providerEditor = {
    list: () => [...providers.values()],
    get: (id) => providers.get(id),
    add({ info, models }) {
      if (providers.has(info.id)) throw new Error(`provider ${info.id} already exists`);
      providers.set(info.id, { provider: info, models: new Map(models.map((m) => [m.id, m])) });
    },
    update(id, fn) { const p = providers.get(id); if (p) fn(p.provider); },
    remove(id) { providers.delete(id); },
    models: { set() {}, update() {}, remove() {} },
  };
  const toolEditor = {
    list: () => [...tools.values()],
    get: (id) => tools.get(id),
    namespace(ns) { namespaces.set(ns.name, ns); },
    add(info) {
      const ns = info.options?.namespace;
      if (ns !== undefined && !namespaces.has(ns)) throw new Error(`namespace ${ns} not declared`);
      const id = ns ? `${ns}_${info.name}` : info.name;
      if (tools.has(id)) throw new Error(`tool ${id} already exists`);
      defineTool(id, info);
    },
    update() {},
    remove(id) { tools.delete(id); },
  };

  const base = {
    provider: { async transform(cb) { calls.providerTransform++; cb(providerEditor); return { dispose: async () => {} }; } },
    tool: {
      async transform(cb) { calls.toolTransform++; cb(toolEditor); return { dispose: async () => {} }; },
      async list() { return [...tools.values()]; },
    },
    session: {
      async hook(name, callback, options) { hooks.push({ name, callback, options }); return { dispose: async () => {} }; },
    },
  };
  const ctx = new Proxy(base, {
    get(target, prop) {
      if (FORBIDDEN_CTX.includes(prop)) {
        calls.forbidden.push(prop);
        throw new Error(`Guest plugin must not access ctx.${String(prop)}`);
      }
      return target[prop];
    },
  });

  async function runHook(name, event, providerID) {
    for (const h of hooks) {
      if (h.name !== name) continue;
      if (h.options?.providerID !== undefined && h.options.providerID !== providerID) continue;
      await h.callback(event);
    }
    return event;
  }

  /** Build the per-request context map Core would hand to `session.context`. */
  function contextTools({ extra = true } = {}) {
    const map = {};
    for (const [id, def] of definitions) if (tools.has(id)) map[id] = def;
    if (extra) map.arbitrary_extra = { description: "injected extra", input: { type: "object" } };
    return map;
  }

  /** Emulates SessionModelRequest identity mapping: flat name -> definition object -> registry executor. */
  async function dispatch(contextMap, call) {
    if (typeof call.name !== "string" || /[./]/.test(call.name)) throw new Error("dispatch: invalid tool name");
    if (call.namespace !== undefined && call.namespace !== "guest") throw new Error("dispatch: foreign namespace");
    if (!Object.hasOwn(contextMap, call.name)) throw new Error(`dispatch: tool ${call.name} not exposed`);
    const id = idByDefinition.get(contextMap[call.name]);
    if (id === undefined) throw new Error("dispatch: definition identity not registered");
    const tool = tools.get(id);
    assert.ok(tool, "registry tool exists");
    return { id, result: await tool.execute(call.input, { signal: new AbortController().signal }) };
  }

  return { ctx, providers, tools, namespaces, definitions, hooks, calls, runHook, contextTools, dispatch, idByDefinition };
}

export function envProxy(values) {
  const accessed = new Set();
  const env = new Proxy({ ...values }, {
    get(target, prop) { if (typeof prop === "string") accessed.add(prop); return target[prop]; },
    has(target, prop) { if (typeof prop === "string") accessed.add(prop); return prop in target; },
    ownKeys() { throw new Error("Guest plugin must not enumerate the environment"); },
  });
  return { env, accessed };
}

export const TEST_CAPABILITY = `ocb_${"A".repeat(43)}`;
