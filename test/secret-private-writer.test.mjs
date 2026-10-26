import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Exercise the real CLI and permissions helper in a child with synthetic keys.
// Instrument only the operations needed to observe publication or inject faults.
const runner = String.raw`
import assert from "node:assert/strict";
import cp from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [root, mode] = process.argv.slice(1);
const load = (name) => import(pathToFileURL(path.join(root, "src", name)).href);
const security = await load("file-security.mjs");
const paths = await load("paths.mjs");
const targets = [paths.INTERNAL_SECRET_PATH, paths.CALLER_SECRET_PATH, paths.CURSOR_PUBLIC_SECRET_PATH];
const target = targets[0];
const previous = new Map();
fs.mkdirSync(paths.STATE_DIR, { recursive: true, mode: 0o700 });
const existing = mode.startsWith("existing-") || mode === "repair-failure";
const failing = ["write-failure", "close-failure", "harden-failure", "rename-failure", "cleanup-failure", "exclusive-collision"].includes(mode);
for (const [index, file] of targets.entries()) {
  if (existing || mode === "invalid-existing" || failing || mode === "legacy-collision") {
    const bytes = Buffer.from((!existing && index === 0 ? "invalid old key" : String(index).repeat(64)) + "\n");
    previous.set(file, bytes);
    fs.writeFileSync(file, bytes, { mode: 0o644 });
  }
}
if (existing) assert.equal(security.privateFileIsProtected(target), false, "detector must reject a public fixture before repair");

const original = { exec: cp.execFileSync, open: fs.openSync, write: fs.writeFileSync,
  close: fs.closeSync, rename: fs.renameSync, unlink: fs.unlinkSync };
const temporaries = new Set();
const descriptors = new Set();
const stranger = Buffer.from("UNOWNED_TEMPORARY\n");
let unowned;
let helperCalls = 0;
let publications = 0;
let injected = false;
const focused = (file) => typeof file === "string" && file.startsWith(target + ".tmp.");
const fault = (phase) => Object.assign(new Error("injected " + phase + " failure"), { code: "EACCES" });
if (mode === "legacy-collision") {
  unowned = target + ".tmp." + process.pid;
  original.write(unowned, stranger, { mode: 0o600 });
}
cp.execFileSync = (command, args, options = {}) => {
  if (options.env?.CODEX_ROUTER_PRIVATE_FILES) {
    helperCalls += 1;
    const files = JSON.parse(options.env.CODEX_ROUTER_PRIVATE_FILES);
    if ((mode === "harden-failure" && files.some(focused))
      || (mode === "repair-failure" && files.includes(target))) {
      injected = true;
      throw fault("ACL");
    }
  }
  return original.exec(command, args, options);
};
fs.openSync = (file, flags, permission) => {
  if (focused(file) && flags === "wx") {
    assert.equal(permission, 0o600);
    if (mode === "exclusive-collision") {
      injected = true;
      unowned = file;
      const collision = original.open(file, "wx", 0o600);
      try { original.write(collision, stranger); }
      finally { original.close(collision); }
    }
  }
  const descriptor = original.open(file, flags, permission);
  if (focused(file) && flags === "wx") { temporaries.add(file); descriptors.add(descriptor); }
  return descriptor;
};
fs.writeFileSync = (file, bytes, options) => {
  if (descriptors.has(file) && mode === "write-failure") {
    injected = true;
    original.write(file, "PARTIAL");
    throw fault("write");
  }
  return original.write(file, bytes, options);
};
fs.closeSync = (descriptor) => {
  const owned = descriptors.delete(descriptor);
  const result = original.close(descriptor);
  if (owned && mode === "close-failure") { injected = true; throw fault("close"); }
  return result;
};
fs.renameSync = (temporary, file) => {
  if (targets.includes(file)) {
    assert.equal(path.dirname(temporary), path.dirname(file));
    assert.equal(security.privateFileIsProtected(temporary), true, "protect bytes before publication");
    if (focused(temporary)) {
      assert.equal(descriptors.size, 0, "close the completed write before publication");
      if (["rename-failure", "cleanup-failure"].includes(mode)) { injected = true; throw fault("rename"); }
    }
    publications += 1;
  }
  return original.rename(temporary, file);
};
fs.unlinkSync = (file) => {
  if (mode === "cleanup-failure" && temporaries.has(file)) throw fault("cleanup");
  return original.unlink(file);
};
syncBuiltinESMExports();

const command = mode === "existing-status" || mode === "missing-status" ? "status" : "ensure";
process.argv[2] = command;
const write = process.stdout.write;
let output = "";
let error;
process.stdout.write = (value) => { output += String(value); return true; };
try { await load("secret.mjs"); } catch (cause) { error = cause; }
finally { process.stdout.write = write; }

if (unowned) {
  assert.equal(fs.existsSync(unowned), true, "a colliding temporary belongs to another writer");
  assert.deepEqual(fs.readFileSync(unowned), stranger, "a colliding temporary must retain its exact bytes");
}
if (failing || mode === "repair-failure") {
  assert.equal(injected, true, "the injected operation must actually be reached");
  assert.ok(error, "publication or permission repair failure must propagate");
  assert.equal(output, "", "failed ensure must not report a successful status");
  assert.equal(publications, 0);
  for (const [file, bytes] of previous) assert.deepEqual(fs.readFileSync(file), bytes, "failure preserves the previous key generation");
  if (mode === "exclusive-collision") assert.equal(error.code, "EEXIST");
  if (mode === "cleanup-failure") {
    assert.match(error.message, /injected rename/);
    assert.match(error.cleanupError?.message || "", /injected cleanup/);
  }
} else {
  assert.equal(error, undefined);
  const status = JSON.parse(output);
  assert.deepEqual(Object.keys(status).sort(), ["caller", "cursorPublic", "internal", "mode", "present"]);
  if (mode === "missing-status") {
    assert.equal(process.exitCode, 1);
    assert.deepEqual(status, { present: false, mode: null, internal: { present: false, mode: null }, caller: { present: false, mode: null }, cursorPublic: { present: false, mode: null } });
    for (const file of targets) assert.equal(fs.existsSync(file), false);
    assert.equal(publications, 0);
    assert.equal(helperCalls, 0);
    process.exitCode = 0;
  } else {
    assert.equal(status.present, true);
    for (const [index, file] of targets.entries()) {
      const bytes = fs.readFileSync(file);
      assert.match(bytes.toString(), /^[A-Za-z0-9_-]{64}\n$/);
      assert.equal(security.privateFileIsProtected(file), true, "published and repaired keys must be private");
      const item = status[["internal", "caller", "cursorPublic"][index]];
      assert.equal(item.present, true);
      assert.equal(item.mode, fs.statSync(file).mode & 0o777);
      if (process.platform !== "win32") assert.equal(item.mode, 0o600);
      if (existing || (previous.has(file) && index > 0)) assert.deepEqual(bytes, previous.get(file), "valid keys must never rotate during ensure/status");
    }
    if (!previous.size) assert.equal(new Set(targets.map((file) => fs.readFileSync(file, "utf8"))).size, 3);
    assert.equal(publications, existing ? 0 : previous.size ? 1 : 3);
    if (process.platform === "win32") assert.equal(helperCalls, 3, "one protection per new key or existing-key repair");
  }
}
for (const temporary of temporaries) {
  assert.equal(fs.existsSync(temporary), mode === "cleanup-failure", "clean only owned unpublished temporaries");
  if (mode === "cleanup-failure") assert.equal(security.privateFileIsProtected(temporary), true);
}
assert.equal(descriptors.size, 0);
process.stdout.write(JSON.stringify({ helperCalls, publications }) + "\n");
`;

function exercise(mode) {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "router-secret-private-"));
  assert.equal(path.dirname(path.resolve(scratch)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(scratch).startsWith("router-secret-private-"));
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => (
    !/^(MODEL_ROUTER_|CODEX_ROUTER_|CODEX_HOME$|NODE_OPTIONS$)/i.test(name)
    && !/(?:KEY|TOKEN|SECRET|PROXY)/i.test(name)
  )));
  Object.assign(env, {
    CODEX_HOME: path.join(scratch, "codex"),
    MODEL_ROUTER_STATE_DIR: path.join(scratch, "state space's 目录"),
    CODEX_ROUTER_STATE_DIR: path.join(scratch, "state space's 目录"),
    MODEL_ROUTER_TARGET: "codex",
    CODEX_ROUTER_NO_DISCOVERY: "1",
  });
  try {
    return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", runner, root, mode], {
      cwd: root, env, encoding: "utf8", timeout: 120_000,
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    }).trim());
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

for (const mode of ["fresh", "invalid-existing", "existing-ensure", "existing-status", "missing-status", "legacy-collision"]) {
  test(`secret CLI ${mode} preserves key bytes, status and required privacy work`, () => exercise(mode));
}
for (const mode of ["write-failure", "close-failure", "rename-failure", "cleanup-failure", "exclusive-collision"]) {
  test(`secret CLI ${mode} preserves prior keys and temporary ownership`, () => exercise(mode));
}
for (const mode of ["harden-failure", "repair-failure"]) {
  test(`secret CLI ${mode} fails closed without replacing keys`, {
    skip: process.platform !== "win32" ? "Windows ACL failure injection" : false,
  }, () => exercise(mode));
}
