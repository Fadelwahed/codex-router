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
const expected = new Map();
const previous = new Map();
let write;
if (kind === "dsh") {
  const module = await load("dsh-config-manager.mjs");
  const { callerBaseUrl } = await load("caller-auth.mjs");
  const oldKey = "o".repeat(48), nextKey = "n".repeat(48);
  fs.mkdirSync(paths.STATE_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(paths.CALLER_SECRET_PATH, nextKey + "\n", { mode: 0o600 });
  const oldBase = callerBaseUrl(paths.PORTS.router, oldKey);
  const nextBase = callerBaseUrl(paths.PORTS.router, nextKey);
  // Use the scalar shape emitted by DSH publication; parsing is unchanged.
  const credentials = '# caller-owned credentials comment\nrefs:\n  # keep credential comment\n  CODEX_ROUTER_CALLER_KEY: "' + oldKey + '"\n  USER_KEY: "unchanged-fixture"\n';
  const settings = '# caller-owned settings comment\nllm-pi-ai:\n  providers:\n    codex-router:\n      # keep route comment\n      baseURL: ' + JSON.stringify(oldBase) + '\n      api: "openai-responses"\n    user-route:\n      baseURL: "https://fixture.invalid/v1"\n';
  previous.set(paths.DSH_CREDENTIALS_PATH, Buffer.from(credentials));
  previous.set(paths.DSH_SETTINGS_PATH, Buffer.from(settings));
  expected.set(paths.DSH_CREDENTIALS_PATH, Buffer.from(credentials.replace('"' + oldKey + '"', '"' + nextKey + '"')));
  expected.set(paths.DSH_SETTINGS_PATH, Buffer.from(settings.replace(JSON.stringify(oldBase), JSON.stringify(nextBase))));
  write = () => assert.equal(module.refreshCallerCapability().refreshed, true);
} else {
  const module = await load("routed-harness-document.mjs");
  const target = path.join(paths.CODEX_HOME, "client", "settings.yaml");
  const contents = kind === "bytes"
    ? Buffer.from([0xef, 0xbb, 0xbf, 0, 0xff, 0x80, 10])
    : "# caller-owned comment\r\nsetting: '目录'\r\n";
  previous.set(target, Buffer.from("OLD_SYNTHETIC_DOCUMENT\n"));
  expected.set(target, Buffer.from(contents));
  write = () => assert.equal(module.writeHarnessDocument(target, contents), target);
}
const target = [...expected.keys()][0];
for (const [file, bytes] of previous) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
  fs.writeFileSync(file, bytes, { mode: 0o644 });
  assert.equal(security.privateFileIsProtected(file), false, "permission detector must identify the public fixture");
}
const original = { exec: cp.execFileSync, open: fs.openSync, write: fs.writeFileSync, rename: fs.renameSync };
const focused = (value) => typeof value === "string"
  && [...expected.keys()].some((file) => value.startsWith(file + ".tmp."));
const primary = (value) => typeof value === "string" && value.startsWith(target + ".tmp.");
const temporaries = new Set();
const descriptors = new Map();
const stranger = Buffer.from("UNOWNED_SYNTHETIC_TEMPORARY\n");
let unowned, injected = false, helperCalls = 0;
const replacements = [];
if (mode === "legacy-collision") {
  unowned = target + ".tmp." + process.pid;
  original.write(unowned, stranger, { mode: 0o600 });
}
cp.execFileSync = (command, args, options = {}) => {
  if (options.env?.CODEX_ROUTER_PRIVATE_FILES) {
    const files = JSON.parse(options.env.CODEX_ROUTER_PRIVATE_FILES);
    if (files.some((file) => expected.has(file) || focused(file))) {
      helperCalls += 1;
      assert.equal(files.length, 1);
      if (mode === "harden-failure" && files.some(primary) && !injected) {
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
    if (mode === "exclusive-collision" && primary(file) && !injected) {
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
  if (primary(temporary) && mode === "write-failure" && !injected) {
    injected = true;
    original.write(file, "partial unpublished bytes", options);
    throw new Error("injected write failure");
  }
  return original.write(file, bytes, options);
};
fs.renameSync = (temporary, destination) => {
  if (expected.has(destination)) {
    assert.equal(path.dirname(temporary), path.dirname(destination));
    assert.equal(security.privateFileIsProtected(temporary), true, "harden before publishing");
    replacements.push(destination);
    const failingTarget = mode === "second-rename-failure" ? [...expected.keys()][1] : target;
    if (["rename-failure", "second-rename-failure"].includes(mode) && destination === failingTarget && !injected) {
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
  assert.ok(error, "publication failure must propagate");
  if (mode === "exclusive-collision") assert.equal(error.code, "EEXIST");
  else assert.match(error.message, /injected/);
  for (const [file, bytes] of previous) {
    // DSH retains its established credentials-then-settings publication order.
    const before = mode === "second-rename-failure" && file === target ? expected.get(file) : bytes;
    assert.deepEqual(fs.readFileSync(file), before);
  }
  assert.equal(replacements.length, mode === "second-rename-failure" ? 2 : mode === "rename-failure" ? 1 : 0);
} else {
  assert.equal(error, undefined);
  for (const [file, bytes] of expected) {
    assert.deepEqual(fs.readFileSync(file), bytes, "text/binary bytes and user-owned content are unchanged");
    assert.equal(security.privateFileIsProtected(file), true);
    if (process.platform !== "win32") assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o755);
  }
  assert.deepEqual(replacements, [...expected.keys()]);
  if (process.platform === "win32") assert.equal(helperCalls, expected.size, "one Windows ACL operation per file");
}
for (const temporary of temporaries) {
  if (temporary !== unowned) assert.equal(fs.existsSync(temporary), false, "owned unpublished data must be removed");
}
process.stdout.write(JSON.stringify({ failure, files: expected.size, helperCalls }) + "\n");
`;

function exercise(kind, mode) {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "router-harness-private-"));
  assert.equal(path.dirname(path.resolve(scratch)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(scratch).startsWith("router-harness-private-"));
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => (
    !/^(MODEL_ROUTER_|CODEX_ROUTER_|CODEX_HOME$|DSH_HOME$|NODE_OPTIONS$)/i.test(name)
    && !/(?:KEY|TOKEN|SECRET|PROXY)/i.test(name)
  )));
  const state = path.join(scratch, "state");
  const home = path.join(scratch, "harness space's 目录");
  Object.assign(env, {
    CODEX_HOME: path.join(scratch, "codex"), MODEL_ROUTER_STATE_DIR: state, CODEX_ROUTER_STATE_DIR: state,
    DSH_HOME: home, MODEL_ROUTER_DSH_SETTINGS: path.join(home, "settings.yaml"),
    MODEL_ROUTER_DSH_CREDENTIALS: path.join(home, ".credentials.yaml"),
    MODEL_ROUTER_USER_MODELS: path.join(state, "user-models.json"),
    CODEX_ROUTER_NO_DISCOVERY: "1", MODEL_ROUTER_ALLOW_FOREIGN_STATE: "1",
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

for (const kind of ["text", "bytes", "dsh"]) {
  for (const mode of ["success", "legacy-collision", "write-failure", "rename-failure", "exclusive-collision"]) {
    test(`${kind} harness ${mode} preserves document bytes and temporary ownership`, () => {
      assert.equal(exercise(kind, mode).failure, mode.endsWith("failure") || mode === "exclusive-collision");
    });
  }
  test(`${kind} harness ACL failure preserves documents and cleans unpublished data`, {
    skip: process.platform !== "win32" ? "Windows ACL failure injection" : false,
  }, () => assert.equal(exercise(kind, "harden-failure").failure, true));
}
test("DSH later replacement failure retains its established per-document publication order", () => {
  assert.equal(exercise("dsh", "second-rename-failure").failure, true);
});
