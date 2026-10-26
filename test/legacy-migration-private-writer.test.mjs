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
import { pathToFileURL } from "node:url";

const [root, scratch, kind, mode] = process.argv.slice(1);
const load = (name) => import(pathToFileURL(path.join(root, "src", name)).href);
const instant = "2026-10-25T00:00:00.000Z";
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...args) { super(...(args.length ? args : [instant])); }
  static now() { return new RealDate(instant).getTime(); }
};
const paths = await load("paths.mjs");
const security = await load("file-security.mjs");
const migration = await load("legacy-migration.mjs");
const directory = path.join(paths.MIGRATIONS_DIR, "2026-10-25T00-00-00-000Z-" + process.pid);
const manifest = path.join(directory, "migration.json");
const pointer = path.join(paths.MIGRATIONS_DIR, "latest.json");
const target = kind === "manifest" ? manifest : pointer;
const plist = path.join(paths.LAUNCH_AGENTS_DIR, "com.ziwenxu.kimi-codex-proxy.plist");
const state = path.join(paths.CODEX_HOME, "kimi-proxy");
const configBytes = Buffer.from('# SYNTHETIC_PRIVATE_目录\r\nmodel = "gpt-example"\r\n[profiles.work]\r\nvalue = "κ"\r\n');
const plistBytes = Buffer.from("SYNTHETIC_PRIVATE_PLIST_κ\n");
for (const folder of [directory, paths.LAUNCH_AGENTS_DIR, state]) fs.mkdirSync(folder, { recursive: true });
fs.writeFileSync(paths.CONFIG_PATH, configBytes, { mode: 0o600 });
fs.writeFileSync(plist, plistBytes, { mode: 0o600 });
const stateFile = path.join(state, "retained.txt");
fs.writeFileSync(stateFile, "retained state\n");
const priorManifest = path.join(paths.MIGRATIONS_DIR, "prior.json");
const prior = { version: 1, services: [], marker: "old snapshot" };
fs.writeFileSync(priorManifest, JSON.stringify(prior));
const oldManifest = Buffer.from('{ "version": 1, "marker": "SYNTHETIC_PRIVATE_旧记录" }\r\n');
const oldPointer = Buffer.from(JSON.stringify({ version: 1, manifestPath: priorManifest }) + "\r\n");
if (mode !== "fresh") {
  fs.writeFileSync(manifest, oldManifest);
  fs.writeFileSync(pointer, oldPointer);
}
const previous = kind === "manifest" ? oldManifest : oldPointer;
const original = { exec: cp.execFileSync, open: fs.openSync, write: fs.writeFileSync,
  close: fs.closeSync, rename: fs.renameSync, unlink: fs.unlinkSync, read: fs.readFileSync };
const within = (file, parent) => {
  const relative = path.relative(parent, path.resolve(file));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};
const focused = (file) => typeof file === "string" && file.startsWith(target + ".tmp.");
const jsonTarget = (file) => file === manifest || file === pointer;
const descriptors = new Set();
const temporaries = new Set();
const stranger = Buffer.from("FOREIGN_TEMPORARY\n");
let foreign;
let displaced;
let injected = false;
let publications = 0;
let jsonAclCalls = 0;
let configCalls = 0;
let forbiddenReads = 0;
const primary = Object.assign(new Error("injected migration failure"), { code: "EACCES" });
if (mode === "legacy-collision") {
  foreign = target + ".tmp." + process.pid;
  original.write(foreign, stranger);
}
cp.execFileSync = (command, args, options = {}) => {
  if (options.env?.CODEX_ROUTER_PRIVATE_FILES || options.env?.CODEX_ROUTER_PRIVATE_FILE) {
    const files = options.env.CODEX_ROUTER_PRIVATE_FILES
      ? JSON.parse(options.env.CODEX_ROUTER_PRIVATE_FILES) : [options.env.CODEX_ROUTER_PRIVATE_FILE];
    assert.ok(files.every((file) => within(file, scratch)), "ACL operations stay inside the fixture");
    if (options.env.CODEX_ROUTER_PRIVATE_FILES) {
      jsonAclCalls += files.filter((file) => jsonTarget(file) || file.startsWith(manifest + ".tmp.") || file.startsWith(pointer + ".tmp.")).length;
      if (mode === "harden-failure" && files.some(focused)) { injected = true; throw primary; }
    }
    return original.exec(command, args, options);
  }
  assert.equal(command, process.execPath, "no real service or external command may execute");
  assert.deepEqual(args, [path.join(root, "src", "config-manager.mjs"), "disable"]);
  configCalls += 1;
  assert.equal(security.privateFileIsProtected(manifest), true);
  assert.equal(security.privateFileIsProtected(pointer), true);
  assert.equal(fs.existsSync(plist), false);
  if (mode === "disable-failure") {
    original.write(paths.CONFIG_PATH, "partial synthetic config\n");
    injected = true;
    throw primary;
  }
  return Buffer.alloc(0);
};
fs.openSync = (file, flags, permission) => {
  if (focused(file) && flags === "wx") {
    assert.equal(permission, 0o600);
    if (mode === "exclusive-collision") {
      injected = true;
      foreign = file;
      const fd = original.open(file, "wx", 0o600);
      try { original.write(fd, stranger); } finally { original.close(fd); }
    }
  }
  const fd = original.open(file, flags, permission);
  if (focused(file) && flags === "wx") { descriptors.add(fd); temporaries.add(file); }
  return fd;
};
fs.writeFileSync = (file, contents, options) => {
  if (descriptors.has(file) && mode === "write-failure") {
    original.write(file, "partial"); injected = true; throw primary;
  }
  return original.write(file, contents, options);
};
fs.closeSync = (fd) => {
  const owned = descriptors.delete(fd);
  const result = original.close(fd);
  if (owned && mode === "close-failure") { injected = true; throw primary; }
  return result;
};
fs.renameSync = (temporary, destination) => {
  if (jsonTarget(destination)) {
    assert.equal(path.dirname(temporary), path.dirname(destination));
    assert.equal(descriptors.size, 0);
    assert.equal(security.privateFileIsProtected(temporary), true, "JSON must be private before publication");
    if (destination === target && ["rename-failure", "cleanup-failure", "leaf-race"].includes(mode)) {
      injected = true;
      if (mode === "leaf-race") {
        displaced = temporary + ".displaced";
        original.rename(temporary, displaced);
        foreign = temporary;
        original.write(foreign, stranger);
      }
      throw primary;
    }
    publications += 1;
  }
  return original.rename(temporary, destination);
};
fs.unlinkSync = (file) => {
  if (mode === "cleanup-failure" && temporaries.has(file)) throw new Error("injected cleanup failure");
  return original.unlink(file);
};
fs.readFileSync = (file, options) => {
  if (typeof file !== "number" && !within(file, scratch) && !within(file, root)) {
    forbiddenReads += 1;
    throw new Error("outside fixture read blocked");
  }
  return original.read(file, options);
};
syncBuiltinESMExports();
globalThis.fetch = () => { throw new Error("no network in migration fixture"); };
assert.throws(() => fs.readFileSync(path.join(scratch, "..", "outside-fixture")), /outside fixture read blocked/);
assert.equal(forbiddenReads, 1);
forbiddenReads = 0;
let result;
let error;
try { result = migration.applyKnownMigrations(); } catch (cause) { error = cause; }
if (foreign) {
  assert.equal(fs.existsSync(foreign), true, "foreign temporary survives byte-exact");
  assert.deepEqual(fs.readFileSync(foreign), stranger, "foreign temporary survives byte-exact");
}
const failure = ["write-failure", "close-failure", "rename-failure", "cleanup-failure", "leaf-race", "exclusive-collision", "harden-failure"].includes(mode);
if (failure) {
  assert.equal(injected, true);
  assert.ok(error);
  assert.equal(configCalls, 0, "never disable config before both records publish");
  assert.equal(publications, kind === "manifest" ? 0 : 1);
  assert.deepEqual(fs.readFileSync(target), previous, "preserve prior target bytes");
  assert.deepEqual(fs.readFileSync(pointer), oldPointer, "old snapshot pointer must survive publication failure");
  assert.deepEqual(migration.latestMigration(), prior);
  assert.deepEqual(fs.readFileSync(plist), plistBytes, "no service plist mutation before publication");
  if (mode === "exclusive-collision") assert.equal(error.code, "EEXIST");
  else if (mode === "harden-failure") assert.match(error.message, /^Failed to protect private file ACL: injected migration failure/);
  else assert.equal(error, primary);
  if (mode === "cleanup-failure") assert.match(error.cleanupError?.message || "", /injected cleanup failure/);
  if (mode === "leaf-race") {
    assert.equal(error.cleanupError?.code, "ESTALE");
    assert.equal(security.privateFileIsProtected(displaced), true);
    assert.equal(JSON.parse(fs.readFileSync(displaced, "utf8")).version, 1);
  }
} else {
  if (mode === "disable-failure") { assert.equal(injected, true); assert.equal(error, primary); }
  else { assert.equal(error, undefined); assert.equal(result.migrated, true); assert.equal(result.manifestPath, manifest); }
  assert.equal(configCalls, 1);
  assert.equal(publications, 2);
  for (const file of [manifest, pointer]) {
    const bytes = fs.readFileSync(file, "utf8");
    assert.equal(bytes, JSON.stringify(JSON.parse(bytes), null, 2) + "\n", "retain pretty JSON and final LF");
    assert.equal(security.privateFileIsProtected(file), true);
  }
  const snapshot = migration.latestMigration();
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.snapshotDir, directory);
  assert.equal(snapshot.createdAt, instant);
  assert.equal(snapshot.services[0].stateRetained, true);
  assert.deepEqual(fs.readFileSync(snapshot.configBackup), configBytes);
  if (process.platform === "win32") assert.equal(jsonAclCalls, 2, "one ACL hardening per JSON publication");
  migration.rollbackLatestMigration({ removeNewService: false });
  assert.deepEqual(fs.readFileSync(plist), plistBytes);
}
assert.deepEqual(fs.readFileSync(paths.CONFIG_PATH), configBytes);
assert.equal(fs.readFileSync(stateFile, "utf8"), "retained state\n");
for (const file of temporaries) assert.equal(fs.existsSync(file), mode === "cleanup-failure" || mode === "leaf-race");
assert.equal(descriptors.size, 0);
assert.equal(forbiddenReads, 0);
process.stdout.write(JSON.stringify({ publications, configCalls, failure }) + "\n");
`;

function exercise(kind, mode) {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "router-migration-private-"));
  assert.equal(path.dirname(path.resolve(scratch)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(scratch).startsWith("router-migration-private-"));
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => (
    !/^(MODEL_ROUTER_|CODEX_ROUTER_|CODEX_HOME$|NODE_OPTIONS$|KIMI_|GROK_|GCLOUD_)/i.test(name)
    && !/(?:KEY|TOKEN|SECRET|PROXY)/i.test(name)
  )));
  Object.assign(env, {
    CODEX_HOME: path.join(scratch, "codex space's 目录"),
    CODEX_ROUTER_STATE_DIR: path.join(scratch, "state space's 目录"),
    CODEX_ROUTER_LAUNCH_AGENTS_DIR: path.join(scratch, "LaunchAgents"),
    CODEX_ROUTER_SKIP_LAUNCHCTL: "1",
    MODEL_ROUTER_TARGET: "codex",
  });
  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", runner, root, scratch, kind, mode], {
      cwd: root, env, encoding: "utf8", timeout: 120_000,
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal((result.stdout + result.stderr).includes("SYNTHETIC_PRIVATE_"), false, "do not log snapshot contents");
    return JSON.parse(result.stdout);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

for (const kind of ["manifest", "pointer"]) {
  for (const mode of ["fresh", "legacy-collision", "rename-failure", "exclusive-collision"]) {
    test(`migration ${kind} ${mode} preserves private records and foreign files`, () => exercise(kind, mode));
  }
}
for (const mode of ["write-failure", "close-failure", "cleanup-failure", "leaf-race", "disable-failure"]) {
  test(`migration pointer ${mode} preserves recovery evidence`, () => exercise("pointer", mode));
}
test("migration pointer ACL failure prevents service/config mutation", {
  skip: process.platform !== "win32" ? "Windows ACL injection" : false,
}, () => exercise("pointer", "harden-failure"));
