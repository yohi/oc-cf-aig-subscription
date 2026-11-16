import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseLaunchArgs, buildChildEnv, verifyOpencodeVersion, launch, LaunchError } from "../../bin/guest-launch.mjs";
import { TEST_CAPABILITY } from "./harness.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const LAUNCHER = path.join(ROOT, "bin/guest-launch.mjs");
const BROKER_URL = "http://host.docker.internal:49187/v1";

function fakeOpencode({ version = "2.2.5" } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-opencode-"));
  const script = path.join(dir, "opencode");
  fs.writeFileSync(script, `#!${process.execPath}
if (process.argv[2] === "--version") { process.stdout.write(${JSON.stringify(version)} + "\\n"); process.exit(process.env.OC_CF_AIG_BROKER_CAPABILITY ? 9 : 0); }
const e = process.env;
process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), mode: e.OC_CF_AIG_ACCEPTANCE_MODE, url: e.OC_CF_AIG_BROKER_URL, cap: e.OC_CF_AIG_BROKER_CAPABILITY, root: e.OC_CF_AIG_GUEST_FIXTURE_ROOT ?? null, host: Object.keys(e).filter((k) => /^(CF_AIG_|OPENAI_API_KEY|OC_CF_AIG_HOST_ONLY)/.test(k)) }));
`, { mode: 0o700 });
  return script;
}

function run(args, { input, extraFd, env = {}, stdinFile } = {}) {
  return new Promise((resolve) => {
    const stdio = [stdinFile ? fs.openSync(stdinFile, "r") : "pipe", "pipe", "pipe"];
    if (extraFd) stdio.push("pipe");
    const child = spawn(process.execPath, [LAUNCHER, ...args], { stdio, env: { PATH: process.env.PATH, ...env } });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    if (!stdinFile) {
      if (input !== undefined && !extraFd) child.stdin.end(input);
      else child.stdin.end();
    }
    if (extraFd) child.stdio[3].end(input);
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

test("argument parsing: explicit mode/URL, no capability in argv, unknown flags refused", () => {
  const ok = parseLaunchArgs(["--mode=m1", `--broker-url=${BROKER_URL}`, "--opencode=/opt/oc/opencode", "--", "run", "say gateway-ok"]);
  assert.deepEqual(ok, { mode: "m1", brokerURL: BROKER_URL, capabilityFd: 0, fixtureRoot: undefined, opencodeBin: "/opt/oc/opencode", opencodeArgs: ["run", "say gateway-ok"] });
  assert.equal(parseLaunchArgs(["--mode=m2", `--broker-url=${BROKER_URL}`, "--capability-fd=3", "--fixture-root=/work/fixture"]).capabilityFd, 3);
  for (const bad of [
    [], ["--mode=m3", `--broker-url=${BROKER_URL}`], [`--broker-url=${BROKER_URL}`], ["--mode=m1"],
    ["--mode=m1", "--broker-url=https://api.openai.com/v1"],
    ["--mode=m1", `--broker-url=${BROKER_URL}`, `--capability=${TEST_CAPABILITY}`],
    ["--mode=m1", `--broker-url=${BROKER_URL}`, "--token=x"],
    ["--mode=m1", `--broker-url=${BROKER_URL}`, "--", "run", TEST_CAPABILITY],
    ["--mode=m1", `--broker-url=${BROKER_URL}`, "positional"],
    ["--mode=m1", `--broker-url=${BROKER_URL}`, "--capability-fd=1"],
    ["--mode=m1", `--broker-url=${BROKER_URL}`, "--capability-fd=abc"],
    ["--mode=m2", `--broker-url=${BROKER_URL}`, "--fixture-root=relative"],
    ["--mode=m1", `--broker-url=${BROKER_URL}`, "--opencode=relative/opencode"],
  ]) assert.throws(() => parseLaunchArgs(bad), LaunchError, JSON.stringify(bad));
});

test("child env carries the capability only in the child; Host secrets in the launcher env are refused", () => {
  const parent = { PATH: "/usr/bin", HOME: "/guest-home", OC_CF_AIG_STALE: "x" };
  const env = buildChildEnv(parent, { mode: "m2", brokerURL: BROKER_URL, capability: TEST_CAPABILITY, fixtureRoot: "/work/fixture" });
  assert.deepEqual(env, {
    PATH: "/usr/bin", HOME: "/guest-home", OC_CF_AIG_ACCEPTANCE_MODE: "m2", OC_CF_AIG_BROKER_URL: BROKER_URL,
    OC_CF_AIG_BROKER_CAPABILITY: TEST_CAPABILITY, OC_CF_AIG_GUEST_FIXTURE_ROOT: "/work/fixture",
  });
  assert.equal(parent.OC_CF_AIG_BROKER_CAPABILITY, undefined);
  for (const k of ["CF_AIG_TOKEN", "CF_AIG_BASE", "OPENAI_API_KEY", "OC_CF_AIG_HOST_ONLY", "OC_CF_AIG_BROKER_CAPABILITY"]) {
    assert.throws(() => buildChildEnv({ ...parent, [k]: "v" }, { mode: "m1", brokerURL: BROKER_URL, capability: TEST_CAPABILITY }), LaunchError, k);
  }
});

test("version verification is injectable and fails closed on anything but OpenCode 2.2.5", async () => {
  await verifyOpencodeVersion("/opt/oc/opencode", { runVersion: async () => "2.2.5\n" });
  await verifyOpencodeVersion("/opt/oc/opencode", { runVersion: async () => "v2.2.5" });
  // Real Core v2.2.5 prints "opencode v2.2.5" (observed in the Sandbox).
  await verifyOpencodeVersion("/opt/oc/opencode", { runVersion: async () => "opencode v2.2.5\n" });
  await verifyOpencodeVersion("/opt/oc/opencode", { runVersion: async () => "  opencode v2.2.5  \n" });
  for (const v of ["2.2.6", "2.2.5-beta", "opencode 2.2.4", "", "opencode 2.2.5", "opencode v2.2.5\nextra", "x\nopencode v2.2.5", "opencode v2.2.5 beta", "OpenCode v2.2.5", "opencode  v2.2.5"]) {
    await assert.rejects(verifyOpencodeVersion("/opt/oc/opencode", { runVersion: async () => v }), LaunchError, v);
  }
  await assert.rejects(verifyOpencodeVersion("/opt/oc/opencode", { runVersion: async () => { throw new Error("ENOENT"); } }), LaunchError);
});

test("launch: verifies version before reading the capability and never mutates the launcher env", async () => {
  const order = [];
  const spawned = [];
  const parentEnv = { PATH: "/usr/bin" };
  const code = await launch({
    argv: ["--mode=m1", `--broker-url=${BROKER_URL}`, "--opencode=/opt/oc/opencode", "--", "run", "hi"],
    env: parentEnv,
    deps: {
      runVersion: async (bin, env) => { order.push("version"); assert.equal(env.OC_CF_AIG_BROKER_CAPABILITY, undefined); return "2.2.5"; },
      readCapability: async (fd) => { order.push(`read:${fd}`); return TEST_CAPABILITY; },
      spawn: (bin, args, opts) => { spawned.push({ bin, args, opts }); return { on(ev, cb) { if (ev === "close") setImmediate(() => cb(0)); } }; },
    },
  });
  assert.equal(code, 0);
  assert.deepEqual(order, ["version", "read:0"]);
  assert.equal(spawned.length, 1);
  assert.deepEqual(spawned[0].args, ["run", "hi"]);
  assert.ok(!spawned[0].args.join(" ").includes(TEST_CAPABILITY));
  assert.equal(spawned[0].opts.env.OC_CF_AIG_BROKER_CAPABILITY, TEST_CAPABILITY);
  assert.equal(spawned[0].opts.stdio[0], "ignore", "stdin capability pipe is not handed to the child");
  assert.deepEqual(parentEnv, { PATH: "/usr/bin" });
  assert.equal(process.env.OC_CF_AIG_BROKER_CAPABILITY, undefined);

  const noSpawn = [];
  await assert.rejects(launch({
    argv: ["--mode=m1", `--broker-url=${BROKER_URL}`, "--opencode=/opt/oc/opencode"], env: {},
    deps: { runVersion: async () => "2.2.6", readCapability: async () => { noSpawn.push("read"); return TEST_CAPABILITY; }, spawn: () => { noSpawn.push("spawn"); } },
  }), LaunchError);
  assert.deepEqual(noSpawn, []);
});

test("process: stdin pipe handoff reaches only the child OpenCode env (m1)", async () => {
  const oc = fakeOpencode();
  const r = await run(["--mode=m1", `--broker-url=${BROKER_URL}`, `--opencode=${oc}`, "--", "run", "say gateway-ok"], { input: `${TEST_CAPABILITY}\n` });
  assert.equal(r.code, 0, r.err);
  const seen = JSON.parse(r.out);
  assert.deepEqual(seen, { argv: ["run", "say gateway-ok"], mode: "m1", url: BROKER_URL, cap: TEST_CAPABILITY, root: null, host: [] });
  assert.ok(!r.err.includes(TEST_CAPABILITY), "capability never logged");
});

test("process: inherited --capability-fd handoff (m2) and STOP cases", async () => {
  const oc = fakeOpencode();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "guest-fixture-"));
  const r = await run(["--mode=m2", `--broker-url=${BROKER_URL}`, "--capability-fd=3", `--fixture-root=${root}`, `--opencode=${oc}`], { input: `${TEST_CAPABILITY}\n`, extraFd: true });
  assert.equal(r.code, 0, r.err);
  assert.equal(JSON.parse(r.out).cap, TEST_CAPABILITY);
  assert.equal(JSON.parse(r.out).mode, "m2");

  // Regular file on stdin (would persist the bearer) is refused.
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cap-file-")), "cap");
  fs.writeFileSync(file, `${TEST_CAPABILITY}\n`, { mode: 0o600 });
  const reg = await run(["--mode=m1", `--broker-url=${BROKER_URL}`, `--opencode=${oc}`], { stdinFile: file });
  assert.notEqual(reg.code, 0);
  assert.equal(reg.out, "", "OpenCode not started");
  assert.ok(!reg.err.includes(TEST_CAPABILITY));

  for (const [label, args, opts] of [
    ["bad capability", ["--mode=m1", `--broker-url=${BROKER_URL}`, `--opencode=${oc}`], { input: "sk-test\n" }],
    ["empty capability", ["--mode=m1", `--broker-url=${BROKER_URL}`, `--opencode=${oc}`], { input: "" }],
    ["wrong version", ["--mode=m1", `--broker-url=${BROKER_URL}`, `--opencode=${fakeOpencode({ version: "2.3.0" })}`], { input: `${TEST_CAPABILITY}\n` }],
    ["host secret in env", ["--mode=m1", `--broker-url=${BROKER_URL}`, `--opencode=${oc}`], { input: `${TEST_CAPABILITY}\n`, env: { CF_AIG_TOKEN: "HOST" } }],
    ["missing mode", [`--broker-url=${BROKER_URL}`, `--opencode=${oc}`], { input: `${TEST_CAPABILITY}\n` }],
  ]) {
    const res = await run(args, opts);
    assert.notEqual(res.code, 0, label);
    assert.equal(res.out, "", `${label}: OpenCode not started`);
    assert.ok(!res.err.includes(TEST_CAPABILITY), `${label}: no capability in logs`);
    assert.ok(!res.err.includes("HOST"), `${label}: no host secret in logs`);
  }
});

// ---------- credential-like variable filter (child env only) ----------
// NOTE: this filter does not prove Sandbox-wide credential safety.

const OPTS = { mode: "m1", brokerURL: BROKER_URL, capability: TEST_CAPABILITY };

test("child env drops credential-like variables by exact name, prefix and suffix", () => {
  const dropped = [
    "GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_PAT", "ANTHROPIC_FOO", "OPENAI_ORG", "CF_ACCOUNT_ID",
    "CLOUDFLARE_API_BASE", "AWS_PROFILE", "AZURE_CLIENT", "GOOGLE_APPLICATION_CREDENTIALS", "GEMINI_X", "HF_HOME",
    "NPM_TOKEN", "NPM_CONFIG_TOKEN", "MCP_SENTINEL_TOKEN_NAME", "FOO_TOKEN", "FOO_SECRET", "FOO_PASSWORD", "FOO_API_KEY",
    "FOO_APIKEY", "FOO_CREDENTIALS", "SSH_AUTH_SOCK",
  ];
  const parent = { PATH: "/usr/bin", ...Object.fromEntries(dropped.map((k) => [k, "value-" + k])) };
  const env = buildChildEnv(parent, OPTS);
  for (const k of dropped) assert.ok(!(k in env), k);
  assert.equal(env.PATH, "/usr/bin");
});

test("child env keeps proxy, locale and GIT_CONFIG_* variables", () => {
  const keep = {
    HTTP_PROXY: "http://p:1", HTTPS_PROXY: "http://p:1", http_proxy: "http://p:1", https_proxy: "http://p:1", NO_PROXY: "x", no_proxy: "x",
    PATH: "/usr/bin", HOME: "/h", LANG: "C", TERM: "xterm", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "k", GIT_CONFIG_VALUE_0: "v",
  };
  const env = buildChildEnv({ ...keep }, OPTS);
  for (const [k, v] of Object.entries(keep)) assert.equal(env[k], v, k);
});

test("sentinel-looking credential values are still dropped; launcher env is not mutated; no value leaks in errors", () => {
  const parent = { PATH: "/usr/bin", GH_TOKEN: "ghp_SENTINEL_looking_value", MCP_SENTINEL_TOKEN_NAME: "SENTINEL", FOO_SECRET: "s3cr3t-value" };
  const snapshot = structuredClone(parent);
  const env = buildChildEnv(parent, OPTS);
  assert.ok(!("GH_TOKEN" in env) && !("MCP_SENTINEL_TOKEN_NAME" in env) && !("FOO_SECRET" in env));
  assert.deepEqual(parent, snapshot);
  assert.ok(!JSON.stringify(env).includes("SENTINEL") && !JSON.stringify(env).includes("s3cr3t-value"));
  try {
    buildChildEnv({ ...parent, CF_AIG_TOKEN: "leak-me-123" }, OPTS);
    assert.fail("must refuse");
  } catch (e) {
    assert.ok(e instanceof LaunchError);
    assert.ok(!e.message.includes("leak-me-123") && !e.message.includes("s3cr3t-value"));
  }
});
