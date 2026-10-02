import assert from "node:assert/strict";
import test from "node:test";

import { formatAccountReset } from "../apps/control-center/src/lib.ts";
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
