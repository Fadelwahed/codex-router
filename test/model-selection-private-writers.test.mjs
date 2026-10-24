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

const [root, kind, mode] = process.argv.slice(1);
const load = (name) => import(pathToFileURL(path.join(root, "src", name)).href);
const security = await load("file-security.mjs");
const paths = await load("paths.mjs");
const json = (value) => Buffer.from(JSON.stringify(value, null, 2) + "\n");
let target, before, expected, write;
if (kind === "default") {
  const module = await load("codex-default-model.mjs");
  target = paths.CODEX_DEFAULT_MODEL_PATH;
  before = json({ version: 1, model: "custom/previous", previousPresent: true, previousModel: "gpt-fixture" });
  expected = json({ version: 1, model: "custom/fixture", previousPresent: true, previousModel: "gpt-fixture" });
  write = () => module.writeCodexRouterDefault({ model: " custom/fixture ", previousPresent: true, previousModel: "gpt-fixture" });
} else if (kind === "picker") {
  const module = await load("model-picker-state.mjs");
  target = module.MODEL_PICKER_STATE_PATH;
  before = json({ version: 1, hidden: ["custom/z"], visible: ["custom/b", "custom/a"], seeded: ["custom/z", "custom/b", "custom/a"] });
  expected = json({ version: 1, hidden: ["custom/z"], visible: ["custom/a", "custom/b"], seeded: ["custom/a", "custom/b", "custom/z"], order: "routed-first" });
  write = () => module.setPickerOrder("routed-first");
} else if (kind === "local") {
  const module = await load("local-models.mjs");
  target = module.LOCAL_MODELS_STATE_PATH;
  before = json({ version: 1, enabled: ["previous:latest"] });
  expected = json({ version: 1, enabled: ["fixture:latest", "previous:latest"] });
  write = () => module.setLocalModelEnabled("fixture:latest", true, { capabilitiesFor: () => ["completion", "tools"] });
} else throw new Error("unknown model-selection fixture");

fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
fs.writeFileSync(target, before, { mode: 0o644 });
assert.equal(security.privateFileIsProtected(target), false, "permission detector must identify the public fixture");
const original = { exec: cp.execFileSync, open: fs.openSync, write: fs.writeFileSync, rename: fs.renameSync };
const focused = (value) => typeof value === "string" && value.startsWith(target + ".tmp.");
const temporaries = new Set();
const descriptors = new Map();
const stranger = Buffer.from("UNOWNED_SYNTHETIC_TEMPORARY\n");
let unowned, injected = false, replacements = 0, helperCalls = 0;
if (mode === "legacy-collision") {
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
  if (destination === target) {
    assert.equal(path.dirname(temporary), path.dirname(target));
    assert.equal(security.privateFileIsProtected(temporary), true, "harden before publishing");
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
try { write(); } catch (cause) { error = cause; }
if (unowned) {
  assert.equal(fs.existsSync(unowned), true, "a colliding temporary belongs to another writer");
  assert.deepEqual(fs.readFileSync(unowned), stranger, "unowned bytes must survive");
}
const failure = mode.endsWith("failure") || mode === "exclusive-collision";
if (failure) {
  assert.ok(injected, "the intended failure must be reached");
  assert.ok(error, "publication failures must propagate");
  if (mode === "exclusive-collision") assert.equal(error.code, "EEXIST");
  else assert.match(error.message, /injected/);
  assert.deepEqual(fs.readFileSync(target), before, "failed publication preserves the previous settings");
  assert.equal(replacements, mode === "rename-failure" ? 1 : 0);
} else {
  assert.equal(error, undefined);
  assert.deepEqual(fs.readFileSync(target), expected, "settings bytes and previous model choices are preserved");
  assert.equal(security.privateFileIsProtected(target), true);
  assert.equal(replacements, 1);
  if (process.platform === "win32") assert.equal(helperCalls, 1, "one Windows ACL operation per settings file");
  else assert.equal(fs.statSync(path.dirname(target)).mode & 0o777, kind === "default" ? 0o755 : 0o700);
}
for (const temporary of temporaries) {
  if (temporary !== unowned) assert.equal(fs.existsSync(temporary), false, "unpublished owned temporary must be removed");
}
process.stdout.write(JSON.stringify({ failure, replacements, helperCalls }) + "\n");
`;

function exercise(kind, mode) {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "router-model-private-"));
  assert.equal(path.dirname(path.resolve(scratch)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(scratch).startsWith("router-model-private-"));
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => (
    !/^(MODEL_ROUTER_|CODEX_ROUTER_|CODEX_HOME$|NODE_OPTIONS$)/i.test(name)
    && !/(?:KEY|TOKEN|SECRET|PROXY)/i.test(name)
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
    return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", runner, root, kind, mode], {
      cwd: root, env, encoding: "utf8", timeout: 120_000,
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    }).trim());
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

for (const kind of ["default", "picker", "local"]) {
  for (const mode of ["success", "legacy-collision", "write-failure", "rename-failure", "exclusive-collision"]) {
    test(`${kind} settings ${mode} preserves bytes, privacy and temporary ownership`, () => {
      assert.equal(exercise(kind, mode).failure, mode.endsWith("failure") || mode === "exclusive-collision");
    });
  }
  test(`${kind} settings hardening failure preserves old bytes and cleans unpublished data`, {
    skip: process.platform !== "win32" ? "Windows ACL failure injection" : false,
  }, () => assert.equal(exercise(kind, "harden-failure").failure, true));
}
