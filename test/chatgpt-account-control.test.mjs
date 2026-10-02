import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync as rawWriteFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { protectPrivateFile } from "../src/file-security.mjs";

function writeFileSync(target, contents, options) {
  rawWriteFileSync(target, contents, options);
  if (options && typeof options === "object" && options.mode === 0o600) {
    protectPrivateFile(target);
  }
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stateDir = mkdtempSync(path.join(os.tmpdir(), "codex-account-control-"));
const codexStub = path.join(stateDir, process.platform === "win32" ? "codex-control-stub.cmd" : "codex-control-stub");
writeFileSync(
  codexStub,
  process.platform === "win32"
    ? "@echo off\r\nif \"%1\"==\"--version\" (echo codex-cli 99.0.0& exit /b 0)\r\nif \"%1\"==\"login\" exit /b 0\r\nif \"%1\"==\"debug\" (echo {\"models\":[{\"slug\":\"gpt-5.6-sol\",\"display_name\":\"GPT-5.6 Sol\",\"visibility\":\"list\"}]}& exit /b 0)\r\nexit /b 1\r\n"
    : "#!/bin/sh\ncase \"$1\" in\n  --version) echo 'codex-cli 99.0.0' ;;\n  login) exit 0 ;;\n  debug) printf '%s\\n' '{\"models\":[{\"slug\":\"gpt-5.6-sol\",\"display_name\":\"GPT-5.6 Sol\",\"visibility\":\"list\"}]}' ;;\n  *) exit 1 ;;\nesac\n",
  { mode: 0o755 },
);
const env = {
  ...process.env,
  CODEX_BIN: codexStub,
  CODEX_HOME: stateDir,
  MODEL_ROUTER_STATE_DIR: stateDir,
};
const run = (...args) => JSON.parse(execFileSync(process.execPath, [path.join(root, "src/control.mjs"), ...args], {
  env,
  encoding: "utf8",
}));

test.after(() => rmSync(stateDir, { recursive: true, force: true }));

test("account selection persists without replacing another saved login", () => {
  writeFileSync(
    path.join(stateDir, "auth.json"),
    JSON.stringify({ tokens: { account_id: "current" } }),
    { mode: 0o600 },
  );
  const added = run("chatgpt-account-pool", "add", "Secondary").account;
  mkdirSync(path.join(stateDir, "chatgpt-accounts", added.id), { recursive: true });
  writeFileSync(
    path.join(stateDir, "chatgpt-accounts", added.id, "auth.json"),
    JSON.stringify({ tokens: { account_id: "secondary" } }),
    { mode: 0o600 },
  );
  const selected = run("chatgpt-account-pool", "select", added.id);
  assert.equal(selected.policy.selectedAccountId, added.id);
  const status = run("chatgpt-account-pool", "status");
  assert.equal(status.policy.mode, "switch");
  assert.equal(status.profile.desired, added.id);
  assert.equal(status.profile.pending, status.profile.running);
  assert.equal(status.accounts[added.id].label, "Secondary");
  assert.equal(status.accounts[added.id].state, "active");
  assert.equal(Object.keys(status.accounts).length, 2);

  const primary = Object.keys(status.accounts).find((id) => id !== added.id);
  // Desktop runners queue the selection and headless runners apply it. Build
  // the pending removal around the profile that actually became active so the
  // production guard is exercised on both instead of fabricating stale state
  // that ensureProfileAccountLocked correctly normalizes away.
  const pendingActive = status.profile.active;
  const pendingTarget = pendingActive === added.id ? primary : added.id;
  assert.ok(pendingActive);
  assert.ok(pendingTarget);
  writeFileSync(
    path.join(stateDir, "chatgpt-profile-switch.json"),
    JSON.stringify({ version: 1, desired: pendingTarget, active: pendingActive, pending: true, phase: "idle" }),
    { mode: 0o600 },
  );
  assert.throws(
    () => run("chatgpt-account-pool", "remove", pendingTarget),
    /pending native profile selection/i,
  );
});

test("a renamed ChatGPT account label persists across a new control process", () => {
  const isolated = mkdtempSync(path.join(os.tmpdir(), "codex-account-rename-"));
  const isolatedEnv = {
    ...env,
    CODEX_HOME: isolated,
    MODEL_ROUTER_STATE_DIR: isolated,
  };
  const runIsolated = (...args) => JSON.parse(execFileSync(process.execPath, [path.join(root, "src/control.mjs"), ...args], {
    env: isolatedEnv,
    encoding: "utf8",
  }));
  try {
    const added = runIsolated("chatgpt-account-pool", "add", "Shared inbox").account;
    const renamed = runIsolated("chatgpt-account-pool", "label", added.id, "  Personal  ");
    assert.equal(renamed.account.id, added.id);
    assert.equal(renamed.account.label, "Personal");
    assert.equal(renamed.account.state, added.state);
    const status = runIsolated("chatgpt-account-pool", "status");
    assert.equal(status.accounts[added.id].id, added.id);
    assert.equal(status.accounts[added.id].label, "Personal");
    const cleared = runIsolated("chatgpt-account-pool", "label", added.id, "   ");
    assert.equal(cleared.account.id, added.id);
    assert.equal(cleared.account.label, "ChatGPT account 1");
    assert.equal(cleared.account.labelCustom, undefined);
    const reread = runIsolated("chatgpt-account-pool", "status");
    assert.equal(reread.accounts[added.id].label, "ChatGPT account 1");
    assert.equal(reread.accounts[added.id].labelCustom, undefined);
    assert.equal(reread.accounts[added.id].id, added.id);
    const stderrOf = (error) => String(error?.stderr || error?.message || error);
    assert.throws(
      () => runIsolated("chatgpt-account-pool", "label", added.id, "x".repeat(121)),
      (error) => /Account label is limited to 120 characters/.test(stderrOf(error)),
    );
    assert.throws(
      () => runIsolated("chatgpt-account-pool", "label", added.id, "user\u202Eexe.txt"),
      (error) => /Account label contains characters that are not allowed/.test(stderrOf(error)),
    );
    assert.throws(
      () => runIsolated("chatgpt-account-pool", "label", "acct_missing1", "Name"),
      (error) => /not registered/.test(stderrOf(error)),
    );
    assert.equal(runIsolated("chatgpt-account-pool", "status").accounts[added.id].label, "ChatGPT account 1");
    const quietEnv = { ...isolatedEnv };
    delete quietEnv.DEBUG;
    const failed = spawnSync(process.execPath, [path.join(root, "src/control.mjs"), "chatgpt-account-pool", "label", added.id, "x".repeat(121)], {
      env: quietEnv,
      encoding: "utf8",
    });
    assert.notEqual(failed.status, 0);
    const lines = String(failed.stderr || "").split(/\r?\n/).filter((line) => line.length > 0);
    assert.deepEqual(lines, ["account-label-error:too-long: Account label is limited to 120 characters."]);
    const collided = spawnSync(process.execPath, [path.join(root, "src/control.mjs"), "chatgpt-account-pool", "add", "Chat GPT account 1"], {
      env: quietEnv,
      encoding: "utf8",
    });
    assert.notEqual(collided.status, 0);
    const collidedLines = String(collided.stderr || "").split(/\r?\n/).filter((line) => line.length > 0);
    assert.deepEqual(collidedLines, ["account-label-error:collision: Account label matches another account."]);
    assert.doesNotMatch(String(collided.stderr || ""), /\n\s+at /);
    const usage = spawnSync(process.execPath, [path.join(root, "src/control.mjs"), "chatgpt-account-pool", "nope"], {
      env: quietEnv,
      encoding: "utf8",
    });
    assert.notEqual(usage.status, 0);
    const usageLines = String(usage.stderr || "").split(/\r?\n/).filter((line) => line.length > 0);
    assert.equal(usageLines.length, 1);
    assert.match(usageLines[0], /^Usage: control chatgpt-account-pool /);
    assert.doesNotMatch(String(usage.stderr || ""), /\n\s+at /);
    const debugEnv = { ...quietEnv, DEBUG: "1" };
    const traced = spawnSync(process.execPath, [path.join(root, "src/control.mjs"), "chatgpt-account-pool", "label", added.id, "user\u202Eexe.txt"], {
      env: debugEnv,
      encoding: "utf8",
    });
    assert.notEqual(traced.status, 0);
    assert.match(String(traced.stderr || ""), /Account label contains characters that are not allowed/);
    assert.match(String(traced.stderr || ""), /\n\s+at /);
  } finally {
    rmSync(isolated, { recursive: true, force: true });
  }
});

test("no-discovery account reads never import account modules or create pool state", () => {
  const isolated = mkdtempSync(path.join(os.tmpdir(), "codex-account-no-discovery-"));
  const loader = path.join(isolated, "import-audit-loader.mjs");
  const importLog = path.join(isolated, "account-imports.log");
  const poolPath = path.join(isolated, "private", "pool.json");
  const switchPath = path.join(isolated, "private", "chatgpt-profile-switch.json");
  writeFileSync(loader, `
    import { appendFileSync } from "node:fs";
    export async function load(url, context, nextLoad) {
      if (/chatgpt-(?:account-pool|profile-switch)\\.mjs$/.test(url)) {
        appendFileSync(process.env.IMPORT_LOG, url + "\\n");
      }
      return nextLoad(url, context);
    }
  `, { mode: 0o600 });
  writeFileSync(
    path.join(isolated, "auth.json"),
    JSON.stringify({ tokens: { account_id: "must-not-be-read" } }),
    { mode: 0o600 },
  );
  const disabledEnv = {
    ...process.env,
    CODEX_ROUTER_NO_DISCOVERY: "1",
    CODEX_HOME: isolated,
    MODEL_ROUTER_STATE_DIR: path.join(isolated, "private"),
    MODEL_ROUTER_CHATGPT_ACCOUNT_POOL: poolPath,
    MODEL_ROUTER_CHATGPT_ACCOUNT_HOMES: path.join(isolated, "private", "homes"),
    IMPORT_LOG: importLog,
  };
  for (const command of [["account"], ["chatgpt-account-pool", "status"]]) {
    assert.throws(
      () => execFileSync(
        process.execPath,
        [
          "--experimental-loader",
          pathToFileURL(loader).href,
          path.join(root, "src/control.mjs"),
          ...command,
        ],
        { env: disabledEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      ),
      (error) => /credential discovery is disabled/i.test(String(error?.stderr || error?.message)),
    );
  }
  assert.equal(existsSync(poolPath), false);
  assert.equal(existsSync(switchPath), false);
  assert.equal(existsSync(importLog) ? readFileSync(importLog, "utf8") : "", "");
  rmSync(isolated, { recursive: true, force: true });
});

test("one production account status poll owns pending profile reconciliation", () => {
  const source = readFileSync(path.join(root, "src", "control.mjs"), "utf8");
  const accountUsage = source.match(/async function printAccountUsage\(\)[\s\S]*?\r?\n}\r?\n\r?\nasync function printProviderUsage/)?.[0];
  const accountPool = source.match(/async function handleChatGptAccountSwitch[\s\S]*?\r?\n}\r?\n\r?\n\/\/ The public/)?.[0];
  assert.ok(accountUsage);
  assert.ok(accountPool);
  assert.doesNotMatch(accountUsage, /reconcileChatGPTProfileSwitchIfReady/);
  assert.match(accountPool, /if \(!action \|\| action === "status"\)[\s\S]*?await reconcileChatGPTProfileSwitchIfReady\(\)/);
  assert.match(accountPool, /await refreshBoundedChatGPTSubscriptionAccounts\(beforeRefresh\)/);
  assert.match(accountPool, /attentionRequired[\s\S]*?retryable: false[\s\S]*?previous sign-in may still be running/i);
  assert.doesNotMatch(accountPool, /\.map\(\(account\) => refreshChatGPTSubscriptionAccount/);
});
