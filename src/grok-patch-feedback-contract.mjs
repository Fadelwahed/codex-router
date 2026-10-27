// Denial-only client protocol. This small module is the entire hook payload;
// it never imports the Router, reads project files, or transforms valid tools.
export const GROK_PATCH_FEEDBACK_PREFIX = "CODEX_ROUTER_PATCH_ERROR_V2\n";
export const GROK_PATCH_FEEDBACK_CAPABILITY = "patch-feedback-v2";
export const MAX_PATCH_FEEDBACK_ARGUMENT_BYTES = 1024 * 1024;
const codePattern = /^[a-z_]{1,64}$/u;

export function boundedFeedbackArguments(raw) {
  if (typeof raw !== "string" || raw.length > MAX_PATCH_FEEDBACK_ARGUMENT_BYTES ||
      !raw.isWellFormed() || Buffer.byteLength(raw, "utf8") > MAX_PATCH_FEEDBACK_ARGUMENT_BYTES) {
    throw new TypeError("invalid patch feedback argument bounds");
  }
  return raw;
}

export function encodePatchFeedback(code, raw) {
  if (typeof code !== "string" || !codePattern.test(code)) throw new TypeError("invalid patch feedback code");
  return GROK_PATCH_FEEDBACK_PREFIX + code + "\n" + boundedFeedbackArguments(raw);
}

export function decodePatchFeedback(input) {
  if (typeof input !== "string" || !input.startsWith(GROK_PATCH_FEEDBACK_PREFIX)) return undefined;
  const end = input.indexOf("\n", GROK_PATCH_FEEDBACK_PREFIX.length);
  const code = input.slice(GROK_PATCH_FEEDBACK_PREFIX.length, end);
  if (end < 0 || !codePattern.test(code)) throw new TypeError("invalid patch feedback envelope");
  return { code, argumentsText: boundedFeedbackArguments(input.slice(end + 1)) };
}

export function adaptPatchFeedback(event) {
  const command = event?.tool_input?.command;
  if (event?.hook_event_name !== "PreToolUse" || event?.tool_name !== "apply_patch" ||
      typeof command !== "string" || !command.startsWith(GROK_PATCH_FEEDBACK_PREFIX)) return {};
  // The reserved envelope is never executable, even if replayed under another
  // model. Only a denial is possible; valid native patches pass unchanged.
  let code = "invalid_feedback_envelope";
  try { code = decodePatchFeedback(command).code; } catch { /* deny malformed framing */ }
  return { hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: `Invalid structured apply_patch arguments (${code}). Correct the structured arguments and retry this tool.`,
  } };
}
