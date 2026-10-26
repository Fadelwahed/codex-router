import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runner = String.raw`
import assert from "node:assert/strict";
import cp from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const [root, scratch, kind, mode, valueIndex] = process.argv.slice(1);
const load = name => import(pathToFileURL(path.join(root, "src", name)).href);
const security = await load("file-security.mjs");
const kimi = kind === "kimi" ? await load("kimi-oauth-session.mjs") : undefined;
const target = kind === "kimi" ? (await load("kimi-region.mjs")).resolveKimiCodeEnvironment().credentialsPath
  : path.join(scratch, "generic", "private.bin");
const directory = path.dirname(target);
fs.mkdirSync(directory, { recursive: true, mode: 0o755 });
fs.chmodSync(directory, 0o755);
const old = { access_token: "KIMI_FIXTURE_OLD_ACCESS", refresh_token: "KIMI_FIXTURE_OLD_REFRESH",
  expires_at: 1, expires_in: 3600, scope: "kimi-code", token_type: "Bearer" };
const previous = kind === "kimi" ? Buffer.from(JSON.stringify(old) + "\r\n") : Buffer.from("old bytes\r\n");
fs.writeFileSync(target, previous, { mode: 0o600 });
if (kind === "kimi") fs.writeFileSync(path.join(process.env.KIMI_CODE_HOME, "device_id"), "fixture-device\n");
const binary = Buffer.from([0, 255, 13, 10, 65]);
const original = { exec: cp.execFileSync, spawn: cp.spawn, open: fs.openSync, write: fs.writeFileSync,
  close: fs.closeSync, fsync: fs.fsyncSync, chmod: fs.chmodSync, rename: fs.renameSync,
  unlink: fs.unlinkSync, read: fs.readFileSync };
const within = (file, parent) => {
  const relative = path.relative(parent, path.resolve(file instanceof URL ? fileURLToPath(file) : file));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};
const focused = file => typeof file === "string" && file.startsWith(target + ".tmp.");
const events = [];
const descriptors = new Set();
const temporaries = new Set();
const stranger = Buffer.from("FOREIGN KIMI TEMPORARY\n");
const primary = new Error("injected Kimi publication failure");
const secondary = new Error("injected secondary close failure");
const throwValues = [primary, undefined, null, false, 0, ""];
const thrown = throwValues[Number(valueIndex || 0)];
const throwMode = mode.startsWith("throw-");
const phase = throwMode ? mode.slice(6) : undefined;
let foreign, displaced, injected = false, helpers = 0, requests = 0, forbiddenReads = 0, forbiddenCommands = 0;
const before = Math.floor(Date.now() / 1000);
if (mode === "legacy-collision") {
  foreign = target + ".tmp." + process.pid;
  original.write(foreign, stranger, { mode: 0o600 });
}
function allowedAcl(options) {
  const list = options.env?.CODEX_ROUTER_PRIVATE_FILES;
  const one = options.env?.CODEX_ROUTER_PRIVATE_FILE;
  if (!list && !one) return false;
  const files = list ? JSON.parse(list) : [one];
  assert.ok(files.every(file => within(file, scratch)), "ACLs stay in owned fixtures");
  if (list) { helpers += files.length; events.push("acl"); }
  return true;
}
cp.execFileSync = (command, args, options = {}) => {
  if (allowedAcl(options)) return original.exec(command, args, options);
  if (command === "/usr/bin/sw_vers" && args.length === 1 && args[0] === "-productVersion") return "15.0";
  forbiddenCommands += 1; throw new Error("external command blocked");
};
cp.spawn = (command, args, options = {}) => {
  if (allowedAcl(options)) return original.spawn(command, args, options);
  forbiddenCommands += 1; throw new Error("external process blocked");
};
fs.openSync = (file, flags, permissions) => {
  if (focused(file) && mode === "collision" && flags === "wx") {
    injected = true; foreign = file;
    const fd = original.open(file, "wx", 0o600);
    try { original.write(fd, stranger); } finally { original.close(fd); }
  }
  const fd = original.open(file, flags, permissions);
  if (focused(file) && ["wx", "w"].includes(flags)) {
    assert.equal(permissions, 0o600); events.push("open:" + flags);
    descriptors.add(fd); temporaries.add(file);
  }
  return fd;
};
fs.writeFileSync = (file, bytes, options) => {
  if (descriptors.has(file)) {
    events.push("write");
    if (mode === "write-failure" || phase === "write") {
      injected = true; original.write(file, "partial"); throw throwMode ? thrown : primary;
    }
  }
  return original.write(file, bytes, options);
};
fs.fsyncSync = fd => {
  if (descriptors.has(fd)) {
    events.push("fsync");
    if (mode === "fsync-failure" || phase === "fsync") { injected = true; throw throwMode ? thrown : primary; }
  }
  return original.fsync(fd);
};
fs.closeSync = fd => {
  const owned = descriptors.delete(fd);
  const result = original.close(fd);
  if (owned) {
    events.push("close");
    if (phase === "close") { injected = true; throw thrown; }
    if (throwMode) throw secondary;
    if (mode === "close-failure") { injected = true; throw primary; }
  }
  return result;
};
fs.chmodSync = (file, permissions) => {
  if (focused(file)) {
    events.push("harden");
    if (mode === "harden-failure") { injected = true; throw primary; }
  }
  return original.chmod(file, permissions);
};
fs.renameSync = (temporary, destination) => {
  if (destination === target) {
    assert.equal(path.dirname(temporary), directory); assert.equal(descriptors.size, 0);
    assert.equal(security.privateFileIsProtected(temporary), true, "harden before publication");
    if (["rename-failure", "cleanup-failure", "leaf-race"].includes(mode)) {
      injected = true;
      if (mode === "leaf-race") {
        displaced = temporary + ".displaced"; original.rename(temporary, displaced);
        foreign = temporary;
        const fd = original.open(foreign, "wx", 0o600);
        try { original.write(fd, stranger); } finally { original.close(fd); }
      }
      throw primary;
    }
    events.push("rename");
  }
  return original.rename(temporary, destination);
};
fs.unlinkSync = file => {
  if (temporaries.has(file) && mode === "cleanup-failure") throw new Error("injected Kimi cleanup failure");
  return original.unlink(file);
};
fs.readFileSync = (file, options) => {
  if (typeof file !== "number" && !within(file, root) && !within(file, scratch)) {
    forbiddenReads += 1; throw new Error("outside fixture read blocked");
  }
  return original.read(file, options);
};
syncBuiltinESMExports();
assert.throws(() => fs.readFileSync(path.join(scratch, "..", "outside")), /outside fixture read blocked/);
assert.equal(forbiddenReads, 1); forbiddenReads = 0;
globalThis.fetch = async (url, options) => {
  assert.equal(kind, "kimi"); assert.match(String(url), /\/api\/oauth\/token$/);
  assert.equal(options.method, "POST");
  assert.equal(new URLSearchParams(options.body).get("refresh_token"), requests ? "KIMI_FIXTURE_NEW_REFRESH" : old.refresh_token);
  requests += 1;
  return new Response(JSON.stringify(mode === "tombstone" ? { error: "invalid_grant" }
    : { access_token: "KIMI_FIXTURE_NEW_ACCESS", refresh_token: "KIMI_FIXTURE_NEW_REFRESH", expires_in: 3600 }),
    { status: mode === "tombstone" ? 401 : 200, headers: { "Content-Type": "application/json" } });
};
let error, caught = false, result;
try {
  if (kind === "kimi") {
    result = await kimi.ensureFreshKimiOAuthToken({ force: true });
    if (mode === "repeat") result = await kimi.ensureFreshKimiOAuthToken({ force: true });
  } else if (mode === "async") result = await security.writePrivateFileAsync(target, binary);
  else if (mode === "default") result = security.writePrivateFile(target, binary);
  else result = security.writePrivateFile(target, binary, { fsync: mode !== "false" });
} catch (cause) { caught = true; error = cause; }
if (foreign) {
  assert.equal(fs.existsSync(foreign), true, "foreign temporary must survive");
  assert.deepEqual(fs.readFileSync(foreign), stranger, "foreign bytes must survive");
}
const failure = throwMode || ["collision", "write-failure", "fsync-failure", "close-failure", "harden-failure", "rename-failure", "cleanup-failure", "leaf-race"].includes(mode);
if (failure) {
  assert.equal(injected, true); assert.equal(caught, true); assert.equal(events.includes("rename"), false);
  assert.deepEqual(fs.readFileSync(target), previous, "failed publication preserves old bytes");
  if (mode === "collision") assert.equal(error.code, "EEXIST");
  else assert.equal(error, throwMode ? thrown : primary, "retain the exact primary thrown value");
  if (throwMode && phase !== "close" && valueIndex === "0") assert.equal(error.closeError, secondary);
  if (mode === "cleanup-failure") assert.match(primary.cleanupError?.message || "", /injected Kimi cleanup failure/);
  if (mode === "leaf-race") assert.equal(primary.cleanupError?.code, "ESTALE");
} else {
  if (mode === "tombstone") { assert.equal(caught, true); assert.equal(error.code, "oauth_unauthorized"); }
  else { assert.equal(caught, false); assert.equal(result, kind === "kimi" ? "KIMI_FIXTURE_NEW_ACCESS" : target); }
  assert.equal(security.privateFileIsProtected(target), true);
  const saved = fs.readFileSync(target);
  if (kind === "kimi") {
    const value = JSON.parse(saved);
    const expected = mode === "tombstone" ? { ...old, access_token: "", refresh_token: "", expires_at: 0, expires_in: 0 }
      : { ...old, access_token: "KIMI_FIXTURE_NEW_ACCESS", refresh_token: "KIMI_FIXTURE_NEW_REFRESH", expires_at: value.expires_at };
    assert.deepEqual(value, expected);
    if (mode !== "tombstone") assert.ok(value.expires_at >= before + 3600 && value.expires_at <= Math.floor(Date.now() / 1000) + 3600);
    assert.deepEqual(saved, Buffer.from(JSON.stringify(expected, null, 2) + "\n"));
  } else assert.deepEqual(saved, binary);
  const count = mode === "repeat" ? 2 : 1;
  const synced = kind === "kimi" || mode === "sync";
  const cycle = ["open:wx", "write", ...(synced ? ["fsync"] : []), "close", ...(mode === "async" && process.platform === "win32" ? [] : ["harden"]), ...(process.platform === "win32" ? ["acl"] : []), "rename"];
  assert.deepEqual(events, Array.from({ length: count }, () => cycle).flat(), "sync before close/hardening/publication; default writers remain unsynced");
  if (process.platform === "win32") assert.equal(helpers, count);
}
if (process.platform !== "win32" && kind === "kimi") assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
for (const file of temporaries) assert.equal(fs.existsSync(file), mode === "cleanup-failure" || mode === "leaf-race", "clean only owned unpublished token temporary");
assert.equal(descriptors.size, 0); assert.equal(forbiddenReads, 0); assert.equal(forbiddenCommands, 0);
if (kind === "kimi") assert.equal(fs.existsSync(path.join(process.env.KIMI_CODE_HOME, "oauth", "kimi-code.lock")), false);
assert.equal(requests, kind === "kimi" ? mode === "repeat" ? 2 : 1 : 0);
process.stdout.write(JSON.stringify({ publications: events.filter(x => x === "rename").length, helpers }) + "\n");
`;

function exercise(kind, mode, valueIndex = 0) {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "router-kimi-private-"));
  assert.equal(path.dirname(path.resolve(scratch)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(scratch).startsWith("router-kimi-private-"));
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => (
    !/^(MODEL_ROUTER_|CODEX_ROUTER_|CODEX_HOME$|NODE_OPTIONS$|KIMI_|GROK_|GCLOUD_)/i.test(name)
    && !/(?:KEY|TOKEN|SECRET|PROXY)/i.test(name)
  )));
  Object.assign(env, { CODEX_HOME: path.join(scratch, "codex"), CODEX_ROUTER_STATE_DIR: path.join(scratch, "state"),
    MODEL_ROUTER_TARGET: "codex", KIMI_CODE_HOME: path.join(scratch, "kimi space's 目录") });
  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", runner, root, scratch, kind, mode, String(valueIndex)], {
      cwd: root, env, encoding: "utf8", timeout: 120_000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal((result.stdout + result.stderr).includes("KIMI_FIXTURE_"), false, "do not print token data");
    return JSON.parse(result.stdout);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

for (const mode of ["refresh", "repeat", "tombstone", "legacy-collision", "collision", "write-failure", "fsync-failure", "close-failure", "harden-failure", "rename-failure", "cleanup-failure", "leaf-race"]) {
  test(`Kimi private writer ${mode} preserves sync and ownership`, () => exercise("kimi", mode));
}
for (const mode of ["sync", "default", "false", "async"]) {
  test(`shared private writer ${mode} preserves synchronization policy`, () => exercise("shared", mode));
}
for (const phase of ["write", "fsync", "close"]) {
  for (let index = 0; index < 6; index += 1) {
    test(`shared private writer ${phase} preserves thrown value ${index} and closes safely`, () => exercise("shared", "throw-" + phase, index));
  }
}
