import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { PORT_POOL_FIRST, PORT_POOL_LAST, freePort } from "./port-pool.mjs";

// The routing suite shares one machine with the live router service, which
// owns the production loopback block (gateway 4200, oauth 4201, router 4202,
// api 4203, grok-oauth 4208, devin-cli 4210, antigravity 4212) and whose
// spawned children draw from the OS ephemeral range when they need their own
// sockets. test/port-pool.mjs keeps every test-drawn port inside its dedicated
// non-ephemeral window for exactly this reason; these tests pin that contract
// so a future refactor cannot quietly hand a test a port the live service --
// or an unrelated process -- already holds.

const POOL_FLOOR = PORT_POOL_FIRST;
// One below Linux's default ephemeral floor of 32768.
const POOL_CEILING = PORT_POOL_LAST;
const PRODUCTION_DEFAULTS = new Set([4200, 4201, 4202, 4203, 4208, 4210, 4212]);
const POOL_URL = new URL("./port-pool.mjs", import.meta.url).href;

test("drawn ports stay inside the dedicated pool window and off production defaults", async () => {
  const ports = await Promise.all(Array.from({ length: 24 }, () => freePort()));
  for (const port of ports) {
    assert.ok(
      Number.isInteger(port) && port >= POOL_FLOOR && port <= POOL_CEILING,
      `port ${port} is outside the test pool window [${POOL_FLOOR}, ${POOL_CEILING}]`,
    );
    assert.ok(
      !PRODUCTION_DEFAULTS.has(port),
      `port ${port} is one of the live router's production defaults`,
    );
  }
});

test("concurrent and sequential draws never hand out the same port twice", async () => {
  const concurrent = await Promise.all(Array.from({ length: 12 }, () => freePort()));
  const sequential = [];
  for (let index = 0; index < 6; index += 1) sequential.push(await freePort());
  const all = [...concurrent, ...sequential];
  assert.equal(new Set(all).size, all.length, `duplicate draws: ${all.join(", ")}`);
});

function runPortChild(script, { dir, start, signal } = {}) {
  const env = { ...process.env };
  if (dir !== undefined) env.CODEX_ROUTER_TEST_PORT_POOL_DIR = dir;
  if (start !== undefined) env.CODEX_ROUTER_TEST_PORT_POOL_START = String(start);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code, exitSignal) => {
      const killed = signal !== undefined
        && (exitSignal === signal || code === 137);
      if (signal) {
        if (!killed) {
          reject(new Error(`port child signal ${exitSignal ?? code}: ${stderr || stdout}`));
          return;
        }
      } else if (code !== 0) {
        reject(new Error(`port child exited ${code}: ${stderr || stdout}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`port child output was not JSON (${error.message}): ${stdout} ${stderr}`));
      }
    });
  });
}

function spawnHeldPortChild(script, { dir, start } = {}) {
  const env = { ...process.env };
  if (dir !== undefined) env.CODEX_ROUTER_TEST_PORT_POOL_DIR = dir;
  if (start !== undefined) env.CODEX_ROUTER_TEST_PORT_POOL_START = String(start);
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    stdio: ["pipe", "pipe", "pipe"],
    env,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const drawn = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`port child did not report ports: ${stderr || stdout}`));
    }, 30_000);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      reject(new Error(`port child exited ${code} before reporting ports: ${stderr || stdout}`));
    });
    child.stdout.on("data", () => {
      const line = stdout.split("\n").find((entry) => entry.trim());
      if (!line) return;
      clearTimeout(timer);
      try {
        resolve(JSON.parse(line));
      } catch (error) {
        reject(new Error(`port child output was not JSON (${error.message}): ${stdout} ${stderr}`));
      }
    });
  });
  return {
    drawn,
    release() {
      child.stdin.end();
    },
    done: new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`port child exited ${code}: ${stderr || stdout}`));
      });
    }),
  };
}

test("two processes never draw the same port", async () => {
  // The default shared directory, not a private one: this is the path two
  // worktrees actually share. A private directory would hide a collision
  // with the rest of this suite. Each child keeps its reservations until
  // both have reported: exiting first deletes them, and a child that has
  // not started yet would then legally redraw the same ports.
  const script = `
    import { writeSync } from "node:fs";
    import { freePort } from ${JSON.stringify(POOL_URL)};
    const ports = [];
    for (let index = 0; index < 8; index += 1) ports.push(await freePort());
    writeSync(1, JSON.stringify(ports) + "\\n");
    await new Promise((resolve) => {
      process.stdin.resume();
      process.stdin.once("data", resolve);
      process.stdin.once("end", resolve);
    });
  `;
  const left = spawnHeldPortChild(script);
  const right = spawnHeldPortChild(script);
  try {
    const [leftPorts, rightPorts] = await Promise.all([left.drawn, right.drawn]);
    const all = [...leftPorts, ...rightPorts];
    assert.equal(all.length, 16);
    assert.equal(new Set(all).size, all.length, `cross-process duplicate draws: ${all.join(", ")}`);
    for (const port of all) {
      assert.ok(port >= POOL_FLOOR && port <= POOL_CEILING, `port ${port} left the pool window`);
    }
  } finally {
    left.release();
    right.release();
    await Promise.allSettled([left.done, right.done]);
  }
});

test("a reservation left by a dead process can be drawn again", async () => {
  // A private directory keeps this SIGKILL residue out of the shared pool.
  // The cursor sits at the top of the window so the probe does not bind the
  // low ports the rest of the suite is reserving for real listeners.
  const dir = mkdtempSync(path.join(tmpdir(), "port-pool-reclaim-"));
  const start = POOL_CEILING - 32;
  const killed = `
    import { writeSync } from "node:fs";
    import { freePort } from ${JSON.stringify(POOL_URL)};
    const port = await freePort();
    writeSync(1, JSON.stringify(port));
    process.kill(process.pid, "SIGKILL");
  `;
  const redraw = `
    import { writeSync } from "node:fs";
    import { freePort } from ${JSON.stringify(POOL_URL)};
    writeSync(1, JSON.stringify(await freePort()));
  `;
  try {
    const abandoned = await runPortChild(killed, { dir, start, signal: "SIGKILL" });
    // The killed process already advanced the shared cursor. Point the next
    // draw back at the reservation it left behind; a dead pid must not block it.
    writeFileSync(path.join(dir, "cursor"), `${abandoned}\n`);
    const reused = await runPortChild(redraw, { dir, start });
    assert.equal(reused, abandoned);
    assert.ok(reused >= start && reused <= POOL_CEILING);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
