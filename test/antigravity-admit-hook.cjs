// Loaded only by the slow-body forwarder tests, via NODE_OPTIONS --require.
// The credential reader opens antigravity-oauth.json when a request is
// admitted and again after the body completes. Recording the open gives the
// test a point that is after admission and before the body is required.
const fs = require("node:fs");
const path = require("node:path");

const marker = process.env.ANTIGRAVITY_ADMIT_MARKER;
if (typeof marker === "string" && marker !== "") {
  const openSync = fs.openSync;
  fs.openSync = function admitMarkerOpenSync(target, ...args) {
    const descriptor = openSync.call(this, target, ...args);
    if (typeof target === "string" && path.basename(target) === "antigravity-oauth.json") {
      try {
        fs.appendFileSync(marker, "read\n");
      } catch {
        // A failed signal must not fail the credential read.
      }
    }
    return descriptor;
  };
}
