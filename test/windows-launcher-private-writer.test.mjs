import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
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
const [root, scratch, kind, mode] = process.argv.slice(1);
const paths = await import(pathToFileURL(path.join(root, "src/paths.mjs")).href);
const security = await import(pathToFileURL(path.join(root, "src/file-security.mjs")).href);
const wrapper = path.join(paths.STATE_DIR, "start-codex-router.cmd");
const launcher = path.join(paths.STATE_DIR, "start-codex-router-hidden.vbs");
const target = kind === "cmd" ? wrapper : launcher;
const previous = Buffer.from("OLD_PRIVATE_LAUNCHER\r\n");
const stranger = Buffer.from("FOREIGN_TEMPORARY\n");
fs.mkdirSync(path.join(paths.SOURCE_ROOT, "src"), { recursive: true });
const config = path.join(paths.CODEX_HOME, "config.toml");
fs.mkdirSync(paths.CODEX_HOME, { recursive: true });
fs.writeFileSync(config, "unrelated synthetic config\n");
if (mode !== "guard") {
  fs.mkdirSync(paths.STATE_DIR, { recursive: true });
  if (mode !== "fresh") {
    for (const file of [wrapper, launcher]) fs.writeFileSync(file, previous, { mode: 0o600 });
  }
}
const original = { exec: cp.execFileSync, open: fs.openSync, write: fs.writeFileSync,
  close: fs.closeSync, rename: fs.renameSync, unlink: fs.unlinkSync, read: fs.readFileSync };
const within = (file, parent) => {
  const relative = path.relative(parent, path.resolve(file instanceof URL ? fileURLToPath(file) : file));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};
const focused = (file) => typeof file === "string" && file.startsWith(target + ".tmp.");
const isLauncher = (file) => file === wrapper || file === launcher;
const descriptors = new Set();
const temporaries = new Set();
const published = [];
let helpers = 0;
let schedulerQueries = 0;
let checkoutCalls = 0;
let forbiddenReads = 0;
let forbiddenCommands = 0;
let foreign;
let displaced;
let injected = false;
const primary = Object.assign(new Error("injected launcher failure"), { code: "EACCES" });
if (mode === "legacy-collision") {
  foreign = target + ".tmp." + process.pid;
  original.write(foreign, stranger);
}
cp.execFileSync = (command, args, options = {}) => {
  if (options.env?.CODEX_ROUTER_PRIVATE_FILES || options.env?.CODEX_ROUTER_PRIVATE_FILE) {
    const files = options.env.CODEX_ROUTER_PRIVATE_FILES
      ? JSON.parse(options.env.CODEX_ROUTER_PRIVATE_FILES) : [options.env.CODEX_ROUTER_PRIVATE_FILE];
    assert.ok(files.every((file) => within(file, scratch)), "only fixture ACL operations are allowed");
    if (options.env.CODEX_ROUTER_PRIVATE_FILES) {
      helpers += files.filter((file) => isLauncher(file) || file.startsWith(wrapper + ".tmp.") || file.startsWith(launcher + ".tmp.")).length;
      if (mode === "harden-failure" && files.some(focused)) { injected = true; throw primary; }
    }
    return original.exec(command, args, options);
  }
  if (options.env?.CODEX_ROUTER_CHECKOUT_PATH) {
    assert.equal(options.env.CODEX_ROUTER_CHECKOUT_PATH, paths.SOURCE_ROOT);
    assert.ok(within(paths.SOURCE_ROOT, scratch));
    checkoutCalls += 1;
    return Buffer.alloc(0); // no need to modify even the fixture checkout ACL
  }
  if (command === "schtasks.exe") {
    if (JSON.stringify(args) !== JSON.stringify(["/Query", "/TN", "Codex Router"])) forbiddenCommands += 1;
    assert.deepEqual(args, ["/Query", "/TN", "Codex Router"]);
    schedulerQueries += 1;
    return "synthetic existing task";
  }
  forbiddenCommands += 1;
  assert.fail("no real scheduler, process, launcher or external command may run");
};
fs.openSync = (file, flags, permission) => {
  if (focused(file) && flags === "wx") {
    assert.equal(permission, 0o600);
    if (mode === "exclusive-collision") {
      injected = true; foreign = file;
      const fd = original.open(file, "wx", 0o600);
      try { original.write(fd, stranger); } finally { original.close(fd); }
    }
  }
  const fd = original.open(file, flags, permission);
  if (focused(file) && flags === "wx") { descriptors.add(fd); temporaries.add(file); }
  return fd;
};
fs.writeFileSync = (file, bytes, options) => {
  if (descriptors.has(file) && mode === "write-failure") {
    original.write(file, "partial"); injected = true; throw primary;
  }
  return original.write(file, bytes, options);
};
fs.closeSync = (fd) => {
  const owned = descriptors.delete(fd);
  const result = original.close(fd);
  if (owned && mode === "close-failure") { injected = true; throw primary; }
  return result;
};
fs.renameSync = (temporary, destination) => {
  if (isLauncher(destination)) {
    assert.equal(path.dirname(temporary), path.dirname(destination));
    assert.equal(descriptors.size, 0);
    assert.equal(security.privateFileIsProtected(temporary), true, "harden launchers before publishing proxy credentials");
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
    published.push(destination);
  }
  return original.rename(temporary, destination);
};
fs.unlinkSync = (file) => {
  if (mode === "cleanup-failure" && temporaries.has(file)) throw new Error("injected cleanup failure");
  return original.unlink(file);
};
fs.readFileSync = (file, options) => {
  if (typeof file !== "number" && !within(file, scratch) && !within(file, root)) {
    forbiddenReads += 1; throw new Error("outside fixture read blocked");
  }
  return original.read(file, options);
};
syncBuiltinESMExports();
globalThis.fetch = () => { throw new Error("no network in launcher fixture"); };
assert.throws(() => fs.readFileSync(path.join(scratch, "..", "outside-fixture")), /outside fixture read blocked/);
assert.equal(forbiddenReads, 1); forbiddenReads = 0;
let invocation = 0;
async function invoke(command) {
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  let out = ""; let err = ""; let error;
  process.stdout.write = (value) => { out += String(value); return true; };
  process.stderr.write = (value) => { err += String(value); return true; };
  process.argv = [process.execPath, path.join(root, "src/service-windows.mjs"), command];
  try { await import(pathToFileURL(process.argv[1]).href + "?fixture=" + (++invocation)); }
  catch (cause) { error = cause; }
  finally { process.stdout.write = stdout; process.stderr.write = stderr; }
  const code = process.exitCode || 0; process.exitCode = 0;
  return { out, err, error, code };
}
const renderedCmd = await invoke("render");
const renderedVbs = await invoke("render-launcher");
assert.equal(renderedCmd.error, undefined); assert.equal(renderedVbs.error, undefined);
const expected = new Map([
  [wrapper, Buffer.from(renderedCmd.out, "utf8")],
  [launcher, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(renderedVbs.out, "utf16le")])],
]);
assert.ok(renderedCmd.out.includes("SYNTHETIC_PROXY_PRIVATE"), "fixture includes secret-bearing proxy environment");
assert.ok(renderedVbs.out.includes("目录"));
const result = await invoke("install");
if (mode === "guard") {
  assert.match(result.error?.message || "", /Refusing to write the service launchers/);
  assert.equal(fs.existsSync(paths.STATE_DIR), false);
  assert.equal(checkoutCalls, 0); assert.equal(helpers, 0); assert.equal(schedulerQueries, 0);
} else {
  assert.equal(result.error, undefined);
  const failure = ["write-failure", "close-failure", "harden-failure", "rename-failure", "cleanup-failure", "leaf-race", "exclusive-collision"].includes(mode);
  assert.equal(result.code, failure ? 1 : 0, result.err);
  const report = JSON.parse(result.out);
  assert.deepEqual(report, { installed: true, launchers: true, path: wrapper });
  assert.equal((result.out + result.err).includes("SYNTHETIC_PROXY_PRIVATE"), false, "install output must not expose proxy credentials");
  if (foreign) {
    assert.equal(fs.existsSync(foreign), true, "preserve foreign temporary file");
    assert.deepEqual(fs.readFileSync(foreign), stranger);
  }
  if (failure) {
    assert.equal(injected, true);
    assert.deepEqual(fs.readFileSync(target), previous, "failed publication preserves exact old launcher");
    assert.deepEqual(fs.readFileSync(kind === "cmd" ? launcher : wrapper), kind === "cmd" ? previous : expected.get(wrapper));
    assert.deepEqual(published, kind === "cmd" ? [] : [wrapper]);
    assert.match(result.err, /Failed to write the service launchers/);
    if (mode === "cleanup-failure") assert.match(primary.cleanupError?.message || "", /injected cleanup/);
    if (mode === "leaf-race") {
      assert.equal(primary.cleanupError?.code, "ESTALE");
      assert.deepEqual(fs.readFileSync(displaced), expected.get(target));
      assert.equal(security.privateFileIsProtected(displaced), true);
    }
  } else {
    if (mode === "repeat") {
      const repeated = await invoke("install");
      assert.equal(repeated.error, undefined); assert.equal(repeated.code, 0); assert.equal(repeated.err, "");
      assert.equal(repeated.out, result.out);
    }
    for (const [file, bytes] of expected) {
      assert.deepEqual(fs.readFileSync(file), bytes, "preserve exact UTF-8 CMD and BOM-prefixed UTF-16LE VBS bytes");
      assert.equal(security.privateFileIsProtected(file), true);
    }
    assert.deepEqual(published, mode === "repeat" ? [wrapper, launcher, wrapper, launcher] : [wrapper, launcher]);
    if (process.platform === "win32") assert.equal(helpers, mode === "repeat" ? 4 : 2, "one Windows ACL hardening per launcher publication");
  }
  assert.equal(schedulerQueries, mode === "repeat" ? 2 : 1, "only stubbed read queries; no service mutations");
}
for (const file of temporaries) assert.equal(fs.existsSync(file), mode === "cleanup-failure" || mode === "leaf-race", "remove owned unpublished launcher temporary");
assert.equal(descriptors.size, 0); assert.equal(forbiddenReads, 0); assert.equal(forbiddenCommands, 0);
assert.equal(fs.readFileSync(config, "utf8"), "unrelated synthetic config\n");
process.stdout.write(JSON.stringify({ helpers, publications: published.length }) + "\n");
`;

function exercise(kind, mode) {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "router-launcher-private-"));
  assert.equal(path.dirname(path.resolve(scratch)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(scratch).startsWith("router-launcher-private-"));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => (
    !/^(MODEL_ROUTER_|CODEX_ROUTER_|CODEX_HOME$|NODE_OPTIONS$|KIMI_|GROK_|GCLOUD_)/i.test(key)
    && !/(?:KEY|TOKEN|SECRET|PROXY)/i.test(key)
  )));
  const proxy = new URL("http://proxy.invalid:8080");
  proxy.username = "fixture";
  proxy.password = "SYNTHETIC_PROXY_PRIVATE_" + randomBytes(16).toString("hex");
  Object.assign(env, {
    CODEX_HOME: path.join(scratch, "codex 目录"),
    CODEX_ROUTER_SOURCE_ROOT: path.join(scratch, "source space's 目录 100%"),
    CODEX_ROUTER_STATE_DIR: path.join(scratch, "state space's 目录 100%"),
    CODEX_ROUTER_SERVICE_PLATFORM: "win32",
    MODEL_ROUTER_SKIP_SERVICE_MANAGER: "1",
    MODEL_ROUTER_TARGET: "codex",
    NODE_TEST_CONTEXT: "child-v8",
    https_proxy: proxy.href,
    KIMI_CODE_HOME: path.join(scratch, "kimi"),
  });
  if (mode === "guard") delete env.CODEX_ROUTER_STATE_DIR;
  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", runner, root, scratch, kind, mode], {
      env, cwd: root, encoding: "utf8", timeout: 120_000, windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal((result.stdout + result.stderr).includes("SYNTHETIC_PROXY_PRIVATE"), false, "fixture output never exposes proxy credentials");
    return JSON.parse(result.stdout);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

for (const kind of ["cmd", "vbs"]) {
  for (const mode of ["fresh", "legacy-collision", "rename-failure", "exclusive-collision"]) {
    test(`Windows ${kind} launcher ${mode} retains bytes and temporary ownership`, () => exercise(kind, mode));
  }
}
for (const mode of ["repeat", "write-failure", "close-failure", "cleanup-failure", "leaf-race", "guard"]) {
  test(`Windows launcher ${mode} preserves publication and service boundaries`, () => exercise("vbs", mode));
}
test("Windows launcher ACL failure fails before replacement", {
  skip: process.platform !== "win32" ? "Windows ACL injection" : false,
}, () => exercise("vbs", "harden-failure"));
