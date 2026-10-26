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

const [root, index, mode] = process.argv.slice(1);
const selected = Number(index);
fs.mkdirSync(process.env.MODEL_ROUTER_STATE_DIR, { recursive: true });
fs.writeFileSync(path.join(process.env.MODEL_ROUTER_STATE_DIR, "compatibility-layer.json"),
  JSON.stringify({ version: 1, enabled: mode !== "disabled" }));
const load = (name) => import(pathToFileURL(path.join(root, "src", name)).href);
const security = await load("file-security.mjs");
const module = await load("litellm-config.mjs");
const directory = path.join(process.env.CODEX_HOME, "gateway 目录");
const names = ["grok_service_tier_callback.py", "litellm_stream_cleanup_callback.py", "litellm.yaml"];
const targets = names.map((name) => path.join(directory, name));
const target = targets[selected];
const before = names.map((name) => Buffer.from("OLD SYNTHETIC " + name + "\r\n"));
const expected = names.map((name, position) => position === 2
  ? Buffer.from(module.renderLiteLlmConfig()) : fs.readFileSync(path.join(root, "src", name)));
if (mode !== "new-directory") {
  fs.mkdirSync(directory, { recursive: true, mode: 0o755 });
  targets.forEach((file, position) => fs.writeFileSync(file, before[position], { mode: 0o644 }));
  assert.equal(security.privateFileIsProtected(target), false, "detect an unprotected fixture");
}
const original = { exec: cp.execFileSync, open: fs.openSync, write: fs.writeFileSync, rename: fs.renameSync };
const focused = (value) => typeof value === "string" && targets.some((file) => value.startsWith(file + ".tmp."));
const selectedTemporary = (value) => typeof value === "string" && value.startsWith(target + ".tmp.");
const temporaries = new Set();
const descriptors = new Map();
const helperCalls = new Map();
const replacements = [];
const stranger = Buffer.from("UNOWNED SYNTHETIC BYTES\n");
let unowned, injected = false;
if (mode === "legacy-collision") {
  unowned = target + ".tmp." + process.pid;
  original.write(unowned, stranger, { mode: 0o600 });
}
cp.execFileSync = (command, args, options = {}) => {
  if (options.env?.CODEX_ROUTER_PRIVATE_FILES) {
    const files = JSON.parse(options.env.CODEX_ROUTER_PRIVATE_FILES);
    const matching = files.find((file) => targets.includes(file) || focused(file));
    if (matching) {
      assert.equal(files.length, 1);
      const owner = targets.find((file) => file === matching || matching.startsWith(file + ".tmp."));
      helperCalls.set(owner, (helperCalls.get(owner) || 0) + 1);
      if (owner === target && mode === "harden-failure" && !injected) {
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
    if (selectedTemporary(file) && mode === "exclusive-collision" && !injected) {
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
  if (selectedTemporary(temporary) && mode === "write-failure" && !injected) {
    injected = true;
    original.write(file, "partial unpublished bytes", options);
    throw new Error("injected write failure");
  }
  return original.write(file, bytes, options);
};
fs.renameSync = (temporary, destination) => {
  if (targets.includes(destination)) {
    assert.equal(path.dirname(temporary), directory);
    assert.equal(security.privateFileIsProtected(temporary), true, "harden before publication");
    replacements.push(destination);
    if (destination === target && mode === "rename-failure" && !injected) {
      injected = true;
      throw new Error("injected replacement failure");
    }
  }
  return original.rename(temporary, destination);
};
syncBuiltinESMExports();

let error, result;
try { result = module.writeLiteLlmConfig(targets[2]); } catch (cause) { error = cause; }
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
  assert.deepEqual(replacements, targets.slice(0, selected + (mode === "rename-failure" ? 1 : 0)));
} else {
  assert.equal(error, undefined);
  assert.equal(result, mode === "disabled" ? undefined : targets[2]);
  assert.deepEqual(replacements, mode === "disabled" ? [] : targets);
}
for (const [position, file] of targets.entries()) {
  const published = mode !== "disabled" && (!failure || position < selected);
  assert.deepEqual(fs.readFileSync(file), published ? expected[position] : before[position], "preserve exact bytes and existing partial-publication order");
  if (published) {
    assert.equal(security.privateFileIsProtected(file), true);
    if (process.platform === "win32") assert.equal(helperCalls.get(file), 1, "one Windows ACL operation per published file");
  }
}
if (mode === "disabled") {
  assert.equal(helperCalls.size, 0);
  assert.equal(temporaries.size, 0);
}
if (process.platform !== "win32") {
  assert.equal(fs.statSync(directory).mode & 0o777, mode === "new-directory" ? 0o700 : 0o755);
}
for (const temporary of temporaries) {
  if (temporary !== unowned) assert.equal(fs.existsSync(temporary), false, "remove owned unpublished data only");
}
process.stdout.write(JSON.stringify({ failure, replacements: replacements.length }) + "\n");
`;

function exercise(index, mode) {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "router-gateway-private-"));
  assert.equal(path.dirname(path.resolve(scratch)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(scratch).startsWith("router-gateway-private-"));
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => (
    !/^(MODEL_ROUTER_|CODEX_ROUTER_|CODEX_HOME$|NODE_OPTIONS$)/i.test(name)
    && !/(?:KEY|TOKEN|SECRET|PROXY)/i.test(name)
    && !/^(VERTEX_|GOOGLE_|GCLOUD_|CLOUDSDK_)/i.test(name)
  )));
  const state = path.join(scratch, "state");
  Object.assign(env, {
    CODEX_HOME: path.join(scratch, "codex"),
    MODEL_ROUTER_STATE_DIR: state,
    CODEX_ROUTER_STATE_DIR: state,
    MODEL_ROUTER_USER_MODELS: path.join(state, "user-models.json"),
    CODEX_ROUTER_NO_DISCOVERY: "1",
  });
  try {
    return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", runner, root, String(index), mode], {
      cwd: root, env, encoding: "utf8", timeout: 120_000,
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    }).trim());
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

for (const [index, name] of ["Grok callback", "cleanup callback", "gateway YAML"].entries()) {
  for (const mode of ["success", "legacy-collision", "write-failure", "rename-failure", "exclusive-collision"]) {
    test(`${name} ${mode} preserves bytes, order and temporary ownership`, () => {
      assert.equal(exercise(index, mode).failure, mode.endsWith("failure") || mode === "exclusive-collision");
    });
  }
  test(`${name} hardening failure preserves the prior publication boundary`, {
    skip: process.platform !== "win32" ? "Windows ACL failure injection" : false,
  }, () => assert.equal(exercise(index, "harden-failure").failure, true));
}
test("new gateway directory is created privately without changing publication order", () => {
  assert.equal(exercise(2, "new-directory").replacements, 3);
});
test("disabled compatibility layer leaves every gateway document untouched", () => {
  assert.equal(exercise(2, "disabled").replacements, 0);
});
