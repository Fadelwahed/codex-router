import { createHash } from "node:crypto";

// A fixed vocabulary, not a dump of the caller's tools. Names, descriptions,
// schemas, argument values and custom namespaces can all contain private data.
const PARAMETERS = new Set([
  "cmd", "command", "workdir", "working_directory", "shell", "login", "tty",
  "yield_time_ms", "max_output_tokens", "sandbox_permissions", "justification", "prefix_rule",
  "query", "limit", "session_id", "chars", "input", "operations", "path", "old_string", "new_string", "contents",
]);
const NAMES = new Set([
  "exec_command", "write_stdin", "shell_command", "apply_patch", "apply_patch_structured_v1", "replace_lines",
  "search_replace", "write", "run_terminal_command", "exec", "tool_search",
]);

const APP_NAMES = new Set(["list_projects", "create_thread", "automation_update"]);
const APP_NAMESPACES = new Set(["codex_app", "mcp__codex_app"]);

function diagnosticName(tool, namespace) {
  if (tool.type === "tool_search" && namespace === undefined && tool.namespace === undefined) {
    return "tool_search";
  }
  if (!["function", "custom"].includes(tool.type)) return undefined;
  let name = tool.name ?? tool.function?.name;
  if (typeof name !== "string") return undefined;
  if (namespace !== undefined && tool.namespace !== undefined && namespace !== tool.namespace) return undefined;
  const owner = namespace ?? tool.namespace;
  if (owner === undefined) {
    // Match only complete, fixed identities. Connector namespaces and arbitrary
    // client functions must never turn into diagnostic labels.
    for (const app of APP_NAMESPACES) {
      for (const fn of APP_NAMES) if (name === `${app}__${fn}`) return name;
    }
    if (name.startsWith("functions__")) name = name.slice("functions__".length);
  } else if (APP_NAMESPACES.has(owner)) {
    return APP_NAMES.has(name) ? `${owner}__${name}` : undefined;
  } else if (owner !== "functions") return undefined;
  return NAMES.has(name) ? name : undefined;
}

export function grokToolDiagnostics(tools) {
  let count = 0;
  const known = {};
  function visit(tool, namespace, namespaceDeferred = false) {
    if (!tool || typeof tool !== "object") return;
    if (tool.type === "namespace") {
      // Responses namespace declarations have one level; never traverse an
      // arbitrary nested object or reflect an untrusted namespace into logs.
      if (namespace !== undefined) return;
      for (const child of Array.isArray(tool.tools) ? tool.tools : []) visit(child, tool.name, tool.defer_loading === true);
      return;
    }
    count++;
    const name = diagnosticName(tool, namespace);
    if (!name) return;
    const entry = known[name] ??= { count: 0, declarations: [] };
    entry.count++;
    if (entry.declarations.length >= 4) return;
    const schema = tool.parameters ?? tool.function?.parameters ?? tool.inputSchema ?? tool.format;
    const properties = schema?.properties;
    entry.declarations.push({
      type: tool.type,
      ...(tool.type === "tool_search" && ["client", "server"].includes(tool.execution)
        ? { execution: tool.execution } : {}),
      deferred: namespaceDeferred || tool.defer_loading === true,
      ...(schema && typeof schema === "object" ? {
        schemaSha256: createHash("sha256").update(JSON.stringify(schema)).digest("hex"),
      } : {}),
      parameters: Object.keys(properties && typeof properties === "object" ? properties : {})
        .filter(key => PARAMETERS.has(key)).sort(),
    });
  }
  for (const tool of Array.isArray(tools) ? tools : []) visit(tool);
  return { count, known };
}


// Observe original provider snapshots before Chat/LiteLLM conversion. Only
// fixed shape labels leave this function; no call IDs, field names, values,
// hashes, or JSON parser messages are retained in diagnostics.
export function createGrokPatchArgumentObserver(record) {
  const pending = new Set();
  let samples = 0;
  const isPatch = item => item?.type === "function_call" &&
    diagnosticName({ ...item, type: "function" }) === "apply_patch_structured_v1";
  const emit = (stage, argumentsText) => {
    if (samples++ >= 32) {
      if (samples === 33) record({ stage: "limit", shape: "omitted" });
      return;
    }
    record({ stage, shape: patchArgumentShape(argumentsText) });
  };
  return event => {
    if (event?.type === "response.output_item.added") {
      const id = event.item?.id;
      pending.delete(id);
      if (isPatch(event.item) && typeof id === "string" && id.length <= 256 && pending.size < 32) pending.add(id);
    } else if (event?.type === "response.function_call_arguments.done" && pending.has(event.item_id)) {
      emit("arguments_done", event.arguments);
    } else if (event?.type === "response.output_item.done") {
      if (isPatch(event.item)) emit("output_item_done", event.item.arguments);
      pending.delete(event.item?.id);
    } else if (["response.completed", "response.failed", "response.incomplete"].includes(event?.type)) {
      for (const item of Array.isArray(event.response?.output) ? event.response.output : []) {
        if (isPatch(item)) emit("terminal", item.arguments);
      }
      pending.clear();
    }
  };
}

function patchArgumentShape(text) {
  if (typeof text !== "string") return "arguments_not_string";
  // Independently cap diagnostic work before allocating a parsed object.
  if (text.length > 1024 * 1024 || Buffer.byteLength(text, "utf8") > 1024 * 1024) return "arguments_too_large";
  let value;
  try { value = JSON.parse(text); } catch { return "arguments_invalid_json"; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return "arguments_not_object";
  if (!Object.hasOwn(value, "operations")) return "operations_missing";
  if (Array.isArray(value.operations)) return "operations_array";
  if (typeof value.operations !== "string") return "operations_wrong_type";
  try {
    return Array.isArray(JSON.parse(value.operations)) ? "operations_encoded_array" : "operations_encoded_non_array";
  } catch {
    return "operations_invalid_json";
  }
}
