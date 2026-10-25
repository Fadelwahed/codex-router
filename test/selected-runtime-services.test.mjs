import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { writePrivateJson } from "../src/file-security.mjs";
import { terminateProcessTree } from "../src/process-tree.mjs";
import { freePort } from "./port-pool.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const caller = "selected-services-fixture-caller-with-sufficient-length";
const names = ["router", "gateway", "oauth", "api", "grok", "antigravity", "devin", "cursor"];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function listen(server, port = 0) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return server.address().port;
}

async function portClosed(port) {
  return new Promise(resolve => {
    const socket = net.connect(port, "127.0.0.1");
    const finish = closed => { socket.destroy(); resolve(closed); };
    socket.setTimeout(2000, () => finish(false));
    socket.once("connect", () => finish(false));
    socket.once("error", () => finish(true));
  });
}

async function fixture(t, { protocol, pending = false } = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "selected-services-"));
  const state = path.join(directory, "state"), home = path.join(directory, "home");
  mkdirSync(state); mkdirSync(home);
  const ports = Object.fromEntries(await Promise.all(names.map(async name => [name, await freePort()])));
  assert.equal(new Set(Object.values(ports)).size, names.length);
  const used = new Set(["router", ...(protocol ? ["api"] : []), ...(pending ? ["antigravity"] : [])]);
  const servers = [], foreign = [], requests = [];
  let child, errors = "";
  t.after(async () => {
    try {
      if (child) await terminateProcessTree(child, { graceMs: 500 });
      for (const name of used) assert.equal(await portClosed(ports[name]), true, `owned ${name} survived teardown`);
      for (const record of foreign) {
        assert.equal(record.server.listening, true, `unused ${record.name} listener was stopped`);
        assert.equal(record.requests, 0, `unused ${record.name} listener was probed`);
      }
    } finally {
      for (const server of servers) {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
      }
      assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
      assert.ok(path.basename(directory).startsWith("selected-services-"));
      rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    requests.push(body);
    const result = { id: "resp_fixture", object: "response", status: "completed", model: body.model,
      output: [{ id: "msg_fixture", type: "message", role: "assistant", status: "completed",
        content: [{ type: "output_text", text: "fixture complete", annotations: [] }] }],
      usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } };
    if (body.stream) {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const event of [{ type: "response.created", response: { ...result, status: "in_progress", output: [] } },
        { type: "response.completed", response: result }]) {
        response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      }
      response.end();
    } else response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(result));
  });
  servers.push(upstream);
  const upstreamPort = await listen(upstream);
  const models = protocol ? [{ slug: "custom/fixture", gatewayModel: "fixture", upstreamModel: "fixture",
    provider: "custom", listed: true, displayName: "Fixture", description: "Synthetic loopback model",
    contextWindow: 128000, autoCompact: 110000, priority: 1, defaultEffort: "medium",
    reasoningLevels: [{ effort: "medium", description: "Fixture" }], inputModalities: ["text"],
    compHash: "fixture", endpoint: { protocol, baseUrl: `http://127.0.0.1:${upstreamPort}/v1`, keyless: true } }] : [];
  const registry = path.join(directory, "registry.json");
  writeFileSync(registry, JSON.stringify({ version: 1, providers: [{ id: "custom", displayName: "Fixture",
    ownedBy: "fixture", kind: "openai-compatible", authMode: "per-model", perModelEndpoint: true }], models }));
  writeFileSync(path.join(state, "enabled-providers.json"), JSON.stringify({ version: 1, providers: protocol ? ["custom"] : [] }));
  writeFileSync(path.join(state, "compatibility-layer.json"), '{"version":1,"enabled":true}');
  writeFileSync(path.join(state, "caller-secret"), caller);
  writeFileSync(path.join(state, "internal-secret"), "selected-services-fixture-internal-with-sufficient-length");
  const proofFile = path.join(state, "antigravity-oauth.json");
  if (pending) writePrivateJson(proofFile, {
    version: 3, managed_by: "codex-router", session_generation: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    client_id: "fixture.apps.googleusercontent.com", client_secret: "synthetic-client-secret",
    access_token: "synthetic-access-token", refresh_token: "synthetic-refresh-token",
    expires_at: Math.floor(Date.now() / 1000) + 3600, expires_in: 3600,
    project_id: "fixture-project", project_source: "managed", probe_version: 1,
    probe_verified_at: Date.now(), probe_model: "gemini-3.1-pro",
    probe_activation: { version: 1, state: "pending_activation", generation: "77777777-7777-4777-8777-777777777777" },
  });
  for (const name of names.filter(name => !used.has(name))) {
    const record = { name, requests: 0 };
    record.server = http.createServer((_request, response) => {
      record.requests++;
      response.writeHead(418, { "Content-Type": "application/json" }).end('{"foreign":true}');
    });
    await listen(record.server, ports[name]);
    servers.push(record.server); foreign.push(record);
  }
  const allowed = new Set(["path", "systemroot", "windir", "comspec", "pathext", "temp", "tmp", "psmodulepath",
    "systemdrive", "programdata", "programfiles", "programfiles(x86)", "programw6432"]);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.has(key.toLowerCase())));
  Object.assign(env, { HOME: home, USERPROFILE: home, CODEX_HOME: home, APPDATA: path.join(home, "appdata"),
    LOCALAPPDATA: path.join(home, "localappdata"), KIMI_CODE_HOME: path.join(home, "kimi"),
    DSH_HOME: path.join(home, "dsh"), XDG_CONFIG_HOME: path.join(home, "xdg"),
    MODEL_ROUTER_TARGET: "codex", MODEL_ROUTER_STATE_DIR: state, CODEX_ROUTER_STATE_DIR: state,
    MODEL_ROUTER_REGISTRY: registry, CODEX_ROUTER_SOURCE_ROOT: root,
    MODEL_ROUTER_USER_MODELS: path.join(state, "user-models.json"),
    MODEL_ROUTER_GENERIC_PROVIDERS: path.join(state, "generic-providers.json"),
    MODEL_ROUTER_MODEL_PICKER_STATE: path.join(state, "picker.json"),
    CODEX_ROUTER_SERVICE_PLATFORM: "test-fixture", CODEX_BIN: path.join(home, "missing-codex"),
    CODEX_ROUTER_NO_DISCOVERY: "0", NO_DISCOVERY: "0", CODEX_ROUTER_NATIVE_SESSION_FALLBACK: "0",
    CODEX_NATIVE_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
    MODEL_ROUTER_LITELLM_BIN: path.join(directory, "missing-litellm"),
    CODEX_ROUTER_STARTUP_HEALTH_TIMEOUT_MS: "60000", CODEX_ROUTER_GATEWAY_HEALTH_TIMEOUT_MS: "60000",
    MODEL_ROUTER_PORT: String(ports.router), MODEL_ROUTER_GATEWAY_PORT: String(ports.gateway),
    MODEL_ROUTER_OAUTH_PORT: String(ports.oauth), MODEL_ROUTER_API_PORT: String(ports.api),
    MODEL_ROUTER_GROK_OAUTH_PORT: String(ports.grok), MODEL_ROUTER_ANTIGRAVITY_OAUTH_PORT: String(ports.antigravity),
    MODEL_ROUTER_DEVIN_CLI_PORT: String(ports.devin), MODEL_ROUTER_CURSOR_PUBLIC_PORT: String(ports.cursor),
    MODEL_ROUTER_QUIET: "1", CODEX_ROUTER_QUIET: "1" });
  child = spawn(process.execPath, [path.join(root, "src/foreground-start.mjs")], {
    cwd: root, env, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.resume();
  child.stderr.on("data", chunk => { errors += chunk; });
  child.on("error", error => { errors += String(error); });
  const base = `http://127.0.0.1:${ports.router}`;
  const get = async url => {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    return { status: response.status, body: await response.json() };
  };
  const ready = async () => {
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      assert.equal(child.exitCode, null, errors);
      for (const record of foreign) assert.equal(record.requests, 0, `unused ${record.name} listener was probed`);
      try {
        const result = await get(`${base}/health`);
        if (result.status === 200 && errors.includes("ready (authenticated loopback endpoint)")) return result;
      } catch { /* Owned startup can still be in progress. */ }
      await pause(100);
    }
    throw new Error(`selected stack did not become ready:\n${errors}`);
  };
  return { child, errors: () => errors, ready, base, ports, requests, state, proofFile, get,
    callerBase: `${base}/_codex-router/${caller}/v1` };
}

test("native-only startup ignores occupied unused services and an absent gateway", { timeout: 180000 }, async t => {
  const f = await fixture(t);
  const health = await f.ready();
  assert.equal(health.body.compatibilityLayer.enabled, true);
  const detail = await f.get(`${f.callerBase}/health`);
  for (const name of ["api", "gateway", "oauth", "grokOauth", "antigravityOauth", "devinCli"]) {
    assert.equal(detail.body[name].enabled, false, name);
  }
  assert.equal(existsSync(path.join(f.state, "litellm.yaml")), false);
});

test("Responses-only startup keeps compatibility enabled and completes through only the API hop", { timeout: 180000 }, async t => {
  const f = await fixture(t, { protocol: "openai-responses" });
  assert.equal((await f.ready()).body.compatibilityLayer.enabled, true);
  const response = await fetch(`${f.callerBase}/responses`, { method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "custom/fixture", stream: false, input: "owned fixture request" }),
    signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await response.json()).status, "completed");
  assert.equal(f.requests.length, 1);
  assert.equal(existsSync(path.join(f.state, "litellm.yaml")), false);
});

test("a selected Chat route still fails preflight when its gateway is absent", { timeout: 180000 }, async t => {
  const f = await fixture(t, { protocol: "openai" });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`missing gateway was ignored:\n${f.errors()}`)), 30000);
    f.child.once("exit", () => { clearTimeout(timer); resolve(); });
  });
  assert.equal(f.child.exitCode, 1);
  assert.match(f.errors(), /LiteLLM is not installed/);
  assert.equal(f.requests.length, 0);
});

test("an explicit pending Antigravity proof retains its otherwise unselected listener", { timeout: 180000 }, async t => {
  const f = await fixture(t, { pending: true });
  await f.ready();
  const proof = JSON.parse(readFileSync(f.proofFile, "utf8"));
  assert.equal(proof.probe_activation.state, "active");
  assert.equal(proof.probe_activation.generation, "77777777-7777-4777-8777-777777777777");
  const listener = await fetch(`http://127.0.0.1:${f.ports.antigravity}/health`, {
    headers: { Authorization: "Bearer selected-services-fixture-internal-with-sufficient-length" },
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(listener.status, 200);
  assert.equal((await listener.json()).service, "codex-router-antigravity-oauth-forwarder");
  assert.equal(f.requests.length, 0);
  assert.equal(existsSync(path.join(f.state, "litellm.yaml")), false);
});
