import { GROK_STRUCTURED_PATCH_CODEC, compileStructuredOperationsArguments, StructuredPatchError } from "./grok-structured-patch.mjs";
import { boundedFeedbackArguments, encodePatchFeedback, decodePatchFeedback, GROK_PATCH_FEEDBACK_CAPABILITY } from "./grok-patch-feedback-contract.mjs";
import { isGrokOauthAgenticRoute } from "./grok-oauth-routes.mjs";
import { GROK_PATCH_HOOK_HEADER } from "./grok-patch-hook-transport.mjs";

export function grokPatchFeedbackEnabled(route, headers, environment = process.env, endpointCapability) {
  return isGrokOauthAgenticRoute(route) && environment.CODEX_ROUTER_GROK_PATCH_FEEDBACK === "1" &&
    (headers?.[GROK_PATCH_HOOK_HEADER] === GROK_PATCH_FEEDBACK_CAPABILITY || endpointCapability === GROK_PATCH_FEEDBACK_CAPABILITY);
}

export const GROK_PATCH_FEEDBACK_CODEC = {
  ...GROK_STRUCTURED_PATCH_CODEC,
  preserveRawArguments: true,
  decodeArguments(raw) {
    boundedFeedbackArguments(raw);
    try { return compileStructuredOperationsArguments(raw); } catch (error) {
      const code = GROK_STRUCTURED_PATCH_CODEC.argumentErrorCode(error);
      if (!(error instanceof StructuredPatchError) || !code ||
          ["arguments_too_large", "invalid_unicode", "patch_too_large"].includes(code)) throw error;
      return encodePatchFeedback(code, raw);
    }
  },
  encodeHistoryInput(input) { return decodePatchFeedback(input)?.argumentsText; },
};
