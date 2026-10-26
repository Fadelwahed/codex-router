import assert from "node:assert/strict";
import test from "node:test";
import { grokToolDiagnostics, createGrokPatchArgumentObserver } from "../src/grok-tool-diagnostics.mjs";
import { chatProviderToolSurface } from "../src/chat-tool-surface.mjs";

const poll = { type: "function", name: "write_stdin", parameters: {
  type: "object", properties: { session_id: { type: "number" }, chars: { type: "string" },
    yield_time_ms: { type: "number" }, max_output_tokens: { type: "number" } }, required: ["session_id"],
} };

test("poll diagnostics follow the native namespace through the Chat surface without dropping its schema", () => {
  const tools = [{ type: "namespace", name: "functions", tools: [poll] }];
  const before = grokToolDiagnostics(tools);
  const surface = chatProviderToolSurface(tools, "grok-oauth");
  const after = grokToolDiagnostics(surface.tools);
  assert.deepEqual(after.known.write_stdin, before.known.write_stdin);
  assert.deepEqual(after.known.write_stdin.declarations[0].parameters,
    ["chars", "max_output_tokens", "session_id", "yield_time_ms"]);
  assert.equal(after.known.write_stdin.declarations[0].deferred, false);
  const chat = grokToolDiagnostics([{ type: "function", function: { name: poll.name, parameters: poll.parameters } }]);
  assert.deepEqual(chat.known.write_stdin, before.known.write_stdin);
});

test("tool diagnostics distinguish absent, deferred, changed and duplicate declarations", () => {
  const base = grokToolDiagnostics([poll]);
  assert.deepEqual(grokToolDiagnostics([]), { count: 0, known: {} });
  const deferred = grokToolDiagnostics([{ ...poll, defer_loading: true }]);
  assert.equal(deferred.known.write_stdin.declarations[0].deferred, true);
  const changed = grokToolDiagnostics([{ ...poll, parameters: { type: "object", properties: {} } }]);
  assert.notEqual(changed.known.write_stdin.declarations[0].schemaSha256,
    base.known.write_stdin.declarations[0].schemaSha256);
  const duplicate = grokToolDiagnostics(Array(50).fill(poll));
  assert.equal(duplicate.known.write_stdin.count, 50);
  assert.equal(duplicate.known.write_stdin.declarations.length, 4);
});

test("namespace deferral is visible before the search relay withholds its function", () => {
  const tools = [{ type: "namespace", name: "functions", defer_loading: true, tools: [poll] },
    { type: "tool_search", execution: "client" }];
  const before = grokToolDiagnostics(tools);
  assert.equal(before.known.write_stdin.declarations[0].deferred, true);
  const after = grokToolDiagnostics(chatProviderToolSurface(tools, "grok-oauth").tools);
  assert.equal(after.known.write_stdin, undefined);
});

test("diagnostics never reflect unknown names, namespaces, properties or schema content", () => {
  const secret = "DO_NOT_LOG_PRIVATE_CONTENT";
  const result = grokToolDiagnostics([
    { ...poll, name: secret },
    { type: "namespace", name: secret, tools: [poll] },
    { ...poll, namespace: secret },
    { ...poll, description: secret, parameters: { properties: { session_id: { description: secret }, [secret]: {} } } },
    { type: "custom", name: "apply_patch", format: { type: "grammar", definition: secret } },
  ]);
  assert.equal(result.count, 5);
  assert.equal(result.known.write_stdin.count, 1);
  assert.equal(result.known.apply_patch.declarations[0].type, "custom");
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
  assert.deepEqual(result.known.write_stdin.declarations[0].parameters, ["session_id"]);
});


test("discovery and app diagnostics distinguish native, relay, current and legacy registrations", () => {
  const app = { type: "function", name: "list_projects", parameters: { type: "object", properties: {} } };
  const tools = [
    { type: "tool_search", execution: "client", parameters: {
      type: "object", properties: { query: { type: "string" }, limit: { type: "number" } },
    } },
    { type: "namespace", name: "mcp__codex_app", defer_loading: true, tools: [app] },
    { type: "namespace", name: "codex_app", tools: [app] },
  ];
  const before = grokToolDiagnostics(tools);
  assert.equal(before.known.tool_search.declarations[0].execution, "client");
  assert.equal(before.known.mcp__codex_app__list_projects.declarations[0].deferred, true);
  assert.equal(before.known.codex_app__list_projects.declarations[0].deferred, false);
  const after = grokToolDiagnostics(chatProviderToolSurface(tools, "grok-oauth").tools);
  assert.equal(after.known.tool_search.declarations[0].type, "function");
  assert.equal(after.known.mcp__codex_app__list_projects, undefined);
  assert.deepEqual(after.known.codex_app__list_projects, before.known.codex_app__list_projects);
  const chat = grokToolDiagnostics([{ type: "function", function: {
    ...app, name: "mcp__codex_app__list_projects",
  } }]);
  assert.equal(chat.known.mcp__codex_app__list_projects.declarations[0].schemaSha256,
    before.known.mcp__codex_app__list_projects.declarations[0].schemaSha256);
});

test("app diagnostics do not log lookalikes or arbitrary search metadata", () => {
  const secret = "DO_NOT_LOG_DISCOVERY_SECRET";
  const tools = [
    { type: "function", name: "create_thread" },
    { type: "function", name: "mcp__codex_app__" + secret },
    { type: "namespace", name: "mcp__codex_apps__private", tools: [{ type: "function", name: "create_thread" }] },
    { type: "function", name: "mcp__codex_app__list_projects", namespace: secret },
    { type: "namespace", name: "mcp__codex_app", tools: [{ type: "function", name: "create_thread", namespace: secret }] },
    { type: "tool_search", execution: secret, description: secret },
  ];
  const result = grokToolDiagnostics(tools);
  assert.deepEqual(Object.keys(result.known), ["tool_search"]);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
});

test("structured patch diagnostics retain the declared schema without exposing history or lookalike names", () => {
  const result = grokToolDiagnostics([
    { type: "function", name: "apply_patch_structured_v1", parameters: { type: "object", properties: { operations: { type: "array" } } } },
    { type: "function", name: "apply_patch_history_v1" },
    { type: "function", name: "private_apply_patch_structured_v1" },
  ]);
  assert.deepEqual(Object.keys(result.known), ["apply_patch_structured_v1"]);
  assert.deepEqual(result.known.apply_patch_structured_v1.declarations[0].parameters, ["operations"]);
});


test("patch snapshots identify malformed encoded operations before adapter conversion without values", () => {
  const samples = [];
  const observe = createGrokPatchArgumentObserver(sample => samples.push(sample));
  const id = "PRIVATE_CALL_ID";
  const args = JSON.stringify({ operations: '[{"path":"PRIVATE_SOURCE"' });
  const item = { type: "function_call", id, name: "apply_patch_structured_v1", arguments: args };
  const before = structuredClone(item);
  observe({ type: "response.output_item.added", item: { ...item, arguments: "" } });
  observe({ type: "response.function_call_arguments.delta", item_id: id, delta: "PRIVATE_PARTIAL_JSON" });
  assert.deepEqual(samples, []);
  observe({ type: "response.function_call_arguments.done", item_id: id, arguments: args });
  assert.deepEqual(samples, [{ stage: "arguments_done", shape: "operations_invalid_json" }]);
  observe({ type: "response.output_item.done", item });
  observe({ type: "response.completed", response: { output: [item] } });
  assert.deepEqual(samples, ["arguments_done", "output_item_done", "terminal"].map(stage => ({ stage, shape: "operations_invalid_json" })));
  assert.doesNotMatch(JSON.stringify(samples), /PRIVATE/);
  assert.deepEqual(item, before);
});

test("patch snapshot shape is syntax evidence and does not claim schema acceptance", () => {
  for (const [args, shape] of [
    [null, "arguments_not_string"], ["x".repeat(1024 * 1024 + 1), "arguments_too_large"],
    ["ю".repeat(524289), "arguments_too_large"],
    ["{", "arguments_invalid_json"], ["null", "arguments_not_object"], ["[]", "arguments_not_object"],
    ["{}", "operations_missing"], [JSON.stringify({ operations: null }), "operations_wrong_type"],
    [JSON.stringify({ operations: [] }), "operations_array"],
    [JSON.stringify({ operations: '[{"PRIVATE_PATH":true}]' }), "operations_encoded_array"],
    [JSON.stringify({ operations: '{"PRIVATE_PATH":true}' }), "operations_encoded_non_array"],
  ]) {
    const samples = [];
    createGrokPatchArgumentObserver(s => samples.push(s))({ type: "response.completed", response: {
      output: [{ type: "function_call", name: "apply_patch_structured_v1", arguments: args }],
    } });
    assert.deepEqual(samples, [{ stage: "terminal", shape }]);
    assert.doesNotMatch(JSON.stringify(samples), /PRIVATE/);
  }
});

test("patch snapshot diagnostics ignore unrelated identities and bound snapshots", () => {
  const samples = [];
  const observe = createGrokPatchArgumentObserver(s => samples.push(s));
  const item = { type: "function_call", id: "private_id", name: "apply_patch_structured_v1", arguments: '{"operations":[]}' };
  for (const other of [
    { ...item, name: "private_apply_patch_structured_v1" },
    { ...item, name: "apply_patch_history_v1" }, { ...item, namespace: "private_namespace" },
    { ...item, type: "custom_tool_call" },
  ]) {
    observe({ type: "response.output_item.added", item: other });
    observe({ type: "response.function_call_arguments.done", item_id: other.id, arguments: other.arguments });
    observe({ type: "response.output_item.done", item: other });
  }
  assert.deepEqual(samples, []);
  for (let i = 0; i < 50; i++) observe({ type: "response.output_item.done", item });
  assert.equal(samples.length, 33);
  assert.deepEqual(samples.at(-1), { stage: "limit", shape: "omitted" });
  assert.doesNotMatch(JSON.stringify(samples), /private/);
});


test("patch snapshot correlation bounds pending IDs and drops reused unrelated IDs", () => {
  const samples = [];
  const observe = createGrokPatchArgumentObserver(s => samples.push(s));
  for (let i = 0; i < 33; i++) observe({ type: "response.output_item.added", item: {
    type: "function_call", id: `id_${i}`, name: "apply_patch_structured_v1",
  } });
  const done = id => ({ type: "response.function_call_arguments.done", item_id: id, arguments: '{"operations":[]}' });
  observe(done("id_32"));
  assert.deepEqual(samples, []);
  observe(done("id_0"));
  assert.deepEqual(samples, [{ stage: "arguments_done", shape: "operations_array" }]);
  observe({ type: "response.output_item.added", item: { type: "function_call", id: "id_0", name: "PRIVATE_TOOL" } });
  observe(done("id_0"));
  assert.equal(samples.length, 1);
});
