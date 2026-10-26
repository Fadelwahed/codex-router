// A client capability declaration, never authentication or proof of hook trust.
// Normalize only AFTER caller authentication; do not forward it to providers.
export const CODEX_PATCH_HOOK_BASE_PATH = "/v1/_codex-router/structured-patch-v1";

export const CODEX_PATCH_FEEDBACK_BASE_PATH = "/v1/_codex-router/patch-feedback-v2";
export const CODEX_PATCH_CAPABILITY_PATHS = Object.freeze([CODEX_PATCH_HOOK_BASE_PATH, CODEX_PATCH_FEEDBACK_BASE_PATH]);

export function codexPatchHookEndpoint(authenticatedPath) {
  if (authenticatedPath === CODEX_PATCH_FEEDBACK_BASE_PATH || authenticatedPath?.startsWith(`${CODEX_PATCH_FEEDBACK_BASE_PATH}/`)) {
    return { pathname: `/v1${authenticatedPath.slice(CODEX_PATCH_FEEDBACK_BASE_PATH.length)}`, capability: "patch-feedback-v2" };
  }
  if (authenticatedPath === CODEX_PATCH_HOOK_BASE_PATH ||
      authenticatedPath?.startsWith(`${CODEX_PATCH_HOOK_BASE_PATH}/`)) {
    return {
      pathname: `/v1${authenticatedPath.slice(CODEX_PATCH_HOOK_BASE_PATH.length)}`,
      capability: "structured-patch-v1",
    };
  }
  return { pathname: authenticatedPath };
}

export function codexPatchCapabilityBasePath(capability) {
  return CODEX_PATCH_CAPABILITY_PATHS.find((base) => base.split("/").at(-1) === capability);
}
