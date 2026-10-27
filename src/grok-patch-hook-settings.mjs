import { readFileSync } from "node:fs";
import path from "node:path";
import { STATE_DIR } from "./paths.mjs";

// Separate opt-ins prevent enabling v2 from reactivating the v1 serializer in
// already-loaded clients. Neither marker installs or trusts a native hook.
export function serviceGrokPatchHookEnvironment({ environment = process.env, stateDir = STATE_DIR } = {}) {
  const result = {};
  for (const [flag, file] of [
    ["CODEX_ROUTER_GROK_PATCH_HOOK", "grok-patch-hook.json"],
    ["CODEX_ROUTER_GROK_PATCH_FEEDBACK", "grok-patch-feedback.json"],
  ]) {
    if (Object.hasOwn(environment, flag)) {
      result[flag] = environment[flag] === "1" ? "1" : "0";
      continue;
    }
    try {
      const value = JSON.parse(readFileSync(path.join(stateDir, file), "utf8"));
      if (value?.version === 1 && value.enabled === true && Object.keys(value).length === 2) result[flag] = "1";
    } catch {
      // Missing or invalid opt-in cannot enable a client protocol.
    }
  }
  return result;
}
