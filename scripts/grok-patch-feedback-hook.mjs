#!/usr/bin/env node
import { adaptPatchFeedback } from "../src/grok-patch-feedback-contract.mjs";

try {
  // JSON encoding of a bounded argument can expand sixfold. Bound bytes before
  // decoding and never print parser errors or input content.
  const input = Buffer.allocUnsafe(8 * 1024 * 1024);
  let size = 0;
  for await (const chunk of process.stdin) {
    if (chunk.length > input.length - size) throw new Error("hook input too large");
    input.set(chunk, size);
    size += chunk.length;
  }
  const event = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input.subarray(0, size)));
  process.stdout.write(JSON.stringify(adaptPatchFeedback(event)) + "\n");
} catch {
  process.stderr.write("Patch feedback hook failed to process its input.\n");
  process.exitCode = 1;
}
