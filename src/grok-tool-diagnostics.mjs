import { createHash } from "node:crypto";

// A fixed vocabulary, not a dump of the caller's tools. Names, descriptions,
// schemas, argument values and custom namespaces can all contain private data.
const PARAMETERS = new Set([
  "cmd", "command", "workdir", "working_directory", "shell", "login", "tty",
  "yield_time_ms", "max_output_tokens", "sandbox_permissions", "justification", "prefix_rule",
  "session_id", "chars", "input", "operations", "path", "old_string", "new_string", "contents",
]);
const NAMES = new Set([
  "exec_command", "write_stdin", "shell_command", "apply_patch", "replace_lines",
  "search_replace", "write", "run_terminal_command",
]);

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
    const rawName = tool.name ?? tool.function?.name;
    const name = typeof rawName === "string" && rawName.startsWith("functions__")
      ? rawName.slice("functions__".length) : rawName;
    if (namespace !== undefined && namespace !== "functions" ||
        tool.namespace !== undefined && tool.namespace !== "functions" ||
        !NAMES.has(name) || !["function", "custom"].includes(tool.type)) return;
    const entry = known[name] ??= { count: 0, declarations: [] };
    entry.count++;
    if (entry.declarations.length >= 4) return;
    const schema = tool.parameters ?? tool.function?.parameters ?? tool.inputSchema ?? tool.format;
    const properties = schema?.properties;
    entry.declarations.push({
      type: tool.type,
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
