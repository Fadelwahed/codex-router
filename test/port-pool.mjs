import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

// Two failures stacked on the old fixed blocks.
//
// `node --test` runs every file in its own process, and each file used to own
// a port block chosen from the sorted list of files that import this module.
// That listing is identical in two checkouts, so two worktrees running the
// suite at once bound the same ports. The probe made it worse: it bound a
// candidate, closed it, and only then returned the number. The caller's real
// listen happened later, and the other worktree could win that gap
// (`listen EADDRINUSE`).
//
// Binding port 0 and closing it is the same race against the ephemeral pool,
// which is why this helper stopped doing that. The ports stay in a private
// range below every platform's ephemeral floor (Linux 32768, macOS and Windows
// 49152), so an unrelated bind(0) is not handed one of them. What coordinates
// *our* processes is a shared directory, not a per-checkout file list:
//
//   1. An exclusive lock file (`allocation.lock`, created with `wx`) is held
//      across the probe and the reservation write. The pid is written before
//      any await. Waiters steal a lock only when that pid is dead. An empty
//      lock (the creator has not written the pid yet, or died in that gap)
//      is stolen only after it has sat for a second, so one waiter cannot
//      unlink a lock another process is still creating. Releasing the lock
//      unlinks it only when the file still names this pid, so a replacement
//      lock is left alone.
//   2. The chosen port is recorded as `reservations/<port>` containing the
//      owner pid *before* the lock is released. Another pool process skips a
//      reservation whose pid is still alive, so the gap between this probe's
//      close and the caller's later listen is not a window another test can
//      take.
//   3. A `cursor` file in the same directory is the next port to try. It is
//      read and advanced under the same lock, so a process does not walk
//      every reservation already handed out (that scan blocked the test
//      event loop long enough for a 5s health wait to expire). A reservation
//      whose pid is dead is removed when the cursor lands on it, and that
//      port may be drawn again.
//   4. On process exit, this process deletes only the reservations it wrote.
//      The cursor file stays, so the next process continues forward.
//
// The directory is `os.tmpdir()/codex-router-test-port-pool`, shared by every
// checkout on the machine. `CODEX_ROUTER_TEST_PORT_POOL_DIR` points a single
// process at a private directory; the suite itself leaves it unset so
// concurrent worktrees keep coordinating. `CODEX_ROUTER_TEST_PORT_POOL_START`
// is an optional integer cursor inside the window (invalid values are
// ignored). It applies only when `cursor` does not already exist. Unset, the
// first process starts at the bottom of the window.
//
// Nothing here draws from the OS ephemeral pool. Exhausting the private range
// throws rather than falling back to bind(0).

export const PORT_POOL_FIRST = 10_000;
// One below Linux's default ephemeral floor of 32768.
export const PORT_POOL_LAST = 32_767;
const PORT_SPAN = PORT_POOL_LAST - PORT_POOL_FIRST + 1;
const LOCK_WAIT_MS = 60_000;
const LOCK_POLL_MS = 5;
// Long enough for the creator's pid write to become visible, short enough
// that a process killed between `wx` and that write does not wedge the pool.
const LOCK_STALE_MS = 1_000;

function initialCursor() {
  const raw = process.env.CODEX_ROUTER_TEST_PORT_POOL_START;
  if (raw === undefined || raw === "") return PORT_POOL_FIRST;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < PORT_POOL_FIRST || value > PORT_POOL_LAST) {
    return PORT_POOL_FIRST;
  }
  return value;
}

const issued = new Set();
const ownedReservations = new Set();
let releaseHooked = false;

function poolPaths() {
  const root = process.env.CODEX_ROUTER_TEST_PORT_POOL_DIR
    || path.join(tmpdir(), "codex-router-test-port-pool");
  return {
    root,
    lock: path.join(root, "allocation.lock"),
    reservations: path.join(root, "reservations"),
  };
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means some live process owns the pid and we may not signal it.
    // Treating that as dead would let us steal a port (or the lock) out from
    // under a process that is still using it.
    return error?.code === "EPERM";
  }
}

function reservationFile(reservations, port) {
  return path.join(reservations, String(port));
}

// True when a live process, including this one, already owns the port. A
// missing, corrupt, or dead-pid file is removed and does not block the port.
function reservationHeld(reservations, port) {
  const file = reservationFile(reservations, port);
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  const pid = Number(String(text).trim());
  if (pid === process.pid || pidAlive(pid)) return true;
  try {
    unlinkSync(file);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return false;
}

function hookRelease() {
  if (releaseHooked) return;
  releaseHooked = true;
  process.on("exit", () => {
    for (const file of ownedReservations) {
      try {
        unlinkSync(file);
      } catch {
        // The reservation is already gone, or the directory went away with it.
      }
    }
    const { lock } = poolPaths();
    try {
      const owner = Number(String(readFileSync(lock, "utf8")).trim());
      if (owner === process.pid) unlinkSync(lock);
    } catch {
      // Another process owns the lock, or it was already released.
    }
  });
}

function sleep(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

// True when the lock file names a dead pid, or has sat empty long enough that
// its creator is not still in the `wx` → pid-write gap. A live pid, including
// this process, is never stale.
function lockIsStale(lockPath) {
  let owner = Number.NaN;
  let mtimeMs = 0;
  try {
    owner = Number(String(readFileSync(lockPath, "utf8")).trim());
    mtimeMs = statSync(lockPath).mtimeMs;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  if (owner === process.pid || pidAlive(owner)) return false;
  if (!Number.isInteger(owner) || owner <= 0) {
    return Date.now() - mtimeMs > LOCK_STALE_MS;
  }
  return true;
}

async function withLock(fn) {
  const paths = poolPaths();
  mkdirSync(paths.root, { recursive: true });
  mkdirSync(paths.reservations, { recursive: true });
  const started = Date.now();
  for (;;) {
    let fd;
    try {
      fd = openSync(paths.lock, "wx");
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (lockIsStale(paths.lock)) {
        try {
          unlinkSync(paths.lock);
        } catch {
          // The owner released it, or another waiter stole it first.
        }
      }
      if (Date.now() - started > LOCK_WAIT_MS) {
        throw new Error(
          "timed out waiting for the test port-pool lock; another test process " +
            "is holding allocation.lock in the shared port-pool directory",
        );
      }
      // Yield. A same-process waiter must return to the event loop so the
      // holder can finish its bind probe.
      // eslint-disable-next-line no-await-in-loop -- the lock is the queue
      await sleep(LOCK_POLL_MS);
      continue;
    }
    try {
      writeFileSync(fd, String(process.pid));
      // eslint-disable-next-line no-await-in-loop -- one critical section
      return await fn(paths);
    } finally {
      closeSync(fd);
      try {
        const owner = Number(String(readFileSync(paths.lock, "utf8")).trim());
        if (owner === process.pid) unlinkSync(paths.lock);
      } catch {
        // Exit cleanup, or a dead-pid steal, already removed it.
      }
    }
  }
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

function cursorFile(root) {
  return path.join(root, "cursor");
}

function readCursor(root) {
  try {
    const value = Number(String(readFileSync(cursorFile(root), "utf8")).trim());
    if (Number.isInteger(value) && value >= PORT_POOL_FIRST && value <= PORT_POOL_LAST) return value;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return initialCursor();
}

function writeCursor(root, value) {
  // A few bytes: one write is atomic on the platforms this suite runs on, so
  // a reader never observes a torn integer.
  writeFileSync(cursorFile(root), String(value));
}

function portAt(start, offset) {
  const index = (start - PORT_POOL_FIRST + offset) % PORT_SPAN;
  return PORT_POOL_FIRST + index;
}

/**
 * A port nothing else using this helper will take, in this process or another.
 *
 * The number is inside the dedicated non-ephemeral window. It is reserved
 * under the shared lock before it is returned, and the caller binds it later.
 */
export async function freePort() {
  hookRelease();
  return withLock(async (paths) => {
    const start = readCursor(paths.root);
    for (let offset = 0; offset < PORT_SPAN; offset += 1) {
      const port = portAt(start, offset);
      if (issued.has(port)) continue;
      if (reservationHeld(paths.reservations, port)) continue;
      // Claimed before the probe. Callers draw several ports at once
      // (`Promise.all`), and the file lock already serializes those draws;
      // the set also keeps a port that probed busy from being tried again
      // for the rest of this process.
      issued.add(port);
      // Yield on a long scan so a sibling test in this process can keep
      // polling a server it already started. The common path tries one port.
      if (offset > 0 && offset % 32 === 0) {
        // eslint-disable-next-line no-await-in-loop -- the lock stays held
        await sleep(0);
      }
      // eslint-disable-next-line no-await-in-loop -- probing in order is the point
      if (!(await isFree(port))) continue;
      const file = reservationFile(paths.reservations, port);
      let fd;
      try {
        fd = openSync(file, "wx");
      } catch (error) {
        if (error?.code === "EEXIST") continue;
        throw error;
      }
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      ownedReservations.add(file);
      writeCursor(paths.root, port === PORT_POOL_LAST ? PORT_POOL_FIRST : port + 1);
      return port;
    }
    throw new Error(
      `test port pool exhausted its ${PORT_SPAN}-port window at ` +
        `${PORT_POOL_FIRST}-${PORT_POOL_LAST}; free leftover listeners or ` +
        "reservations in the shared port-pool directory",
    );
  });
}

// Both names were in use across the suite for the identical function.
export { freePort as openPort };
