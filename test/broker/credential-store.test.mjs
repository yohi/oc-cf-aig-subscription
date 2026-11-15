import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createCredentialStore, CredentialStoreError } from "../../src/broker/credential-store.mjs";

const SECRET_ACCESS = "SECRET-ACCESS-tok_aaaaaaaa";
const SECRET_REFRESH = "SECRET-REFRESH-tok_bbbbbbbb";
const SECRET_ID = "SECRET-ID-tok_cccccccc";
const UUID_V4 = /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function tmpRoot() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "oc2-cred-")));
}

function freshPath() {
  const root = tmpRoot();
  return { root, dir: path.join(root, "store"), file: path.join(root, "store", "siwc.json") };
}

function record(extra = {}) {
  return {
    issuer: "https://auth.openai.com",
    subject: "user-123",
    identity_label: "owner@example.test",
    client_id: "issued-client-A",
    scopes: ["openid", "profile", "email", "offline_access", "resource.invoke", "chatgpt.tokens.use.direct"],
    id_token: SECRET_ID,
    access_token: SECRET_ACCESS,
    refresh_token: SECRET_REFRESH,
    token_type: "Bearer",
    expires_at: 2_000_000,
    ...extra,
  };
}

function assertNoSecret(err) {
  const text = `${err?.message}\n${err?.stack}\n${JSON.stringify(err)}`;
  for (const s of [SECRET_ACCESS, SECRET_REFRESH, SECRET_ID]) assert.ok(!text.includes(s), "secret leaked in error");
}

test("Host ID is a stable urn:uuid v4 persisted across restarts, in a 0700 dir / 0600 file", () => {
  const { dir, file } = freshPath();
  const a = createCredentialStore({ path: file });
  const id = a.ensureHostId();
  assert.match(id, UUID_V4);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const b = createCredentialStore({ path: file });
  assert.equal(b.ensureHostId(), id);
  assert.equal(b.load().ext_agent_host_id, id);
});

test("accounts are stored separately per issuer/subject with distinct issued client IDs", () => {
  const { file } = freshPath();
  const store = createCredentialStore({ path: file });
  store.ensureHostId();
  const k1 = store.putAccount(record(), { activate: true });
  const k2 = store.putAccount(record({ subject: "user-456", client_id: "issued-client-B", earliest_refresh_at: 1_500_000 }));
  assert.notEqual(k1, k2);
  const reopened = createCredentialStore({ path: file });
  assert.equal(reopened.getAccount(k1).client_id, "issued-client-A");
  assert.equal(reopened.getAccount(k2).client_id, "issued-client-B");
  assert.equal(reopened.getAccount(k2).earliest_refresh_at, 1_500_000);
  assert.equal(reopened.getActive().subject, "user-123");
  assert.deepEqual(reopened.getAccount(k1).scopes, record().scopes);
  assert.equal(reopened.getAccount(k1).refresh_token, SECRET_REFRESH);
  assert.equal(reopened.getAccount(k1).id_token, SECRET_ID);
});

test("token-set replacement is atomic: whole record replaced, mode stays 0600, no temp files left", () => {
  const { dir, file } = freshPath();
  const store = createCredentialStore({ path: file });
  store.ensureHostId();
  const key = store.putAccount(record(), { activate: true });
  const inodeBefore = fs.statSync(file).ino;
  store.putAccount(record({ access_token: "new-access", refresh_token: "new-refresh", expires_at: 3_000_000 }));
  const got = createCredentialStore({ path: file }).getAccount(key);
  assert.equal(got.access_token, "new-access");
  assert.equal(got.refresh_token, "new-refresh");
  assert.equal(got.expires_at, 3_000_000);
  assert.notEqual(fs.statSync(file).ino, inodeBefore, "replaced by rename, not in-place write");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n !== "siwc.json"), []);
});

test("putAccount rejects incomplete token sets without leaking secrets", () => {
  const { file } = freshPath();
  const store = createCredentialStore({ path: file });
  store.ensureHostId();
  for (const bad of [{ refresh_token: "" }, { client_id: undefined }, { expires_at: Number.NaN }, { scopes: "openid" }, { subject: "" }]) {
    assert.throws(() => store.putAccount(record(bad)), (e) => {
      assert.ok(e instanceof CredentialStoreError);
      assertNoSecret(e);
      return true;
    });
  }
});

test("refuses a symlinked credential file", () => {
  const { root, dir, file } = freshPath();
  fs.mkdirSync(dir, { mode: 0o700 });
  const target = path.join(root, "elsewhere.json");
  fs.writeFileSync(target, "{}", { mode: 0o600 });
  fs.symlinkSync(target, file);
  const store = createCredentialStore({ path: file });
  assert.throws(() => store.load(), (e) => e instanceof CredentialStoreError && e.code === "unsafe_path");
  assert.throws(() => store.ensureHostId(), (e) => e instanceof CredentialStoreError && e.code === "unsafe_path");
  assert.equal(fs.readFileSync(target, "utf8"), "{}", "symlink target untouched");
});

test("refuses a symlinked directory or symlinked path component", () => {
  const root = tmpRoot();
  const real = path.join(root, "real");
  fs.mkdirSync(real, { mode: 0o700 });
  const link = path.join(root, "link");
  fs.symlinkSync(real, link);
  const store = createCredentialStore({ path: path.join(link, "siwc.json") });
  assert.throws(() => store.ensureHostId(), (e) => e.code === "unsafe_path");
  assert.deepEqual(fs.readdirSync(real), []);
});

test("refuses group/other-accessible directory and file modes", () => {
  const { dir, file } = freshPath();
  fs.mkdirSync(dir, { mode: 0o700 });
  fs.chmodSync(dir, 0o755);
  assert.throws(() => createCredentialStore({ path: file }).ensureHostId(), (e) => e.code === "unsafe_mode");
  fs.chmodSync(dir, 0o700);
  createCredentialStore({ path: file }).ensureHostId();
  fs.chmodSync(file, 0o644);
  assert.throws(() => createCredentialStore({ path: file }).load(), (e) => e.code === "unsafe_mode");
});

test("refuses relative paths and non-regular files", () => {
  assert.throws(() => createCredentialStore({ path: "relative/siwc.json" }), (e) => e.code === "unsafe_path");
  const { dir, file } = freshPath();
  fs.mkdirSync(dir, { mode: 0o700 });
  fs.mkdirSync(file, { mode: 0o700 });
  assert.throws(() => createCredentialStore({ path: file }).load(), (e) => e.code === "unsafe_path");
});

test("corrupt store errors never echo file contents", () => {
  const { dir, file } = freshPath();
  fs.mkdirSync(dir, { mode: 0o700 });
  fs.writeFileSync(file, `{"access_token":"${SECRET_ACCESS}"`, { mode: 0o600 });
  assert.throws(() => createCredentialStore({ path: file }).load(), (e) => {
    assert.equal(e.code, "corrupt_store");
    assertNoSecret(e);
    return true;
  });
});

test("store operations never write secrets to console", () => {
  const { file } = freshPath();
  const seen = [];
  const orig = {};
  for (const m of ["log", "info", "warn", "error", "debug"]) {
    orig[m] = console[m];
    console[m] = (...a) => seen.push(a.join(" "));
  }
  try {
    const store = createCredentialStore({ path: file });
    store.ensureHostId();
    store.putAccount(record(), { activate: true });
    store.getActive();
  } finally {
    Object.assign(console, orig);
  }
  assert.ok(!seen.join("\n").includes("SECRET"));
});

test("withLock serializes concurrent holders across store instances", async () => {
  const { file } = freshPath();
  const a = createCredentialStore({ path: file, lockPollMs: 5 });
  const b = createCredentialStore({ path: file, lockPollMs: 5 });
  a.ensureHostId();
  const order = [];
  const hold = (store, name) =>
    store.withLock(async () => {
      order.push(`${name}:in`);
      await new Promise((r) => setTimeout(r, 30));
      order.push(`${name}:out`);
    });
  await Promise.all([hold(a, "a"), hold(b, "b")]);
  assert.ok(order.join(",") === "a:in,a:out,b:in,b:out" || order.join(",") === "b:in,b:out,a:in,a:out", order.join(","));
  assert.ok(!fs.existsSync(`${file}.lock`), "lock released");
});

test("withLock waits for a lock held by another live process", async () => {
  const { file } = freshPath();
  createCredentialStore({ path: file }).ensureHostId();
  const modUrl = new URL("../../src/broker/credential-store.mjs", import.meta.url).href;
  const child = spawn(process.execPath, [
    "--input-type=module",
    "-e",
    `import { createCredentialStore } from ${JSON.stringify(modUrl)};
     const s = createCredentialStore({ path: process.argv[1] });
     await s.withLock(async () => { process.stdout.write("locked\\n"); await new Promise(r => setTimeout(r, 250)); });`,
    file,
  ]);
  await new Promise((resolve, reject) => {
    child.stdout.on("data", (d) => String(d).includes("locked") && resolve());
    child.on("exit", (c) => reject(new Error(`child exited ${c}`)));
  });
  const started = Date.now();
  let entered;
  await createCredentialStore({ path: file, lockPollMs: 10 }).withLock(async () => {
    entered = Date.now();
  });
  assert.ok(entered - started >= 100, `entered after ${entered - started}ms`);
  await new Promise((r) => child.exitCode !== null ? r() : child.on("exit", r));
});

test("withLock recovers a stale lock left by a dead process", async () => {
  const { file } = freshPath();
  createCredentialStore({ path: file }).ensureHostId();
  const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"]);
  const deadPid = Number(String(dead.stdout));
  fs.writeFileSync(`${file}.lock`, JSON.stringify({ pid: deadPid, created: Date.now() }), { mode: 0o600 });
  let ran = false;
  await createCredentialStore({ path: file, lockPollMs: 5, lockTimeoutMs: 2000 }).withLock(async () => {
    ran = true;
  });
  assert.ok(ran);
});

test("withLock fails closed after timeout while a live holder keeps the lock", async () => {
  const { file } = freshPath();
  createCredentialStore({ path: file }).ensureHostId();
  fs.writeFileSync(`${file}.lock`, JSON.stringify({ pid: process.pid, created: Date.now() }), { mode: 0o600 });
  await assert.rejects(
    createCredentialStore({ path: file, lockPollMs: 5, lockTimeoutMs: 60, lockStaleMs: 60_000 }).withLock(async () => {}),
    (e) => e instanceof CredentialStoreError && e.code === "lock_timeout",
  );
  assert.ok(fs.existsSync(`${file}.lock`), "live lock not stolen");
});

test("withLock refuses a symlinked lock file", async () => {
  const { root, file } = freshPath();
  createCredentialStore({ path: file }).ensureHostId();
  const target = path.join(root, "victim");
  fs.writeFileSync(target, "keep", { mode: 0o600 });
  fs.symlinkSync(target, `${file}.lock`);
  await assert.rejects(
    createCredentialStore({ path: file, lockPollMs: 5, lockTimeoutMs: 60 }).withLock(async () => {}),
    (e) => e instanceof CredentialStoreError && e.code === "unsafe_path",
  );
  assert.equal(fs.readFileSync(target, "utf8"), "keep");
});
