import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes as nodeRandomBytes, randomUUID as nodeRandomUUID } from "node:crypto";

const { O_RDONLY, O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = fs.constants;
const MAX_STORE_BYTES = 1024 * 1024;
const HOST_ID = /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STRING_FIELDS = ["issuer", "subject", "client_id", "id_token", "access_token", "refresh_token", "token_type"];

/** Errors carry only a fixed code and generic message: never paths, file contents or tokens. */
export class CredentialStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CredentialStoreError";
    this.code = code;
  }
}

const fail = (code, message) => {
  throw new CredentialStoreError(code, message);
};

function uid() {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

function checkOwnerMode(st, kind) {
  const me = uid();
  if (me !== null && st.uid !== me) fail("unsafe_owner", `credential ${kind} not owned by current user`);
  if ((st.mode & 0o077) !== 0) fail("unsafe_mode", `credential ${kind} permissions too open`);
}

function accountKey(issuer, subject) {
  return createHash("sha256").update(`${issuer}\n${subject}`).digest("hex").slice(0, 32);
}

function validateRecord(r) {
  if (!r || typeof r !== "object") fail("invalid_record", "invalid credential record");
  for (const k of STRING_FIELDS) if (typeof r[k] !== "string" || r[k] === "") fail("invalid_record", `invalid credential record field ${k}`);
  if (!Array.isArray(r.scopes) || r.scopes.length === 0 || !r.scopes.every((s) => typeof s === "string" && s !== "")) {
    fail("invalid_record", "invalid credential record field scopes");
  }
  if (!Number.isFinite(r.expires_at) || r.expires_at <= 0) fail("invalid_record", "invalid credential record field expires_at");
  if (r.earliest_refresh_at !== undefined && r.earliest_refresh_at !== null && !Number.isFinite(r.earliest_refresh_at)) {
    fail("invalid_record", "invalid credential record field earliest_refresh_at");
  }
  if (r.identity_label !== undefined && r.identity_label !== null && typeof r.identity_label !== "string") {
    fail("invalid_record", "invalid credential record field identity_label");
  }
  // Durable "refresh in progress" marker (M-10): written before a refresh
  // POST, removed by the full replacement that stores the rotated set.
  if (r.refresh_pending_since !== undefined && r.refresh_pending_since !== null && !Number.isFinite(r.refresh_pending_since)) {
    fail("invalid_record", "invalid credential record field refresh_pending_since");
  }
}

function sanitizeRecord(r) {
  const out = {};
  for (const k of STRING_FIELDS) out[k] = r[k];
  out.scopes = [...r.scopes];
  out.expires_at = r.expires_at;
  if (Number.isFinite(r.earliest_refresh_at)) out.earliest_refresh_at = r.earliest_refresh_at;
  if (typeof r.identity_label === "string") out.identity_label = r.identity_label;
  if (Number.isFinite(r.refresh_pending_since)) out.refresh_pending_since = r.refresh_pending_since;
  return out;
}

function validateStore(data) {
  if (!data || typeof data !== "object" || data.version !== 1) fail("corrupt_store", "credential store is corrupt");
  if (typeof data.ext_agent_host_id !== "string" || !HOST_ID.test(data.ext_agent_host_id)) fail("corrupt_store", "credential store is corrupt");
  if (!data.accounts || typeof data.accounts !== "object" || Array.isArray(data.accounts)) fail("corrupt_store", "credential store is corrupt");
  for (const r of Object.values(data.accounts)) {
    try {
      validateRecord(r);
    } catch {
      fail("corrupt_store", "credential store is corrupt");
    }
  }
  if (data.active !== null && (typeof data.active !== "string" || !data.accounts[data.active])) fail("corrupt_store", "credential store is corrupt");
  return data;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** "exists" | "gone" (ESRCH: certainly dead) | "unknown". */
function pidExists(pid) {
  try {
    process.kill(pid, 0);
    return "exists";
  } catch (e) {
    if (e.code === "ESRCH") return "gone";
    return e.code === "EPERM" ? "exists" : "unknown";
  }
}

/**
 * Linux process identity from /proc/<pid>/stat: { start, state } where start
 * is field 22 (starttime, clock ticks since boot). null when unreadable
 * (non-Linux, hidepid, raced exit): callers must treat that as unknown.
 */
function procStat(pid) {
  let text;
  try {
    text = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return null;
  }
  const close = text.lastIndexOf(")");
  if (close < 0) return null;
  const f = text.slice(close + 2).trim().split(/\s+/);
  // f[0] is field 3 (state); starttime (field 22) is f[19].
  if (f.length < 20 || !/^[0-9]+$/.test(f[19])) return null;
  return { start: f[19], state: f[0] };
}

function readBootId() {
  try {
    const id = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    return id || null;
  } catch {
    return null;
  }
}

/**
 * Host-only protected SIWC credential persistence.
 *
 * - Directory must be 0700 and owned by the current user; file 0600. Unsafe
 *   modes are refused, never silently repaired.
 * - Symlinks anywhere in the absolute path are refused (realpath must match).
 * - Writes go to an O_EXCL temp file in the same directory, fsync, rename,
 *   then fsync the directory, so readers see the old or new token set only.
 * - `withLock` is a cross-process lockfile (atomic hard-link publish). The
 *   owner record holds pid + process start time + boot id. A lock is only
 *   reclaimed when its owner is certainly dead (ESRCH, zombie, or a different
 *   start time / boot id for that pid = PID reuse). A live or unverifiable
 *   owner is never stolen, regardless of age: waiters fail closed with
 *   lock_timeout. Reclaim is serialized by a short-lived guard file and
 *   re-verifies the lock inode, record and owner death before unlinking.
 *   (`lockStaleMs` is accepted for compatibility but no longer permits
 *   stealing.)
 */
export function createCredentialStore({
  path: filePath,
  randomUUID = nodeRandomUUID,
  randomBytes = nodeRandomBytes,
  now = Date.now,
  lockPollMs = 25,
  lockTimeoutMs = 30_000,
  processStat = procStat,
  bootId = readBootId,
} = {}) {
  if (typeof filePath !== "string" || !path.isAbsolute(filePath) || path.normalize(filePath) !== filePath || filePath.endsWith(path.sep)) {
    fail("unsafe_path", "credential path must be a normalized absolute file path");
  }
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const lockPath = `${filePath}.lock`;

  function checkDir({ create }) {
    let st;
    try {
      st = fs.lstatSync(dir);
    } catch (e) {
      if (e.code !== "ENOENT" || !create) {
        if (e.code === "ENOENT") return false;
        fail("unsafe_path", "credential directory is not accessible");
      }
      try {
        fs.mkdirSync(dir, { mode: 0o700 });
      } catch {
        fail("unsafe_path", "credential directory cannot be created");
      }
      st = fs.lstatSync(dir);
    }
    if (st.isSymbolicLink() || !st.isDirectory()) fail("unsafe_path", "credential directory must be a real directory");
    let real;
    try {
      real = fs.realpathSync(dir);
    } catch {
      fail("unsafe_path", "credential directory is not accessible");
    }
    if (real !== dir) fail("unsafe_path", "credential path must not traverse symlinks");
    checkOwnerMode(st, "directory");
    return true;
  }

  function readRaw() {
    if (!checkDir({ create: false })) return null;
    let fd;
    try {
      fd = fs.openSync(filePath, O_RDONLY | O_NOFOLLOW);
    } catch (e) {
      if (e.code === "ENOENT") return null;
      if (e.code === "ELOOP") fail("unsafe_path", "credential file must not be a symlink");
      fail("unsafe_path", "credential file is not accessible");
    }
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile()) fail("unsafe_path", "credential file must be a regular file");
      checkOwnerMode(st, "file");
      if (st.size > MAX_STORE_BYTES) fail("corrupt_store", "credential store is too large");
      const buf = Buffer.alloc(st.size);
      let off = 0;
      while (off < st.size) {
        const n = fs.readSync(fd, buf, off, st.size - off, off);
        if (n === 0) break;
        off += n;
      }
      let data;
      try {
        data = JSON.parse(buf.subarray(0, off).toString("utf8"));
      } catch {
        fail("corrupt_store", "credential store is corrupt");
      }
      return validateStore(data);
    } finally {
      fs.closeSync(fd);
    }
  }

  function writeAtomic(data) {
    validateStore(data);
    checkDir({ create: true });
    const tmp = path.join(dir, `.${base}.${Buffer.from(randomBytes(8)).toString("hex")}.tmp`);
    let fd;
    try {
      fd = fs.openSync(tmp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600);
    } catch {
      fail("write_failed", "credential store temp file cannot be created");
    }
    try {
      fs.writeFileSync(fd, `${JSON.stringify(data)}\n`);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      // Refuse replacing anything that is not a regular file we own.
      try {
        const st = fs.lstatSync(filePath);
        if (st.isSymbolicLink() || !st.isFile()) fail("unsafe_path", "credential file must be a regular file");
        checkOwnerMode(st, "file");
      } catch (e) {
        if (e instanceof CredentialStoreError) throw e;
        if (e.code !== "ENOENT") fail("unsafe_path", "credential file is not accessible");
      }
      fs.renameSync(tmp, filePath);
    } catch (e) {
      if (fd !== undefined) fs.closeSync(fd);
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* already renamed or gone */
      }
      if (e instanceof CredentialStoreError) throw e;
      fail("write_failed", "credential store write failed");
    }
    try {
      const dfd = fs.openSync(dir, O_RDONLY);
      try {
        fs.fsyncSync(dfd);
      } finally {
        fs.closeSync(dfd);
      }
    } catch {
      /* directory fsync unsupported on some platforms */
    }
  }

  function load() {
    return readRaw();
  }

  function ensureHostId() {
    const existing = readRaw();
    if (existing) return existing.ext_agent_host_id;
    const id = `urn:uuid:${randomUUID()}`;
    if (!HOST_ID.test(id)) fail("invalid_host_id", "generated Host ID is not a UUIDv4 URN");
    writeAtomic({ version: 1, ext_agent_host_id: id, accounts: {}, active: null });
    return id;
  }

  function getAccount(key) {
    const data = readRaw();
    const r = data?.accounts?.[key];
    return r ? { ...r, scopes: [...r.scopes] } : null;
  }

  function getActive() {
    const data = readRaw();
    if (!data || !data.active) return null;
    const r = data.accounts[data.active];
    return { ...r, scopes: [...r.scopes], key: data.active };
  }

  /** Replace one account's entire token set atomically. Returns the account key. */
  function putAccount(record, { activate = false } = {}) {
    validateRecord(record);
    const clean = sanitizeRecord(record);
    const data = readRaw();
    if (!data) fail("no_host_id", "credential store not initialized");
    const key = accountKey(clean.issuer, clean.subject);
    const next = { ...data, accounts: { ...data.accounts, [key]: clean } };
    if (activate || next.active === null) next.active = key;
    writeAtomic(next);
    return key;
  }

  const guardPath = `${lockPath}.reclaim`;
  const recoveryPath = `${guardPath}.recovery`;

  function readLockInfo(p = lockPath) {
    let fd;
    try {
      fd = fs.openSync(p, O_RDONLY | O_NOFOLLOW);
    } catch (e) {
      if (e.code === "ENOENT") return null;
      if (e.code === "ELOOP") fail("unsafe_path", "credential lock must not be a symlink");
      fail("unsafe_path", "credential lock is not accessible");
    }
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile()) fail("unsafe_path", "credential lock must be a regular file");
      let info = {};
      try {
        info = JSON.parse(fs.readFileSync(fd, "utf8").slice(0, 4096));
      } catch {
        info = {};
      }
      if (!info || typeof info !== "object" || Array.isArray(info)) info = {};
      return { pid: info.pid, start: info.start, boot: info.boot, ino: st.ino, raw: JSON.stringify(info) };
    } finally {
      fs.closeSync(fd);
    }
  }

  function selfRecord(token) {
    const self = processStat(process.pid);
    return { pid: process.pid, start: self?.start ?? null, boot: bootId(), created: Date.now(), token };
  }

  /**
   * "dead" only when owner death is certain; "alive" when the same process
   * is verified running; otherwise "unknown" (fail closed, never reclaimed).
   */
  function ownerState(info) {
    if (!Number.isInteger(info.pid) || info.pid <= 0) return "unknown";
    const exists = pidExists(info.pid);
    if (exists === "gone") return "dead";
    if (exists !== "exists") return "unknown";
    if (typeof info.start !== "string" || info.start === "") return "unknown";
    const cur = processStat(info.pid);
    if (!cur) return "unknown";
    if (cur.start !== info.start) return "dead"; // pid reused by another process
    if (typeof info.boot === "string" && info.boot !== "") {
      const b = bootId();
      if (b !== null && b !== info.boot) return "dead"; // same pid/start after reboot
    }
    if (cur.state === "Z" || cur.state === "X") return "dead"; // exited, not yet reaped
    return "alive";
  }

  /**
   * Publish an owner record atomically: write it to a private temp file, then
   * hard-link into place (EEXIST if held). Observers never see a lock without
   * its owner record. Returns the inode, or null if already held.
   */
  function publish(target, record, token) {
    const tmp = path.join(dir, `.${base}.lock.${token}.${Buffer.from(randomBytes(4)).toString("hex")}.tmp`);
    let ino;
    try {
      const fd = fs.openSync(tmp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify(record));
        fs.fsyncSync(fd);
        ino = fs.fstatSync(fd).ino;
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* not created */
      }
      fail("lock_failed", "credential lock cannot be created");
    }
    let linked = false;
    try {
      fs.linkSync(tmp, target);
      linked = true;
    } catch (e) {
      if (e.code !== "EEXIST") {
        fs.unlinkSync(tmp);
        fail("lock_failed", "credential lock cannot be created");
      }
    }
    fs.unlinkSync(tmp);
    return linked ? ino : null;
  }

  /** Unlink `p` only if it is still exactly the observed file and its owner is still certainly dead. */
  function unlinkIfDead(p, seen) {
    const again = readLockInfo(p);
    if (!again || again.ino !== seen.ino || again.raw !== seen.raw) return;
    if (ownerState(again) !== "dead") return;
    try {
      fs.unlinkSync(p);
    } catch {
      /* already gone */
    }
  }

  /**
   * Reclaim a lock whose owner is certainly dead. Only the holder of the
   * guard may unlink another owner's lock, so two waiters can never both
   * pass the re-check and then remove a lock freshly linked by a third.
   */
  function reclaim(info, token) {
    const guardIno = publish(guardPath, selfRecord(token), token);
    if (guardIno === null) {
      // A dead guard is removed only while holding a second, non-recoverable
      // recovery mutex. If that mutex's owner crashes, fail closed rather than
      // allowing two waiters to race its unlink.
      const g = readLockInfo(guardPath);
      if (g && ownerState(g) === "dead") {
        let recoveryIno;
        try {
          fs.mkdirSync(recoveryPath, { mode: 0o700 });
          recoveryIno = fs.lstatSync(recoveryPath).ino;
        } catch (e) {
          if (e.code !== "EEXIST") fail("lock_failed", "credential lock recovery is unavailable");
          return;
        }
        try {
          unlinkIfDead(guardPath, g);
        } finally {
          try {
            if (fs.lstatSync(recoveryPath).ino === recoveryIno) fs.rmdirSync(recoveryPath);
          } catch {
            /* keep recovery fail-closed if ownership changed or cleanup failed */
          }
        }
      }
      return;
    }
    try {
      unlinkIfDead(lockPath, info);
    } finally {
      try {
        if (fs.lstatSync(guardPath).ino === guardIno) fs.unlinkSync(guardPath);
      } catch {
        /* gone */
      }
    }
  }

  async function acquire() {
    checkDir({ create: true });
    const token = Buffer.from(randomBytes(16)).toString("hex");
    const deadline = now() + lockTimeoutMs;
    for (;;) {
      const ino = publish(lockPath, selfRecord(token), token);
      if (ino !== null) return { token, ino };
      const info = readLockInfo();
      // A live or unverifiable owner is never stolen, however old the lock.
      if (info && ownerState(info) === "dead") reclaim(info, token);
      if (now() >= deadline) fail("lock_timeout", "timed out waiting for credential lock");
      if (!info || !fs.existsSync(lockPath)) continue;
      await sleep(lockPollMs);
    }
  }

  function release({ token, ino }) {
    try {
      const fd = fs.openSync(lockPath, O_RDONLY | O_NOFOLLOW);
      let mine = false;
      try {
        // Ownership = same inode we linked AND our random token.
        mine = fs.fstatSync(fd).ino === ino && JSON.parse(fs.readFileSync(fd, "utf8")).token === token;
      } catch {
        mine = false;
      } finally {
        fs.closeSync(fd);
      }
      if (mine && fs.lstatSync(lockPath).ino === ino) fs.unlinkSync(lockPath);
    } catch {
      /* lock already gone */
    }
  }

  async function withLock(fn) {
    const held = await acquire();
    try {
      return await fn();
    } finally {
      release(held);
    }
  }

  return { load, ensureHostId, getAccount, getActive, putAccount, withLock, accountKey };
}

export { accountKey };
