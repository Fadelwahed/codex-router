import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Run the real catalog and private writer in isolated children. Builtin
// instrumentation injects failures but executes the real Windows ACL helper.
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
const catalog = await load("codex-agent-catalog.mjs");
const { subagentEffort } = await load("multi-agent-state.mjs");
const { CODEX_AGENTS_DIR: directory } = await load("paths.mjs");
const models = [
  { slug: "custom/new", displayName: "New fixture" },
  { slug: "custom/existing", displayName: "Existing fixture" },
];
const expected = new Map(models.map((model) => {
  const definition = catalog.routedAgentDefinition(model, { effort: subagentEffort(model.slug) });
  return [path.join(directory, definition.fileName), Buffer.from(definition.contents)];
}));
const existing = [...expected.keys()][1];
const stale = path.join(directory, "router-model-retired.toml");
const user = path.join(directory, "reviewer.toml");
const previous = new Map([
  [existing, Buffer.from('# previous routed definition\nname = "previous"\n')],
  [stale, Buffer.from('# previous retired definition\nname = "retired"\n')],
  [user, Buffer.from('# user-owned definition\nname = "reviewer"\n')],
]);
fs.mkdirSync(directory, { recursive: true, mode: 0o755 });
for (const [target, bytes] of previous) fs.writeFileSync(target, bytes, { mode: 0o644 });
assert.equal(security.privateFileIsProtected(existing), false, "permission detector must see the public fixture");

const original = {
  exec: cp.execFileSync, open: fs.openSync, write: fs.writeFileSync, rename: fs.renameSync,
};
const temporaryPaths = new Set();
const descriptors = new Map();
const stranger = Buffer.from("UNOWNED_SYNTHETIC_TEMPORARY\n");
let unowned;
let injected = false;
let replacements = 0;
let helperCalls = 0;
const isTemporary = (target) => typeof target === "string"
  && path.dirname(target) === directory && path.basename(target).includes(".tmp.");
const focused = (target) => typeof target === "string" && target.startsWith(existing + ".tmp.");
if (mode === "legacy-collision") {
  unowned = existing + ".tmp." + process.pid;
  original.write(unowned, stranger, { mode: 0o600 });
}

cp.execFileSync = (command, args, options = {}) => {
  if (options.env?.CODEX_ROUTER_PRIVATE_FILES) {
    const files = JSON.parse(options.env.CODEX_ROUTER_PRIVATE_FILES);
    helperCalls += 1;
    assert.equal(files.length, 1);
    if (mode === "harden-failure" && files.some(focused) && !injected) {
      injected = true;
      throw new Error("injected ACL failure");
    }
  }
  return original.exec(command, args, options);
};
fs.openSync = (target, flags, permissions) => {
  if (isTemporary(target) && flags === "wx") {
    assert.equal(temporaryPaths.has(target), false, "each replacement needs its own temporary");
    temporaryPaths.add(target);
    if (mode === "exclusive-collision" && focused(target) && !injected) {
      injected = true;
      unowned = target;
      const collision = original.open(target, "wx", 0o600);
      try { original.write(collision, stranger); }
      finally { fs.closeSync(collision); }
    }
  }
  const descriptor = original.open(target, flags, permissions);
  if (isTemporary(target) && flags === "wx") descriptors.set(descriptor, target);
  return descriptor;
};
fs.writeFileSync = (target, bytes, options) => {
  const temporary = typeof target === "number" ? descriptors.get(target) : target;
  if (isTemporary(temporary)) temporaryPaths.add(temporary);
  if (mode === "write-failure" && focused(temporary) && !injected) {
    injected = true;
    original.write(target, "partial unpublished bytes", options);
    throw new Error("injected write failure");
  }
  return original.write(target, bytes, options);
};
fs.renameSync = (temporary, target) => {
  if (path.dirname(target) === directory) {
    assert.equal(path.dirname(temporary), directory, "replacement stays on the same volume");
    assert.equal(security.privateFileIsProtected(temporary), true, "harden before publication");
    replacements += 1;
    if (mode === "rename-failure" && target === existing && !injected) {
      injected = true;
      throw new Error("injected replacement failure");
    }
  }
  return original.rename(temporary, target);
};
syncBuiltinESMExports();

let error;
try {
  catalog.syncRoutedCodexAgents(models);
  if (mode === "repeat") catalog.syncRoutedCodexAgents(models);
} catch (cause) { error = cause; }
if (unowned) {
  assert.equal(fs.existsSync(unowned), true, "a colliding temporary belongs to another writer");
  assert.deepEqual(fs.readFileSync(unowned), stranger, "a colliding temporary's bytes must not change");
}
const failure = ["write-failure", "harden-failure", "rename-failure", "exclusive-collision"].includes(mode);
if (failure) {
  assert.ok(injected, "the injected operation must actually be reached");
  assert.ok(error, "a failed publication must propagate");
  if (mode === "exclusive-collision") assert.equal(error.code, "EEXIST");
  else assert.match(error.message, /injected/);
  assert.equal(fs.existsSync([...expected.keys()][0]), false, "rollback removes the newly created definition");
  for (const [target, bytes] of previous) {
    assert.deepEqual(fs.readFileSync(target), bytes, "rollback restores exact previous definitions");
  }
} else {
  assert.equal(error, undefined);
  for (const [target, bytes] of expected) {
    assert.deepEqual(fs.readFileSync(target), bytes, "definition bytes are unchanged");
    assert.equal(security.privateFileIsProtected(target), true);
  }
  assert.equal(fs.existsSync(stale), false, "retired definitions are still removed");
  assert.deepEqual(fs.readFileSync(user), previous.get(user), "unmanaged definitions are untouched");
  assert.equal(replacements, expected.size * (mode === "repeat" ? 2 : 1));
  if (process.platform === "win32") assert.equal(helperCalls, replacements, "one ACL helper per published file");
  assert.equal(catalog.routedCodexAgentStatus(models).ok, true);
}
for (const temporary of temporaryPaths) {
  if (temporary !== unowned) assert.equal(fs.existsSync(temporary), false, "failed publication leaves no owned temporary");
}
process.stdout.write(JSON.stringify({ replacements, helperCalls, failure }) + "\n");
`;

function exercise(mode) {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "router-agent-private-"));
  assert.equal(path.dirname(path.resolve(scratch)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(scratch).startsWith("router-agent-private-"));
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => (
    !/^(MODEL_ROUTER_|CODEX_ROUTER_|CODEX_HOME$|NODE_OPTIONS$)/i.test(name)
    && !/(?:KEY|TOKEN|SECRET|PROXY)/i.test(name)
  )));
  const state = path.join(scratch, "state");
  Object.assign(env, {
    CODEX_HOME: path.join(scratch, "codex space's 目录"),
    MODEL_ROUTER_STATE_DIR: state,
    CODEX_ROUTER_STATE_DIR: state,
    MODEL_ROUTER_USER_MODELS: path.join(scratch, "models.json"),
    MODEL_ROUTER_MULTI_AGENT_STATE: path.join(state, "multi-agent.json"),
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

for (const mode of ["success", "repeat", "legacy-collision"]) {
  test(`agent catalog ${mode} preserves private definitions with one ACL operation per publication`, () => {
    assert.equal(exercise(mode).failure, false);
  });
}
for (const mode of ["write-failure", "rename-failure", "exclusive-collision"]) {
  test(`agent catalog ${mode} restores previous files and cleans only its own temporary`, () => {
    assert.equal(exercise(mode).failure, true);
  });
}
test("agent catalog ACL failure retains previous definitions and removes unpublished bytes", {
  skip: process.platform !== "win32" ? "Windows ACL failure injection" : false,
}, () => assert.equal(exercise("harden-failure").failure, true));
