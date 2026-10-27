import assert from "node:assert/strict";
import test from "node:test";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { GROK_PATCH_FEEDBACK_CODEC as codec, grokPatchFeedbackEnabled } from "../src/grok-patch-feedback.mjs";
import { adaptPatchFeedback, decodePatchFeedback, encodePatchFeedback, GROK_PATCH_FEEDBACK_PREFIX as prefix, MAX_PATCH_FEEDBACK_ARGUMENT_BYTES } from "../src/grok-patch-feedback-contract.mjs";
import { serializeStructuredPatch } from "../src/grok-structured-patch.mjs";
import { bridgeCustomTools, flattenNamespaceTools, NamespaceToolCallTransform } from "../src/namespace-relay.mjs";
import { CODEX_PATCH_FEEDBACK_BASE_PATH as base, codexPatchHookEndpoint } from "../src/codex-patch-hook-endpoint.mjs";
import { authenticatedRoute, isManagedCodexBaseUrl, redactCallerUrl } from "../src/caller-auth.mjs";

const valid = { operations: [{ op: "add", path: "fixture.txt", lines: ["hello"] }] };
const event = (command) => ({ hook_event_name: "PreToolUse", model: "grok-oauth/grok-4.7", tool_name: "apply_patch", tool_input: { command } });
const native = { type: "custom", name: "apply_patch", format: { type: "grammar", syntax: "lark", definition: "preserved" } };
function setup(input = [], tools = [native]) {
  const flattened = flattenNamespaceTools(tools);
  const bridged = bridgeCustomTools(flattened.tools, input, flattened.namespaces, undefined, undefined, { codecs: new Map([["apply_patch", codec]]) });
  return { ...bridged, namespaces: flattened.namespaces };
}

test("feedback requires negotiated capability and opt-in on supported routes", () => {
  for (const slug of ["grok-oauth/grok-4.6", "grok-oauth/grok-4.7", "grok-api/grok-4.7", "gpt-6.1-sol"]) {
    for (const flag of [undefined, "0", "1"]) for (const cap of [undefined, "structured-patch-v1", "patch-feedback-v2"]) {
      const expected = slug.startsWith("grok-oauth/") && flag === "1" && cap === "patch-feedback-v2";
      assert.equal(grokPatchFeedbackEnabled({ slug }, { "x-codex-router-patch-hook": cap }, { CODEX_ROUTER_GROK_PATCH_FEEDBACK: flag }), expected);
      assert.equal(grokPatchFeedbackEnabled({ slug }, {}, { CODEX_ROUTER_GROK_PATCH_FEEDBACK: flag }, cap), expected);
    }
  }
});

test("feedback opt-in cannot activate the v1 serializer or vice versa", async () => {
  const { grokPatchHookEnabled } = await import("../src/grok-patch-hook-transport.mjs");
  const route = { slug: "grok-oauth/grok-4.7" };
  assert.equal(grokPatchHookEnabled(route, {}, { CODEX_ROUTER_GROK_PATCH_FEEDBACK: "1" }, "structured-patch-v1"), false);
  assert.equal(grokPatchFeedbackEnabled(route, {}, { CODEX_ROUTER_GROK_PATCH_HOOK: "1" }, "patch-feedback-v2"), false);
});

test("valid patch bypasses the hook and retains native history and permissions", () => {
  const patch = codec.decodeArguments(JSON.stringify(valid));
  assert.equal(patch, serializeStructuredPatch(valid));
  assert.deepEqual(adaptPatchFeedback(event(patch)), {});
  assert.equal(codec.encodeHistoryInput(patch), undefined);
  const bridged = setup([{ type: "custom_tool_call", name: "apply_patch", call_id: "valid", input: patch }]);
  assert.equal(bridged.input[0].arguments, JSON.stringify({ input: patch }));
  assert.equal(bridged.tools.some((tool) => tool.name === bridged.input[0].name), false);
});

test("semantic and JSON failures become native denial without argument repair or a granted permission", () => {
  for (const [raw, code] of [
    ['{"operations":"[{broken"}', "operations_invalid_json"],
    ["{", "arguments_invalid_json"],
    ['{"operations":[],"operations":[]}', "arguments_ambiguous_json"],
    ['{"operations":[]}', "array_bounds"],
    ['{"path":"secret.txt","contents":"overwrite"}', "unknown_field"],
    ['{"path":"secret.txt","old_string":"a","new_string":"b"}', "unknown_field"],
  ]) {
    const wire = codec.decodeArguments(raw);
    assert.deepEqual(decodePatchFeedback(wire), { code, argumentsText: raw });
    const reply = adaptPatchFeedback(event(wire));
    assert.equal(reply.hookSpecificOutput.permissionDecision, "deny");
    assert.equal(reply.hookSpecificOutput.updatedInput, undefined);
    assert.ok(reply.hookSpecificOutput.permissionDecisionReason.includes(`(${code})`));
    assert.equal(JSON.stringify(reply).includes("secret.txt"), false);
    for (const tools of [[native], []]) {
      const bridged = setup([{ type: "custom_tool_call", name: "apply_patch", call_id: "bad", input: wire }, { type: "custom_tool_call_output", call_id: "bad", output: "denied" }], tools);
      assert.equal(bridged.input[0].arguments, raw);
      assert.equal(bridged.input[1].call_id, "bad");
      assert.equal(bridged.input[1].output, "denied");
      assert.equal(bridged.tools.length, tools.length);
    }
  }
});

test("bounds and malformed envelopes fail closed without code or input disclosure", () => {
  for (const raw of ["a".repeat(MAX_PATCH_FEEDBACK_ARGUMENT_BYTES + 1), "é".repeat(MAX_PATCH_FEEDBACK_ARGUMENT_BYTES), "\ud800", '{"operations":[{"op":"add","path":"x","lines":["\\ud800"]}]}']) assert.throws(() => codec.decodeArguments(raw));
  assert.throws(() => encodePatchFeedback("secret/path", "{}"));
  for (const malformed of [prefix, prefix + "secret/path\n{}", prefix + "array_bounds\n\ud800"]) {
    const out = adaptPatchFeedback(event(malformed)).hookSpecificOutput;
    assert.equal(out.permissionDecision, "deny");
    assert.ok(out.permissionDecisionReason.includes("invalid_feedback_envelope"));
    assert.equal(out.updatedInput, undefined);
  }
  assert.deepEqual(adaptPatchFeedback({ ...event(prefix), tool_name: "exec_command" }), {});
  assert.deepEqual(adaptPatchFeedback({ ...event(prefix), hook_event_name: "PostToolUse" }), {});
});

test("an invalid patch after committed text completes as one native denial envelope", async () => {
  const bridge = setup();
  const name = bridge.tools[0].name;
  const raw = '{"operations":"[{broken"}';
  const item = { type: "function_call", id: "fc_patch", call_id: "patch", name, arguments: raw };
  const events = [
    { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg", role: "assistant", content: [] } },
    { type: "response.output_text.delta", item_id: "msg", output_index: 0, content_index: 0, delta: "Working" },
    { type: "response.output_item.added", output_index: 1, item: { ...item, arguments: "" } },
    { type: "response.function_call_arguments.delta", item_id: item.id, output_index: 1, delta: raw },
    { type: "response.function_call_arguments.done", item_id: item.id, output_index: 1, arguments: raw },
    { type: "response.output_item.done", output_index: 1, item },
    { type: "response.completed", response: { output: [item] } },
  ];
  const output = [];
  await pipeline(Readable.from(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)), new NamespaceToolCallTransform(bridge.namespaces, "text/event-stream", "grok-oauth/grok-4.7"), new Writable({ write(chunk, _, next) { output.push(chunk); next(); } }));
  const wire = Buffer.concat(output).toString();
  const received = wire.split("\n").filter(l => l.startsWith("data: ")).map(l => JSON.parse(l.slice(6)));
  assert.equal(received.at(-1).type, "response.completed");
  assert.equal(received.filter(e => e.type === "response.custom_tool_call_input.done").length, 1);
  assert.equal(received.at(-1).response.output[0].input, codec.decodeArguments(raw));
});

test("feedback endpoint preserves authentication, recognition and redaction", () => {
  const secret = "test-feedback-secret-with-enough-length";
  assert.deepEqual(codexPatchHookEndpoint(base + "/responses"), { pathname: "/v1/responses", capability: "patch-feedback-v2" });
  const url = `http://127.0.0.1:46192/_codex-router/${secret}${base}`;
  assert.equal(isManagedCodexBaseUrl(url, 46192), true);
  assert.equal(isManagedCodexBaseUrl(`http://127.0.0.1:46192${base}`, 46192), true);
  assert.equal(isManagedCodexBaseUrl(url + "/responses", 46192), false);
  assert.equal(authenticatedRoute(`/_codex-router/${secret}${base}`, "wrong"), undefined);
  assert.equal(redactCallerUrl(url).includes(secret), false);
});
