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
import vm from "node:vm";
const [root, scratch, index, mode] = process.argv.slice(1);
const names = ["atomicWrite", "writeProviderModeState", "writeSignedProviderModeState"];
const targets = [path.join(scratch, "codex", "config.toml"),
  path.join(scratch, "state", "codex-provider-mode.json"),
  path.join(scratch, "state", "codex-signed-provider-mode.json")];
const target = targets[Number(index)];
const directory = path.dirname(target);
const value = Number(index) ? { version: 1, original: "Fixture κ 目录\r\n", enabled: true }
  : '# preserve comment\r\nmodel = "fixture-model"\r\n[profiles.user]\r\nvalue = "κ 目录"\r\n';
const expected = Buffer.from(Number(index) ? JSON.stringify(value, null, 2) + "\n" : value);
const previous = Buffer.from("prior bytes\r\n");
const stranger = Buffer.from("FOREIGN CONFIG TEMPORARY\n");
if (mode !== "fresh") {
  fs.mkdirSync(directory, { recursive: true, mode: 0o755 });
  fs.chmodSync(directory, 0o755);
  fs.writeFileSync(target, previous, { mode: 0o600 });
}
const source = fs.readFileSync(path.join(root, "src", "config-manager.mjs"), "utf8");
const security = await import(pathToFileURL(path.join(root, "src", "file-security.mjs")).href);
const original = { exec: cp.execFileSync, open: fs.openSync, write: fs.writeFileSync,
  close: fs.closeSync, rename: fs.renameSync, unlink: fs.unlinkSync,
  chmod: fs.chmodSync, read: fs.readFileSync };
const within = (file, parent) => {
  const relative = path.relative(parent, path.resolve(file instanceof URL ? fileURLToPath(file) : file));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};
const focused = file => typeof file === "string" && file.startsWith(target + ".tmp.");
const descriptors = new Set();
const temporaries = new Set();
const primary = Object.assign(new Error("injected config publication failure"), { code: "EACCES" });
let foreign, displaced, injected = false, publications = 0, helpers = 0;
let forbiddenReads = 0, forbiddenCommands = 0;
if (mode === "legacy-collision") {
  foreign = target + ".tmp." + process.pid;
  original.write(foreign, stranger, { mode: 0o600 });
}
cp.execFileSync = (command, args, options = {}) => {
  if (options.env?.CODEX_ROUTER_PRIVATE_FILES || options.env?.CODEX_ROUTER_PRIVATE_FILE) {
    const files = options.env.CODEX_ROUTER_PRIVATE_FILES ? JSON.parse(options.env.CODEX_ROUTER_PRIVATE_FILES) : [options.env.CODEX_ROUTER_PRIVATE_FILE];
    assert.ok(files.every(file => within(file, scratch)), "ACLs stay in the owned fixture");
    if (options.env.CODEX_ROUTER_PRIVATE_FILES) helpers += files.length;
    return original.exec(command, args, options);
  }
  forbiddenCommands += 1; throw new Error("external commands blocked");
};
fs.openSync = (file, flags, permissions) => {
  if (focused(file) && flags === "wx") {
    assert.equal(permissions, 0o600);
    if (mode === "exclusive-collision") {
      injected = true; foreign = file;
      const fd = original.open(file, "wx", 0o600);
      try { original.write(fd, stranger); } finally { original.close(fd); }
    }
  }
  const fd = original.open(file, flags, permissions);
  if (focused(file) && flags === "wx") { temporaries.add(file); descriptors.add(fd); }
  return fd;
};
fs.writeFileSync = (file, bytes, options) => {
  if (descriptors.has(file) && mode === "write-failure") {
    injected = true; original.write(file, "partial unpublished bytes"); throw primary;
  }
  return original.write(file, bytes, options);
};
fs.closeSync = fd => {
  const owned = descriptors.delete(fd);
  const result = original.close(fd);
  if (owned && mode === "close-failure") { injected = true; throw primary; }
  return result;
};
fs.chmodSync = (file, permissions) => {
  if (focused(file) && mode === "harden-failure") { injected = true; throw primary; }
  return original.chmod(file, permissions);
};
fs.renameSync = (temporary, destination) => {
  assert.equal(destination, target); assert.equal(path.dirname(temporary), directory);
  assert.equal(descriptors.size, 0);
  assert.equal(security.privateFileIsProtected(temporary), true, "harden before publishing");
  if (["rename-failure", "cleanup-failure", "leaf-race"].includes(mode)) {
    injected = true;
    if (mode === "leaf-race") {
      displaced = temporary + ".displaced"; original.rename(temporary, displaced);
      foreign = temporary; original.write(foreign, stranger);
    }
    throw primary;
  }
  publications += 1;
  return original.rename(temporary, destination);
};
fs.unlinkSync = file => {
  if (temporaries.has(file) && mode === "cleanup-failure") throw new Error("injected config cleanup failure");
  return original.unlink(file);
};
fs.readFileSync = (file, options) => {
  if (typeof file !== "number" && !within(file, root) && !within(file, scratch)) {
    forbiddenReads += 1; throw new Error("outside fixture read blocked");
  }
  return original.read(file, options);
};
syncBuiltinESMExports();
globalThis.fetch = () => { throw new Error("network blocked"); };
assert.throws(() => fs.readFileSync(path.join(scratch, "..", "outside")), /outside fixture read blocked/);
assert.equal(forbiddenReads, 1); forbiddenReads = 0;
// Execute the exact three source functions without the CLI's top-level exits
// or Codex probes. The existing config-manager suite covers their real imports,
// command paths, mode transitions and transaction rollback independently.
const declarations = names.map(name => {
  const match = source.match(new RegExp("^function " + name + "\\([^]*?^}", "m"));
  assert.ok(match, "source function must exist: " + name); return match[0];
}).join("\n");
const context = { ...fs, ...security, path, process,
  CONFIG_PATH: targets[0], CODEX_PROVIDER_MODE_PATH: targets[1], SIGNED_PROVIDER_MODE_PATH: targets[2] };
const writer = vm.runInNewContext(declarations + "\n" + names[Number(index)], context);
let result, error;
try { result = writer(value); if (mode === "repeat") result = writer(value); } catch (cause) { error = cause; }
if (foreign) {
  assert.equal(fs.existsSync(foreign), true, "foreign temporary must survive");
  assert.deepEqual(fs.readFileSync(foreign), stranger, "foreign bytes must survive");
}
if (["exclusive-collision", "write-failure", "close-failure", "harden-failure", "rename-failure", "cleanup-failure", "leaf-race"].includes(mode)) {
  assert.equal(injected, true); assert.ok(error); assert.equal(publications, 0);
  assert.deepEqual(fs.readFileSync(target), previous, "failure leaves the old generation intact");
  if (mode === "exclusive-collision") assert.equal(error.code, "EEXIST");
  else assert.equal(error, primary);
  if (mode === "cleanup-failure") assert.match(primary.cleanupError?.message || "", /injected config cleanup failure/);
  if (mode === "leaf-race") {
    assert.equal(primary.cleanupError?.code, "ESTALE");
    assert.deepEqual(fs.readFileSync(displaced), expected);
  }
} else {
  assert.equal(error, undefined); assert.equal(result, undefined, "retain wrapper return contract");
  assert.deepEqual(fs.readFileSync(target), expected, "preserve exact TOML/JSON bytes");
  assert.equal(publications, mode === "repeat" ? 2 : 1);
  assert.equal(security.privateFileIsProtected(target), true);
  if (process.platform === "win32") assert.equal(helpers, publications, "one Windows ACL per publication");
  else assert.equal(fs.statSync(directory).mode & 0o777, mode === "fresh" ? 0o700 : 0o755);
}
for (const file of temporaries) assert.equal(fs.existsSync(file), mode === "cleanup-failure" || mode === "leaf-race", "clean only owned unpublished temporary");
assert.equal(descriptors.size, 0); assert.equal(forbiddenReads, 0); assert.equal(forbiddenCommands, 0);
process.stdout.write(JSON.stringify({ publications, helpers }) + "\n");
`;

function exercise(index, mode) {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "router-codex-config-private-"));
  assert.equal(path.dirname(path.resolve(scratch)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(scratch).startsWith("router-codex-config-private-"));
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => (
    !/^(MODEL_ROUTER_|CODEX_ROUTER_|CODEX_HOME$|NODE_OPTIONS$|KIMI_|GROK_|GCLOUD_)/i.test(name)
    && !/(?:KEY|TOKEN|SECRET|PROXY)/i.test(name)
  )));
  Object.assign(env, { CODEX_HOME: path.join(scratch, "codex"),
    CODEX_ROUTER_STATE_DIR: path.join(scratch, "state"), MODEL_ROUTER_TARGET: "codex" });
  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", runner, root, scratch, String(index), mode], {
      cwd: root, env, encoding: "utf8", timeout: 120_000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr || result.stdout);
    for (const privateText of ["Fixture κ", "fixture-model"]) {
      assert.equal((result.stdout + result.stderr).includes(privateText), false, "do not print configuration data");
    }
    return JSON.parse(result.stdout);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

for (const [index, name] of ["Codex TOML", "provider-mode state", "signed-provider-mode state"].entries()) {
  for (const mode of ["fresh", "repeat", "legacy-collision", "exclusive-collision", "write-failure", "close-failure", "harden-failure", "rename-failure", "cleanup-failure", "leaf-race"]) {
    test(`${name}: ${mode} preserves private bytes and temporary ownership`, () => exercise(index, mode));
  }
}
