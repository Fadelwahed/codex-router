import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// Binding port 0, reading the number, and closing the socket puts that number
// back in the ephemeral pool before the test binds it. `node --test` runs
// every file in its own process, so a second bind(0) can be handed the same
// port inside that window:
//
//     Error: listen EADDRINUSE: address already in use 127.0.0.1:35011
//
// A fixed block per file, taken from the sorted test-file list, only avoids
// that inside one worktree. A second checkout running the same suite computes
// the same blocks, and the bind-to-check then close step lets both processes
// observe one port as free.
//
// Each process therefore reserves a private aligned block under an exclusive
// lock in the OS temp directory, which every worktree on the machine shares.
// The reservation stores the pid plus a token file that dies with the
// process, so a crash is reaped by the next reservation instead of pinning
// the block. Ports stay below Linux's default ephemeral floor (32768), so an
// unrelated bind(0) is not handed one of them on a default kernel. The probe
// still runs: a leftover listener can sit in a block this process just
// reclaimed, and a busy port stays claimed here while the walk moves on.
//
// On-disk protocol, so a concurrent checkout using this helper coordinates
// rather than guessing:
//   ${TMP}/codex-router-test-port-pool.lock/          exclusive mkdir lock
//   ${TMP}/codex-router-test-port-pool.json           { version: 1, blocks: [...] }
//   ${TMP}/codex-router-test-port-pool-owners/<pid>   token for that pid
// A block is { pid, token, start, size }. It is live only while the pid
// exists and that owner file still contains the same token.

const FIRST_PORT = 10_000;
// One below Linux's default ephemeral floor of 32768.
const LAST_PORT = 32_767;
// routing.test.mjs needs 75 listeners. One block covers that with room to
// spare; a file that outgrows it reserves another block.
const BLOCK_SIZE = 256;
const LOCK_WAIT_MS = 20_000;
const LOCK_STALE_MS = 15_000;

const LOCK_DIR = path.join(os.tmpdir(), "codex-router-test-port-pool.lock");
const REGISTRY = path.join(os.tmpdir(), "codex-router-test-port-pool.json");
const OWNERS_DIR = path.join(os.tmpdir(), "codex-router-test-port-pool-owners");

const blocks = [];
const issued = new Set();
let ownerToken;
let queue = Promise.resolve();

function ownerFile(pid) {
  return path.join(OWNERS_DIR, String(pid));
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function claimLive(claim) {
  if (!claim || typeof claim.token !== "string" || !pidAlive(claim.pid)) return false;
  try {
    return readFileSync(ownerFile(claim.pid), "utf8") === claim.token;
  } catch {
    return false;
  }
}

function ensureOwner() {
  if (ownerToken) return;
  ownerToken = randomUUID();
  mkdirSync(OWNERS_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(ownerFile(process.pid), ownerToken, { mode: 0o600 });
  process.on("exit", () => {
    try {
      if (readFileSync(ownerFile(process.pid), "utf8") === ownerToken) {
        rmSync(ownerFile(process.pid), { force: true });
      }
    } catch {
      // The owner file is already gone. The next reservation reaps the block.
    }
  });
}

function enqueue(task) {
  const run = queue.then(task, task);
  queue = run.then(() => {}, () => {});
  return run;
}

function emptyRegistry() {
  return { version: 1, blocks: [] };
}

function readRegistry() {
  let info;
  try {
    info = lstatSync(REGISTRY);
  } catch (error) {
    if (error?.code === "ENOENT") return emptyRegistry();
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error("test port pool registry is not a regular file");
  }
  const parsed = JSON.parse(readFileSync(REGISTRY, "utf8"));
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.blocks)) {
    throw new Error("test port pool registry is unreadable");
  }
  return parsed;
}

function writeRegistry(registry) {
  let info;
  try {
    info = lstatSync(REGISTRY);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (info?.isSymbolicLink()) throw new Error("test port pool registry is not a regular file");
  const tmp = `${REGISTRY}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(registry), { mode: 0o600 });
  try {
    renameOver(tmp, REGISTRY);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

function renameOver(from, to) {
  try {
    // POSIX rename replaces the destination atomically, so a crash cannot
    // leave the registry missing while other processes still hold blocks.
    renameSync(from, to);
  } catch (error) {
    if (process.platform !== "win32") throw error;
    // Windows refuses to rename onto an existing file. The lock is held, so
    // no other pool process reads the gap between the delete and the rename.
    rmSync(to, { force: true });
    renameSync(from, to);
  }
}

function lockStale() {
  try {
    const owner = readFileSync(path.join(LOCK_DIR, "owner"), "utf8");
    const pid = Number(owner.split("\n")[0]);
    return !pidAlive(pid);
  } catch {
    try {
      return Date.now() - statSync(LOCK_DIR).mtimeMs > LOCK_STALE_MS;
    } catch {
      return true;
    }
  }
}

async function withFileLock(fn) {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(LOCK_DIR, { mode: 0o700 });
      writeFileSync(path.join(LOCK_DIR, "owner"), `${process.pid}\n${ownerToken}`, { mode: 0o600 });
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (lockStale()) {
        rmSync(LOCK_DIR, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error("timed out waiting for the test port pool lock");
      }
      await delay(20);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(LOCK_DIR, { recursive: true, force: true });
  }
}

function reserveBlock() {
  const registry = readRegistry();
  const live = registry.blocks.filter((block) => (
    block
    && Number.isInteger(block.start)
    && Number.isInteger(block.size)
    && block.size > 0
    && claimLive(block)
  ));
  for (let start = FIRST_PORT; start + BLOCK_SIZE - 1 <= LAST_PORT; start += BLOCK_SIZE) {
    const overlaps = live.some((block) => (
      start < block.start + block.size && block.start < start + BLOCK_SIZE
    ));
    if (overlaps) continue;
    const reserved = { pid: process.pid, token: ownerToken, start, size: BLOCK_SIZE };
    writeRegistry({ version: 1, blocks: [...live, reserved] });
    return reserved;
  }
  return undefined;
}

function nextLocalPort() {
  for (const block of blocks) {
    for (let port = block.start; port < block.start + block.size; port += 1) {
      if (issued.has(port)) continue;
      // Claimed before the probe. Callers draw several ports at once, and a
      // claim on the far side of the await would start every draw at the same
      // port. A port that then probes busy stays claimed for this process.
      issued.add(port);
      return port;
    }
  }
  return undefined;
}

async function isFree(port) {
  const server = createServer();
  const listening = await new Promise((resolve) => {
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => resolve(true));
  });
  if (!listening) return false;
  await new Promise((resolve) => server.close(resolve));
  return true;
}

/**
 * A port nothing else in this test run, or in another worktree's run, will take.
 */
export async function freePort() {
  ensureOwner();
  return enqueue(async () => {
    for (;;) {
      let port = nextLocalPort();
      if (port === undefined) {
        const reserved = await withFileLock(() => reserveBlock());
        if (!reserved) {
          throw new Error(
            `test port pool exhausted between ${FIRST_PORT} and ${LAST_PORT}; ` +
              "another suite is holding every block, or leftovers are still listening",
          );
        }
        blocks.push(reserved);
        port = nextLocalPort();
      }
      // eslint-disable-next-line no-await-in-loop -- probing in order is the point
      if (await isFree(port)) return port;
    }
  });
}

// Both names were in use across the suite for the identical function.
export { freePort as openPort };
