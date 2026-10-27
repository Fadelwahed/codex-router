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

const [root, kind, mode] = process.argv.slice(1);
const load = (name) => import(pathToFileURL(path.join(root, "src", name)).href);
const security = await load("file-security.mjs");
const credentials = await load("provider-credentials.mjs");
const { PROVIDERS } = await load("model-registry.mjs");
const generic = kind === "generic";
const providerId = generic ? "synthetic-private-writer" : "deepseek";
const target = generic ? credentials.genericProviderCredentialPath(providerId)
  : credentials.primaryCredentialPath(PROVIDERS.get(providerId));
const write = (value) => generic ? credentials.writeGenericProviderCredential(providerId, value)
  : credentials.writeProviderCredential(providerId, value);
const reference = { type: "provider-file", providerId, target: "codex" };
const resolve = (ref = reference) => generic
  ? credentials.resolveGenericProviderCredentialReference(providerId, ref)
  : credentials.resolveProviderCredentialReference(providerId, ref);
const value = "\tSYNTHETIC_κ_new_目录 \r\n";
const expected = Buffer.from("SYNTHETIC_κ_new_目录\n");
const previous = Buffer.from("  SYNTHETIC_OLD\r\n");
fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
if (mode !== "fresh") {
  fs.writeFileSync(target, previous, { mode: 0o644 });
  fs.chmodSync(target, 0o644);
  assert.equal(security.privateFileIsProtected(target), false, "detector must reject a public fixture");
}

const original = { exec: cp.execFileSync, open: fs.openSync, write: fs.writeFileSync,
  close: fs.closeSync, rename: fs.renameSync, unlink: fs.unlinkSync };
const temporaries = new Set();
const descriptors = new Set();
const stranger = Buffer.from("UNOWNED_SYNTHETIC_TEMPORARY\n");
let unowned;
let displaced;
let injected = false;
let helperCalls = 0;
let publications = 0;
let opens = 0;
const focused = (file) => typeof file === "string" && file.startsWith(target + ".tmp.");
const primaryError = Object.assign(new Error("injected publication failure"), { code: "EACCES" });
if (mode === "legacy-collision") {
  unowned = target + ".tmp." + process.pid;
  original.write(unowned, stranger, { mode: 0o600 });
}
cp.execFileSync = (command, args, options = {}) => {
  assert.notEqual(command, "/usr/bin/security", "synthetic file references never require the real Keychain");
  if (options.env?.CODEX_ROUTER_PRIVATE_FILES) {
    helperCalls += 1;
    assert.deepEqual(JSON.parse(options.env.CODEX_ROUTER_PRIVATE_FILES).map((file) => focused(file) || file === target), [true]);
    if (mode === "harden-failure") { injected = true; throw primaryError; }
  }
  return original.exec(command, args, options);
};
fs.openSync = (file, flags, permission) => {
  if (focused(file) && flags === "wx") {
    assert.equal(permission, 0o600);
    opens += 1;
    assert.equal(temporaries.has(file), false, "each write needs its own temporary");
    if (mode === "exclusive-collision") {
      injected = true;
      unowned = file;
      const collision = original.open(file, "wx", 0o600);
      try { original.write(collision, stranger); } finally { original.close(collision); }
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
    throw primaryError;
  }
  return original.write(file, bytes, options);
};
fs.closeSync = (descriptor) => {
  const owned = descriptors.delete(descriptor);
  const result = original.close(descriptor);
  if (owned && mode === "close-failure") { injected = true; throw primaryError; }
  return result;
};
fs.renameSync = (temporary, destination) => {
  if (destination === target) {
    assert.equal(path.dirname(temporary), path.dirname(target));
    assert.equal(descriptors.size, 0, "close the complete write before publication");
    assert.equal(security.privateFileIsProtected(temporary), true, "harden before publishing key bytes");
    if (["rename-failure", "cleanup-failure", "leaf-race"].includes(mode)) {
      injected = true;
      if (mode === "leaf-race") {
        displaced = temporary + ".displaced";
        original.rename(temporary, displaced);
        unowned = temporary;
        original.write(unowned, stranger, { mode: 0o600 });
      }
      throw primaryError;
    }
    publications += 1;
  }
  return original.rename(temporary, destination);
};
fs.unlinkSync = (file) => {
  if (mode === "cleanup-failure" && temporaries.has(file)) throw new Error("injected cleanup failure");
  return original.unlink(file);
};
syncBuiltinESMExports();
globalThis.fetch = () => { throw new Error("no network is allowed in this synthetic writer test"); };

let error;
let result;
try {
  if (mode === "validation") {
    assert.throws(() => write(" \t\r\n"), /nothing changed/);
    assert.throws(() => credentials.writeProviderCredential("unknown-private-writer", value), /Unknown API-key provider/);
    for (const id of ["opencode-free", "custom"]) assert.throws(() => credentials.writeProviderCredential(id, value), /Unknown API-key provider/);
    assert.throws(() => credentials.writeProviderCredential("vertex", value), /does not accept API keys/);
    assert.throws(() => credentials.writeProviderCredential("github-copilot", "ghp_SYNTHETIC_CLASSIC_TOKEN"), /Classic GitHub PATs/);
    assert.throws(() => credentials.writeGenericProviderCredential("../outside", value), /Provider id must match/);
    assert.throws(() => credentials.writeGenericProviderCredential("deepseek", value), /already used/);
  } else {
    result = write(value);
    if (mode === "repeat") result = write(value);
  }
} catch (cause) { error = cause; }

if (unowned) {
  assert.equal(fs.existsSync(unowned), true, "a colliding temporary belongs to another writer");
  assert.deepEqual(fs.readFileSync(unowned), stranger, "foreign temporary bytes must remain exact");
}
const failure = ["write-failure", "close-failure", "harden-failure", "rename-failure", "cleanup-failure", "exclusive-collision", "leaf-race"].includes(mode);
if (failure) {
  assert.equal(injected, true, "the injected operation must be reached");
  assert.ok(error);
  assert.equal(publications, 0);
  assert.deepEqual(fs.readFileSync(target), previous, "failed publication preserves the exact old key");
  if (mode === "exclusive-collision") assert.equal(error.code, "EEXIST");
  else if (mode === "harden-failure") assert.match(error.message, /^Failed to protect private file ACL: injected publication failure/);
  else assert.equal(error, primaryError, "preserve the original failure object");
  if (mode === "cleanup-failure") assert.match(error.cleanupError?.message || "", /injected cleanup/);
  if (mode === "leaf-race") {
    assert.equal(error.cleanupError?.code, "ESTALE");
    assert.deepEqual(fs.readFileSync(displaced), expected);
    assert.equal(security.privateFileIsProtected(displaced), true);
  }
} else if (mode === "validation") {
  assert.equal(error, undefined);
  assert.equal(publications, 0);
  assert.equal(helperCalls, 0);
  assert.equal(opens, 0);
  assert.deepEqual(fs.readFileSync(target), previous);
} else {
  assert.equal(error, undefined);
  assert.equal(result, target);
  assert.deepEqual(fs.readFileSync(target), expected, "trim only input edges and append exactly one LF");
  assert.equal(security.privateFileIsProtected(target), true);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(target).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(target)).mode & 0o777, 0o700);
  }
  const writes = mode === "repeat" ? 2 : 1;
  assert.equal(publications, writes);
  if (process.platform === "win32") assert.equal(helperCalls, writes, "one ACL helper per key publication");
  assert.equal(resolve()?.value, expected.toString().trim());
  assert.equal(resolve()?.persistent, true);
  assert.equal(resolve({ ...reference, target: "cursor" }), undefined);
  assert.equal(resolve({ ...reference, providerId: "unrelated-provider" }), undefined);
  process.env.CODEX_ROUTER_NO_DISCOVERY = "1";
  assert.equal(resolve(), undefined);
  process.env.CODEX_ROUTER_NO_DISCOVERY = "0";
  assert.equal(resolve()?.value, expected.toString().trim());
}
for (const temporary of temporaries) {
  assert.equal(fs.existsSync(temporary), mode === "cleanup-failure" || mode === "leaf-race", "remove only owned unpublished temporaries");
  if (mode === "cleanup-failure") assert.equal(security.privateFileIsProtected(temporary), true);
}
assert.equal(descriptors.size, 0);
process.stdout.write(JSON.stringify({ helperCalls, publications, failure }) + "\n");
`;

function exercise(kind, mode) {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "router-provider-private-"));
  assert.equal(path.dirname(path.resolve(scratch)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(scratch).startsWith("router-provider-private-"));
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => (
    !/^(MODEL_ROUTER_|CODEX_ROUTER_|CODEX_HOME$|NODE_OPTIONS$|KIMI_|GROK_|GCLOUD_)/i.test(name)
    && !/(?:KEY|TOKEN|SECRET|PROXY)/i.test(name)
  )));
  Object.assign(env, {
    CODEX_HOME: path.join(scratch, "codex"),
    MODEL_ROUTER_STATE_DIR: path.join(scratch, "state space's 目录"),
    CODEX_ROUTER_STATE_DIR: path.join(scratch, "state space's 目录"),
    MODEL_ROUTER_TARGET: "codex",
    CODEX_ROUTER_NO_DISCOVERY: "0",
    KIMI_CODE_HOME: path.join(scratch, "kimi"),
    GROK_AUTH_PATH: path.join(scratch, "grok", "auth.json"),
    GCLOUD_BIN: path.join(scratch, "missing-gcloud"),
  });
  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", runner, root, kind, mode], {
      cwd: root, env, encoding: "utf8", timeout: 120_000,
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal((result.stdout + result.stderr).includes("SYNTHETIC_"), false, "writer output must not expose key bytes");
    return JSON.parse(result.stdout);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

for (const kind of ["builtin", "generic"]) {
  for (const mode of ["fresh", "repeat", "legacy-collision", "rename-failure", "exclusive-collision", "validation"]) {
    test(`${kind} provider key ${mode} preserves private bytes and ownership`, () => exercise(kind, mode));
  }
}
for (const mode of ["write-failure", "close-failure", "cleanup-failure", "leaf-race"]) {
  test(`provider key ${mode} preserves the old key and primary error`, () => exercise("builtin", mode));
}
test("provider key ACL failure preserves the old key and removes unpublished bytes", {
  skip: process.platform !== "win32" ? "Windows ACL failure injection" : false,
}, () => exercise("builtin", "harden-failure"));
