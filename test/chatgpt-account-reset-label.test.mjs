import assert from "node:assert/strict";
import test from "node:test";

import {
  accountResetProbeEpochs,
  accountResetProbeStep,
  accountResetTickDelay,
  accountUsageClause,
  accountWindowPeriodLabel,
  bindAccountResetClock,
  formatAccountReset,
} from "../apps/control-center/src/lib.ts";
import { createTranslator } from "../apps/control-center/src/i18n.ts";

const NOW = Date.UTC(2026, 9, 2, 12, 0, 0);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function at(offsetMs) {
  return NOW + offsetMs;
}

test("a future reset renders a compact relative time from a fixed clock", () => {
  const t = createTranslator("en");
  assert.equal(formatAccountReset(at(2 * DAY + 4 * HOUR), t, NOW), "resets in 2d 4h");
  assert.equal(formatAccountReset(at(3 * HOUR + 12 * MINUTE), t, NOW), "resets in 3h 12m");
  assert.equal(formatAccountReset(at(59_000), t, NOW), "resets in <1m");
  assert.equal(formatAccountReset(at(1), t, NOW), "resets in <1m");
});

test("zero trailing units are omitted", () => {
  const t = createTranslator("en");
  assert.equal(formatAccountReset(at(2 * DAY), t, NOW), "resets in 2d");
  assert.equal(formatAccountReset(at(DAY), t, NOW), "resets in 1d");
  assert.equal(formatAccountReset(at(3 * HOUR), t, NOW), "resets in 3h");
  assert.equal(formatAccountReset(at(45 * MINUTE), t, NOW), "resets in 45m");
  assert.equal(formatAccountReset(at(MINUTE), t, NOW), "resets in 1m");
});

test("day-scale leftovers round to the nearest hour", () => {
  const t = createTranslator("en");
  const simplified = createTranslator("zh-CN");
  const traditional = createTranslator("zh-TW");
  assert.equal(formatAccountReset(at(2 * DAY + 30 * MINUTE), t, NOW), "resets in 2d 1h");
  assert.equal(formatAccountReset(at(2 * DAY + 29 * MINUTE), t, NOW), "resets in 2d 0h");
  assert.equal(formatAccountReset(at(2 * DAY + 4 * HOUR + 29 * MINUTE), t, NOW), "resets in 2d 4h");
  assert.equal(formatAccountReset(at(2 * DAY + 4 * HOUR + 30 * MINUTE), t, NOW), "resets in 2d 5h");
  assert.equal(formatAccountReset(at(2 * DAY + 23 * HOUR + 30 * MINUTE), t, NOW), "resets in 3d");
  assert.equal(formatAccountReset(at(2 * DAY + 30 * MINUTE), simplified, NOW), "2 天 1 小时后重置");
  assert.equal(formatAccountReset(at(2 * DAY + 29 * MINUTE), simplified, NOW), "2 天 0 小时后重置");
  assert.equal(formatAccountReset(at(2 * DAY + 30 * MINUTE), traditional, NOW), "2 天 1 小時後重設");
  assert.equal(formatAccountReset(at(2 * DAY + 29 * MINUTE), traditional, NOW), "2 天 0 小時後重設");
});

test("only an exact week is labeled weekly, in the active language", () => {
  const t = createTranslator("en");
  const simplified = createTranslator("zh-CN");
  const traditional = createTranslator("zh-TW");
  assert.equal(accountWindowPeriodLabel({ period: "weekly", windowDurationMins: 7 * 24 * 60 }, t), "weekly");
  assert.equal(accountWindowPeriodLabel({ period: "monthly", windowDurationMins: 30 * 24 * 60 }, t), "monthly");
  assert.equal(accountWindowPeriodLabel({ period: "current", windowDurationMins: 10 * 24 * 60 }, t), "10d");
  assert.equal(accountWindowPeriodLabel({ period: "current", windowDurationMins: 300 }, t), "5h");
  assert.equal(accountWindowPeriodLabel({ period: "current", windowDurationMins: 90 }, t), "90m");
  assert.equal(accountWindowPeriodLabel({ period: "weekly", windowDurationMins: 7 * 24 * 60 }, simplified), "每周");
  assert.equal(accountWindowPeriodLabel({ period: "monthly", windowDurationMins: 30 * 24 * 60 }, simplified), "每月");
  assert.equal(accountWindowPeriodLabel({ period: "current", windowDurationMins: 10 * 24 * 60 }, simplified), "10 天");
  assert.equal(accountWindowPeriodLabel({ period: "current", windowDurationMins: 300 }, simplified), "5 小时");
  assert.equal(accountWindowPeriodLabel({ period: "weekly", windowDurationMins: 7 * 24 * 60 }, traditional), "每週");
  assert.equal(accountWindowPeriodLabel({ period: "monthly", windowDurationMins: 30 * 24 * 60 }, traditional), "每月");
  assert.equal(accountWindowPeriodLabel({ period: "current", windowDurationMins: 10 * 24 * 60 }, traditional), "10 天");
  assert.equal(accountWindowPeriodLabel({ period: "current", windowDurationMins: 300 }, traditional), "5 小時");
  assert.equal(accountWindowPeriodLabel({ period: "weekly", windowDurationMins: 10 * 24 * 60 }, simplified), "每周");
  assert.equal(accountWindowPeriodLabel({ period: "current", windowDurationMins: 10 * 24 * 60 }, t), "10d");
});

test("a missing, zero, or negative window duration localizes the current period", () => {
  const t = createTranslator("en");
  const simplified = createTranslator("zh-CN");
  const traditional = createTranslator("zh-TW");
  for (const windowDurationMins of [undefined, null, 0, -5, Number.NaN]) {
    const window = { period: "current", windowDurationMins };
    assert.equal(accountWindowPeriodLabel(window, t), "current");
    assert.equal(accountWindowPeriodLabel(window, simplified), "当前");
    assert.equal(accountWindowPeriodLabel(window, traditional), "目前");
  }
  assert.equal(accountWindowPeriodLabel({ period: "weekly" }, simplified), "每周");
  assert.equal(accountWindowPeriodLabel({ period: "monthly", windowDurationMins: 0 }, traditional), "每月");
});

test("minute labels floor, and under a minute lasts only while time remains", () => {
  const t = createTranslator("en");
  const simplified = createTranslator("zh-CN");
  assert.equal(formatAccountReset(at(50_000), t, NOW), "resets in <1m");
  assert.equal(formatAccountReset(at(80_000), t, NOW), "resets in 1m");
  assert.equal(formatAccountReset(at(MINUTE), t, NOW), "resets in 1m");
  assert.equal(formatAccountReset(at(MINUTE + 1), t, NOW), "resets in 1m");
  assert.equal(formatAccountReset(at(1), simplified, NOW), "不到 1 分钟后重置");
  assert.equal(accountResetTickDelay([at(50_000)], NOW), 50_000);
  assert.equal(accountResetTickDelay([at(80_000)], NOW), 20_000);
  assert.equal(accountResetTickDelay([at(MINUTE)], NOW), 1);
  assert.equal(accountResetTickDelay([at(3 * HOUR + 12 * MINUTE + 45_000)], NOW), 45_000);
  assert.equal(accountResetTickDelay([at(3 * HOUR + 12 * MINUTE + 45_000), at(2 * DAY + 4 * HOUR + 20 * MINUTE)], NOW), 1);
  assert.equal(accountResetTickDelay([0, -5], NOW), null);
});

test("a passed reset refreshes instead of keeping the previous percent", () => {
  const t = createTranslator("en");
  const simplified = createTranslator("zh-CN");
  const traditional = createTranslator("zh-TW");
  const window = { period: "current", remainingPercent: 70, resetsAt: at(-1), windowDurationMins: 0 };
  assert.equal(accountUsageClause(window, t, NOW), "Refreshing usage");
  assert.equal(accountUsageClause(window, simplified, NOW), "正在刷新用量");
  assert.equal(accountUsageClause(window, traditional, NOW), "正在更新用量");
  assert.equal(accountUsageClause(window, t, NOW).includes("70"), false);
  assert.equal(accountUsageClause({ ...window, resetsAt: at(0) }, t, NOW), "Refreshing usage");
  assert.equal(accountUsageClause({ ...window, resetsAt: at(50_000) }, t, NOW), "current · 70% remaining · resets in <1m");
  assert.equal(accountUsageClause({ period: "weekly", remainingPercent: 70, resetsAt: at(2 * DAY) }, simplified, NOW), "每周 · 剩余 70% · 2 天后重置");
  assert.equal(accountUsageClause({ period: "current", remainingPercent: Number.NaN }, t, NOW), "");
  assert.equal(accountUsageClause([], t, NOW), "");
  const probed = new Set();
  const due = accountResetProbeEpochs([at(-1), at(MINUTE), at(-1)], NOW, probed);
  assert.deepEqual(due, [at(-1)]);
  for (const epoch of due) probed.add(epoch);
  assert.deepEqual(accountResetProbeEpochs([at(-1), 0], NOW, probed), []);
});

test("leftover seconds stay inside the current floor bucket", () => {
  const t = createTranslator("en");
  assert.equal(formatAccountReset(at(2 * DAY + 4 * HOUR + 59_000), t, NOW), "resets in 2d 4h");
  assert.equal(formatAccountReset(at(3 * HOUR + 12 * MINUTE + 59_000), t, NOW), "resets in 3h 12m");
  assert.equal(formatAccountReset(at(MINUTE - 1), t, NOW), "resets in <1m");
});

test("a seconds timestamp uses the same threshold as other control-center times", () => {
  const t = createTranslator("en");
  const seconds = Math.floor(at(2 * DAY + 4 * HOUR) / 1_000);
  assert.ok(seconds < 10_000_000_000);
  assert.equal(formatAccountReset(seconds, t, NOW), "resets in 2d 4h");
  assert.equal(formatAccountReset(String(seconds), t, NOW), "resets in 2d 4h");
});

test("a missing or past reset is blank", () => {
  const t = createTranslator("en");
  for (const value of [undefined, null, "", Number.NaN, "nope", Number.POSITIVE_INFINITY, 0, -1, at(0), at(-1), 1_700_000_000]) {
    const label = formatAccountReset(value, t, NOW);
    assert.equal(label, "", `expected blank for ${String(value)}`);
    assert.equal(label.includes("NaN"), false);
    assert.equal(/-\d/.test(label), false);
  }
});

test("an unsafe remainder is blank rather than a nonsense duration", () => {
  const t = createTranslator("en");
  assert.equal(formatAccountReset(Number.MAX_VALUE, t, NOW), "");
});

test("reset copy is localized in simplified and traditional Chinese", () => {
  const simplified = createTranslator("zh-CN");
  const traditional = createTranslator("zh-TW");
  assert.equal(formatAccountReset(at(2 * DAY + 4 * HOUR), simplified, NOW), "2 天 4 小时后重置");
  assert.equal(formatAccountReset(at(3 * HOUR + 12 * MINUTE), simplified, NOW), "3 小时 12 分钟后重置");
  assert.equal(formatAccountReset(at(30_000), simplified, NOW), "不到 1 分钟后重置");
  assert.equal(formatAccountReset(at(0), simplified, NOW), "");
  assert.equal(formatAccountReset(at(2 * DAY + 4 * HOUR), traditional, NOW), "2 天 4 小時後重設");
  assert.equal(formatAccountReset(at(3 * HOUR + 12 * MINUTE), traditional, NOW), "3 小時 12 分鐘後重設");
  assert.equal(formatAccountReset(at(30_000), traditional, NOW), "不到 1 分鐘後重設");
  assert.equal(formatAccountReset(at(-5), traditional, NOW), "");
});

test("the re-probe wait doubles through sixteen minutes and then holds", () => {
  const gate = { streak: 0, nextAllowedAt: 0 };
  let now = NOW;
  const waits = [];
  for (let i = 0; i < 6; i += 1) {
    const step = accountResetProbeStep([now - 1], now, gate);
    assert.equal(step.probe, true);
    waits.push(step.gate.nextAllowedAt - now);
    gate.streak = step.gate.streak;
    gate.nextAllowedAt = step.gate.nextAllowedAt;
    now = step.gate.nextAllowedAt;
  }
  assert.deepEqual(waits, [60_000, 120_000, 240_000, 480_000, 960_000, 960_000]);
});

test("a near or missing reset keeps the wait, and a normal window clears it", () => {
  const held = accountResetProbeStep([NOW - 1], NOW, { streak: 0, nextAllowedAt: 0 });
  assert.equal(held.probe, true);
  const near = accountResetProbeStep([NOW + 5_000], NOW, held.gate);
  assert.equal(near.probe, false);
  assert.equal(near.delay, 5_000);
  assert.equal(near.gate.streak, 1);
  const dropped = accountResetProbeStep([null, 0, -1], NOW, near.gate);
  assert.equal(dropped.probe, false);
  assert.equal(dropped.delay, null);
  assert.equal(dropped.gate.streak, 1);
  assert.equal(dropped.gate.nextAllowedAt, held.gate.nextAllowedAt);
  const cleared = accountResetProbeStep([NOW + 2 * HOUR, NOW + 5_000], NOW + 1, near.gate);
  assert.equal(cleared.probe, false);
  assert.equal(cleared.gate.streak, 1, "one reset still inside a minute keeps the wait");
  const normal = accountResetProbeStep([NOW + 2 * HOUR], NOW, cleared.gate);
  assert.deepEqual(normal.gate, { streak: 0, nextAllowedAt: 0 });
  const again = accountResetProbeStep([NOW - 1], NOW, normal.gate);
  assert.equal(again.probe, true);
  assert.equal(again.gate.nextAllowedAt - NOW, 60_000);
});

function openResetClock(t, start, options = {}) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: start });
  let resets = options.resets ?? [start - 1_000];
  let probes = 0;
  const live = new Set();
  const handles = new Map();
  let seq = 0;
  let lastDelay = null;
  const gate = { current: { streak: 0, nextAllowedAt: 0 } };
  let clock;
  clock = bindAccountResetClock({
    getResets: () => resets,
    onTick: () => {},
    onProbe: () => {
      probes += 1;
      options.onProbe?.(() => { clock.arm(); });
    },
    gate,
    schedule: (fn, ms) => {
      lastDelay = ms;
      const id = ++seq;
      live.add(id);
      const handle = setTimeout(() => {
        if (!live.delete(id)) return;
        handles.delete(id);
        fn();
      }, ms);
      handles.set(id, handle);
      return id;
    },
    cancel: (id) => {
      live.delete(id);
      const handle = handles.get(id);
      if (handle !== undefined) {
        clearTimeout(handle);
        handles.delete(id);
      }
    },
  });
  return {
    clock,
    gate,
    live,
    setResets(next) { resets = next; },
    probes: () => probes,
    delay: () => lastDelay,
  };
}

test("a reset a few seconds ahead waits, backs off, and a normal window restores the minute", (t) => {
  const start = Date.UTC(2026, 9, 2, 12, 0, 0);
  const harness = openResetClock(t, start);
  harness.clock.arm();
  assert.equal(harness.probes(), 1);
  assert.equal(harness.live.size, 1);
  assert.equal(harness.delay(), 60_000);
  assert.equal(harness.gate.current.nextAllowedAt, start + 60_000);

  harness.setResets([start + 5_000]);
  harness.clock.arm();
  assert.equal(harness.probes(), 1);
  assert.equal(harness.live.size, 1);
  assert.equal(harness.delay(), 5_000);

  t.mock.timers.tick(5_000);
  assert.equal(harness.probes(), 1);
  assert.equal(harness.live.size, 1);
  assert.equal(harness.delay(), 55_000);
  t.mock.timers.tick(54_999);
  assert.equal(harness.probes(), 1);
  t.mock.timers.tick(1);
  assert.equal(harness.probes(), 2);
  assert.equal(harness.delay(), 120_000);
  assert.equal(harness.gate.current.streak, 2);
  assert.equal(harness.live.size, 1);

  const secondProbeAt = start + 60_000;
  harness.setResets([secondProbeAt + 5_000]);
  harness.clock.arm();
  assert.equal(harness.probes(), 2);
  assert.equal(harness.delay(), 5_000);
  t.mock.timers.tick(5_000);
  assert.equal(harness.probes(), 2);
  assert.equal(harness.delay(), 115_000);
  t.mock.timers.tick(114_999);
  assert.equal(harness.probes(), 2);
  t.mock.timers.tick(1);
  assert.equal(harness.probes(), 3);
  assert.equal(harness.delay(), 240_000);
  assert.equal(harness.live.size, 1);

  const thirdProbeAt = secondProbeAt + 120_000;
  harness.setResets([thirdProbeAt + 2 * 60 * 60_000]);
  harness.clock.arm();
  assert.equal(harness.probes(), 3);
  assert.deepEqual(harness.gate.current, { streak: 0, nextAllowedAt: 0 });
  assert.equal(harness.live.size, 1);

  harness.setResets([Date.now() - 1]);
  harness.clock.arm();
  assert.equal(harness.probes(), 4);
  assert.equal(harness.delay(), 60_000);
  t.mock.timers.tick(59_000);
  assert.equal(harness.probes(), 4);
  t.mock.timers.tick(1_000);
  assert.equal(harness.probes(), 5);
  assert.equal(harness.delay(), 120_000);

  harness.clock.pause();
  assert.equal(harness.live.size, 0);
  t.mock.timers.tick(30_000);
  assert.equal(harness.probes(), 5);
  harness.clock.arm();
  assert.equal(harness.probes(), 5);
  assert.equal(harness.live.size, 1);

  harness.clock.stop();
  assert.equal(harness.live.size, 0);
  t.mock.timers.tick(60 * 60_000);
  assert.equal(harness.probes(), 5);
  assert.equal(harness.live.size, 0);
});

test("a probe that re-enters the clock does not arm a second timer", (t) => {
  const harness = openResetClock(t, NOW, {
    onProbe(rearm) { rearm(); },
  });
  harness.clock.arm();
  assert.equal(harness.probes(), 1);
  assert.equal(harness.live.size, 1);
  harness.clock.stop();
  assert.equal(harness.live.size, 0);
  t.mock.timers.tick(120_000);
  assert.equal(harness.probes(), 1);
  assert.equal(harness.live.size, 0);
});
