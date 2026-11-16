import { isDeepStrictEqual } from "node:util";

export const BROKER_MODEL = "gpt-6-luna";
export const READ_FILE_SCHEMA = Object.freeze({
  type: "object",
  properties: { path: { type: "string" } },
  required: ["path"],
  additionalProperties: false,
});
export const DEFAULT_INCLUDE = "reasoning.encrypted_content";
export const GUEST_NAMESPACE = "guest";
export const GUEST_TOOL = "read_file";

export class PolicyError extends Error {
  constructor(status, message, code) {
    super(message);
    this.name = "PolicyError";
    this.status = status;
    this.code = code ?? "invalid_request";
  }
}

const bad = (message) => new PolicyError(400, message, "invalid_request");

// Guest-controlled headers that must never be honoured or even tolerated.
const FORBIDDEN_HEADER = /^(cf-aig-|x-forwarded-|proxy-|x-api-key$|api-key$|cookie$|set-cookie$|forwarded$|x-real-ip$|x-target|x-upstream|x-original-url$|openai-|x-openai-|anthropic-)/i;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isStr = (v) => typeof v === "string";

function checkKeys(obj, required, optional, where) {
  const keys = Object.keys(obj);
  for (const k of required) if (!(k in obj)) throw bad(`${where}: missing ${k}`);
  const allowed = new Set([...required, ...optional]);
  for (const k of keys) if (!allowed.has(k)) throw bad(`${where}: unsupported field ${k}`);
}

function validateHeaders(headers, limits) {
  let size = 0;
  for (const [name, value] of Object.entries(headers ?? {})) {
    size += name.length + String(value).length + 4;
    if (FORBIDDEN_HEADER.test(name)) throw bad(`unsupported header ${name.toLowerCase()}`);
  }
  if (limits?.maxHeaderBytes && size > limits.maxHeaderBytes) throw new PolicyError(413, "headers too large", "headers_too_large");
}

function validateTextBlocks(content, type, where) {
  if (!Array.isArray(content) || content.length === 0) throw bad(`${where}: content must be a non-empty array`);
  for (const block of content) {
    if (!isObj(block)) throw bad(`${where}: invalid content block`);
    checkKeys(block, ["type", "text"], [], `${where} content`);
    if (block.type !== type || !isStr(block.text)) throw bad(`${where}: content block must be ${type} text`);
  }
}

function validateMessage(item) {
  switch (item.role) {
    case "developer":
      checkKeys(item, ["type", "role", "content"], [], "developer message");
      if (!isStr(item.content)) throw bad("developer message content must be a string");
      break;
    case "user":
      checkKeys(item, ["type", "role", "content"], ["id", "status"], "user message");
      validateTextBlocks(item.content, "input_text", "user message");
      break;
    case "assistant":
      checkKeys(item, ["type", "role", "content"], ["id", "status", "phase"], "assistant message");
      validateTextBlocks(item.content, "output_text", "assistant message");
      if ("phase" in item && ![null, "commentary", "final_answer"].includes(item.phase)) throw bad("assistant message: invalid phase");
      break;
    default:
      throw bad("unsupported message role");
  }
  for (const k of ["id", "status"]) if (k in item && !isStr(item[k])) throw bad(`message ${k} must be a string`);
  return item;
}

function validateReasoning(item) {
  checkKeys(item, ["type", "summary"], ["id", "encrypted_content"], "reasoning");
  if (!Array.isArray(item.summary)) throw bad("reasoning summary must be an array");
  for (const s of item.summary) {
    if (!isObj(s)) throw bad("reasoning summary entry invalid");
    checkKeys(s, ["type", "text"], [], "reasoning summary");
    if (s.type !== "summary_text" || !isStr(s.text)) throw bad("reasoning summary entry invalid");
  }
  if ("id" in item && !isStr(item.id)) throw bad("reasoning id must be a string");
  if ("encrypted_content" in item && item.encrypted_content !== null && !isStr(item.encrypted_content)) {
    throw bad("reasoning encrypted_content must be a string or null");
  }
  return item;
}

function validateInput(input) {
  if (!Array.isArray(input) || input.length === 0) throw bad("input must be a non-empty array");
  const out = [];
  const pending = new Set();
  const seenCalls = new Set();
  for (const item of input) {
    if (!isObj(item) || !isStr(item.type)) throw bad("invalid input item");
    switch (item.type) {
      case "message":
        out.push(validateMessage(item));
        break;
      case "reasoning":
        out.push(validateReasoning(item));
        break;
      case "function_call": {
        checkKeys(item, ["type", "name", "call_id", "arguments"], ["id", "namespace", "status"], "function_call");
        if (item.name !== GUEST_TOOL) throw bad("function_call: unsupported tool name");
        if ("namespace" in item && item.namespace !== GUEST_NAMESPACE) throw bad("function_call: unsupported namespace");
        if (!isStr(item.call_id) || item.call_id === "") throw bad("function_call: call_id required");
        if (seenCalls.has(item.call_id)) throw bad("function_call: duplicate call_id");
        if (!isStr(item.arguments)) throw bad("function_call: arguments must be a string");
        for (const k of ["id", "status"]) if (k in item && !isStr(item[k])) throw bad(`function_call: ${k} must be a string`);
        seenCalls.add(item.call_id);
        pending.add(item.call_id);
        const { namespace: _ns, ...rest } = item;
        out.push({ ...rest, namespace: GUEST_NAMESPACE });
        break;
      }
      case "function_call_output":
        checkKeys(item, ["type", "call_id", "output"], ["id", "status"], "function_call_output");
        if (!isStr(item.call_id) || !isStr(item.output)) throw bad("function_call_output: call_id and string output required");
        for (const k of ["id", "status"]) if (k in item && !isStr(item[k])) throw bad(`function_call_output: ${k} must be a string`);
        if (!pending.delete(item.call_id)) throw bad("function_call_output: unmatched or duplicate call_id");
        out.push(item);
        break;
      default:
        throw bad(`unsupported input item type ${item.type}`);
    }
  }
  if (pending.size > 0) throw bad("function_call without matching function_call_output");
  return out;
}

function projectTools(tools) {
  if (!Array.isArray(tools)) throw bad("tools must be an array");
  if (tools.length === 0) return undefined;
  if (tools.length !== 1) throw bad("only a single read_file tool is supported");
  const tool = tools[0];
  if (!isObj(tool)) throw bad("invalid tool");
  checkKeys(tool, ["type", "name", "description", "parameters", "strict"], [], "tool");
  if (tool.type !== "function" || tool.name !== GUEST_TOOL) throw bad("unsupported tool");
  if (!isStr(tool.description)) throw bad("tool description must be a string");
  if (tool.strict !== false) throw bad("tool strict must be literal false");
  if (!isDeepStrictEqual(tool.parameters, READ_FILE_SCHEMA)) throw bad("tool schema mismatch");
  return [
    {
      type: "namespace",
      name: GUEST_NAMESPACE,
      description: "Sandbox-local tools",
      tools: [
        { type: "function", name: GUEST_TOOL, description: tool.description, parameters: structuredClone(READ_FILE_SCHEMA), strict: false },
      ],
    },
  ];
}

// OpenCode Core v2.2.5 adds text:{verbosity:"low"} to Responses requests. Only that exact shape
// (single key, OpenAI Responses text.verbosity enum) is admitted; text.format and anything else is refused.
const TEXT_VERBOSITY = new Set(["low", "medium", "high"]);
function validateText(text) {
  if (!isObj(text)) throw bad("text must be an object");
  checkKeys(text, ["verbosity"], [], "text");
  if (!isStr(text.verbosity) || !TEXT_VERBOSITY.has(text.verbosity)) throw bad("text.verbosity must be low, medium or high");
  return { verbosity: text.verbosity };
}

export function parseBrokerRequest({ method, pathname, headers, body, limits = {} }) {
  if (pathname !== "/v1/responses") throw new PolicyError(404, "not found", "not_found");
  if (method !== "POST") throw new PolicyError(405, "method not allowed", "method_not_allowed");
  validateHeaders(headers, limits);
  const ct = String(headers?.["content-type"] ?? "");
  if (!/^application\/json\s*(;|$)/i.test(ct)) throw bad("content-type must be application/json");
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body ?? "", "utf8");
  if (limits.maxBodyBytes && buf.length > limits.maxBodyBytes) throw new PolicyError(413, "request too large", "request_too_large");
  let json;
  try {
    json = JSON.parse(buf.toString("utf8"));
  } catch {
    throw bad("invalid JSON");
  }
  if (!isObj(json)) throw bad("body must be a JSON object");
  // Anything not listed here (including prompt_cache_key, previous_response_id, ...) is rejected, never stripped.
  checkKeys(json, ["model", "input", "stream"], ["store", "include", "instructions", "tools", "text"], "request");
  if (json.model !== BROKER_MODEL) throw bad("unsupported model");
  if (json.stream !== true) throw bad("stream must be true");
  if ("store" in json && json.store !== false) throw bad("store must be false or absent");
  if ("include" in json && !isDeepStrictEqual(json.include, [DEFAULT_INCLUDE])) throw bad("unsupported include");
  if ("instructions" in json && !isStr(json.instructions)) throw bad("instructions must be a string");

  const parsed = { model: BROKER_MODEL, input: validateInput(json.input), stream: true, store: false };
  if ("include" in json) parsed.include = [DEFAULT_INCLUDE];
  if ("instructions" in json) parsed.instructions = json.instructions;
  if ("text" in json) parsed.text = validateText(json.text);
  if ("tools" in json) {
    const tools = projectTools(json.tools);
    if (tools) parsed.tools = tools;
  }
  return parsed;
}
