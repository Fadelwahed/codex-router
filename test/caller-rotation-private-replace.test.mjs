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
const rotation = await load("caller-key-rotation.mjs");
const target = path.join(scratch, "rotation space's 目录", "caller-secret");
const operationId = "a".repeat(32);
const temporary = target + ".rotate-new." + operationId;
const backup = rotation.callerCapabilityBackupPath(target, operationId);
const oldKey = "o".repeat(48), newKey = "n".repeat(48);
const previous = Buffer.from(oldKey + "\n"), next = Buffer.from(newKey + "\n");
fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
fs.writeFileSync(target, previous, { mode: 0o600 });
security.protectPrivateFile(target);
if (kind === "shared") {
  fs.writeFileSync(temporary, next, { mode: 0o600 });
  if (mode === "cross-directory") fs.mkdirSync(path.join(scratch, "other"));
}
const stranger = Buffer.from("FOREIGN ROTATION GENERATION\n");
if (mode === "temporary-collision") fs.writeFileSync(temporary, stranger);
if (mode === "backup-collision") fs.writeFileSync(backup, stranger);
const original = { exec: cp.execFileSync, rename: fs.renameSync, unlink: fs.unlinkSync,
  read: fs.readFileSync, chmod: fs.chmodSync };
const within = (file, parent) => {
  const relative = path.relative(parent, path.resolve(file instanceof URL ? fileURLToPath(file) : file));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};
const events = [];
let helpers = 0, forbiddenReads = 0, forbiddenCommands = 0, injected = false;
let beforeCalls = 0, afterCalls = 0, faults = true;
const primary = new Error("injected rotation publication failure");
const secondary = new Error("injected rotation rollback failure");
const thrown = [primary, undefined, null, false, 0, ""][Number(valueIndex || 0)];
const label = file => file === temporary ? "temporary" : file === backup ? "backup"
  : file === target ? original.read(target, "utf8").trim() === newKey ? "new-live" : "old-live" : "other";
cp.execFileSync = (command, args, options = {}) => {
  const list = options.env?.CODEX_ROUTER_PRIVATE_FILES;
  const one = options.env?.CODEX_ROUTER_PRIVATE_FILE;
  if (list || one) {
    const files = list ? JSON.parse(list) : [one];
    assert.ok(files.every(file => within(file, scratch)), "ACLs stay inside the synthetic fixture");
    if (list) helpers += files.length;
    return original.exec(command, args, options);
  }
  forbiddenCommands += 1; throw new Error("external command blocked");
};
fs.chmodSync = (file, permissions) => {
  if ([temporary, backup, target].includes(file)) events.push("harden:" + label(file));
  return original.chmod(file, permissions);
};
fs.renameSync = (source, destination) => {
  if (source === target && destination === backup) {
    events.push("rename:backup");
    if (mode === "backup-rename-failure" && faults) { injected = true; throw primary; }
  } else if (source === temporary && destination === target) {
    events.push("rename:publish");
    assert.equal(security.privateFileIsProtected(temporary), true, "protect before publish");
    if ((mode === "publish-failure" || mode === "rename-failure") && faults) { injected = true; throw primary; }
  } else if (source === backup && destination === target) {
    events.push("rename:restore:" + fs.existsSync(target));
    if (mode === "rollback-failure" && faults) { injected = true; throw secondary; }
  }
  return original.rename(source, destination);
};
fs.unlinkSync = file => {
  if (file === target) events.push("unlink:live");
  if (file === temporary) events.push("unlink:temporary");
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
const protect = file => {
  const current = label(file); events.push("custom:" + current);
  if (faults && ((current === "temporary" && mode === "harden-failure")
    || (current === "backup" && mode === "backup-protect-failure")
    || (current === "new-live" && ["final-failure", "rollback-failure"].includes(mode)))) {
    injected = true; throw primary;
  }
  return security.protectPrivateFile(file);
};
let result, error, caught = false;
try {
  if (kind === "rotation") result = rotation.swapCallerCapability({ secretPath: target,
    operationId: mode === "invalid-operation" ? "invalid" : operationId,
    generateSecret: () => mode === "same-key" ? oldKey : newKey,
    ...(mode === "default" || mode.endsWith("collision") || mode === "same-key" || mode === "invalid-operation" ? {} : { protect }) });
  else result = security.replacePrivateFile(mode === "cross-directory" ? path.join(scratch, "other", "new") : temporary, target, {
    protect,
    beforeReplace() {
      beforeCalls += 1; events.push("before");
      assert.deepEqual(fs.readFileSync(target), previous);
      if (mode === "before-failure") { injected = true; throw primary; }
    },
    ...(mode === "no-callback" ? {} : { afterReplace() {
      afterCalls += 1; events.push("after");
      assert.deepEqual(fs.readFileSync(target), next, "after callback sees the published generation");
      assert.equal(fs.existsSync(temporary), false);
      if (mode === "after-failure") { injected = true; throw thrown; }
    } }),
  });
} catch (cause) { caught = true; error = cause; }
if (kind === "shared") {
  const early = ["harden-failure", "before-failure", "rename-failure", "cross-directory"].includes(mode);
  const failure = early || mode === "after-failure" || mode === "final-failure";
  assert.equal(caught, failure, error?.stack || String(error));
  assert.deepEqual(fs.readFileSync(target), early ? previous : next);
  assert.equal(fs.existsSync(temporary), early);
  assert.equal(beforeCalls, ["harden-failure", "cross-directory"].includes(mode) ? 0 : 1);
  assert.equal(afterCalls, early || mode === "no-callback" ? 0 : 1, "post-replace callback runs exactly once only after a successful rename");
  if (failure) {
    if (mode === "cross-directory") assert.match(error.message, /same-directory/);
    else { assert.equal(injected, true); assert.equal(error, mode === "after-failure" ? thrown : primary); }
  } else assert.equal(result, target);
  if (!early) {
    const expected = ["custom:temporary", "harden:temporary", "before", "rename:publish",
      ...(mode === "no-callback" ? [] : ["after"]),
      ...(mode === "after-failure" ? [] : ["custom:new-live"]),
      ...(mode === "after-failure" || mode === "final-failure" ? [] : ["harden:new-live"])];
    assert.deepEqual(events, expected, "post-replace callback runs after rename and before final custom protection");
  }
} else {
  const invalid = ["temporary-collision", "backup-collision", "same-key", "invalid-operation"].includes(mode);
  const failure = invalid || mode.endsWith("failure");
  assert.equal(caught, failure, error?.stack || String(error));
  if (invalid) {
    assert.match(error.message, mode.endsWith("collision") ? /generation already exists/ : mode === "same-key" ? /existing key/ : /valid operation id/);
    assert.deepEqual(fs.readFileSync(target), previous);
    if (mode.endsWith("collision")) assert.deepEqual(fs.readFileSync(mode === "temporary-collision" ? temporary : backup), stranger);
    assert.deepEqual(events, []);
  } else if (failure) {
    assert.equal(injected, true);
    if (mode === "rollback-failure") {
      assert.equal(error.cause, primary); assert.match(error.message, /rollback failed: injected rotation rollback failure/);
      assert.equal(fs.existsSync(target), false);
      assert.deepEqual(fs.readFileSync(backup), previous, "retain old generation for recovery");
      faults = false;
      const recovered = rotation.restoreCallerCapability({ secretPath: target, operationId, protect });
      assert.equal(recovered.restored, true); assert.equal(recovered.currentSecret, oldKey);
    } else assert.equal(error, primary);
    assert.deepEqual(fs.readFileSync(target), previous);
    assert.equal(fs.existsSync(backup), false);
    if (["final-failure", "rollback-failure"].includes(mode)) {
      const removed = events.indexOf("unlink:live");
      assert.ok(removed > events.indexOf("rename:publish"), "published new generation must be removed before rollback");
      assert.ok(events.indexOf("rename:restore:false") > removed, "remove published new generation before restoring backup");
      assert.equal(events.includes("rename:restore:true"), false);
    }
  } else {
    assert.equal(result.previousSecret, oldKey); assert.equal(result.currentSecret, newKey); assert.equal(result.backupPath, backup);
    assert.deepEqual(fs.readFileSync(target), next); assert.deepEqual(fs.readFileSync(backup), previous);
    assert.equal(security.privateFileIsProtected(target), true); assert.equal(security.privateFileIsProtected(backup), true);
    if (process.platform === "win32") assert.equal(helpers, mode === "default" ? 2 : 3, "default rotation needs only temporary and backup ACLs; custom final protection remains");
    if (mode === "restore") {
      const restored = rotation.restoreCallerCapability({ secretPath: target, operationId, protect });
      assert.equal(restored.currentSecret, oldKey); assert.equal(restored.displacedSecret, newKey);
      assert.deepEqual(fs.readFileSync(target), previous); assert.equal(fs.existsSync(backup), false);
    } else if (mode === "discard") {
      assert.equal(rotation.discardCallerCapabilityBackup({ secretPath: target, operationId }), true);
      assert.equal(fs.existsSync(backup), false); assert.deepEqual(fs.readFileSync(target), next);
    }
  }
  if (mode !== "temporary-collision") assert.equal(fs.existsSync(temporary), false);
}
assert.equal(forbiddenReads, 0); assert.equal(forbiddenCommands, 0);
process.stdout.write(JSON.stringify({ helpers, beforeCalls, afterCalls }) + "\n");
`;

function exercise(kind, mode, valueIndex = 0) {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "router-rotation-private-"));
  assert.equal(path.dirname(path.resolve(scratch)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(scratch).startsWith("router-rotation-private-"));
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => (
    !/^(MODEL_ROUTER_|CODEX_ROUTER_|CODEX_HOME$|NODE_OPTIONS$|KIMI_|GROK_|GCLOUD_)/i.test(name)
    && !/(?:KEY|TOKEN|SECRET|PROXY)/i.test(name)
  )));
  Object.assign(env, { CODEX_HOME: path.join(scratch, "codex"), CODEX_ROUTER_STATE_DIR: path.join(scratch, "state"),
    MODEL_ROUTER_TARGET: "codex", KIMI_CODE_HOME: path.join(scratch, "kimi") });
  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", runner, root, scratch, kind, mode, String(valueIndex)], {
      cwd: root, env, encoding: "utf8", timeout: 120_000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr || result.stdout);
    for (const secret of ["o".repeat(48), "n".repeat(48)]) assert.equal((result.stdout + result.stderr).includes(secret), false, "do not print caller capabilities");
    return JSON.parse(result.stdout);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

for (const mode of ["default", "custom", "harden-failure", "backup-rename-failure", "backup-protect-failure", "publish-failure", "final-failure", "rollback-failure", "temporary-collision", "backup-collision", "same-key", "invalid-operation", "restore", "discard"]) {
  test(`caller rotation ${mode} preserves protection and generation state`, () => exercise("rotation", mode));
}
for (const mode of ["success", "no-callback", "harden-failure", "before-failure", "rename-failure", "final-failure", "cross-directory"]) {
  test(`private replacement ${mode} preserves callback boundaries`, () => exercise("shared", mode));
}
for (let index = 0; index < 6; index += 1) {
  test(`private replacement after callback preserves thrown value ${index}`, () => exercise("shared", "after-failure", index));
}
