import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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

const [root, stage, mode] = process.argv.slice(1);
const preparing = stage === "prepare";
const load = (name) => import(pathToFileURL(path.join(root, "src", name)).href);
const security = await load("file-security.mjs");
const paths = await load("paths.mjs");
const module = await load("native-catalog-source.mjs");
const target = paths.NATIVE_CATALOG_SOURCE_PATH;
const catalogPath = path.join(process.env.CODEX_HOME, "native 目录's.json");
fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });
const catalogBytes = Buffer.from(JSON.stringify({ models: [{ slug: "gpt-fixture-native" }] }) + "\n");
const configBytes = Buffer.from("# untouched source 用户\r\nmodel_catalog_json = " + JSON.stringify(catalogPath) + "\r\n");
fs.writeFileSync(catalogPath, catalogBytes);
fs.writeFileSync(paths.CONFIG_PATH, configBytes);
const pending = { version: 1, path: catalogPath, status: "pending" };
const oldState = { ...pending, note: "retained 用户 metadata" };
const before = Buffer.from(JSON.stringify(oldState, null, 2).replace(/\n/g, "\r\n") + "\r\n");
const expectedState = preparing ? pending : { ...oldState, status: "active" };
const expected = Buffer.from(JSON.stringify(expectedState, null, 2) + "\n");
if (!preparing) {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
  fs.writeFileSync(target, before, { mode: 0o644 });
}
assert.equal(security.privateFileIsProtected(preparing ? catalogPath : target), false, "detect an unprotected fixture");
if (stage === "config-activate") {
  const windows = process.platform === "win32";
  const binary = path.join(process.env.CODEX_HOME, windows ? "codex-fixture.cmd" : "codex-fixture");
  fs.writeFileSync(binary, windows ? "@echo Not logged in 1>&2\r\n@exit /b 1\r\n" : "#!/bin/sh\necho 'Not logged in' >&2\nexit 1\n", { mode: 0o755 });
  process.env.CODEX_BIN = binary;
  fs.writeFileSync(paths.CALLER_SECRET_PATH, "synthetic-native-source-caller-capability\n", { mode: 0o600 });
}
const write = stage === "config-activate" ? async () => {
  process.argv = [process.execPath, path.join(root, "src", "config-manager.mjs"), "enable", "--adopt-native-catalog"];
  await load("config-manager.mjs");
} : preparing ? () => {
  assert.deepEqual(module.prepareNativeCatalogSourceFromConfig(), { created: true, source: pending });
} : () => assert.equal(module.activateNativeCatalogSource(), undefined);
const original = { exec: cp.execFileSync, open: fs.openSync, write: fs.writeFileSync, rename: fs.renameSync };
const focused = (value) => typeof value === "string" && value.startsWith(target + ".tmp.");
const temporaries = new Set();
const descriptors = new Map();
const stranger = Buffer.from("UNOWNED SYNTHETIC TEMPORARY\n");
let unowned, injected = false, replacements = 0, helperCalls = 0, configReplacements = 0;
if (mode === "legacy-collision") {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  unowned = target + ".tmp." + process.pid;
  original.write(unowned, stranger, { mode: 0o600 });
}
cp.execFileSync = (command, args, options = {}) => {
  if (options.env?.CODEX_ROUTER_PRIVATE_FILES) {
    const files = JSON.parse(options.env.CODEX_ROUTER_PRIVATE_FILES);
    if (files.some((file) => file === target || focused(file))) {
      helperCalls += 1;
      assert.equal(files.length, 1);
      if (mode === "harden-failure" && !injected) {
        injected = true;
        throw new Error("injected ACL failure");
      }
    }
  }
  return original.exec(command, args, options);
};
fs.openSync = (file, flags, permissions) => {
  if (focused(file) && flags === "wx") {
    assert.equal(temporaries.has(file), false);
    temporaries.add(file);
    if (mode === "exclusive-collision" && !injected) {
      injected = true;
      unowned = file;
      const collision = original.open(file, "wx", 0o600);
      try { original.write(collision, stranger); }
      finally { fs.closeSync(collision); }
    }
  }
  const descriptor = original.open(file, flags, permissions);
  if (focused(file) && flags === "wx") descriptors.set(descriptor, file);
  else descriptors.delete(descriptor);
  return descriptor;
};
fs.writeFileSync = (file, bytes, options) => {
  const temporary = typeof file === "number" ? descriptors.get(file) : file;
  if (focused(temporary)) temporaries.add(temporary);
  if (focused(temporary) && mode === "write-failure" && !injected) {
    injected = true;
    original.write(file, "partial unpublished bytes", options);
    throw new Error("injected write failure");
  }
  return original.write(file, bytes, options);
};
fs.renameSync = (temporary, destination) => {
  if (destination === paths.CONFIG_PATH) configReplacements += 1;
  if (destination === target) {
    assert.equal(path.dirname(temporary), path.dirname(target));
    assert.equal(security.privateFileIsProtected(temporary), true, "harden before publication");
    replacements += 1;
    if (mode === "rename-failure" && !injected) {
      injected = true;
      throw new Error("injected replacement failure");
    }
  }
  return original.rename(temporary, destination);
};
syncBuiltinESMExports();

let error;
try { await write(); } catch (cause) { error = cause; }
if (unowned) {
  assert.equal(fs.existsSync(unowned), true, "a colliding temporary belongs to another writer");
  assert.deepEqual(fs.readFileSync(unowned), stranger, "unowned bytes must survive");
}
const failure = mode.endsWith("failure") || mode === "exclusive-collision";
if (failure) {
  assert.ok(injected, "the intended failure must be reached");
  assert.ok(error, "publication failure must propagate");
  if (mode === "exclusive-collision") assert.equal(error.code, "EEXIST");
  else assert.match(error.message, /injected/);
  if (preparing) assert.equal(fs.existsSync(target), false, "a failed preparation must not leave a source record");
  else assert.deepEqual(fs.readFileSync(target), before, "failed activation preserves the exact pending record");
  assert.equal(replacements, mode === "rename-failure" ? 1 : 0);
} else {
  assert.equal(error, undefined);
  assert.deepEqual(fs.readFileSync(target), expected);
  assert.deepEqual(module.readNativeCatalogSource(), expectedState);
  assert.equal(security.privateFileIsProtected(target), true);
  assert.equal(replacements, 1);
  if (process.platform === "win32") assert.equal(helperCalls, 1, "one Windows ACL operation per record");
  if (preparing) assert.deepEqual(module.prepareNativeCatalogSourceFromConfig(), { created: false, source: pending });
  else assert.equal(module.activateNativeCatalogSource(), undefined);
  assert.equal(replacements, 1, "repeated preparation or activation must not republish");
}
assert.deepEqual(fs.readFileSync(catalogPath), catalogBytes, "adoption never rewrites the user's catalog");
assert.deepEqual(fs.readFileSync(paths.CONFIG_PATH), configBytes, "record writing never rewrites Codex config");
if (stage === "config-activate") assert.equal(configReplacements, 2, "activation failure restores the config after its first publication");
if (process.platform !== "win32") assert.equal(fs.statSync(path.dirname(target)).mode & 0o777, preparing ? 0o700 : 0o755);
for (const temporary of temporaries) {
  if (temporary !== unowned) assert.equal(fs.existsSync(temporary), false, "remove owned unpublished data only");
}
process.stdout.write(JSON.stringify({ failure, replacements, helperCalls }) + "\n");
`;

function exercise(stage, mode) {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "router-native-source-private-"));
  assert.equal(path.dirname(path.resolve(scratch)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(scratch).startsWith("router-native-source-private-"));
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => (
    !/^(MODEL_ROUTER_|CODEX_ROUTER_|CODEX_HOME$|NODE_OPTIONS$)/i.test(name)
    && !/(?:KEY|TOKEN|SECRET|PROXY)/i.test(name)
    && !/^(VERTEX_|GOOGLE_|GCLOUD_|CLOUDSDK_)/i.test(name)
  )));
  const state = path.join(scratch, "state 目录");
  Object.assign(env, {
    CODEX_HOME: path.join(scratch, "codex"),
    MODEL_ROUTER_STATE_DIR: state,
    CODEX_ROUTER_STATE_DIR: state,
    MODEL_ROUTER_USER_MODELS: path.join(state, "user-models.json"),
    CODEX_ROUTER_NO_DISCOVERY: "1",
  });
  try {
    return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", runner, root, stage, mode], {
      cwd: root, env, encoding: "utf8", timeout: 120_000,
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    }).trim());
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

for (const stage of ["prepare", "activate"]) {
  for (const mode of ["success", "legacy-collision", "write-failure", "rename-failure", "exclusive-collision"]) {
    test(`native catalog source ${stage} ${mode} preserves state and temporary ownership`, () => {
      assert.equal(exercise(stage, mode).failure, mode.endsWith("failure") || mode === "exclusive-collision");
    });
  }
  test(`native catalog source ${stage} hardening failure preserves the prior state`, {
    skip: process.platform !== "win32" ? "Windows ACL failure injection" : false,
  }, () => assert.equal(exercise(stage, "harden-failure").failure, true));
}
for (const mode of ["write-failure", "rename-failure"]) {
  test(`native catalog source config activation ${mode} restores the exact prior Codex config`, () => {
    assert.equal(exercise("config-activate", mode).failure, true);
  });
}
