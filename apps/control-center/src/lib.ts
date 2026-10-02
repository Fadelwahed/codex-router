import type { UsageBucket, UsageMetric } from "./types";
import { createTranslator, detectLanguage, translatorLocale, type MessageKey, type Translate } from "./i18n.ts";

export type AccountBucketSource = "account" | "router-fallback";
export type AccountDisplayBucket = UsageBucket & { displaySource: AccountBucketSource };

export function compactNumber(value: number | null | undefined): string {
  const number = Math.max(0, Number(value) || 0);
  if (number < 1_000) return Math.round(number).toLocaleString(translatorLocale(createTranslator(detectLanguage())));
  if (number < 1_000_000) return `${trim(number / 1_000, number < 10_000 ? 1 : 0)}k`;
  if (number < 1_000_000_000) return `${trim(number / 1_000_000, number < 10_000_000 ? 1 : 0)}m`;
  return `${trim(number / 1_000_000_000, number < 10_000_000_000 ? 1 : 0)}b`;
}

export function exactNumber(value: number | null | undefined): string {
  return Math.max(0, Math.round(Number(value) || 0)).toLocaleString(translatorLocale(createTranslator(detectLanguage())));
}

export function formatContext(value: number | null | undefined, t: Translate = createTranslator(detectLanguage())): string {
  if (!Number.isFinite(Number(value)) || Number(value) <= 0) return t("common.managed");
  return t("common.tokensCount", { count: compactNumber(Number(value)) });
}

// The router publishes the same effort rungs everywhere it names one, so a
// single mapping keeps the control center, the tray, and the catalog in step.
const EFFORT_KEYS: Record<string, MessageKey> = {
  default: "models.effort.default",
  none: "models.effort.none",
  minimal: "models.effort.minimal",
  low: "models.effort.low",
  medium: "models.effort.medium",
  high: "models.effort.high",
  xhigh: "models.effort.xhigh",
  max: "models.effort.max",
  ultra: "models.effort.ultra",
};

export function effortLabel(effort: string, t: Translate = createTranslator(detectLanguage())): string {
  const key = Object.hasOwn(EFFORT_KEYS, effort) ? EFFORT_KEYS[effort] : undefined;
  // An unknown rung is a newer router than this build knows; showing its id
  // beats inventing a name for it.
  if (!key) return effort;
  if (effort === "default") return t(key);
  return ["zh-CN", "zh-TW"].includes(t.language ?? detectLanguage()) ? `${t(key)} (${effort})` : effort;
}

export function formatBytesGb(value: number | null | undefined, t: Translate = createTranslator(detectLanguage())): string {
  if (!Number.isFinite(Number(value))) return t("common.sizeUnknown");
  return `${Number(value).toFixed(Number(value) < 10 ? 1 : 0)} GB`;
}

export function formatDateTime(value: number | string | null | undefined, t: Translate = createTranslator(detectLanguage())): string {
  if (value === null || value === undefined || value === "") return t("common.notReported");
  const numeric = Number(value);
  const date = Number.isFinite(numeric)
    ? new Date(numeric < 10_000_000_000 ? numeric * 1_000 : numeric)
    : new Date(value);
  if (Number.isNaN(date.getTime())) return t("common.notReported");
  return new Intl.DateTimeFormat(translatorLocale(t), {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

// Codex reports each rate-limit window's resetsAt as a Unix timestamp. The
// same threshold formatDateTime uses distinguishes seconds from milliseconds.
// A missing or past instant is omitted: the row must never show "NaN" or a
// negative remainder.
//
// Two significant units, and no third. Under a day the label is hours and
// minutes, or minutes alone, and those minutes are floored: 50s remains
// "<1m", and "<1m" lasts only while time remains. At day scale it is days
// and hours. Leftover minutes are not a display unit there: 30 and above
// round up to the next hour, and a carry of 24 hours becomes the next day
// ("2d 23h 30m" reads "3d"). An exact number of days stays "2d". A remainder
// under 30 minutes with a zero hour stays visible as "2d 0h", so it is not
// identical to an exact day.
const ACCOUNT_RESET_MINUTE_MS = 60_000;

export function accountResetEpochMs(resetsAt: number | string | null | undefined): number | null {
  if (resetsAt === null || resetsAt === undefined || resetsAt === "") return null;
  const numeric = typeof resetsAt === "number" ? resetsAt : Number(resetsAt);
  if (!Number.isFinite(numeric)) return null;
  const epochMs = numeric < 10_000_000_000 ? numeric * 1_000 : numeric;
  return Number.isFinite(epochMs) ? epochMs : null;
}

// A zero or negative stamp is not a reset that has passed; the probe drops
// those before they reach the row. Only a real instant at or before `now`
// has elapsed.
export function accountResetElapsed(
  resetsAt: number | string | null | undefined,
  now = Date.now(),
): boolean {
  const epochMs = accountResetEpochMs(resetsAt);
  if (epochMs === null || epochMs <= 0 || !Number.isFinite(now)) return false;
  return epochMs <= now;
}

// The next paint is the soonest countdown minute boundary, or the reset
// instant when that is sooner. An exact minute is already the bottom of its
// floored bucket, so the following millisecond belongs to the lower label
// and must not keep "1m" on screen while 50s remain.
export function accountResetTickDelay(
  resetsAt: Array<number | string | null | undefined>,
  now = Date.now(),
): number | null {
  if (!Number.isFinite(now)) return null;
  let delay: number | null = null;
  for (const value of resetsAt) {
    const epochMs = accountResetEpochMs(value);
    if (epochMs === null || epochMs <= now) continue;
    const remainingMs = epochMs - now;
    const intoMinute = remainingMs % ACCOUNT_RESET_MINUTE_MS;
    const until = remainingMs < ACCOUNT_RESET_MINUTE_MS
      ? remainingMs
      : (intoMinute === 0 ? 1 : intoMinute);
    if (delay === null || until < delay) delay = until;
  }
  return delay;
}

export function accountResetProbeEpochs(
  resetsAt: Array<number | string | null | undefined>,
  now = Date.now(),
  probed: ReadonlySet<number> = new Set(),
): number[] {
  if (!Number.isFinite(now)) return [];
  const due: number[] = [];
  const seen = new Set<number>();
  for (const value of resetsAt) {
    const epochMs = accountResetEpochMs(value);
    if (epochMs === null || epochMs <= 0 || epochMs > now || probed.has(epochMs) || seen.has(epochMs)) continue;
    seen.add(epochMs);
    due.push(epochMs);
  }
  return due;
}

// A probe that answers with another reset a few seconds out used to arm the
// next probe for those few seconds. The refresh covers every account, so the
// wait is global: at least a minute, doubling while the answer is already
// elapsed or closer than that minute, and cleared once every real reset is
// at least a minute away. The cap is sixteen minutes.
export const ACCOUNT_RESET_REPROBE_MIN_MS = 60_000;
const ACCOUNT_RESET_REPROBE_MAX_SHIFT = 4;

export type AccountResetProbeGate = {
  streak: number;
  nextAllowedAt: number;
};

export function accountResetReprobeWait(streak: number): number {
  const shift = Math.min(
    ACCOUNT_RESET_REPROBE_MAX_SHIFT,
    Number.isFinite(streak) && streak > 0 ? Math.floor(streak) : 0,
  );
  return ACCOUNT_RESET_REPROBE_MIN_MS * (2 ** shift);
}

type AccountResetWindowKind = "elapsed" | "near" | "normal" | "none";

function accountResetWindowKind(
  resetsAt: Array<number | string | null | undefined>,
  now: number,
): AccountResetWindowKind {
  let sawNear = false;
  let sawNormal = false;
  for (const value of resetsAt) {
    const epochMs = accountResetEpochMs(value);
    if (epochMs === null || epochMs <= 0) continue;
    const remainingMs = epochMs - now;
    if (remainingMs <= 0) return "elapsed";
    if (remainingMs < ACCOUNT_RESET_REPROBE_MIN_MS) sawNear = true;
    else sawNormal = true;
  }
  if (sawNear) return "near";
  if (sawNormal) return "normal";
  return "none";
}

function accountResetGate(gate: AccountResetProbeGate): AccountResetProbeGate {
  return {
    streak: Number.isFinite(gate.streak) && gate.streak > 0 ? Math.floor(gate.streak) : 0,
    nextAllowedAt: Number.isFinite(gate.nextAllowedAt) && gate.nextAllowedAt > 0 ? gate.nextAllowedAt : 0,
  };
}

// `delay` is the one wake for both the countdown paint and a held probe.
// A dropped reset does not probe and does not clear a wait already in force.
export function accountResetProbeStep(
  resetsAt: Array<number | string | null | undefined>,
  now: number,
  gate: AccountResetProbeGate,
): { probe: boolean; gate: AccountResetProbeGate; delay: number | null } {
  const held = accountResetGate(gate);
  if (!Number.isFinite(now)) return { probe: false, gate: held, delay: null };
  const display = accountResetTickDelay(resetsAt, now);
  const kind = accountResetWindowKind(resetsAt, now);
  if (kind === "normal") return { probe: false, gate: { streak: 0, nextAllowedAt: 0 }, delay: display };
  if (kind !== "elapsed") return { probe: false, gate: held, delay: display };
  if (now < held.nextAllowedAt) {
    const wake = held.nextAllowedAt - now;
    return { probe: false, gate: held, delay: display === null ? wake : Math.min(display, wake) };
  }
  const wait = accountResetReprobeWait(held.streak);
  return {
    probe: true,
    gate: { streak: held.streak + 1, nextAllowedAt: now + wait },
    delay: display === null ? wait : Math.min(display, wait),
  };
}

// One timer. A nested `arm` from `onProbe` is ignored, so the probe cannot
// schedule a second one; the caller re-arms after the new resets arrive.
export function bindAccountResetClock(options: {
  getResets: () => Array<number | string | null | undefined>;
  onTick: (now: number) => void;
  onProbe: () => void;
  gate: { current: AccountResetProbeGate };
  allow?: () => boolean;
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (id: unknown) => void;
}): { arm: () => void; pause: () => void; stop: () => void } {
  const now = options.now ?? (() => Date.now());
  const schedule = options.schedule ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const cancel = options.cancel ?? ((id: unknown) => {
    clearTimeout(id as ReturnType<typeof setTimeout>);
  });
  let timer: { id: unknown } | null = null;
  let stopped = false;
  let arming = false;
  const clear = () => {
    if (!timer) return;
    cancel(timer.id);
    timer = null;
  };
  const arm = () => {
    if (arming) return;
    arming = true;
    try {
      clear();
      if (stopped || (options.allow && !options.allow())) return;
      const current = now();
      options.onTick(current);
      const step = accountResetProbeStep(options.getResets(), current, options.gate.current);
      options.gate.current = step.gate;
      if (step.probe) options.onProbe();
      if (stopped || (options.allow && !options.allow())) {
        clear();
        return;
      }
      if (step.delay === null) return;
      timer = { id: schedule(arm, step.delay) };
    } finally {
      arming = false;
    }
  };
  return {
    arm,
    pause() {
      if (!stopped) clear();
    },
    stop() {
      stopped = true;
      clear();
    },
  };
}

export function formatAccountReset(
  resetsAt: number | string | null | undefined,
  t: Translate = createTranslator(detectLanguage()),
  now = Date.now(),
): string {
  const epochMs = accountResetEpochMs(resetsAt);
  if (epochMs === null || !Number.isFinite(now)) return "";
  const remainingMs = epochMs - now;
  if (remainingMs <= 0) return "";
  const totalMinutes = Math.floor(remainingMs / ACCOUNT_RESET_MINUTE_MS);
  if (!Number.isSafeInteger(totalMinutes)) return "";
  const when = totalMinutes < 1
    ? t("settings.accounts.resetUnderMinute")
    : accountResetWhen(totalMinutes, t);
  return t("settings.accounts.resetsIn", { when });
}

function accountResetWhen(totalMinutes: number, t: Translate): string {
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) {
    let shownDays = days;
    let shownHours = hours + (minutes >= 30 ? 1 : 0);
    if (shownHours >= 24) {
      shownDays += 1;
      shownHours = 0;
    }
    if (shownHours === 0) {
      return minutes > 0 && minutes < 30
        ? t("settings.accounts.resetDaysHours", { days: shownDays, hours: 0 })
        : t("settings.accounts.resetDays", { days: shownDays });
    }
    return t("settings.accounts.resetDaysHours", { days: shownDays, hours: shownHours });
  }
  if (hours > 0) {
    return minutes > 0
      ? t("settings.accounts.resetHoursMinutes", { hours, minutes })
      : t("settings.accounts.resetHours", { hours });
  }
  return t("settings.accounts.resetMinutes", { minutes });
}

const ACCOUNT_WINDOW_DAY_MINUTES = 24 * 60;

// "weekly" is an exact seven-day window and "monthly" is the named monthly
// window. Both follow the active language. Any other duration keeps its own
// length, in whole days when it has them, so a ten-day window reads "10d"
// (or "10 天") and is not collapsed into the weekly line.
export function accountWindowPeriodLabel(
  window: { period: string; windowDurationMins?: number | null },
  t: Translate,
): string {
  if (window.period === "weekly") return t("settings.accounts.periodWeekly");
  if (window.period === "monthly") return t("settings.accounts.periodMonthly");
  const minutes = window.windowDurationMins;
  if (typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0) {
    if (minutes % ACCOUNT_WINDOW_DAY_MINUTES === 0) {
      return t("settings.accounts.windowDays", { days: minutes / ACCOUNT_WINDOW_DAY_MINUTES });
    }
    if (minutes % 60 === 0) return t("settings.accounts.windowHours", { hours: minutes / 60 });
    return t("settings.accounts.windowMinutes", { minutes: Math.round(minutes) });
  }
  if (window.period === "current") return t("settings.accounts.periodCurrent");
  return window.period;
}

export function accountUsageClause(
  window: {
    period: string;
    remainingPercent: number;
    resetsAt?: number | string | null;
    windowDurationMins?: number | null;
  } | null | undefined,
  t: Translate,
  now = Date.now(),
): string {
  if (!window || typeof window !== "object" || Array.isArray(window)) return "";
  if (typeof window.remainingPercent !== "number" || !Number.isFinite(window.remainingPercent)) return "";
  if (accountResetElapsed(window.resetsAt, now)) return t("settings.accounts.resetRefreshing");
  const remaining = t("settings.accounts.remaining", {
    period: accountWindowPeriodLabel(window, t),
    percent: Math.round(window.remainingPercent),
  });
  const reset = formatAccountReset(window.resetsAt, t, now);
  return reset ? `${remaining} · ${reset}` : remaining;
}

export function formatDuration(milliseconds: number | null | undefined, t: Translate = createTranslator(detectLanguage())): string {
  const value = Math.max(0, Number(milliseconds) || 0);
  if (value < 1_000) return t("common.durationMs", { count: Math.round(value) });
  if (value < 60_000) return t("common.durationSeconds", { count: (value / 1_000).toFixed(value < 10_000 ? 1 : 0) });
  return t("common.durationMinutesSeconds", { minutes: Math.floor(value / 60_000), seconds: Math.round((value % 60_000) / 1_000) });
}

export function metricValue(metric: UsageMetric, t: Translate = createTranslator(detectLanguage())): string {
  if (metric.kind === "balance" && Number.isFinite(Number(metric.value))) {
    return formatBalance(Number(metric.value), metric.currency, t);
  }
  if (Number.isFinite(Number(metric.remainingPercent))) return t("common.percentLeft", { percent: Math.round(Number(metric.remainingPercent)) });
  if (Number.isFinite(Number(metric.usedPercent))) return t("common.percentLeft", { percent: Math.round(100 - Number(metric.usedPercent)) });
  if (Number.isFinite(Number(metric.remaining))) return t("common.countLeft", { count: compactNumber(Number(metric.remaining)) });
  return t("common.reported");
}

export function remainingPercent(metric: UsageMetric): number | null {
  if (Number.isFinite(Number(metric.remainingPercent))) {
    return Math.max(0, Math.min(100, Number(metric.remainingPercent)));
  }
  if (Number.isFinite(Number(metric.usedPercent))) {
    return Math.max(0, Math.min(100, 100 - Number(metric.usedPercent)));
  }
  if (Number.isFinite(Number(metric.remaining)) && Number.isFinite(Number(metric.limit)) && Number(metric.limit) > 0) {
    return Math.max(0, Math.min(100, (Number(metric.remaining) / Number(metric.limit)) * 100));
  }
  return null;
}

// The window has to be walked in UTC days, because that is the day space every
// bucket key is written in -- the router keys its own buckets that way and
// OpenAI's account stream reports them that way. Walking local days asked for
// "the local day of the same name", which east of UTC is a different window
// than the bucket measured, and left the newest slot with no bucket to match
// until the offset had elapsed: an account mid-session read as zero all morning.
export function bucketRange(buckets: UsageBucket[] = [], days: number): UsageBucket[] {
  const index = new Map(buckets.map((bucket) => [bucket.startDate, bucket]));
  const anchor = new Date();
  anchor.setUTCHours(12, 0, 0, 0);
  return Array.from({ length: days }, (_, offset) => {
    const date = new Date(anchor);
    date.setUTCDate(anchor.getUTCDate() - (days - offset - 1));
    const key = date.toISOString().slice(0, 10);
    const existing = index.get(key);
    return existing
      ? { ...existing, startDate: key, tokens: Number(existing.tokens) || 0 }
      : { startDate: key, tokens: 0 };
  });
}

// OpenAI's account stream is authoritative whenever it contains a date. The
// local OpenAI provider stream is a narrower, router-only meter, so it may fill
// an absent account date but must never replace or augment an account bucket.
export function accountBucketsWithRouterFallback(
  accountBuckets: UsageBucket[] = [],
  routerBuckets: UsageBucket[] = [],
): AccountDisplayBucket[] {
  const merged = new Map<string, AccountDisplayBucket>();
  for (const bucket of routerBuckets) {
    merged.set(bucket.startDate, { ...bucket, displaySource: "router-fallback" });
  }
  for (const bucket of accountBuckets) {
    merged.set(bucket.startDate, { ...bucket, displaySource: "account" });
  }
  return [...merged.values()].sort((left, right) => left.startDate.localeCompare(right.startDate));
}

export function classNames(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}

function formatBalance(value: number, currency: string | undefined, t: Translate): string {
  const code = typeof currency === "string" && currency.trim() ? currency.trim() : "USD";
  try {
    return new Intl.NumberFormat(translatorLocale(t), {
      style: "currency",
      currency: code,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    // Venice reports a DIEM ledger that is not an ISO 4217 code. Intl throws
    // RangeError, React unmounts Usage, and the operator sees a white screen.
    return `${new Intl.NumberFormat(translatorLocale(t), { maximumFractionDigits: 2 }).format(value)} ${code}`;
  }
}

function trim(value: number, digits: number): string {
  return value.toFixed(digits).replace(/\.0$/, "");
}
