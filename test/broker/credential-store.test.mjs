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

test("withLock treats a fresh empty/unparseable lockfile (holder mid-write) as live and does not steal it", async () => {
  const { file } = freshPath();
  createCredentialStore({ path: file }).ensureHostId();
  fs.writeFileSync(`${file}.lock`, "", { mode: 0o600 });
  await assert.rejects(
    createCredentialStore({ path: file, lockPollMs: 5, lockTimeoutMs: 80, lockStaleMs: 60_000 }).withLock(async () => assert.fail("stole lock")),
    (e) => e instanceof CredentialStoreError && e.code === "lock_timeout",
  );
  assert.ok(fs.existsSync(`${file}.lock`), "live lock not removed");
  fs.writeFileSync(`${file}.lock`, "{not json", { mode: 0o600 });
  await assert.rejects(
    createCredentialStore({ path: file, lockPollMs: 5, lockTimeoutMs: 80, lockStaleMs: 60_000 }).withLock(async () => assert.fail("stole lock")),
    (e) => e.code === "lock_timeout",
  );
});

test("withLock never reclaims an ownerless (empty) lockfile by age: unknown owner fails closed", async () => {
  const { file } = freshPath();
  createCredentialStore({ path: file }).ensureHostId();
  fs.writeFileSync(`${file}.lock`, "", { mode: 0o600 });
  ageLock(file);
  await assert.rejects(
    createCredentialStore({ path: file, lockPollMs: 5, lockTimeoutMs: 80, lockStaleMs: 50 }).withLock(async () => assert.fail("stole lock")),
    (e) => e instanceof CredentialStoreError && e.code === "lock_timeout",
  );
  assert.ok(fs.existsSync(`${file}.lock`), "ownerless lock not removed");
});

function ageLock(file, ms = 120_000) {
  const old = new Date(Date.now() - ms);
  fs.utimesSync(`${file}.lock`, old, old);
}

const MOD_URL = new URL("../../src/broker/credential-store.mjs", import.meta.url).href;
const HAS_PROC = fs.existsSync("/proc/self/stat");

function bootId() {
  try {
    return fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  } catch {
    return null;
  }
}

function spawnNode(script, args) {
  return spawn(process.execPath, ["--input-type=module", "-e", script, ...args], { stdio: ["ignore", "pipe", "pipe"] });
}

function exited(child) {
  return new Promise((resolve) => (child.exitCode !== null ? resolve(child.exitCode) : child.on("exit", (c) => resolve(c))));
}

/** Spawn a child that holds the lock for `holdMs`; resolves once it reports holding it. */
async function lockHolderChild(file, holdMs) {
  const child = spawnNode(
    `import { createCredentialStore } from ${JSON.stringify(MOD_URL)};
     const s = createCredentialStore({ path: process.argv[1] });
     await s.withLock(async () => { process.stdout.write("locked\\n"); await new Promise(r => setTimeout(r, Number(process.argv[2]))); });`,
    [file, String(holdMs)],
  );
  await new Promise((resolve, reject) => {
    child.stdout.on("data", (d) => String(d).includes("locked") && resolve());
    child.on("exit", (c) => reject(new Error(`child exited ${c}`)));
  });
  return child;
}

test("lock owner record carries pid, token and process start identity", { skip: !HAS_PROC }, async () => {
  const { file } = freshPath();
  const store = createCredentialStore({ path: file, lockPollMs: 5 });
  store.ensureHostId();
  await store.withLock(async () => {
    const info = JSON.parse(fs.readFileSync(`${file}.lock`, "utf8"));
    assert.equal(info.pid, process.pid);
    assert.equal(typeof info.start, "string");
    assert.ok(info.start.length > 0);
  });
});

test("M-6: a live owner holding the lock past lockStaleMs is never stolen", { skip: !HAS_PROC }, async () => {
  const { file } = freshPath();
  createCredentialStore({ path: file }).ensureHostId();
  const child = await lockHolderChild(file, 1500);
  try {
    const before = fs.readFileSync(`${file}.lock`, "utf8");
    ageLock(file);
    await assert.rejects(
      createCredentialStore({ path: file, lockPollMs: 5, lockTimeoutMs: 200, lockStaleMs: 10 }).withLock(async () => assert.fail("stole live lock")),
      (e) => e instanceof CredentialStoreError && e.code === "lock_timeout",
    );
    assert.equal(fs.readFileSync(`${file}.lock`, "utf8"), before, "live owner's lock untouched");
  } finally {
    child.kill("SIGKILL");
    await exited(child);
  }
});

test("M-6: a waiter enters only after a live long-running holder releases", async () => {
  const { file } = freshPath();
  createCredentialStore({ path: file }).ensureHostId();
  const child = await lockHolderChild(file, 400);
  ageLock(file);
  let enteredWhileChildRunning = false;
  await createCredentialStore({ path: file, lockPollMs: 5, lockTimeoutMs: 5000, lockStaleMs: 10 }).withLock(async () => {
    enteredWhileChildRunning = child.exitCode === null && fs.readFileSync(`${file}.lock`, "utf8").includes(`"pid":${child.pid}`);
  });
  assert.equal(enteredWhileChildRunning, false);
  await exited(child);
});

test("M-6: a reused PID (live pid, different process start time) is reclaimed as dead", { skip: !HAS_PROC }, async () => {
  const { file } = freshPath();
  createCredentialStore({ path: file }).ensureHostId();
  fs.writeFileSync(`${file}.lock`, JSON.stringify({ pid: process.pid, start: "0", boot: bootId(), created: Date.now(), token: "old-owner" }), { mode: 0o600 });
  let ran = false;
  await createCredentialStore({ path: file, lockPollMs: 5, lockTimeoutMs: 2000 }).withLock(async () => {
    ran = true;
  });
  assert.ok(ran);
});

test("M-6: a live pid without recorded start time (cannot rule out PID reuse) fails closed, even when old", async () => {
  const { file } = freshPath();
  createCredentialStore({ path: file }).ensureHostId();
  fs.writeFileSync(`${file}.lock`, JSON.stringify({ pid: process.pid, created: Date.now() - 120_000 }), { mode: 0o600 });
  ageLock(file);
  await assert.rejects(
    createCredentialStore({ path: file, lockPollMs: 5, lockTimeoutMs: 80, lockStaleMs: 10 }).withLock(async () => assert.fail("stole lock")),
    (e) => e.code === "lock_timeout",
  );
  assert.ok(fs.existsSync(`${file}.lock`));
});

test("M-6: an owner whose process start time cannot be read is unknown and fails closed", async () => {
  const { file } = freshPath();
  createCredentialStore({ path: file }).ensureHostId();
  fs.writeFileSync(`${file}.lock`, JSON.stringify({ pid: process.pid, start: "12345", created: Date.now(), token: "t" }), { mode: 0o600 });
  ageLock(file);
  const store = createCredentialStore({ path: file, lockPollMs: 5, lockTimeoutMs: 80, lockStaleMs: 10, processStat: () => null });
  await assert.rejects(store.withLock(async () => assert.fail("stole lock")), (e) => e.code === "lock_timeout");
  assert.ok(fs.existsSync(`${file}.lock`));
});

test("M-6: reclaim race: several waiter processes reclaim a dead lock and hold it strictly one at a time", async () => {
  const { dir, file } = freshPath();
  createCredentialStore({ path: file }).ensureHostId();
  const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"]);
  fs.writeFileSync(`${file}.lock`, JSON.stringify({ pid: Number(String(dead.stdout)), start: "1", created: Date.now(), token: "dead" }), { mode: 0o600 });
  const log = path.join(path.dirname(dir), "race.log");
  fs.writeFileSync(log, "");
  const go = path.join(path.dirname(dir), "go");
  const children = Array.from({ length: 4 }, (_, i) =>
    spawnNode(
      `import fs from "node:fs";
       import { createCredentialStore } from ${JSON.stringify(MOD_URL)};
       const [file, log, go, name] = process.argv.slice(1);
       while (!fs.existsSync(go)) await new Promise(r => setTimeout(r, 2));
       const s = createCredentialStore({ path: file, lockPollMs: 2, lockTimeoutMs: 10000 });
       await s.withLock(async () => {
         fs.appendFileSync(log, name + ":in\\n");
         await new Promise(r => setTimeout(r, 40));
         fs.appendFileSync(log, name + ":out\\n");
       });`,
      [file, log, go, `w${i}`],
    ),
  );
  await new Promise((r) => setTimeout(r, 150));
  fs.writeFileSync(go, "");
  const codes = await Promise.all(children.map(exited));
  assert.deepEqual(codes, [0, 0, 0, 0]);
  const lines = fs.readFileSync(log, "utf8").trim().split("\n");
  assert.equal(lines.length, 8);
  for (let i = 0; i < lines.length; i += 2) {
    const [n, s] = lines[i].split(":");
    assert.equal(s, "in", lines.join(","));
    assert.equal(lines[i + 1], `${n}:out`, `overlapping holders: ${lines.join(",")}`);
  }
  assert.ok(!fs.existsSync(`${file}.lock`));
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n !== "siwc.json"), [], "no guard/temp files left");
});

test("M-6: multi-process read-modify-write under withLock is serialized (no lost updates)", async () => {
  const { dir, file } = freshPath();
  createCredentialStore({ path: file }).ensureHostId();
  const counter = path.join(path.dirname(dir), "counter");
  fs.writeFileSync(counter, "0");
  const children = Array.from({ length: 5 }, () =>
    spawnNode(
      `import fs from "node:fs";
       import { createCredentialStore } from ${JSON.stringify(MOD_URL)};
       const [file, counter] = process.argv.slice(1);
       const s = createCredentialStore({ path: file, lockPollMs: 2, lockTimeoutMs: 10000 });
       await s.withLock(async () => {
         const n = Number(fs.readFileSync(counter, "utf8"));
         await new Promise(r => setTimeout(r, 30));
         fs.writeFileSync(counter, String(n + 1));
       });`,
      [file, counter],
    ),
  );
  assert.deepEqual(await Promise.all(children.map(exited)), [0, 0, 0, 0, 0]);
  assert.equal(fs.readFileSync(counter, "utf8"), "5");
});

test("lockfile is never observable without its owner record (atomic publish) and leaves no temp files", async () => {
  const { dir, file } = freshPath();
  const store = createCredentialStore({ path: file, lockPollMs: 5 });
  store.ensureHostId();
  await store.withLock(async () => {
    const info = JSON.parse(fs.readFileSync(`${file}.lock`, "utf8"));
    assert.equal(info.pid, process.pid);
    assert.equal(typeof info.token, "string");
    assert.equal(fs.lstatSync(`${file}.lock`).mode & 0o777, 0o600);
  });
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n !== "siwc.json"), []);
});

test("release does not unlink a lock that was replaced by another holder", async () => {
  const { file } = freshPath();
  const store = createCredentialStore({ path: file, lockPollMs: 5 });
  store.ensureHostId();
  const foreign = JSON.stringify({ pid: process.pid, created: Date.now(), token: "someone-else" });
  await store.withLock(async () => {
    fs.unlinkSync(`${file}.lock`);
    fs.writeFileSync(`${file}.lock`, foreign, { mode: 0o600 });
  });
  assert.equal(fs.readFileSync(`${file}.lock`, "utf8"), foreign);
});

test("M-10: refresh-in-progress marker is persisted with the account and cleared by a full replacement", () => {
  const { file } = freshPath();
  const store = createCredentialStore({ path: file });
  store.ensureHostId();
  const key = store.putAccount(record(), { activate: true });
  store.putAccount({ ...record(), refresh_pending_since: 1_234 });
  assert.equal(createCredentialStore({ path: file }).getAccount(key).refresh_pending_since, 1_234);
  assert.equal(createCredentialStore({ path: file }).getActive().refresh_pending_since, 1_234);
  store.putAccount(record({ access_token: "new-access" }));
  assert.equal(createCredentialStore({ path: file }).getAccount(key).refresh_pending_since, undefined);
  assert.throws(() => store.putAccount({ ...record(), refresh_pending_since: "soon" }), (e) => e.code === "invalid_record");
});
