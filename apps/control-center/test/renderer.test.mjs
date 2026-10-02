import assert from "node:assert/strict";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(appRoot, "dist");

const bridgeSource = String.raw`
(() => {
  const calls = [];
  let navigationListener;
  let operationListener;
  const searchParams = new URLSearchParams(location.search);
  let usageDelayMs = Number(searchParams.get("usageDelayMs")) || 0;
  let cursorHarnessState = "configured";
  let openclawHarnessConfigured = true;
  const snapshotDelayMs = Number(searchParams.get("snapshotDelayMs")) || 0;
  const providerDelayMs = Number(searchParams.get("providerDelayMs")) || 0;
  const accountDelay = searchParams.has("accountDelayMs")
    ? Number(searchParams.get("accountDelayMs")) || 0
    : null;
  const providerUsageDelay = searchParams.has("providerUsageDelayMs")
    ? Number(searchParams.get("providerUsageDelayMs")) || 0
    : null;
  const rejectAccountUsageRead = Number(searchParams.get("rejectAccountUsageRead")) || 0;
  const rejectAccountPool = searchParams.get("rejectAccountPool") === "1";
  const accountMutationDelayMs = Number(searchParams.get("accountMutationDelayMs")) || 0;
  const credentialDelayMs = Number(searchParams.get("credentialDelayMs")) || 0;
  const terminalLoginFailure = searchParams.get("terminalLoginFailure") === "1";
  const rejectLoginImmediately = searchParams.get("rejectLoginImmediately") === "1";
  const loginStaysPending = searchParams.get("loginStaysPending") === "1";
  const staleAccountFailure = searchParams.get("staleAccountFailure") === "1";
  const staleProviderUsage = searchParams.get("staleProviderUsage") === "1";
  const fallbackUsage = searchParams.get("fallbackUsage") === "1";
  const renameFails = searchParams.get("renameFails") || "";
  let labelFailureIndex = 0;
  const longAccountLabel = searchParams.get("longAccountLabel") === "1";
  const duplicateEmail = searchParams.get("duplicateEmail") === "1";
  const duplicateTitle = searchParams.get("duplicateTitle") === "1";
  const collidingReset = searchParams.get("collidingReset") === "1";
  // The usage chart walks a rolling window of UTC days ending on the current
  // one (bucketRange in src/lib.ts), so a frozen bucket key silently ages out
  // of the 30-day default and the bars it feeds stop rendering -- the fixture
  // still returns the bucket, the chart just has no slot for it any more. Key
  // these off today, in the same UTC day space the chart walks.
  const usageDayKey = (daysAgo) => {
    const day = new Date();
    day.setUTCHours(12, 0, 0, 0);
    day.setUTCDate(day.getUTCDate() - daysAgo);
    return day.toISOString().slice(0, 10);
  };
  const accountUsageDay = usageDayKey(2);
  // A distinct day from the account's, so the local router meter fills exactly
  // one date the account stream does not cover.
  const routerFallbackDay = usageDayKey(1);
  const pollOnceMs = Number(searchParams.get("pollOnceMs")) || 0;
  const healthPollOnceMs = Number(searchParams.get("healthPollOnceMs")) || 0;
  const staleHealth = searchParams.get("staleHealth") === "1";
  let accountUsageReads = 0;
  let accountPoolReads = 0;
  let subscriptionLoginRequested = false;
  let providerUsageReads = 0;
  let healthReads = 0;
  if (pollOnceMs > 0 || healthPollOnceMs > 0) {
    const nativeSetInterval = window.setInterval.bind(window);
    window.setInterval = (callback, delay, ...args) => {
      if (delay === 5 * 60_000 && pollOnceMs > 0) return window.setTimeout(callback, pollOnceMs, ...args);
      if (delay === 1_000 && healthPollOnceMs > 0) return window.setTimeout(callback, healthPollOnceMs, ...args);
      return nativeSetInterval(callback, delay, ...args);
    };
  }
  const subagents = { mode: "all", enabled: [], disabled: [], efforts: {}, proofs: {} };
  const selectedModel = {
    slug: "deepseek/deepseek-chat",
    displayName: "DeepSeek Chat",
    description: "Selected route used by the renderer fixture.",
    provider: "deepseek",
    enabled: true,
    visible: true,
    multiAgentVersion: "v2",
    subagentCertification: "v2",
    reasoningLevels: ["low", "medium", "high"],
    contextWindow: 128000,
    inputModalities: ["text"],
  };
  const oxProviders = [
    { id: "commandcode", displayName: "Command Code", kind: "api", configured: false },
    { id: "nousresearch", displayName: "Nous Research", kind: "api", configured: false },
    { id: "opencode-free", displayName: "OpenCode Free", kind: "anonymous", configured: true },
    { id: "opencode-go", displayName: "opencode Go/Zen", kind: "api", configured: true },
    { id: "openrouter", displayName: "OpenRouter", kind: "api", configured: false },
    { id: "venice", displayName: "Venice", kind: "api", configured: false },
  ];
  const knownOxModels = oxProviders.map((provider) => ({
    slug: provider.id + "/ox-alpha",
    displayName: "Ox Alpha (" + provider.displayName + ")",
    provider: provider.id,
    available: provider.id === "opencode-free" || provider.id === "opencode-go",
    contextWindow: 1048576,
    inputModalities: ["text", "image"],
    isFree: true,
  }));
  const activeOxModels = knownOxModels.filter((model) => model.available).map((model) => ({
    ...model,
    enabled: true,
    visible: false,
    multiAgentVersion: "v1",
    subagentCertification: "unknown",
    // One route of a multi-route family is locally curated, so the fixture
    // covers the discrimination the delete control depends on rather than a
    // family where every route answers the same way.
    ...(model.provider === "opencode-go" ? { local: true } : {}),
  }));
  const target = {
    target: "codex",
    configured: true,
    active: true,
    enabledProviders: ["deepseek", "opencode-free", "opencode-go"],
    providers: [
      { id: "deepseek", displayName: "DeepSeek", kind: "api" },
      { id: "kilo-free", displayName: "Kilo Free", kind: "anonymous" },
      ...oxProviders.map(({ id, displayName, kind }) => ({ id, displayName, kind })),
    ],
    models: [selectedModel, ...activeOxModels],
    modelSettings: {
      subagents,
      picker: { hidden: [], visible: [selectedModel.slug], hasExplicitVisibility: true },
      localModels: {
        available: [],
        availableVision: [],
        availableExplore: [{
          tag: "hf.co/unsloth/GLM-5.3-Flash-GGUF:UD-IQ1_S",
          family: "hf.co/unsloth/GLM-5.3-Flash-GGUF",
          variant: "UD-IQ1_S",
          displayName: "GLM-5.3-Flash · UD-IQ1_S",
          sizeGb: 93.1,
          context: 1048576,
          fit: "too-large",
          diskFit: "fits",
          downloadable: true,
          researchStatus: "Unsloth GGUF · 7 local quants",
          researchCapabilities: ["vision", "tools", "thinking"],
          researchNote: "Community quantization; capability and Codex checks run after pull.",
        }],
        families: [{
          family: "hf.co/unsloth/GLM-5.3-Flash-GGUF",
          displayName: "GLM-5.3-Flash",
          variants: ["UD-IQ1_S"],
        }],
        installed: 0,
        enabled: 0,
        models: [],
        totalGb: 0,
        machine: "16 GB unified memory",
        runtime: { installed: true, running: true, managed: true, version: "test" },
      },
      visionBridge: { enabled: false },
    },
  };
  const snapshot = {
    targets: { codex: target },
    catalog: {
      source: "codex-router",
      configured: true,
      enabledProviders: ["deepseek", "opencode-free", "opencode-go"],
      models: [selectedModel, ...activeOxModels],
      knownModels: knownOxModels,
      picker: { hidden: [], visible: [selectedModel.slug], hasExplicitVisibility: true },
      subagents,
    },
    chatgptSession: { sharing: "disabled", session: "unavailable", present: false },
  };
  const providers = {
    providers: [
      {
        id: "deepseek",
        displayName: "DeepSeek",
        kind: "api",
        configured: true,
        action: "ready",
        credentialLabel: "DeepSeek API key",
        catalogSources: [{ id: "deepseek", displayName: "DeepSeek", kind: "models-endpoint" }],
      },
      {
        id: "kilo-free",
        displayName: "Kilo Free",
        kind: "anonymous",
        configured: true,
        action: "anonymous",
        credentialLabel: "No API key",
        catalogSources: [{ id: "kilo-free", displayName: "Kilo Free", kind: "models-endpoint" }],
      },
      ...oxProviders.map((provider) => ({
        ...provider,
        action: provider.configured ? "ready" : "provider-key",
        credentialLabel: provider.kind === "anonymous" ? "No API key" : provider.displayName + " API key",
      })),
    ],
  };

  const record = (name, ...args) => calls.push({ name, args });
  const catalog = (providerId) => {
    record("discoverProviderModels", providerId);
    if (providerId === "kilo-free") {
      return {
        provider: providerId,
        discovered: ["kilo-unselected-free"],
        registered: [],
        unregistered: ["kilo-unselected-free"],
        addable: ["kilo-unselected-free"],
        blocked: {},
        unavailable: [],
        free: ["kilo-unselected-free"],
      };
    }
    return {
      provider: providerId,
      discovered: ["catalog-addable", "blocked-preview"],
      registered: [],
      unregistered: ["catalog-addable", "blocked-preview"],
      addable: ["catalog-addable"],
      blocked: { "blocked-preview": "No certified protocol route is available." },
      unavailable: [],
      contextLengths: { "catalog-addable": 200000, "blocked-preview": 128000 },
      fetchedAt: "2026-08-24T00:00:00.000Z",
    };
  };

  let accountSeq = 0;
  const accountPoolState = {
    version: 1,
    policy: { enabled: true, mode: "switch", selectedAccountId: "active" },
    accounts: {
      revoked: { id: "revoked", state: "revoked", paused: true, priority: 50, label: "Removed account", health: { state: "healthy" }, turns: 0, requests: 0 },
      active: { id: "active", state: "active", paused: false, priority: 50, label: "Secondary account", subscription: { status: "usable", authenticated: true, usable: true, expired: false, email: "secondary@example.com", usage: { period: "weekly", remainingPercent: 70, windowDurationMins: 10080, planType: "plus", also: { period: "current", remainingPercent: 12, windowDurationMins: 300 } } }, health: { state: "healthy" }, turns: 0, requests: 0 },
      current: { id: "current", state: "active", paused: false, priority: 50, label: "Current account", subscription: terminalLoginFailure || loginStaysPending ? { status: "invalid", authenticated: false, usable: false, expired: false, email: "primary@example.com" } : { status: "usable", authenticated: true, usable: true, expired: false, email: "primary@example.com" }, health: { state: "healthy" }, turns: 0, requests: 0 },
    },
    get loginAttempts() {
      return terminalLoginFailure && subscriptionLoginRequested
        ? { current: { status: "failed", error: "Codex login closed before this account became usable.", retryable: true } }
        : undefined;
    },
    sessions: { count: 0 },
    profile: { desired: "active", active: "active", pending: false, running: false },
  };
  if (duplicateEmail) {
    accountPoolState.accounts.active.label = "ChatGPT account 1";
    delete accountPoolState.accounts.active.labelCustom;
    accountPoolState.accounts.active.subscription.email = "same@example.com";
    accountPoolState.accounts.current.label = "ChatGPT account 2";
    delete accountPoolState.accounts.current.labelCustom;
    accountPoolState.accounts.current.subscription.email = "same@example.com";
  }
  if (duplicateTitle) {
    accountPoolState.accounts.active.label = "Shared inbox";
    accountPoolState.accounts.active.labelCustom = true;
    accountPoolState.accounts.current.label = "Shared inbox";
    accountPoolState.accounts.current.labelCustom = true;
  }
  if (longAccountLabel) {
    accountPoolState.accounts.current.label = "Very long account label that keeps going and going and going and going and going and going and going and going";
    accountPoolState.accounts.current.labelCustom = true;
  }
  if (collidingReset) {
    accountPoolState.accounts.active.label = "ChatGPT account 1";
    delete accountPoolState.accounts.active.labelCustom;
    accountPoolState.accounts.current.label = "ChatGPT account 1";
    accountPoolState.accounts.current.labelCustom = true;
  }

  window.routerControl = Object.freeze({
    platform: navigator.platform.toLowerCase().includes("mac") ? "darwin" : "linux",
    getSnapshot: async () => {
      await new Promise((resolve) => setTimeout(resolve, snapshotDelayMs));
      return snapshot;
    },
    getChatGptSession: async () => ({ sharing: "disabled", session: "usable", present: true, email: "primary@example.com" }),
    getChatGptAccountPool: async () => {
      if (rejectAccountPool) throw new Error("The saved ChatGPT account list could not be read as JSON.");
      accountPoolReads += 1;
      if (terminalLoginFailure) record("getChatGptAccountPool", accountPoolReads);
      const usage = accountPoolState.accounts.active.subscription?.usage;
      if (usage) {
        const now = Date.now();
        // Day-scale leftovers of 30 minutes round up to the next hour, so the
        // padding stays under that line. 3h 12m keeps a 45s pad because
        // seconds are floored away.
        usage.resetsAt = now + ((2 * 24 * 60) + (4 * 60) + 20) * 60_000;
        usage.also.resetsAt = now + ((3 * 60) + 12) * 60_000 + 45_000;
      }
      return JSON.parse(JSON.stringify(accountPoolState));
    },
    getProviders: async () => {
      await new Promise((resolve) => setTimeout(resolve, providerDelayMs));
      return providers;
    },
    getPresence: async () => ({ mode: "always" }),
    getHealth: async () => {
      healthReads += 1;
      const read = healthReads;
      await new Promise((resolve) => setTimeout(resolve, staleHealth && read === 1 ? 400 : 0));
      return staleHealth && read === 1
        ? { ok: false, error: "Stale health response", activity: { state: "offline", active: [], activeCount: 0 } }
        : { ok: true, version: "health-" + read, activity: { state: "idle", active: [], activeCount: 0 } };
    },
    getHarnesses: async () => ({
      platform: "darwin",
      terminalAvailable: true,
      harnesses: [
        {
          id: "openclaw", displayName: "OpenClaw", ownership: "openclaw",
          description: "OpenClaw's current agent runtime.", cliInstalled: true, appInstalled: false,
          configured: openclawHarnessConfigured, canInstall: true, installRequirement: "Publish shared config.",
          docsUrl: "https://docs.openclaw.ai/",
        },
        {
          id: "codex", displayName: "Codex", ownership: "openai",
          description: "OpenAI coding client.", cliInstalled: true, appInstalled: true,
          configured: true, canInstall: true, installRequirement: "Publish shared config.",
          docsUrl: "https://developers.openai.com/codex/",
        },
        {
          id: "dsh", displayName: "DeepSeek Harness", ownership: "deepseek",
          description: "DeepSeek coding client.", cliInstalled: true, appInstalled: true,
          configured: true, canInstall: true, installRequirement: "Publish shared config.",
          docsUrl: "https://github.com/deepseek-ai/DeepSeek-Harness",
        },
        {
          id: "cursor", displayName: "Cursor", ownership: "cursor",
          description: "Cursor Agent and Cursor App.", cliInstalled: true, appInstalled: true,
          configured: cursorHarnessState === "configured",
          agentConfigured: true,
          appConfigured: cursorHarnessState === "configured",
          canInstall: true,
          installRequirement: cursorHarnessState === "configured" ? "Cursor App is connected." : "Continue Cursor setup.",
          tunnel: cursorHarnessState === "configured"
            ? { provider: "cloudflare", binaryInstalled: true, loggedIn: true, configured: true, nextAction: "ready" }
            : cursorHarnessState === "login"
              ? { provider: "cloudflare", binaryInstalled: true, loggedIn: false, configured: false, nextAction: "login" }
              : { provider: "cloudflare", binaryInstalled: false, loggedIn: false, configured: false, nextAction: "install-cloudflared" },
          docsUrl: "https://docs.cursor.com/",
        },
        {
          id: "claude", displayName: "Claude Code", ownership: "anthropic",
          description: "Anthropic coding client.", cliInstalled: true, appInstalled: false,
          configured: true, canInstall: true, installRequirement: "Publish shared config.",
          docsUrl: "https://code.claude.com/docs/en/overview",
        },
        {
          id: "gemini", displayName: "Gemini CLI", ownership: "google",
          description: "Google coding client.", cliInstalled: true, appInstalled: false,
          configured: true, canInstall: true, installRequirement: "Publish shared config.",
          docsUrl: "https://github.com/google-gemini/gemini-cli",
        },
      ],
    }),
    getAgentBridges: async () => ({
      version: 1,
      bridges: [
        { id: "anthropic", displayName: "Claude", protocol: "claude-code", installed: true, sessions: 2, authentication: "client-owned" },
        { id: "cursor", displayName: "Cursor Agent", protocol: "acp", installed: true, sessions: 1, authentication: "client-owned" },
        { id: "gemini", displayName: "Gemini CLI", protocol: "acp", installed: false, sessions: 0, authentication: "unavailable" },
      ],
    }),
    getContextSessions: async () => ({
      fetchedAt: "2026-08-30T08:00:00.000Z",
      counts: { total: 3, codex: 1, dsh: 1, cursor: 1, claude: 0, gemini: 0, openclaw: 0, archived: 0 },
      sessions: [
        { id: "11111111-1111-4111-8111-111111111111", harnessId: "cursor", title: "Cursor routing task", updatedAt: "2026-08-30T08:00:00.000Z", archived: false, resumable: true },
        { id: "session-22222222-2222-4222-8222-222222222222", harnessId: "dsh", title: "DeepSeek routing task", updatedAt: "2026-08-30T07:00:00.000Z", archived: false, resumable: true },
        { id: "33333333-3333-4333-8333-333333333333", harnessId: "codex", title: "Codex routing task", updatedAt: "2026-08-30T06:00:00.000Z", archived: false, resumable: true },
      ],
    }),
    setupHarness: async (harnessId) => {
      record("setupHarness", harnessId);
      if (harnessId === "openclaw") openclawHarnessConfigured = true;
      return { configured: true };
    },
    prepareCursorTunnel: async () => {
      record("prepareCursorTunnel");
      operationListener?.({ action: "prepareCursorTunnel", status: "started", message: "Downloading Cloudflare connector…" });
      await new Promise((resolve) => setTimeout(resolve, 250));
      cursorHarnessState = "login";
      operationListener?.({ action: "prepareCursorTunnel", status: "completed", message: "Cloudflare connector installed." });
      return { installed: true };
    },
    connectCursor: async () => {
      record("connectCursor");
      operationListener?.({ action: "connectCursor", status: "started", message: "Installing Cloudflare connector…" });
      await new Promise((resolve) => setTimeout(resolve, 250));
      cursorHarnessState = "configured";
      operationListener?.({ action: "connectCursor", status: "completed", message: "Cursor routing verified." });
      return { configured: true, opened: true };
    },
    disconnectCursor: async () => {
      record("disconnectCursor");
      operationListener?.({ action: "disconnectCursor", status: "started", message: "Fully quit Cursor. Disconnect will resume here automatically…" });
      await new Promise((resolve) => setTimeout(resolve, 250));
      cursorHarnessState = "install";
      operationListener?.({ action: "disconnectCursor", status: "completed", message: "Cursor routing removed." });
      return { removed: true };
    },
    disconnectHarness: async (harnessId) => {
      record("disconnectHarness", harnessId);
      if (harnessId === "cursor") {
        cursorHarnessState = "install";
        return { removed: true, harnessId };
      }
      if (harnessId === "openclaw") openclawHarnessConfigured = false;
      return { removed: true, harnessId };
    },
    launchHarness: async (harnessId, surface) => {
      record("launchHarness", harnessId, surface);
      return { opened: true };
    },
    probeAgentBridge: async (bridgeId) => { record("probeAgentBridge", bridgeId); return { handshake: "ok" }; },
    loginAgentBridge: async (bridgeId) => { record("loginAgentBridge", bridgeId); return { opened: true }; },
    openHarnessSession: async () => ({ opened: true }),
    getAccountUsage: async () => {
      accountUsageReads += 1;
      const read = accountUsageReads;
      await new Promise((resolve) => setTimeout(
        resolve,
        staleAccountFailure && read > 1 ? 0 : accountDelay ?? usageDelayMs,
      ));
      if ((staleAccountFailure && read === 1) || rejectAccountUsageRead === read) {
        throw new Error("Account usage poll failed");
      }
      return {
        fetchedAt: "2026-08-27T08:00:00.000Z",
        planType: "pro",
        primary: {
          usedPercent: 34,
          remainingPercent: 66,
          windowDurationMins: 300,
          resetsAt: 1800000000,
        },
        dailyUsageBuckets: [{ startDate: accountUsageDay, tokens: 24000 }],
        summary: { lifetimeTokens: 24000, peakDailyTokens: 24000, currentStreakDays: 1 },
      };
    },
    getProviderUsage: async () => {
      providerUsageReads += 1;
      const read = providerUsageReads;
      await new Promise((resolve) => setTimeout(
        resolve,
        staleProviderUsage && read > 1 ? 0 : providerUsageDelay ?? usageDelayMs,
      ));
      const totalTokens = staleProviderUsage && read > 1 ? 24000 : 12000;
      return {
        fetchedAt: "2026-08-27T08:00:00.000Z",
        providers: [
          ...(fallbackUsage ? [{
            id: "openai",
            displayName: "OpenAI",
            credentialType: "oauth",
            totalTokens: 31_000,
            requests: 3,
            last24hTokens: 31_000,
            last24hRequests: 3,
            dailyUsageBuckets: [{
              startDate: routerFallbackDay,
              tokens: 31_000,
              requests: 3,
              inputTokens: 25_000,
              cachedInputTokens: 7_000,
              outputTokens: 6_000,
            }],
          }] : []),
          {
            id: "deepseek",
            displayName: "DeepSeek",
            credentialType: "api",
            inputTokens: 10_000,
            regularInputTokens: 7_500,
            cachedInputTokens: searchParams.get("coldCache") === "1" ? 0 : 2_500,
            cacheTelemetrySeen: true,
            totalTokens,
            requests: 8,
            last24hTokens: totalTokens,
            last24hRequests: 8,
            dailyUsageBuckets: [{ startDate: accountUsageDay, tokens: totalTokens, requests: 8 }],
            account: {
              status: "available",
              metrics: [
                {
                  kind: "quota",
                  label: "Monthly credits",
                  usedPercent: 25,
                  remainingPercent: 75,
                  resetAt: 1800000000,
                },
                {
                  kind: "quota",
                  label: "Rolling window",
                  usedPercent: 40,
                  remainingPercent: 60,
                  resetAt: 1790000000,
                },
              ],
            },
          },
          {
            id: "venice",
            displayName: "Venice",
            credentialType: "api",
            inputTokens: 0,
            regularInputTokens: 0,
            cachedInputTokens: 0,
            cacheTelemetrySeen: false,
            totalTokens: 0,
            requests: 0,
            last24hTokens: 0,
            last24hRequests: 0,
            dailyUsageBuckets: [],
            account: {
              status: "available",
              metrics: [
                {
                  kind: "balance",
                  label: "DIEM balance",
                  value: 8.25,
                  currency: "DIEM",
                  detail: "Daily DIEM allowance",
                },
              ],
            },
          },
        ],
      };
    },
    controlTray: async () => ({ status: { supported: true } }),
    discoverProviderModels: async (providerId) => catalog(providerId),
    addProviderModels: async (providerId, modelIds) => {
      record("addProviderModels", providerId, [...modelIds]);
      return { ok: true };
    },
    setPickerModels: async (showAll) => {
      record("setPickerModels", showAll);
      return { ok: true };
    },
    setPickerModel: async () => ({ ok: true }),
    setProviderEnabled: async () => ({ ok: true }),
    setChatGptAccountSelection: async (selection) => {
      record("setChatGptAccountSelection", selection);
      return { ok: true };
    },
    renameChatGptSubscriptionAccount: async (accountId, label = "") => {
      record("renameChatGptSubscriptionAccount", accountId, label);
      const remotePrefix = "Error invoking remote method 'router-control:renameChatGptSubscriptionAccount': Error: ";
      const labelFailures = [
        remotePrefix + "account-label-error:invalid: Account label is invalid.\n",
        remotePrefix + "account-label-error:forbidden: Account label contains characters that are not allowed.\n",
        remotePrefix + "account-label-error:too-long: Account label is limited to 120 characters.\n",
        remotePrefix + "account-label-error:collision: Account label matches another account.\n",
        remotePrefix + "account-label-error:unknown-id: Account id is not registered.\n",
        remotePrefix + "account-label-error:io: The account label could not be saved.\n",
        remotePrefix + "account-label-error:cli: The account label command failed.\n",
        remotePrefix + "account-label-error:not-a-code: raw backend text must stay hidden\n",
        remotePrefix + "Account label matches another account.\n",
        remotePrefix + "ENOSPC: no space left on device\n",
        remotePrefix + "Account id is not registered.\n",
      ];
      if (renameFails === "1") throw new Error(remotePrefix + "ENOSPC: no space left on device\n");
      if (renameFails === "matrix") {
        const failure = labelFailures[Math.min(labelFailureIndex, labelFailures.length - 1)];
        labelFailureIndex += 1;
        throw new Error(failure);
      }
      const account = accountPoolState.accounts[accountId];
      if (!account) throw new Error("Account id is not registered.");
      const raw = String(label);
      const forbidden = /[\u0000-\u001F\u007F-\u009F\u2028\u2029\u202A-\u202E\u2066-\u2069]/;
      const loneSurrogate = (value) => {
        for (let index = 0; index < value.length; index += 1) {
          const code = value.charCodeAt(index);
          if (code >= 0xD800 && code <= 0xDBFF) {
            const next = value.charCodeAt(index + 1);
            if (!(next >= 0xDC00 && next <= 0xDFFF)) return true;
            index += 1;
          } else if (code >= 0xDC00 && code <= 0xDFFF) return true;
        }
        return false;
      };
      if (forbidden.test(raw) || loneSurrogate(raw)) {
        throw new Error("Account label contains characters that are not allowed.");
      }
      const trimmed = raw.trim();
      let graphemes = Array.from(trimmed).length;
      if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
        graphemes = 0;
        const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
        for (const _part of segmenter.segment(trimmed)) graphemes += 1;
      }
      if (graphemes > 120) throw new Error("Account label is limited to 120 characters.");
      const generated = /^ChatGPT account (\d+)$/;
      const canonicalLabel = (value) => String(value || "").normalize("NFKC").replace(/[\u200B-\u200D\u2060\uFEFF]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
      const generatedNumber = (value) => {
        const match = /^chat ?gpt account (\d+)$/.exec(canonicalLabel(value));
        if (!match) return undefined;
        const number = Number(match[1]);
        return Number.isSafeInteger(number) && number >= 1 ? number : undefined;
      };
      if (trimmed) {
        const wanted = generatedNumber(trimmed);
        const collision = wanted !== undefined && Object.values(accountPoolState.accounts).some((entry) => (
          entry && entry.id !== accountId && entry.state !== "revoked" && generatedNumber(entry.label) === wanted
        ));
        if (collision) throw new Error("Account label matches another account.");
        account.label = trimmed;
        account.labelCustom = true;
      } else if (account.labelCustom === true || !generated.test(String(account.label || ""))) {
        delete account.labelCustom;
        delete account.label;
        const used = new Set(Object.values(accountPoolState.accounts).filter((entry) => entry && entry.state !== "revoked").map((entry) => generatedNumber(entry.label)).filter((value) => Number.isInteger(value)));
        let numberValue = 1;
        while (used.has(numberValue)) numberValue += 1;
        account.label = "ChatGPT account " + numberValue;
      } else {
        delete account.labelCustom;
      }
      if (accountMutationDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, accountMutationDelayMs));
      return { account };
    },
    addChatGptSubscriptionAccount: async (label = "") => {
      record("addChatGptSubscriptionAccount", label);
      if (accountMutationDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, accountMutationDelayMs));
      accountSeq += 1;
      const id = "acct_test_" + String(accountSeq).padStart(8, "0");
      const account = {
        id,
        state: "active",
        paused: false,
        priority: 50,
        label: String(label || "").trim() || ("Account " + accountSeq),
        subscription: { status: "pending", authenticated: false, usable: false, expired: false },
        health: { state: "healthy" },
        turns: 0,
        requests: 0,
      };
      accountPoolState.accounts[id] = account;
      return { account, loginRequired: true };
    },
    removeChatGptSubscriptionAccount: async (accountId) => {
      record("removeChatGptSubscriptionAccount", accountId);
      if (accountMutationDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, accountMutationDelayMs));
      delete accountPoolState.accounts[accountId];
      if (accountPoolState.policy.selectedAccountId === accountId) {
        delete accountPoolState.policy.selectedAccountId;
      }
      return { id: accountId };
    },
    loginChatGptSubscriptionAccount: async (accountId) => {
      record("loginChatGptSubscriptionAccount", accountId);
      if (rejectLoginImmediately) throw new Error("Codex login could not be launched.");
      subscriptionLoginRequested = true;
      return { accountId, opened: true, surface: "browser", pending: true };
    },
    setSubagentModel: async () => ({ ok: true }),
    setSubagentEffort: async (slug, effort) => {
      record("setSubagentEffort", slug, effort);
      subagents.efforts[slug] = effort;
      return { ok: true };
    },
    onNavigation: (listener) => {
      navigationListener = listener;
      return () => { if (navigationListener === listener) navigationListener = undefined; };
    },
    onOperation: (listener) => {
      operationListener = listener;
      return () => { if (operationListener === listener) operationListener = undefined; };
    },
    // Not gated behind customEndpoints: a locally curated model can sit on any
    // provider, which is the whole point of the removal being general.
    removeLocalModels: async (slugs) => {
      record("removeLocalModels", [...slugs]);
      return { ok: true };
    },
  });

  if (searchParams.get("customEndpoints") === "1") {
    providers.providers.push({ id: "custom", displayName: "Custom", kind: "per-model", configured: true });
    providers.customEndpoints = [];
    const baseApi = window.routerControl;
    const clone = (value) => JSON.parse(JSON.stringify(value));
    window.routerControl = Object.freeze({
      ...baseApi,
      getSnapshot: async () => clone(await baseApi.getSnapshot()),
      getProviders: async () => clone(await baseApi.getProviders()),
      addCustomEndpoint: async (input) => {
        record("addCustomEndpoint", clone(input));
        const id = "user_fixture";
        const { credential, ...publicFields } = input;
        providers.customEndpoints.push({
          id, ...publicFields, kind: "api", generic: true, configured: true, enabled: true,
          hasKey: Boolean(credential), credentialLabel: "API key",
          catalogSources: [{ id, displayName: input.displayName, kind: "models-endpoint" }],
        });
        // An exact raw diagnostic must remain visible in every UI language.
        return { providerId: id, check: { ok: false, reason: "provider/401 raw_diagnostic" } };
      },
      editCustomEndpoint: async (id, input) => {
        record("editCustomEndpoint", id, clone(input));
        const endpoint = providers.customEndpoints.find((entry) => entry.id === id);
        Object.assign(endpoint, input);
        return { providerId: id, check: { ok: true } };
      },
      saveProviderCredential: async (id, credential) => {
        record("saveProviderCredential", id, credential);
        // The real command writes the key, enables the provider, and
        // republishes every installed client catalog before it resolves.
        if (credentialDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, credentialDelayMs));
        return { ok: true };
      },
      addCustomEndpointModel: async (id, modelId) => {
        record("addCustomEndpointModel", id, modelId);
        const model = {
          slug: id + "/" + modelId, displayName: modelId, provider: id,
          enabled: true, visible: true, contextWindow: 128000, inputModalities: ["text"],
        };
        target.models.push(model);
        snapshot.catalog.models.push(model);
        return { ok: true };
      },
      removeCustomEndpointModels: async (id, slugs) => {
        record("removeCustomEndpointModels", id, [...slugs]);
        target.models = target.models.filter((model) => !slugs.includes(model.slug));
        snapshot.catalog.models = snapshot.catalog.models.filter((model) => !slugs.includes(model.slug));
        return { ok: true };
      },
      removeProviderCredential: async (id) => {
        record("removeProviderCredential", id);
        providers.customEndpoints = providers.customEndpoints.filter((entry) => entry.id !== id);
        target.models = target.models.filter((model) => model.provider !== id);
        snapshot.catalog.models = snapshot.catalog.models.filter((model) => model.provider !== id);
        return { ok: true };
      },
    });
  }
  window.routerControlTest = Object.freeze({
    calls: () => calls.map((call) => ({ name: call.name, args: call.args })),
    navigationReady: () => Boolean(navigationListener),
    navigate: (destination) => {
      if (!navigationListener) return false;
      navigationListener(destination);
      return true;
    },
    setUsageDelay: (milliseconds) => { usageDelayMs = milliseconds; },
    usageReads: () => ({ account: accountUsageReads, provider: providerUsageReads }),
    healthReads: () => healthReads,
    setCursorHarnessState: (state) => { cursorHarnessState = state; },
    setOpenClawHarnessConfigured: (configured) => { openclawHarnessConfigured = configured; },
  });
})();
`;

function mimeType(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  if (filePath.endsWith(".png")) return "image/png";
  return "application/octet-stream";
}

function serveRenderer() {
  const server = http.createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname);
    if (pathname === "/test-bridge.js") {
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      response.end(bridgeSource);
      return;
    }
    if (pathname === "/favicon.ico") {
      response.writeHead(204).end();
      return;
    }
    const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const target = path.resolve(dist, relative);
    if (target !== dist && !target.startsWith(`${dist}${path.sep}`) || !existsSync(target)) {
      response.writeHead(404).end("not found");
      return;
    }
    let contents = readFileSync(target);
    if (relative === "index.html") {
      const html = contents.toString("utf8");
      assert.match(html, /<script type="module"/);
      contents = Buffer.from(
        html.replace('<script type="module"', '<script src="./test-bridge.js"></script><script type="module"'),
      );
    }
    response.writeHead(200, { "content-type": mimeType(target) });
    response.end(contents);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        url: `http://127.0.0.1:${address.port}/`,
        close: () => new Promise((done) => {
          server.close(done);
          server.closeAllConnections?.();
        }),
      });
    });
  });
}

const chromiumPath = [
  process.env.CODEX_ROUTER_TEST_CHROMIUM,
  chromium.executablePath(),
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe"),
  process.env["PROGRAMFILES(X86)"] && path.join(process.env["PROGRAMFILES(X86)"], "Google", "Chrome", "Application", "chrome.exe"),
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
].find((candidate) => candidate && existsSync(candidate));

async function newEnglishTestPage(browser, options) {
  const page = await browser.newPage(options);
  await page.addInitScript(() => {
    localStorage.setItem("codex-router-language", "en");
  });
  return page;
}

test("the production renderer exposes model discovery and picker actions", { timeout: 120_000 }, async () => {
  assert.equal(existsSync(path.join(dist, "index.html")), true, "npm test must build the renderer first");
  assert.ok(chromiumPath, "No Chromium executable is available for the Control Center renderer test.");

  const { url, close } = await serveRenderer();
  const browser = await chromium.launch({
    executablePath: chromiumPath,
    headless: true,
    args: process.platform === "linux" ? ["--no-sandbox"] : [],
  });
  const pageErrors = [];
  try {
    const page = await newEnglishTestPage(browser, { viewport: { width: 1280, height: 840 } });
    // Windows hosted runners routinely spend about 30 seconds starting the
    // browser. Keep UI waits short and diagnostic without letting that startup
    // consume the whole integration-test deadline.
    page.setDefaultTimeout(10_000);
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") pageErrors.push(message.text());
    });

    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.getByRole("navigation", { name: "Control center sections" }).waitFor();
    const wordmark = page.locator(".router-wordmark");
    assert.equal((await wordmark.locator("strong").innerText()).trim(), "Codex Router");
    assert.equal(await wordmark.locator("img").count(), 0);
    await page.waitForFunction(() => window.routerControlTest.navigationReady());
    await page.evaluate(() => window.routerControlTest.setUsageDelay(600));
    assert.equal(
      await page.evaluate(() => window.routerControlTest.navigate({ destination: "usage", sourceId: "deepseek" })),
      true,
    );
    await page.getByRole("heading", { name: "Usage", exact: true }).waitFor();
    await page.getByText("8.25 DIEM", { exact: true }).waitFor();
    // #824: the chosen source is labelled and its allowances are grouped under
    // it instead of being silently floated above the other accounts.
    assert.equal(await page.getByLabel("Usage source").inputValue(), "provider:deepseek");
    await page.locator(".us-source-group-label", { hasText: "Selected · DeepSeek" }).waitFor();
    assert.equal(await page.locator(".us-source-group-label", { hasText: "Other connected accounts" }).count(), 1);
    assert.equal(await page.locator(".us-source-badges .badge", { hasText: "Selected" }).count(), 1);
    // #826: cache hits render as a count plus a share of reported input; a
    // provider with no cache telemetry says so rather than reading "0%".
    await page.getByText("2.5k (25%)", { exact: true }).waitFor();
    await page.getByLabel("Usage source").selectOption("provider:venice");
    await page.getByText(/hit rate not reported/).waitFor();
    assert.equal(await page.getByText(/\(0%\)/).count(), 0);
    await page.getByLabel("Usage source").selectOption("provider:deepseek");
    assert.equal(
      await page.evaluate(() => window.routerControlTest.navigate({ destination: "usage-resets", sourceId: "deepseek" })),
      true,
    );
    await page.waitForFunction(() => {
      const active = document.activeElement;
      return active?.classList.contains("us-metric-card")
        && active.getAttribute("aria-label")?.startsWith("DeepSeek, Rolling window");
    });
    assert.match(
      await page.evaluate(() => document.activeElement?.getAttribute("aria-label")),
      /DeepSeek, Rolling window.*Resets/,
    );
    assert.equal(
      await page.evaluate(() => window.routerControlTest.navigate({ destination: "usage", sourceId: "openai" })),
      true,
    );
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Usage overview");
    assert.equal(await page.getByLabel("Usage source").inputValue(), "chatgpt-subscription");

    // Harness is one client per row, in the product order the operator uses,
    // and the shared metadata index continues into Context Manager.
    await page.getByRole("button", { name: "Harness Experimental", exact: true }).click();
    assert.equal(await page.locator(".primary-nav .badge-warning", { hasText: "Experimental" }).count(), 1);
    assert.equal(await page.locator(".title-tabs .badge-warning", { hasText: "Experimental" }).count(), 1);
    assert.equal(await page.locator(".page-scroll-harness").evaluate((element) => getComputedStyle(element).display), "block");
    const harnessRows = page.locator(".lhc-harness-row");
    await harnessRows.first().waitFor();
    assert.equal(await harnessRows.count(), 6);
    assert.deepEqual(
      (await harnessRows.locator("h2").allTextContents()).map((value) => value.trim()),
      ["OpenClaw", "Cursor", "Claude Code", "Gemini CLI", "DeepSeek Harness", "Codex"],
    );
    assert.equal(await harnessRows.nth(0).locator('[data-client-logo="openclaw"]').count(), 1);
    assert.equal(await harnessRows.nth(1).locator('[data-client-logo="cursor"]').count(), 1);
    assert.equal(await harnessRows.nth(2).locator('[data-client-logo="claude"]').count(), 1);
    assert.equal(await harnessRows.nth(3).locator('[data-client-logo="gemini"]').count(), 1);
    assert.equal(await harnessRows.nth(4).locator('[data-client-logo="dsh"]').count(), 1);
    assert.equal(await harnessRows.nth(5).locator('[data-client-logo="codex"]').count(), 1);
    assert.deepEqual(
      await page.locator(".lhc-harness-table-head span").allTextContents(),
      ["Client", "Models", "Sessions", "Actions"],
    );
    assert.equal(await page.locator(".lhc-harness-catalog").filter({ hasText: /^1$/ }).count(), 6);
    assert.equal(await page.getByLabel("Stable public HTTPS origin").count(), 0);
    assert.deepEqual(
      await harnessRows.evaluateAll((rows) => rows.map((row) => row.querySelectorAll(".lhc-harness-actions button").length)),
      [2, 2, 2, 2, 2, 2],
    );
    for (const client of ["OpenClaw", "Cursor", "Claude Code", "Gemini CLI", "DeepSeek Harness", "Codex"]) {
      assert.equal(await page.getByRole("button", { name: `Open ${client} app`, exact: true }).count(), 1);
      assert.equal(await page.getByRole("button", { name: `Open ${client} terminal`, exact: true }).count(), 1);
      assert.equal(await page.getByRole("checkbox", { name: `Route ${client} through Codex Router`, exact: true }).count(), 1);
    }
    assert.equal(await page.getByRole("button", { name: /documentation|agent/i }).count(), 0);
    await harnessRows.nth(0).getByRole("button", { name: "Open OpenClaw app", exact: true }).click();
    assert.deepEqual(
      await page.evaluate(() => window.routerControlTest.calls().find((call) => call.name === "launchHarness")),
      { name: "launchHarness", args: ["openclaw", "app"] },
    );
    await harnessRows.nth(0).getByRole("button", { name: "Open OpenClaw terminal", exact: true }).click();
    assert.deepEqual(
      await page.evaluate(() => window.routerControlTest.calls().filter((call) => call.name === "launchHarness").at(-1)),
      { name: "launchHarness", args: ["openclaw", "terminal"] },
    );
    await page.evaluate(() => window.routerControlTest.setOpenClawHarnessConfigured(false));
    await page.getByRole("button", { name: "Context Manager", exact: true }).click();
    await page.getByRole("button", { name: "Harness Experimental", exact: true }).click();
    await harnessRows.nth(0).getByRole("button", { name: "Set up OpenClaw", exact: true }).click();
    await harnessRows.nth(0).getByRole("button", { name: "Open OpenClaw app", exact: true }).waitFor();
    assert.equal(
      await page.evaluate(() => window.routerControlTest.calls()
        .filter((call) => call.name === "setupHarness" && call.args[0] === "openclaw").length),
      1,
    );
    assert.equal(await page.locator(".lhc-agent-bridges").count(), 0);
    assert.deepEqual(
      await page.locator(".lhc-harness-bridge").allTextContents(),
      ["Agent · 1", "Agent · 2"],
    );
    const rowBoxes = await harnessRows.evaluateAll((rows) => rows.map((row) => {
      const box = row.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height };
    }));
    assert.equal(rowBoxes.every((box) => box.width === rowBoxes[0].width), true);
    for (let index = 1; index < rowBoxes.length; index += 1) {
      assert.equal(Math.abs(rowBoxes[index].y - (rowBoxes[index - 1].y + rowBoxes[index - 1].height)) < 1, true);
    }
    const listBox = await page.locator(".lhc-harness-list").boundingBox();
    assert.ok(listBox);
    const lastRow = rowBoxes.at(-1);
    assert.ok(lastRow);
    const listEndDelta = (listBox.y + listBox.height) - (lastRow.y + lastRow.height);
    assert.ok(listEndDelta >= 0 && listEndDelta < 3, JSON.stringify({ listBox, rowBoxes, listEndDelta }));
    const harnessColumns = await harnessRows.evaluateAll((rows) => rows.map((row) => {
      const box = (selector) => {
        const rect = row.querySelector(selector).getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width };
      };
      return {
        identity: box(":scope > header"),
        catalog: box(".lhc-harness-catalog"),
        sessions: box(".lhc-harness-sessions"),
        actions: box(":scope > footer"),
      };
    }));
    for (const column of ["identity", "catalog", "sessions", "actions"]) {
      assert.equal(harnessColumns.every((row) => Math.abs(row[column].x - harnessColumns[0][column].x) < 1), true);
      assert.equal(harnessColumns.every((row) => Math.abs(row[column].width - harnessColumns[0][column].width) < 1), true);
    }
    assert.equal(harnessColumns.every((row) => Math.abs(row.actions.y - harnessColumns[0].actions.y - (rowBoxes[harnessColumns.indexOf(row)].y - rowBoxes[0].y)) < 1), true);
    await page.setViewportSize({ width: 880, height: 840 });
    assert.equal(
      await harnessRows.first().evaluate((row) => getComputedStyle(row).gridTemplateColumns.split(" ").length),
      3,
    );
    await page.setViewportSize({ width: 1280, height: 840 });
    await page.evaluate(() => window.routerControlTest.setCursorHarnessState("install"));
    await page.getByRole("button", { name: "Context Manager", exact: true }).click();
    await page.getByRole("button", { name: "Harness Experimental", exact: true }).click();
    await page.getByRole("button", { name: "Set up Cursor", exact: true }).click();
    const cursorProgress = page.getByRole("progressbar", { name: "Cursor setup progress" });
    await cursorProgress.waitFor();
    assert.match(await harnessRows.nth(1).innerText(), /Installing Cloudflare connector/);
    await harnessRows.nth(1).getByRole("button", { name: "Open Cursor app", exact: true }).waitFor();
    assert.equal(await cursorProgress.count(), 0);
    assert.equal(
      await page.evaluate(() => window.routerControlTest.calls().filter((call) => call.name === "connectCursor").length),
      1,
    );
    const cursorHintWrap = harnessRows.nth(1).locator(".lhc-harness-hint");
    const cursorHintTip = cursorHintWrap.locator(".lhc-harness-hint-tooltip");
    const cursorRoute = harnessRows.nth(1).getByRole("checkbox", { name: "Route Cursor through Codex Router", exact: true });
    await page.mouse.move(0, 0);
    assert.equal(await cursorHintTip.evaluate((node) => getComputedStyle(node).visibility), "hidden");
    await cursorRoute.focus();
    await cursorHintTip.waitFor({ state: "visible" });
    assert.match(await cursorHintTip.textContent(), /Custom API keys/);
    await cursorRoute.evaluate((node) => node.blur());
    await page.mouse.move(0, 0);
    await cursorHintTip.waitFor({ state: "hidden" });
    await cursorHintWrap.hover();
    await cursorHintTip.waitFor({ state: "visible" });
    await cursorRoute.click();
    await harnessRows.nth(1).getByRole("button", { name: "Set up Cursor", exact: true }).waitFor();
    assert.equal(
      await page.evaluate(() => window.routerControlTest.calls().filter((call) => call.name === "disconnectCursor").length),
      1,
    );
    await page.getByRole("button", { name: "Context Manager", exact: true }).click();
    await page.getByRole("heading", { name: "Context Manager", exact: true }).waitFor();
    assert.equal(await page.locator(".lhc-session-row").count(), 3);
    assert.deepEqual(
      await page.locator('.segmented-control[aria-label="Filter sessions by harness"] button').allTextContents(),
      ["All", "Cursor", "DeepSeek Harness", "Codex"],
    );
    await page.getByRole("button", { name: "Models", exact: true }).click();

    // The connections strip carries every account: connected providers as
    // chips, the rest behind one menu.
    const connections = page.locator(".pm-connections");
    await connections.waitFor();
    assert.match(await connections.innerText(), /3 of 8 connected/);
    assert.deepEqual(
      (await connections.locator(".pm-chip:not(.pm-chip-add)").allTextContents()).map((text) => text.trim()).sort(),
      ["DeepSeek", "OpenCode Free", "opencode Go/Zen"].sort(),
    );
    await connections.getByRole("button", { name: "Connect provider", exact: true }).click();
    const connectMenu = page.locator(".pm-connect-menu");
    await connectMenu.waitFor();
    // An anonymous endpoint is not connected until it is explicitly enabled,
    // so it belongs with the providers still waiting for a connection.
    assert.match(await connectMenu.innerText(), /Kilo Free/);
    assert.equal(await connectMenu.getByRole("menuitem").count(), 5);
    await page.keyboard.press("Escape");

    // A single-route model's thinking menu opens below its definition-list
    // cell. The menu used to be clipped by that cell's generic text-overflow
    // rule, leaving only its top edge visible.
    const selectedFamily = page.locator(".pm-family-row").filter({ hasText: "DeepSeek Chat" });
    await selectedFamily.locator(".pm-family-open").click();
    const thinkingTrigger = selectedFamily.getByRole("button", {
      name: "DeepSeek Chat DeepSeek subagent thinking effort",
    });
    await thinkingTrigger.click();
    const thinkingMenu = selectedFamily.locator(".pm-effort-menu");
    await thinkingMenu.waitFor();
    const detailsCell = selectedFamily.locator(".pm-model-details-controls");
    assert.equal(await detailsCell.evaluate((element) => getComputedStyle(element).overflow), "visible");
    const [cellBox, menuBox] = await Promise.all([detailsCell.boundingBox(), thinkingMenu.boundingBox()]);
    assert.ok(cellBox && menuBox);
    assert.ok(menuBox.y + menuBox.height > cellBox.y + cellBox.height);
    assert.equal(await page.evaluate(({ x, y }) => (
      Boolean(document.elementFromPoint(x, y)?.closest(".pm-effort-menu"))
    ), {
      x: menuBox.x + menuBox.width / 2,
      y: menuBox.y + menuBox.height - 2,
    }), true);
    await page.keyboard.press("Escape");
    await selectedFamily.locator(".pm-family-open").click();

    // A route that is only known to the registry still has to be findable, and
    // has to say which connection it is waiting for.
    const modelSearch = page.locator('input[placeholder="Search models"]');
    await modelSearch.fill("Ox Alpha");
    const oxFamily = page.locator(".pm-family-row").filter({ hasText: "Ox Alpha" });
    await oxFamily.waitFor();
    assert.match(await oxFamily.innerText(), /6 providers/);
    assert.match(await oxFamily.innerText(), /6 routes/i);
    await oxFamily.locator(".pm-family-open").click();
    assert.equal(await oxFamily.locator(".pm-route-row").count(), 6);
    assert.equal(await oxFamily.locator('.pm-route-row[data-availability="known"]').count(), 4);
    // Every row ends in the same slot: a switch you can use, or the button
    // that would make it usable.
    assert.equal(await oxFamily.getByRole("button", { name: /^Connect / }).count(), 4);
    const columns = await oxFamily.locator(".pm-route-head > span").allTextContents();
    // The fixture's opencode Go route is locally curated, so this family also
    // carries the unlabelled remove column.
    assert.deepEqual(columns, ["Account", "Context", "Input", "In picker", "Subagents", "Reasoning effort", ""]);
    await modelSearch.fill("");

    // Adding reads every connected provider's catalog at once. Only a provider
    // that is both connected and publishes a catalog is asked.
    await page.getByRole("button", { name: "Add models", exact: true }).click();
    const addDialog = page.locator(".pm-add-models");
    await addDialog.waitFor();
    await page.waitForFunction(() => window.routerControlTest.calls()
      .some((call) => call.name === "discoverProviderModels"));
    const bulkCatalogProviders = await page.evaluate(() => window.routerControlTest.calls()
      .filter((call) => call.name === "discoverProviderModels")
      .map((call) => call.args[0]));
    assert.deepEqual(bulkCatalogProviders, ["deepseek"]);

    const blockedRow = addDialog.locator(".pm-add-models-row").filter({ hasText: "blocked-preview" });
    await blockedRow.waitFor();
    assert.equal(await blockedRow.getAttribute("data-blocked"), "true");
    assert.equal(await blockedRow.locator("input[type=checkbox]").isDisabled(), true);
    assert.equal(await blockedRow.getByText("Not yet supported", { exact: true }).count(), 1);
    assert.equal(
      await blockedRow.locator(".pm-catalog-block-reason").innerText(),
      "No certified protocol route is available.",
    );

    const addableRow = addDialog.locator(".pm-add-models-row").filter({ hasText: "catalog-addable" });
    await addableRow.locator("input[type=checkbox]").check();
    await addDialog.getByRole("button", { name: "Add 1 model", exact: true }).click();
    await page.waitForFunction(() => window.routerControlTest.calls()
      .some((call) => call.name === "addProviderModels"));

    // Flipping a model must never move it. Sorting by the switch would throw
    // the row across the list at the moment the reader looks for confirmation.
    const modelNames = () => page.locator(".pm-family-main > strong").allTextContents();
    const orderBefore = await modelNames();
    assert.deepEqual(orderBefore, ["DeepSeek Chat", "Ox Alpha"]);
    const deepseekRow = page.locator(".pm-family-row").filter({ hasText: "DeepSeek Chat" });
    assert.equal((await deepseekRow.locator(".pm-family-state").innerText()).trim(), "On");
    await deepseekRow.locator('.pm-family-action input[type="checkbox"]').click();
    // Scope to the row's own state, not any "Off" inside its expanded panel.
    await deepseekRow.locator(".pm-family-state").filter({ hasText: "Off" }).waitFor();
    assert.deepEqual(await modelNames(), orderBefore);

    // Bulk switches live behind the overflow menu, off the main toolbar.
    await page.getByRole("button", { name: "More model actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Turn all on", exact: true }).click();
    await page.waitForFunction(() => window.routerControlTest.calls()
      .some((call) => call.name === "setPickerModels" && call.args[0] === true));

    const calls = await page.evaluate(() => window.routerControlTest.calls());
    assert.deepEqual(calls.find((call) => call.name === "addProviderModels")?.args, [
      "deepseek",
      ["catalog-addable"],
    ]);
    assert.equal(calls.some((call) => call.name === "setPickerModels" && call.args[0] === true), true);

    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const accountRows = page.locator(".subscription-account-row");
    await page.getByText("ChatGPT accounts", { exact: true }).waitFor();
    assert.equal(await accountRows.count(), 2, "two logged-in accounts should be visible");
    assert.equal(await accountRows.filter({ hasText: "Removed account" }).count(), 0, "revoked accounts stay hidden");
    assert.equal(await accountRows.filter({ hasText: "secondary@example.com" }).count(), 1, "secondary email should be visible");
    const readySecondary = accountRows.filter({ hasText: "Secondary account" });
    assert.equal(await readySecondary.getByRole("button", { name: "Login ChatGPT account: Secondary account", exact: true }).isDisabled(), true, "ready accounts cannot start a duplicate login");
    await page.getByRole("button", { name: "Refresh Settings", exact: true }).click();
    await readySecondary.getByText("resets in 3h 12m", { exact: false }).waitFor();
    const secondaryText = await readySecondary.innerText();
    assert.match(secondaryText, /weekly · 70% remaining · resets in 2d 4h/);
    assert.match(secondaryText, /5h · 12% remaining · resets in 3h 12m/);
    assert.equal(secondaryText.includes("NaN"), false);
    assert.match(secondaryText, /Ready/);
    assert.match(secondaryText, /Selected/);
    const primaryRow = accountRows.filter({ hasText: "primary@example.com" });
    assert.equal(await primaryRow.count(), 1, "primary email should stay visible beside its label");
    await readySecondary.getByRole("button", { name: "Rename ChatGPT account: Secondary account", exact: true }).click();
    await page.waitForFunction(() => {
      const input = document.activeElement;
      return input instanceof HTMLInputElement
        && input.getAttribute("aria-label") === "ChatGPT account label"
        && input.selectionStart === 0
        && input.selectionEnd === input.value.length
        && input.value.length > 0;
    });
    await page.getByRole("textbox", { name: "ChatGPT account label", exact: true }).fill("  Work laptop  ");
    await page.getByRole("textbox", { name: "ChatGPT account label", exact: true }).press("Enter");
    const renamed = accountRows.filter({ hasText: "Work laptop" });
    await renamed.waitFor();
    assert.match(await renamed.innerText(), /secondary@example.com/);
    assert.equal(await page.evaluate(() => window.routerControlTest.calls().some((call) => (
      call.name === "renameChatGptSubscriptionAccount"
      && call.args[0] === "active"
      && call.args[1] === "  Work laptop  "
    ))), true);
    await renamed.getByRole("button", { name: "Rename ChatGPT account: Work laptop", exact: true }).click();
    await page.getByRole("textbox", { name: "ChatGPT account label", exact: true }).fill("ChatGPT account 2");
    assert.equal(await page.locator(".dialog-panel .account-label-count").textContent(), "17/120");
    assert.ok(await page.getByRole("textbox", { name: "ChatGPT account label", exact: true }).getAttribute("aria-describedby"));
    await page.getByRole("textbox", { name: "ChatGPT account label", exact: true }).press("Enter");
    const patterned = accountRows.filter({ hasText: "secondary@example.com" });
    await patterned.getByRole("button", { name: "Selected ChatGPT account: ChatGPT account 2", exact: true }).waitFor();
    assert.match(await patterned.innerText(), /secondary@example.com/);
    await patterned.getByRole("button", { name: "Rename ChatGPT account: ChatGPT account 2", exact: true }).click();
    await page.getByRole("textbox", { name: "ChatGPT account label", exact: true }).fill("not saved");
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    assert.equal(await page.evaluate(() => window.routerControlTest.calls().some((call) => (
      call.name === "renameChatGptSubscriptionAccount" && call.args[1] === "not saved"
    ))), false);
    await patterned.getByRole("button", { name: "Rename ChatGPT account: ChatGPT account 2", exact: true }).click();
    await page.getByRole("textbox", { name: "ChatGPT account label", exact: true }).fill("   ");
    await page.getByRole("button", { name: "Save label", exact: true }).click();
    await page.waitForFunction(() => {
      const row = [...document.querySelectorAll(".subscription-account-row")]
        .find((node) => (node.textContent || "").includes("secondary@example.com"));
      const text = row?.textContent || "";
      return Boolean(row) && text.includes("ChatGPT account 1") && !text.includes("ChatGPT account 2") && !text.includes("Work laptop") && !text.includes("Secondary account");
    });
    await page.getByRole("dialog").waitFor({ state: "hidden" });

    const newLabel = page.getByRole("textbox", { name: "New ChatGPT account label", exact: true });
    const limitLive = page.locator(".subscription-account-create .account-label-limit");
    assert.equal(await limitLive.getAttribute("aria-live"), "polite");
    assert.equal(await limitLive.getAttribute("role"), "status");
    assert.equal((await limitLive.textContent())?.trim() || "", "");
    await newLabel.fill("kept");
    await newLabel.evaluate((el) => el.blur());
    await newLabel.focus();
    assert.equal(await newLabel.evaluate((el) => (
      document.activeElement === el && el.value === "kept" && el.selectionStart === el.selectionEnd
    )), true);
    await newLabel.fill("n".repeat(87));
    const belowLimit = await newLabel.evaluate((el) => {
      const ids = (el.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean);
      const counter = ids[0] ? document.getElementById(ids[0]) : null;
      return {
        ids: ids.length,
        text: counter?.textContent || "",
        label: counter?.getAttribute("aria-label") || "",
      };
    });
    assert.equal(belowLimit.ids, 1);
    assert.equal(belowLimit.text, "87/120");
    assert.equal(belowLimit.label, "87 of 120 characters");
    await newLabel.fill("n".repeat(120));
    await newLabel.press("z");
    assert.equal((await newLabel.inputValue()).length, 120);
    const atLimit = await newLabel.evaluate((el) => {
      const ids = (el.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean);
      return {
        ids: ids.length,
        count: ids[0] ? document.getElementById(ids[0])?.textContent : "",
        limit: ids[1] ? document.getElementById(ids[1])?.textContent : "",
        flagged: ids[0] ? document.getElementById(ids[0])?.getAttribute("data-at-limit") : "",
      };
    });
    assert.equal(atLimit.ids, 2);
    assert.equal(atLimit.count, "120/120");
    assert.equal(atLimit.limit, "Character limit reached.");
    assert.equal(atLimit.flagged, "true");
    assert.equal(await page.getByRole("status").filter({ hasText: "Character limit reached." }).count(), 1);
    await newLabel.fill("\u{1F44D}".repeat(130));
    assert.equal((await newLabel.inputValue()).length, 240);
    assert.equal(await newLabel.getAttribute("maxlength"), null);
    assert.equal(await page.locator(".subscription-account-create .account-label-count").textContent(), "120/120");
    await newLabel.fill("");

    const currentTitle = page.locator(".subscription-account-row").filter({ hasText: "primary@example.com" }).locator(".subscription-account-title");
    assert.equal(await currentTitle.getAttribute("title"), "Current account");
    assert.equal(await currentTitle.evaluate((el) => getComputedStyle(el).whiteSpace), "nowrap");
    assert.equal(await currentTitle.evaluate((el) => getComputedStyle(el).textOverflow), "ellipsis");
    const identityMin = await currentTitle.evaluate((el) => getComputedStyle(el.closest(".subscription-account-identity")).minWidth);
    assert.equal(identityMin, "0px");

    await page.getByRole("button", { name: "Select ChatGPT account: Current account", exact: true }).click();
    await page.waitForFunction(() => window.routerControlTest.calls()
      .some((call) => call.name === "setChatGptAccountSelection" && call.args[0] === "current"));

    // Add/remove must paint before the durable control round-trip finishes.
    const optimisticPage = await newEnglishTestPage(browser, { viewport: { width: 1280, height: 840 } });
    optimisticPage.setDefaultTimeout(10_000);
    await optimisticPage.goto(`${url}?accountMutationDelayMs=1500`, { waitUntil: "domcontentloaded" });
    await optimisticPage.getByRole("button", { name: "Settings", exact: true }).click();
    await optimisticPage.getByText("ChatGPT accounts", { exact: true }).waitFor();
    const optimisticRows = optimisticPage.locator(".subscription-account-row");
    const rowsBeforeAdd = await optimisticRows.count();
    await optimisticPage.getByRole("textbox", { name: "New ChatGPT account label" }).fill("Optimistic Work");
    const optimisticAdd = optimisticRows.filter({ hasText: "Optimistic Work" });
    const addStartedAt = Date.now();
    await optimisticPage.getByRole("button", { name: "Add account", exact: true }).click();
    await optimisticAdd.waitFor();
    assert.ok(Date.now() - addStartedAt < 1200, "add row must appear before the delayed control returns");
    assert.equal(await optimisticAdd.getAttribute("data-optimistic"), "true");
    assert.equal(await optimisticRows.count(), rowsBeforeAdd + 1, "added account appears before the control returns");
    await optimisticPage.waitForFunction(() => {
      const row = [...document.querySelectorAll(".subscription-account-row")]
        .find((node) => (node.textContent || "").includes("Optimistic Work"));
      return Boolean(row && row.getAttribute("data-optimistic") !== "true");
    });
    assert.equal(await optimisticAdd.getByText("Sign-in required", { exact: false }).count(), 1);

    await optimisticAdd.getByRole("button", { name: "Remove ChatGPT account: Optimistic Work", exact: true }).click();
    const removeStartedAt = Date.now();
    await optimisticPage.getByRole("button", { name: "Remove account", exact: true }).click();
    await optimisticAdd.waitFor({ state: "detached" });
    assert.ok(Date.now() - removeStartedAt < 1200, "removed row must disappear before the delayed control returns");
    assert.equal(
      await optimisticRows.filter({ hasText: "Optimistic Work" }).count(),
      0,
      "removed account disappears before the control returns",
    );
    await optimisticPage.waitForFunction(() => window.routerControlTest.calls()
      .some((call) => call.name === "removeChatGptSubscriptionAccount"));
    await optimisticPage.close();

    // Huge community GGUFs stay guarded, but the explicit oversized-model
    // acknowledgement must make their exact Ollama tag selectable. Otherwise
    // the catalog advertises GLM while forcing the operator to retype it.
    await page.getByRole("button", { name: "Local", exact: true }).click();
    await page.getByRole("heading", { name: "Local", exact: true }).waitFor();
    const glmFamily = page.locator(".lhc-catalog-family").filter({ hasText: "GLM-5.3-Flash" });
    await glmFamily.locator(".lhc-catalog-family-trigger").click();
    const glmRow = glmFamily.locator(".lhc-catalog-model").filter({ hasText: "UD-IQ1_S" });
    const glmSelect = glmRow.getByRole("button", { name: "Select", exact: true });
    assert.equal(await glmSelect.isDisabled(), true);
    await page.getByRole("checkbox", { name: "Allow a model larger than the router recommends for this machine" }).check();
    assert.equal(await glmSelect.isEnabled(), true);
    await glmSelect.click();
    assert.equal(
      await page.getByRole("textbox", { name: "Model tag or Ollama URL" }).inputValue(),
      "hf.co/unsloth/GLM-5.3-Flash-GGUF:UD-IQ1_S",
    );

    const cancelledLoginPage = await newEnglishTestPage(browser, { viewport: { width: 1280, height: 840 } });
    const cancelledLoginErrors = [];
    cancelledLoginPage.setDefaultTimeout(10_000);
    cancelledLoginPage.on("pageerror", (error) => cancelledLoginErrors.push(error.message));
    await cancelledLoginPage.goto(`${url}?terminalLoginFailure=1`, { waitUntil: "domcontentloaded" });
    await cancelledLoginPage.getByRole("button", { name: "Settings", exact: true }).click();
    const currentAccount = cancelledLoginPage.locator(".subscription-account-row").filter({ hasText: "Current account" });
    await currentAccount.getByRole("button", { name: "Login ChatGPT account: Current account", exact: true }).click();
    await cancelledLoginPage.getByText("ChatGPT login did not complete", { exact: true }).waitFor();
    // One refresh may already be queued when React observes the terminal
    // projection. Give that in-flight poll one interval to settle, then prove
    // the interval itself was cleared.
    await cancelledLoginPage.waitForTimeout(1_800);
    const readsAfterFailure = await cancelledLoginPage.evaluate(() => window.routerControlTest.calls()
      .filter((call) => call.name === "getChatGptAccountPool").length);
    await cancelledLoginPage.waitForTimeout(1_800);
    assert.equal(
      await cancelledLoginPage.evaluate(() => window.routerControlTest.calls()
        .filter((call) => call.name === "getChatGptAccountPool").length),
      readsAfterFailure,
      "a terminal backend login result must stop the 1.5 second renderer poll",
    );
    await currentAccount.getByRole("button", { name: "Login ChatGPT account: Current account", exact: true }).click();
    await cancelledLoginPage.waitForFunction(() => window.routerControlTest.calls()
      .filter((call) => call.name === "loginChatGptSubscriptionAccount").length === 2);
    assert.deepEqual(cancelledLoginErrors, []);
    await cancelledLoginPage.close();

    const rejectedLoginPage = await newEnglishTestPage(browser, { viewport: { width: 1280, height: 840 } });
    const rejectedLoginErrors = [];
    rejectedLoginPage.setDefaultTimeout(10_000);
    rejectedLoginPage.on("pageerror", (error) => rejectedLoginErrors.push(error.message));
    await rejectedLoginPage.goto(`${url}?terminalLoginFailure=1&rejectLoginImmediately=1`, { waitUntil: "domcontentloaded" });
    await rejectedLoginPage.getByRole("button", { name: "Settings", exact: true }).click();
    const rejectedAccount = rejectedLoginPage.locator(".subscription-account-row").filter({ hasText: "Current account" });
    const rejectedLoginButton = rejectedAccount.getByRole("button", { name: "Login ChatGPT account: Current account", exact: true });
    await rejectedLoginButton.click();
    await rejectedLoginPage.getByText("Codex login could not be launched.", { exact: true }).waitFor();
    await rejectedLoginButton.waitFor({ state: "visible" });
    assert.equal(await rejectedLoginButton.isEnabled(), true, "an immediate launch rejection must release renderer pending state");
    await rejectedLoginPage.waitForTimeout(1_800);
    const readsAfterRejection = await rejectedLoginPage.evaluate(() => window.routerControlTest.calls()
      .filter((call) => call.name === "getChatGptAccountPool").length);
    await rejectedLoginPage.waitForTimeout(1_800);
    assert.equal(
      await rejectedLoginPage.evaluate(() => window.routerControlTest.calls()
        .filter((call) => call.name === "getChatGptAccountPool").length),
      readsAfterRejection,
      "an immediate launch rejection must not leave the completion poll running",
    );
    await rejectedLoginButton.click();
    await rejectedLoginPage.waitForFunction(() => window.routerControlTest.calls()
      .filter((call) => call.name === "loginChatGptSubscriptionAccount").length === 2);
    assert.deepEqual(rejectedLoginErrors, []);
    await rejectedLoginPage.close();

    const pendingRemovalPage = await newEnglishTestPage(browser, { viewport: { width: 1280, height: 840 } });
    pendingRemovalPage.setDefaultTimeout(10_000);
    await pendingRemovalPage.goto(`${url}?loginStaysPending=1`, { waitUntil: "domcontentloaded" });
    await pendingRemovalPage.getByRole("button", { name: "Settings", exact: true }).click();
    const pendingAccount = pendingRemovalPage.locator(".subscription-account-row").filter({ hasText: "Current account" });
    await pendingAccount.getByRole("button", { name: "Login ChatGPT account: Current account", exact: true }).click();
    await pendingRemovalPage.waitForFunction(() => window.routerControlTest.calls()
      .some((call) => call.name === "loginChatGptSubscriptionAccount"));
    assert.equal(
      await pendingAccount.getByRole("button", { name: "Remove ChatGPT account: Current account", exact: true }).isDisabled(),
      true,
      "an account with a detached OAuth lifecycle must not be removable",
    );
    await pendingRemovalPage.close();

    const corruptPoolPage = await newEnglishTestPage(browser, { viewport: { width: 1280, height: 840 } });
    const corruptPoolErrors = [];
    corruptPoolPage.setDefaultTimeout(10_000);
    corruptPoolPage.on("pageerror", (error) => corruptPoolErrors.push(error.message));
    await corruptPoolPage.goto(`${url}?rejectAccountPool=1`, { waitUntil: "domcontentloaded" });
    await corruptPoolPage.getByRole("button", { name: "Settings", exact: true }).click();
    const accountFailure = corruptPoolPage.getByText("ChatGPT account state unavailable", { exact: true });
    await accountFailure.waitFor();
    assert.match(await corruptPoolPage.locator("body").innerText(), /could not be read as JSON/i);
    assert.equal(
      await corruptPoolPage.getByText("No saved ChatGPT accounts", { exact: true }).count(),
      0,
      "a corrupt protected pool must not be rendered as an empty first-run pool",
    );
    assert.equal(
      await corruptPoolPage.getByRole("button", { name: "Add account", exact: true }).isDisabled(),
      true,
    );
    assert.deepEqual(corruptPoolErrors, []);
    await corruptPoolPage.close();
    assert.deepEqual(pageErrors, [], `renderer errors: ${pageErrors.join("; ")}`);
  } finally {
    await browser.close();
    await close();
  }
});

test("ChatGPT account rows stay in the card and label edits are guarded", { timeout: 180_000 }, async () => {
  assert.ok(chromiumPath, "No Chromium executable is available for the Control Center renderer test.");
  let browser;
  let close;
  const longLabel = "Very long account label that keeps going and going and going and going and going and going and going and going";
  const artifactRoot = process.env.CODEX_ROUTER_UI_ARTIFACTS;
  const inside = (inner, outer) => inner
    && outer
    && inner.x >= outer.x - 1
    && inner.y >= outer.y - 1
    && inner.x + inner.width <= outer.x + outer.width + 1
    && inner.y + inner.height <= outer.y + outer.height + 1;
  const overlaps = (left, right) => {
    if (!left || !right) return false;
    const width = Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x);
    const height = Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y);
    return width > 1 && height > 1;
  };
  try {
    const served = await serveRenderer();
    close = served.close;
    const { url } = served;
    browser = await chromium.launch({
      executablePath: chromiumPath,
      headless: true,
      args: process.platform === "linux" ? ["--no-sandbox"] : [],
    });
    const artifactDir = artifactRoot ? path.join(artifactRoot, "chatgpt-account-rows") : "";
    if (artifactDir) mkdirSync(artifactDir, { recursive: true });
    const page = await newEnglishTestPage(browser, { viewport: { width: 1280, height: 760 } });
    page.setDefaultTimeout(10_000);
    await page.goto(`${url}?longAccountLabel=1`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const accounts = page.locator("section.panel-section").filter({
      has: page.getByRole("heading", { level: 2, name: "ChatGPT accounts", exact: true }),
    });
    const desktop = page.locator("section.panel-section").filter({
      has: page.getByRole("heading", { level: 2, name: "Desktop surfaces", exact: true }),
    });
    await accounts.waitFor();
    const sizes = [[960, 640], [1024, 700], [1280, 760], [800, 600], [640, 380]];
    for (const [width, height] of sizes) {
      await page.setViewportSize({ width, height });
      await accounts.scrollIntoViewIfNeeded();
      if (artifactDir) await page.screenshot({ path: path.join(artifactDir, `${width}x${height}.png`) });
      const accountBox = await accounts.boundingBox();
      const desktopBox = await desktop.boundingBox();
      assert.ok(accountBox, `${width}x${height} account card`);
      const controls = accounts.locator(".subscription-account-row button, .subscription-account-title");
      const count = await controls.count();
      assert.ok(count >= 8, `${width}x${height} expected row controls, saw ${count}`);
      for (let index = 0; index < count; index += 1) {
        const box = await controls.nth(index).boundingBox();
        const label = await controls.nth(index).evaluate((el) => el.getAttribute("aria-label") || el.textContent || el.className);
        assert.ok(box, `${width}x${height} missing box for ${label}`);
        assert.ok(inside(box, accountBox), `${width}x${height} ${label} extends past the account card`);
        assert.equal(overlaps(box, desktopBox), false, `${width}x${height} ${label} overlaps Desktop surfaces`);
      }
    }
    await page.setViewportSize({ width: 960, height: 640 });
    const longTitle = accounts.locator(".subscription-account-title").nth(1);
    assert.equal(await longTitle.getAttribute("title"), longLabel);
    assert.equal(await longTitle.evaluate((el) => getComputedStyle(el).textOverflow), "ellipsis");
    assert.equal(await longTitle.evaluate((el) => getComputedStyle(el).whiteSpace), "nowrap");
    assert.equal(await longTitle.evaluate((el) => el.scrollWidth > el.clientWidth), true);
    await page.close();

    const emailPage = await newEnglishTestPage(browser, { viewport: { width: 1280, height: 840 } });
    emailPage.setDefaultTimeout(10_000);
    await emailPage.goto(`${url}?duplicateEmail=1`, { waitUntil: "domcontentloaded" });
    await emailPage.getByRole("button", { name: "Settings", exact: true }).click();
    await emailPage.getByRole("button", { name: "Selected ChatGPT account: same@example.com (ChatGPT account 1)", exact: true }).waitFor();
    await emailPage.getByRole("button", { name: "Select ChatGPT account: same@example.com (ChatGPT account 2)", exact: true }).waitFor();
    await emailPage.getByRole("button", { name: "Rename ChatGPT account: same@example.com (ChatGPT account 1)", exact: true }).waitFor();
    await emailPage.getByRole("button", { name: "Login ChatGPT account: same@example.com (ChatGPT account 2)", exact: true }).waitFor();
    await emailPage.getByRole("button", { name: "Remove ChatGPT account: same@example.com (ChatGPT account 1)", exact: true }).waitFor();
    const currentEmail = emailPage.locator(".subscription-account-row").filter({ hasText: "ChatGPT account 2" });
    await currentEmail.getByRole("button", { name: "Rename ChatGPT account: same@example.com (ChatGPT account 2)", exact: true }).click();
    await emailPage.getByRole("textbox", { name: "ChatGPT account label", exact: true }).fill("ChatGPT account 1");
    const beforeCollision = await emailPage.evaluate(() => window.routerControlTest.calls()
      .filter((call) => call.name === "renameChatGptSubscriptionAccount").length);
    await emailPage.getByRole("button", { name: "Save label", exact: true }).click();
    await emailPage.getByRole("alert").filter({ hasText: "Account label matches another account." }).waitFor();
    assert.equal(await emailPage.getByRole("dialog").count(), 1);
    assert.equal(
      await emailPage.evaluate(() => window.routerControlTest.calls()
        .filter((call) => call.name === "renameChatGptSubscriptionAccount").length),
      beforeCollision,
    );
    const lookalikes = ["chatgpt account 1", "ChatGPT  account  1", "ChatGPT account \uFF11", "Chat GPT account 1", "Chat   GPT account 1"];
    for (const lookalike of lookalikes) {
      await emailPage.getByRole("textbox", { name: "ChatGPT account label", exact: true }).fill(lookalike);
      await emailPage.getByRole("button", { name: "Save label", exact: true }).click();
      await emailPage.getByRole("alert").filter({ hasText: "Account label matches another account." }).waitFor();
    }
    assert.equal(
      await emailPage.evaluate(() => window.routerControlTest.calls()
        .filter((call) => call.name === "renameChatGptSubscriptionAccount").length),
      beforeCollision,
    );
    await emailPage.close();

    const titlePage = await newEnglishTestPage(browser, { viewport: { width: 1280, height: 840 } });
    titlePage.setDefaultTimeout(10_000);
    await titlePage.goto(`${url}?duplicateTitle=1`, { waitUntil: "domcontentloaded" });
    await titlePage.getByRole("button", { name: "Settings", exact: true }).click();
    await titlePage.getByRole("button", { name: "Selected ChatGPT account: Shared inbox (1)", exact: true }).waitFor();
    await titlePage.getByRole("button", { name: "Login ChatGPT account: Shared inbox (2)", exact: true }).waitFor();
    await titlePage.getByRole("button", { name: "Remove ChatGPT account: Shared inbox (2)", exact: true }).waitFor();
    assert.equal(await titlePage.locator(".subscription-account-title").filter({ hasText: "Shared inbox" }).count(), 2);
    await titlePage.close();

    const resetPage = await newEnglishTestPage(browser, { viewport: { width: 1280, height: 840 } });
    resetPage.setDefaultTimeout(10_000);
    await resetPage.goto(`${url}?collidingReset=1`, { waitUntil: "domcontentloaded" });
    await resetPage.getByRole("button", { name: "Settings", exact: true }).click();
    const copied = resetPage.locator(".subscription-account-row").filter({ hasText: "primary@example.com" });
    await copied.getByRole("button", { name: "Rename ChatGPT account: ChatGPT account 1", exact: true }).click();
    await resetPage.getByRole("textbox", { name: "ChatGPT account label", exact: true }).fill("   ");
    await resetPage.getByRole("button", { name: "Save label", exact: true }).click();
    await resetPage.waitForFunction(() => {
      const rows = [...document.querySelectorAll(".subscription-account-row")];
      const primary = rows.find((node) => (node.textContent || "").includes("primary@example.com"));
      const secondary = rows.find((node) => (node.textContent || "").includes("secondary@example.com"));
      const primaryText = primary?.textContent || "";
      const secondaryText = secondary?.textContent || "";
      return primaryText.includes("ChatGPT account 2")
        && !primaryText.includes("ChatGPT account 1")
        && secondaryText.includes("ChatGPT account 1")
        && !secondaryText.includes("ChatGPT account 2");
    });
    await resetPage.close();

    const errorPage = await newEnglishTestPage(browser, { viewport: { width: 1280, height: 840 } });
    errorPage.setDefaultTimeout(10_000);
    await errorPage.goto(`${url}?renameFails=1`, { waitUntil: "domcontentloaded" });
    await errorPage.getByRole("button", { name: "Settings", exact: true }).click();
    await errorPage.locator(".subscription-account-row").filter({ hasText: "Secondary account" })
      .getByRole("button", { name: "Rename ChatGPT account: Secondary account", exact: true }).click();
    const kept = errorPage.getByRole("textbox", { name: "ChatGPT account label", exact: true });
    await kept.fill("Kept label");
    await errorPage.getByRole("button", { name: "Save label", exact: true }).click();
    const diskAlert = errorPage.getByRole("dialog").getByRole("alert");
    await diskAlert.filter({ hasText: "The account label could not be saved because the disk is full or the file could not be written." }).waitFor();
    assert.equal((await errorPage.getByRole("dialog").innerText()).includes("ENOSPC"), false);
    assert.equal((await errorPage.getByRole("dialog").innerText()).includes("Error invoking remote method"), false);
    assert.equal(await errorPage.getByRole("dialog").count(), 1);
    assert.equal(await kept.inputValue(), "Kept label");
    await errorPage.close();

    const oncePage = await newEnglishTestPage(browser, { viewport: { width: 1280, height: 840 } });
    oncePage.setDefaultTimeout(10_000);
    await oncePage.goto(url, { waitUntil: "domcontentloaded" });
    await oncePage.getByRole("button", { name: "Settings", exact: true }).click();
    await oncePage.locator(".subscription-account-row").filter({ hasText: "Secondary account" })
      .getByRole("button", { name: "Rename ChatGPT account: Secondary account", exact: true }).click();
    await oncePage.getByRole("textbox", { name: "ChatGPT account label", exact: true }).fill("Once");
    await oncePage.evaluate(() => {
      const form = document.querySelector(".dialog-panel form");
      for (let index = 0; index < 10; index += 1) form.requestSubmit();
    });
    await oncePage.getByRole("dialog").waitFor({ state: "hidden" });
    assert.equal(await oncePage.evaluate(() => window.routerControlTest.calls()
      .filter((call) => call.name === "renameChatGptSubscriptionAccount" && call.args[1] === "Once").length), 1);
    await oncePage.close();

    const forbiddenPage = await newEnglishTestPage(browser, { viewport: { width: 1280, height: 840 } });
    forbiddenPage.setDefaultTimeout(10_000);
    await forbiddenPage.goto(url, { waitUntil: "domcontentloaded" });
    await forbiddenPage.getByRole("button", { name: "Settings", exact: true }).click();
    await forbiddenPage.locator(".subscription-account-row").filter({ hasText: "Secondary account" })
      .getByRole("button", { name: "Rename ChatGPT account: Secondary account", exact: true }).click();
    await forbiddenPage.getByRole("textbox", { name: "ChatGPT account label", exact: true }).fill("user\u202Eexe.txt");
    const beforeForbidden = await forbiddenPage.evaluate(() => window.routerControlTest.calls()
      .filter((call) => call.name === "renameChatGptSubscriptionAccount").length);
    await forbiddenPage.getByRole("button", { name: "Save label", exact: true }).click();
    await forbiddenPage.getByRole("alert").filter({ hasText: "Account label contains characters that are not allowed." }).waitFor();
    assert.equal(await forbiddenPage.getByRole("dialog").count(), 1);
    assert.equal(
      await forbiddenPage.evaluate(() => window.routerControlTest.calls()
        .filter((call) => call.name === "renameChatGptSubscriptionAccount").length),
      beforeForbidden,
    );
    await forbiddenPage.close();

    const pendingPage = await newEnglishTestPage(browser, { viewport: { width: 1280, height: 840 } });
    pendingPage.setDefaultTimeout(10_000);
    await pendingPage.goto(`${url}?accountMutationDelayMs=800`, { waitUntil: "domcontentloaded" });
    await pendingPage.getByRole("button", { name: "Settings", exact: true }).click();
    await pendingPage.locator(".subscription-account-row").filter({ hasText: "Secondary account" })
      .getByRole("button", { name: "Rename ChatGPT account: Secondary account", exact: true }).click();
    await pendingPage.getByRole("textbox", { name: "ChatGPT account label", exact: true }).fill("Pending save");
    const saveLabel = pendingPage.getByRole("button", { name: "Save label", exact: true });
    await saveLabel.click();
    await pendingPage.waitForFunction(() => {
      const button = [...document.querySelectorAll("button")].find((element) => element.textContent?.trim() === "Saving…");
      const input = document.querySelector(".dialog-panel input");
      return button instanceof HTMLButtonElement
        && button.disabled
        && button.getAttribute("aria-busy") === "true"
        && input instanceof HTMLInputElement
        && input.readOnly;
    });
    await pendingPage.getByRole("dialog").waitFor({ state: "hidden" });
    await pendingPage.close();

    const localized = {
      en: [
        "Account label is invalid.",
        "Account label contains characters that are not allowed.",
        "Account label is limited to 120 characters.",
        "Account label matches another account.",
        "That ChatGPT account is no longer registered.",
        "The account label could not be saved because the disk is full or the file could not be written.",
        "The account label command failed.",
        "The account label could not be saved.",
        "Account label matches another account.",
        "The account label could not be saved because the disk is full or the file could not be written.",
        "That ChatGPT account is no longer registered.",
      ],
      "zh-CN": [
        "账户名称无效。",
        "账户名称包含不允许的字符。",
        "账户名称最多 120 个字符。",
        "账户名称与另一个账户重复。",
        "该账户未注册。",
        "账户名称无法保存，磁盘已满或文件无法写入。",
        "账户名称命令失败。",
        "账户名称无法保存。",
        "账户名称与另一个账户重复。",
        "账户名称无法保存，磁盘已满或文件无法写入。",
        "该账户未注册。",
      ],
      "zh-TW": [
        "帳號標籤無效。",
        "帳號標籤包含不允許的字元。",
        "帳號標籤最多 120 個字元。",
        "帳號標籤與另一個帳號重複。",
        "該帳號未註冊。",
        "帳號標籤無法儲存，磁碟已滿或檔案無法寫入。",
        "帳號標籤命令失敗。",
        "帳號標籤無法儲存。",
        "帳號標籤與另一個帳號重複。",
        "帳號標籤無法儲存，磁碟已滿或檔案無法寫入。",
        "該帳號未註冊。",
      ],
    };
    for (const [language, messages] of Object.entries(localized)) {
      const localePage = await newEnglishTestPage(browser, { viewport: { width: 1280, height: 840 } });
      localePage.setDefaultTimeout(10_000);
      await localePage.goto(`${url}?renameFails=matrix`, { waitUntil: "domcontentloaded" });
      await localePage.getByRole("button", { name: "Settings", exact: true }).click();
      if (language !== "en") {
        await localePage.getByRole("combobox", { name: "Interface language" }).selectOption(language);
      }
      const renameName = language === "zh-CN"
        ? "重命名 ChatGPT 账户：Secondary account"
        : language === "zh-TW"
          ? "重新命名 ChatGPT 帳號：Secondary account"
          : "Rename ChatGPT account: Secondary account";
      const saveName = language === "zh-CN" ? "保存名称" : language === "zh-TW" ? "儲存標籤" : "Save label";
      const fieldName = language === "zh-CN"
        ? "ChatGPT 账户名称"
        : language === "zh-TW"
          ? "ChatGPT 帳號標籤"
          : "ChatGPT account label";
      await localePage.locator(".subscription-account-row").filter({ hasText: "Secondary account" })
        .getByRole("button", { name: renameName, exact: true }).click();
      for (let index = 0; index < messages.length; index += 1) {
        const field = localePage.getByRole("textbox", { name: fieldName, exact: true });
        await field.fill(`Kept label ${index}`);
        await localePage.getByRole("button", { name: saveName, exact: true }).click();
        const alert = localePage.getByRole("dialog").getByRole("alert");
        await alert.filter({ hasText: messages[index] }).waitFor();
        assert.equal(await alert.innerText(), messages[index]);
        const dialogText = await localePage.getByRole("dialog").innerText();
        assert.equal(dialogText.includes("Error invoking remote method"), false);
        assert.equal(dialogText.includes("account-label-error"), false);
        assert.equal(dialogText.includes("raw backend text"), false);
        assert.equal(dialogText.includes("ENOSPC"), false);
        assert.equal(dialogText.includes("Account id is not registered"), false);
        assert.equal(await localePage.getByRole("dialog").count(), 1);
        assert.equal(await field.inputValue(), `Kept label ${index}`);
      }
      await localePage.close();
    }
  } finally {
    await browser?.close();
    await close?.();
  }
});

test("fallback-only splits do not claim account breakdown or a complete range mix", { timeout: 120_000 }, async () => {
  assert.equal(existsSync(path.join(dist, "index.html")), true, "npm test must build the renderer first");
  assert.ok(chromiumPath, "No Chromium executable is available for the Control Center renderer test.");

  const { url, close } = await serveRenderer();
  const browser = await chromium.launch({
    executablePath: chromiumPath,
    headless: true,
    args: process.platform === "linux" ? ["--no-sandbox"] : [],
  });
  const pageErrors = [];
  try {
    const page = await newEnglishTestPage(browser, { viewport: { width: 1280, height: 840 } });
    page.setDefaultTimeout(10_000);
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") pageErrors.push(message.text());
    });

    await page.goto(`${url}?fallbackUsage=1`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForFunction(() => window.routerControlTest.navigationReady());
    assert.equal(
      await page.evaluate(() => window.routerControlTest.navigate({ destination: "usage", sourceId: "openai" })),
      true,
    );
    await page.getByRole("heading", { name: "Usage", exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector('select[aria-label="Usage source"]')?.value === "chatgpt-subscription");
    await page.locator(".us-chart-token-bars rect.router-fallback").first().waitFor();
    await page.getByText(/1 date uses local router fallback\.$/).waitFor();
    await page.getByText(/1 date is filled from this router's local ChatGPT meter/).waitFor();
    assert.equal(
      await page.locator(".us-chart-wrap").getAttribute("aria-label"),
      "Daily account token usage with local router fallback on 1 date",
    );
    assert.doesNotMatch(await page.locator("body").innerText(), /\b1 dates\b/i);

    assert.equal(
      await page.getByText("The account API supplied the input/cache/output split for this 30-day range.", { exact: true }).count(),
      0,
    );
    await page.getByText(
      "OpenAI supplies daily account totals only here; use “This router · all providers” for regular input, cached input, and output.",
      { exact: true },
    ).waitFor();
    assert.equal(await page.locator('.us-token-mix[aria-label="Token mix for selected 30-day range"]').count(), 0);
    assert.equal(await page.locator(".us-token-mix").count(), 0);
    assert.deepEqual(pageErrors, [], `renderer errors: ${pageErrors.join("; ")}`);
  } finally {
    await browser.close();
    await close();
  }
});

test("independent control-center reads reveal each ready page region", { timeout: 120_000 }, async () => {
  assert.equal(existsSync(path.join(dist, "index.html")), true, "npm test must build the renderer first");
  assert.ok(chromiumPath, "No Chromium executable is available for the Control Center renderer test.");

  const { url, close } = await serveRenderer();
  const browser = await chromium.launch({
    executablePath: chromiumPath,
    headless: true,
    args: process.platform === "linux" ? ["--no-sandbox"] : [],
  });
  const pageErrors = [];
  try {
    const page = await newEnglishTestPage(browser, { viewport: { width: 1280, height: 840 } });
    page.setDefaultTimeout(10_000);
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") pageErrors.push(message.text());
    });

    await page.goto(`${url}?snapshotDelayMs=3000&accountDelayMs=4000`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    // Cold Chromium on Windows hosted runners can commit the first React paint
    // after DOMContentLoaded. Keep this wait under snapshotDelayMs=3000 so a
    // heading that waited for the delayed snapshot still fails.
    await page.getByRole("heading", { name: "Dashboard", exact: true }).waitFor({
      timeout: 2_500,
    });
    page.setDefaultTimeout(1_500);
    await page.locator(".service-health-strip").waitFor();
    await page.locator('.db-breakdown-list[aria-label="Providers usage breakdown"]')
      .getByText("DeepSeek", { exact: true })
      .waitFor();
    assert.equal(await page.locator(".db-breakdown-panel .panel-skeleton").count(), 0);

    await page.getByRole("button", { name: "Models", exact: true }).click();
    await page.getByRole("heading", { name: "Models", exact: true }).waitFor();
    const connections = page.locator(".pm-connections:not(.pm-connections-loading)");
    await connections.waitFor();
    assert.match(await connections.innerText(), /DeepSeek/);
    await page.locator(".pm-models-loading").waitFor();

    page.setDefaultTimeout(7_000);
    await page.locator(".pm-family-row").filter({ hasText: "DeepSeek Chat" }).waitFor();
    assert.deepEqual(pageErrors, [], `renderer errors: ${pageErrors.join("; ")}`);
  } finally {
    await browser.close();
    await close();
  }
});

test("only a locally curated route offers to be deleted, and only after confirmation", { timeout: 120_000 }, async () => {
  assert.equal(existsSync(path.join(dist, "index.html")), true, "npm test must build the renderer first");
  assert.ok(chromiumPath, "No Chromium executable is available for the Control Center renderer test.");

  const { url, close } = await serveRenderer();
  const browser = await chromium.launch({
    executablePath: chromiumPath,
    headless: true,
    args: process.platform === "linux" ? ["--no-sandbox"] : [],
  });
  const pageErrors = [];
  try {
    const page = await newEnglishTestPage(browser, { viewport: { width: 1280, height: 840 } });
    page.setDefaultTimeout(10_000);
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") pageErrors.push(message.text());
    });

    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Models", exact: true }).click();
    await page.getByRole("heading", { name: "Models", exact: true }).waitFor();

    await page.locator('input[placeholder="Search models"]').fill("Ox Alpha");
    const oxFamily = page.locator(".pm-family-row").filter({ hasText: "Ox Alpha" });
    await oxFamily.locator(".pm-family-open").click();

    // The locally curated route says so, and is the only one that can be
    // deleted: every other route here is shipped by the checkout.
    const localRoute = oxFamily.locator(".pm-route-row").filter({ hasText: "opencode Go/Zen" });
    const shippedRoute = oxFamily.locator(".pm-route-row").filter({ hasText: "OpenCode Free" });
    await localRoute.locator(".pm-route-local").waitFor();
    assert.equal(await shippedRoute.locator(".pm-route-local").count(), 0);
    assert.equal(await localRoute.locator(".pm-endpoint-model-remove").count(), 1);
    assert.equal(
      await shippedRoute.locator(".pm-endpoint-model-remove").count(),
      0,
      "a checked-in route must not offer a delete curation could not perform",
    );

    // Deleting is not undoable from here, so it is confirmed the way
    // disconnecting a provider is -- and cancelling must call nothing.
    await localRoute.locator(".pm-endpoint-model-remove").click();
    await page.getByRole("heading", { name: "Delete local model", exact: true }).waitFor();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    assert.equal(
      await page.evaluate(() => window.routerControlTest.calls().some((call) => call.name === "removeLocalModels")),
      false,
      "cancelling the dialog must not delete anything",
    );

    await localRoute.locator(".pm-endpoint-model-remove").click();
    await page.getByRole("heading", { name: "Delete local model", exact: true }).waitFor();
    await page.getByRole("button", { name: "Delete model", exact: true }).click();
    await page.waitForFunction(() => window.routerControlTest.calls().some((call) => call.name === "removeLocalModels"));
    // The router resolves the slug against the overlay, so the slug is the
    // whole request: the renderer never derives an upstream id.
    assert.deepEqual(
      await page.evaluate(() => window.routerControlTest.calls().find((call) => call.name === "removeLocalModels").args),
      [["opencode-go/ox-alpha"]],
    );

    assert.deepEqual(pageErrors, []);
  } finally {
    await browser.close();
    await close();
  }
});

test("saving a provider key shows the connection being made before it lands", { timeout: 120_000 }, async () => {
  assert.equal(existsSync(path.join(dist, "index.html")), true, "npm test must build the renderer first");
  assert.ok(chromiumPath, "No Chromium executable is available for the Control Center renderer test.");

  const { url, close } = await serveRenderer();
  const browser = await chromium.launch({
    executablePath: chromiumPath,
    headless: true,
    args: process.platform === "linux" ? ["--no-sandbox"] : [],
  });
  const pageErrors = [];
  try {
    const page = await newEnglishTestPage(browser, { viewport: { width: 1280, height: 840 } });
    page.setDefaultTimeout(10_000);
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") pageErrors.push(message.text());
    });

    // The real command writes the key, enables the provider, and republishes
    // every installed client catalog before the refreshed snapshot can report
    // the routes it unlocked. The dialog has already closed by then, so those
    // seconds are the ones the page has to account for.
    await page.goto(`${url}?customEndpoints=1&credentialDelayMs=1500`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Models", exact: true }).click();
    await page.getByRole("heading", { name: "Models", exact: true }).waitFor();
    const connections = page.locator(".pm-connections:not(.pm-connections-loading)");
    await connections.waitFor();
    const connectedCount = () => connections.locator(".pm-connections-label small").innerText();
    const countBeforeSave = await connectedCount();

    await page.locator('input[placeholder="Search models"]').fill("Ox Alpha");
    const oxFamily = page.locator(".pm-family-row").filter({ hasText: "Ox Alpha" });
    await oxFamily.locator(".pm-family-open").click();
    const openRouterRoute = oxFamily.locator(".pm-route-row").filter({ hasText: "OpenRouter" });
    await openRouterRoute.getByRole("button", { name: "Connect OpenRouter", exact: true }).click();

    await page.getByRole("heading", { name: "Connect OpenRouter", exact: true }).waitFor();
    await page.locator("#provider-credential").fill("sk-renderer-fixture");
    const savedAt = Date.now();
    await page.getByRole("button", { name: "Save credential", exact: true }).click();

    // The chip moves to where the operator will look for it and says what is
    // running, in place of the enabled dot it has not earned yet.
    const pendingChip = connections.locator('.pm-chip[data-pending="connecting"]');
    await pendingChip.waitFor();
    assert.ok(Date.now() - savedAt < 1200, "the connecting chip must appear before the delayed command returns");
    assert.match(await pendingChip.innerText(), /OpenRouter/);
    assert.match(await pendingChip.innerText(), /Connecting…/);
    assert.equal(await pendingChip.getAttribute("data-state"), "connecting");
    assert.equal(await pendingChip.getAttribute("aria-busy"), "true");
    assert.equal(await pendingChip.isDisabled(), true, "a second mutation cannot start from a chip still publishing");
    // Placement is optimistic; the count is not.
    assert.equal(await connectedCount(), countBeforeSave, "a provider still publishing is not counted as connected");

    // The route waiting on that key says the same thing, in the slot its
    // Connect button occupied, with a blank where the switch will go.
    assert.equal(await openRouterRoute.getAttribute("data-connecting"), "true");
    assert.equal(await openRouterRoute.getByRole("button", { name: "Connect OpenRouter", exact: true }).count(), 0);
    assert.equal(await openRouterRoute.locator(".pm-connecting .skeleton-block").count(), 1);
    assert.match(await openRouterRoute.locator(".pm-connecting").innerText(), /Connecting…/);
    // A route whose own provider is untouched keeps its button.
    const veniceRoute = oxFamily.locator(".pm-route-row").filter({ hasText: "Venice" });
    assert.equal(await veniceRoute.getAttribute("data-connecting"), null);
    assert.equal(await veniceRoute.getByRole("button", { name: "Connect Venice", exact: true }).count(), 1);

    await page.waitForFunction(() => window.routerControlTest.calls()
      .some((call) => call.name === "saveProviderCredential" && call.args[0] === "openrouter"));
    // The fixture leaves the provider unconfigured, so the placeholder has to
    // give way to the reconciled snapshot rather than outliving the command.
    await pendingChip.waitFor({ state: "detached" });
    await openRouterRoute.getByRole("button", { name: "Connect OpenRouter", exact: true }).waitFor();
    assert.equal(await openRouterRoute.getAttribute("data-connecting"), null);
    assert.equal(await connections.locator(".pm-chip[data-pending]").count(), 0);

    assert.deepEqual(pageErrors, [], `renderer errors: ${pageErrors.join("; ")}`);
  } finally {
    await browser.close();
    await close();
  }
});

test("usage polling surfaces current rejections, recovers, and ignores older results", { timeout: 120_000 }, async () => {
  assert.equal(existsSync(path.join(dist, "index.html")), true, "npm test must build the renderer first");
  assert.ok(chromiumPath, "No Chromium executable is available for the Control Center renderer test.");

  const { url, close } = await serveRenderer();
  const browser = await chromium.launch({
    executablePath: chromiumPath,
    headless: true,
    args: process.platform === "linux" ? ["--no-sandbox"] : [],
  });
  const pageErrors = [];
  try {
    const page = await newEnglishTestPage(browser, { viewport: { width: 1280, height: 840 } });
    page.setDefaultTimeout(10_000);
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") pageErrors.push(message.text());
    });

    await page.goto(`${url}?providerUsageDelayMs=400&staleProviderUsage=1&rejectAccountUsageRead=2&pollOnceMs=50`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await page.waitForFunction(() => {
      const reads = window.routerControlTest.usageReads();
      return reads.account >= 2 && reads.provider >= 2;
    });
    await page.getByText("Account usage poll failed", { exact: true }).waitFor();
    await page.waitForTimeout(450);
    assert.equal(
      await page.locator('.db-breakdown-list[aria-label="Providers usage breakdown"] .db-breakdown-value').innerText(),
      "24k",
    );
    await page.getByRole("button", { name: "Refresh all data", exact: true }).click();
    await page.getByText("Account usage poll failed", { exact: true }).waitFor({ state: "detached" });
    assert.deepEqual(pageErrors, [], `renderer errors: ${pageErrors.join("; ")}`);
  } finally {
    await browser.close();
    await close();
  }
});

test("an older rejected usage read cannot replace a newer success with a warning", { timeout: 120_000 }, async () => {
  assert.equal(existsSync(path.join(dist, "index.html")), true, "npm test must build the renderer first");
  assert.ok(chromiumPath, "No Chromium executable is available for the Control Center renderer test.");

  const { url, close } = await serveRenderer();
  const browser = await chromium.launch({
    executablePath: chromiumPath,
    headless: true,
    args: process.platform === "linux" ? ["--no-sandbox"] : [],
  });
  const pageErrors = [];
  try {
    const page = await newEnglishTestPage(browser, { viewport: { width: 1280, height: 840 } });
    page.setDefaultTimeout(10_000);
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") pageErrors.push(message.text());
    });

    await page.goto(`${url}?accountDelayMs=400&staleAccountFailure=1&pollOnceMs=50`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await page.waitForFunction(() => window.routerControlTest.usageReads().account >= 2);
    await page.waitForTimeout(450);
    assert.equal(await page.getByText("Account usage poll failed", { exact: true }).count(), 0);
    assert.deepEqual(pageErrors, [], `renderer errors: ${pageErrors.join("; ")}`);
  } finally {
    await browser.close();
    await close();
  }
});

test("health polling and core refresh share latest-wins ordering", { timeout: 120_000 }, async () => {
  assert.equal(existsSync(path.join(dist, "index.html")), true, "npm test must build the renderer first");
  assert.ok(chromiumPath, "No Chromium executable is available for the Control Center renderer test.");

  const { url, close } = await serveRenderer();
  const browser = await chromium.launch({
    executablePath: chromiumPath,
    headless: true,
    args: process.platform === "linux" ? ["--no-sandbox"] : [],
  });
  const pageErrors = [];
  try {
    const page = await newEnglishTestPage(browser, { viewport: { width: 1280, height: 840 } });
    page.setDefaultTimeout(10_000);
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") pageErrors.push(message.text());
    });

    await page.goto(`${url}?staleHealth=1&healthPollOnceMs=50`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await page.waitForFunction(() => window.routerControlTest.healthReads() >= 2);
    await page.waitForTimeout(450);
    assert.match(await page.locator(".service-health-strip").innerText(), /ALL CLEAR/);
    assert.match(
      await page.getByRole("listitem", { name: /^Router state:/ }).getAttribute("aria-label"),
      /version health-2/,
    );
    assert.deepEqual(pageErrors, [], `renderer errors: ${pageErrors.join("; ")}`);
  } finally {
    await browser.close();
    await close();
  }
});

for (const { language, copy } of [
  {
    "language": "zh-CN",
    "copy": {
      "settings": "设置",
      "language": "界面语言",
      "refresh": "刷新所有数据",
      "addModels": "添加模型",
      "closeDialog": "关闭对话框",
      "repair": "运行诊断修复",
      "repairTitle": "运行诊断修复？",
      "cancel": "取消",
      "search": "搜索控制中心",
      "searchInput": "搜索控制中心页面",
      "empty": "没有匹配的页面",
      "effort": "高 (high)",
      "nav": [
        "总览",
        "用量",
        "状态",
        "模型",
        "本地",
        "工具链",
        "上下文管理",
        "设置"
      ]
    }
  },
  {
    "language": "zh-TW",
    "copy": {
      "settings": "設定",
      "language": "介面語言",
      "refresh": "重新整理所有資料",
      "addModels": "加入模型",
      "closeDialog": "關閉對話框",
      "repair": "執行診斷修復",
      "repairTitle": "執行診斷修復？",
      "cancel": "取消",
      "search": "搜尋控制中心",
      "searchInput": "搜尋控制中心區段",
      "empty": "找不到符合的區段",
      "effort": "高 (high)",
      "nav": [
        "總覽",
        "用量",
        "狀態",
        "模型",
        "本機",
        "工具鏈",
        "Context 管理",
        "設定"
      ]
    }
  }
]) {
test(`${language} covers every page, dialogs, raw values, English round trips and persistence`, { timeout: 120_000 }, async () => {
  const { url, close } = await serveRenderer();
  const browser = await chromium.launch({
    executablePath: chromiumPath,
    headless: true,
    args: process.platform === "linux" ? ["--no-sandbox"] : [],
  });
  const errors = [];
  const artifacts = process.env.CODEX_ROUTER_UI_ARTIFACTS;
  if (artifacts) mkdirSync(artifacts, { recursive: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 840 }, locale: "en-US" });
    page.setDefaultTimeout(10_000);
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(url);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("combobox", { name: "Interface language" }).selectOption(language);
    await page.getByRole("heading", { level: 1, name: copy.settings }).waitFor();
    const ids = ["dashboard", "usage", "status", "models", "local", "harness", "context", "settings"];
    const names = copy.nav;
    for (const [index, id] of ids.entries()) {
      const nav = page.locator(".primary-nav button").nth(index);
      assert.match(await nav.innerText(), new RegExp(names[index]));
      await nav.click();
      await page.locator(`.page-scroll-${id} h1`).waitFor();
      assert.match(await page.locator("h1").innerText(), /[\u3400-\u9fff]/, `${id} heading should be Chinese`);
      await page.locator(".app-loading-skeleton").waitFor({ state: "detached" });
      const visibleText = await page.locator("body").innerText();
      assert.doesNotMatch(visibleText, /Rolling window|Monthly credits|Daily DIEM allowance/, `${id} has an untranslated account label`);
      assert.doesNotMatch(visibleText, /\{(?:count|name|label|title|period|hours)\}/, `${id} has an unexpanded translation`);
      assert.equal(await page.getByRole("button", { name: "Refresh all data", exact: true }).count(), 0);
      assert.equal(await page.getByRole("button", { name: copy.refresh, exact: true }).count(), 1);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `${id} overflows the window`);
      if (artifacts) {
        await page.screenshot({ path: path.join(artifacts, `${id}-${language}.png`) });
        writeFileSync(path.join(artifacts, `${id}-${language}.txt`), visibleText);
      }
    }
    await page.locator(".primary-nav button").nth(3).click();
    const family = page.locator(".pm-family-row").filter({ hasText: "DeepSeek Chat" });
    await family.locator(".pm-family-open").click();
    await family.locator(".pm-effort-trigger").click();
    await family.getByRole("menuitemradio", { name: copy.effort, exact: true }).click();
    await page.waitForFunction(() => window.routerControlTest.calls().some(call => call.name === "setSubagentEffort" && call.args[1] === "high"));
    await page.getByRole("button", { name: copy.addModels, exact: true }).click();
    const addDialog = page.getByRole("dialog", { name: copy.addModels, exact: true });
    await addDialog.waitFor();
    await addDialog.getByRole("button", { name: copy.closeDialog, exact: true }).click();
    await page.locator(".primary-nav button").nth(7).click();
    await page.getByRole("button", { name: copy.repair, exact: true }).click();
    await page.getByRole("dialog", { name: copy.repairTitle, exact: true }).waitFor();
    await page.getByRole("button", { name: copy.cancel, exact: true }).click();
    assert.equal(await page.evaluate(() => window.routerControlTest.calls().filter(call => call.name === "repairInstall").length), 0, "canceling the localized dialog must not perform maintenance");
    await page.getByRole("button", { name: copy.search, exact: true }).click();
    const search = page.getByRole("searchbox", { name: copy.searchInput });
    await search.fill("模型");
    await page.getByRole("dialog", { name: copy.search }).getByRole("option", { name: /模型/ }).first().waitFor();
    await search.fill("不存在的页面xyz");
    await page.getByText(copy.empty, { exact: true }).waitFor();
    await search.press("Escape");
    await page.getByRole("combobox", { name: copy.language }).selectOption("en");
    await page.getByRole("heading", { level: 1, name: "Settings" }).waitFor();
    await page.getByText("Router online", { exact: true }).waitFor();
    await page.getByRole("combobox", { name: "Interface language" }).selectOption(language);
    await page.reload();
    await page.getByRole("heading", { level: 1, name: copy.settings }).waitFor();
    assert.equal(await page.locator("html").getAttribute("lang"), language);
    assert.equal(await page.getByRole("combobox", { name: copy.language }).inputValue(), language);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await close();
  }
});

}


async function captureIntegrationView(page, name) {
  const artifacts = process.env.CODEX_ROUTER_UI_ARTIFACTS;
  if (!artifacts) return;
  mkdirSync(artifacts, { recursive: true });
  // Test data only; credential fields are empty at the capture sites.
  await page.screenshot({ path: path.join(artifacts, `${name}.png`) });
}

// Independent expectations for the newly merged Usage and custom-endpoint
// surfaces. Use the actual compiled renderer; the bridge is the only mock.
for (const [language, copy] of [
  ["en", {
    addTitle: "Add custom endpoint", saveChoose: "Save and choose models", cancel: "Cancel",
    namedTitle: "Add a model by name", addModel: "Add model", edit: "Edit endpoint", save: "Save changes",
    remove: "Remove endpoint", removeModel: "Remove this model", noModels: "No models added yet.",
    disconnectTitle: "Disconnect provider", disconnect: "Disconnect", addModels: "Add models",
    closeDialog: "Close dialog", selected: "Selected · DeepSeek", others: "Other connected accounts",
    noHit: "hit rate not reported", key: "API key",
  }],
  ["zh-CN", {
    addTitle: "添加自定义接口", saveChoose: "保存并选择模型", cancel: "取消",
    namedTitle: "按名称添加模型", addModel: "添加模型", edit: "编辑接口", save: "保存更改",
    remove: "移除接口", removeModel: "移除此模型", noModels: "尚未添加模型。",
    disconnectTitle: "断开服务商", disconnect: "断开连接", addModels: "添加模型",
    closeDialog: "关闭对话框", selected: "已选择 · DeepSeek", others: "其他已连接账户",
    noHit: "未报告缓存命中率", key: "API 密钥",
  }],
  ["zh-TW", {
    addTitle: "新增自訂端點", saveChoose: "儲存並選擇模型", cancel: "取消",
    namedTitle: "依名稱新增模型", addModel: "新增模型", edit: "編輯端點", save: "儲存變更",
    remove: "移除端點", removeModel: "移除此模型", noModels: "尚未新增模型。",
    disconnectTitle: "中斷供應商連線", disconnect: "中斷連線", addModels: "加入模型",
    closeDialog: "關閉對話框", selected: "已選取 · DeepSeek", others: "其他已連線帳戶",
    noHit: "未回報快取命中率", key: "API 金鑰",
  }],
]) {
  test(`${language} custom endpoint dialogs retain raw values and support add/edit/remove`, { timeout: 90_000 }, async () => {
    const { url, close } = await serveRenderer();
    const browser = await chromium.launch({ executablePath: chromiumPath, headless: true, args: process.platform === "linux" ? ["--no-sandbox"] : [] });
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: "en-US" });
      page.setDefaultTimeout(10_000);
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.addInitScript((locale) => localStorage.setItem("codex-router-language", locale), language);
      await page.goto(url + "?customEndpoints=1");
      await page.locator(".primary-nav button").nth(3).click();
      const openAdd = async () => {
        await page.locator(".pm-chip-add").click();
        await page.getByRole("menuitem").filter({ hasText: "Custom" }).click();
        await page.getByRole("dialog", { name: copy.addTitle, exact: true }).waitFor();
      };
      await openAdd();
      await page.getByRole("dialog", { name: copy.addTitle, exact: true }).getByRole("button", { name: copy.cancel, exact: true }).click();
      assert.equal(await page.evaluate(() => window.routerControlTest.calls().filter((c) => c.name === "addCustomEndpoint").length), 0);
      await openAdd();
      const dialog = page.getByRole("dialog", { name: copy.addTitle, exact: true });
      const name = "Fixture {count}";
      const address = "https://api.example.test/v1";
      await dialog.locator("#custom-endpoint-name").fill(name);
      await dialog.locator("#custom-endpoint-url").fill("not a URL");
      assert.equal(await dialog.getByRole("button", { name: copy.saveChoose, exact: true }).isDisabled(), true);
      await dialog.locator("#custom-endpoint-url").fill(address);
      await dialog.locator("#custom-endpoint-adapter").selectOption("openai-responses");
      await captureIntegrationView(page, `custom-endpoint-add-${language}`);
      await dialog.getByLabel(copy.key, { exact: true }).fill("test-only-not-a-real-key");
      await dialog.getByRole("button", { name: copy.saveChoose, exact: true }).click();
      await page.waitForFunction(() => window.routerControlTest.calls().some((c) => c.name === "addCustomEndpoint"));
      assert.deepEqual(await page.evaluate(() => window.routerControlTest.calls().find((c) => c.name === "addCustomEndpoint").args), [{
        displayName: name, baseUrl: address, adapter: "openai-responses", credential: "test-only-not-a-real-key",
      }]);
      const notice = page.getByRole("dialog").filter({ hasText: "provider/401 raw_diagnostic" });
      await notice.waitFor();
      assert.match(await notice.innerText(), /Fixture \{count\}/);
      assert.doesNotMatch(await notice.innerText(), /test-only-not-a-real-key/);
      await captureIntegrationView(page, `custom-endpoint-diagnostic-${language}`);
      await notice.getByRole("button", { name: copy.namedTitle, exact: true }).click();
      const named = page.getByRole("dialog", { name: copy.namedTitle, exact: true });
      const modelId = "vendor/model-{count}";
      await named.locator("#named-model-id").fill(modelId);
      await named.getByRole("button", { name: copy.addModel, exact: true }).click();
      await page.waitForFunction(() => window.routerControlTest.calls().some((c) => c.name === "addCustomEndpointModel"));
      assert.deepEqual(await page.evaluate(() => window.routerControlTest.calls().find((c) => c.name === "addCustomEndpointModel").args), ["user_fixture", modelId]);
      const openEndpoint = async () => {
        await page.locator(".pm-chip").filter({ hasText: "Custom" }).click();
        await page.locator(".pm-endpoint-list button").filter({ hasText: name }).click();
        await page.getByRole("button", { name: copy.edit, exact: true }).waitFor();
      };
      await openEndpoint();
      await page.getByRole("button", { name: copy.edit, exact: true }).click();
      const editing = page.getByRole("dialog").filter({ has: page.locator("#custom-endpoint-name") });
      // React populates the edit form in an effect after the dialog opens.
      // Wait for that observable state, not a fixed delay or mere DOM presence.
      await page.waitForFunction((expected) => document.querySelector("#custom-endpoint-name")?.value === expected, name);
      assert.equal(await editing.locator("#custom-endpoint-name").inputValue(), name);
      assert.equal(await editing.locator("#custom-endpoint-key").inputValue(), "", "stored credentials must not be rendered back");
      await captureIntegrationView(page, `custom-endpoint-edit-${language}`);
      await editing.locator("#custom-endpoint-url").fill("https://new.example.test/v1");
      await editing.getByRole("button", { name: copy.save, exact: true }).click();
      await page.waitForFunction(() => window.routerControlTest.calls().some((c) => c.name === "editCustomEndpoint"));
      const editArgs = await page.evaluate(() => window.routerControlTest.calls().find((c) => c.name === "editCustomEndpoint").args);
      assert.deepEqual(editArgs, ["user_fixture", { displayName: name, baseUrl: "https://new.example.test/v1", adapter: "openai-responses" }]);
      assert.equal(await page.evaluate(() => window.routerControlTest.calls().filter((c) => c.name === "saveProviderCredential").length), 0, "empty key keeps the stored credential");
      await openEndpoint();
      await page.locator(".pm-connection-menu").getByRole("button", { name: copy.addModels, exact: true }).click();
      const catalogDialog = page.getByRole("dialog", { name: copy.addModels, exact: true });
      await catalogDialog.waitFor();
      await page.waitForFunction((expected) => document.querySelector(".pm-add-models-toolbar input")?.value === expected, name);
      assert.equal(await catalogDialog.locator(".pm-add-models-toolbar input").inputValue(), name);
      await catalogDialog.getByRole("button", { name: copy.closeDialog, exact: true }).click();
      await openEndpoint();
      await page.getByTitle(copy.removeModel, { exact: true }).click();
      await page.waitForFunction(() => window.routerControlTest.calls().some((c) => c.name === "removeCustomEndpointModels"));
      assert.deepEqual(await page.evaluate(() => window.routerControlTest.calls().find((c) => c.name === "removeCustomEndpointModels").args), ["user_fixture", ["user_fixture/" + modelId]]);
      await page.getByText(copy.noModels, { exact: true }).waitFor();
      await page.getByRole("button", { name: copy.remove, exact: true }).click();
      const removal = page.getByRole("dialog", { name: copy.disconnectTitle, exact: true });
      await removal.getByRole("button", { name: copy.cancel, exact: true }).click();
      assert.equal(await page.evaluate(() => window.routerControlTest.calls().filter((c) => c.name === "removeProviderCredential").length), 0);
      // Cancel dismisses the provider popover through its outside-pointer guard.
      await openEndpoint();
      await page.getByRole("button", { name: copy.remove, exact: true }).click();
      await removal.getByRole("button", { name: copy.disconnect, exact: true }).click();
      await page.waitForFunction(() => window.routerControlTest.calls().some((c) => c.name === "removeProviderCredential"));
      assert.deepEqual(await page.evaluate(() => window.routerControlTest.calls().find((c) => c.name === "removeProviderCredential").args), ["user_fixture"]);
      assert.deepEqual(errors, []);
    } finally { await browser.close(); await close(); }
  });

  test(`${language} Usage keeps selected accounts and missing versus zero cache telemetry`, { timeout: 60_000 }, async () => {
    const { url, close } = await serveRenderer();
    const browser = await chromium.launch({ executablePath: chromiumPath, headless: true, args: process.platform === "linux" ? ["--no-sandbox"] : [] });
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      page.setDefaultTimeout(10_000);
      await page.addInitScript((locale) => localStorage.setItem("codex-router-language", locale), language);
      await page.goto(url);
      await page.locator(".primary-nav button").nth(1).click();
      const select = page.locator(".us-source-select select");
      await select.selectOption("provider:deepseek");
      await page.getByText(copy.selected, { exact: true }).waitFor();
      await page.getByText(copy.others, { exact: true }).waitFor();
      if (language !== "en") {
        const axis = await page.locator(".us-chart-caption").innerText();
        assert.doesNotMatch(axis, /Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec/);
        assert.match(axis, /月|\d+\/\d+/);
      }
      await page.getByText("2.5k (25%)", { exact: true }).waitFor();
      // A present string can still be invisible behind CSS text-overflow.
      // Verify that both the counter and rate fit at supported window sizes.
      for (const width of [960, 1280, 1600]) {
        await page.setViewportSize({ width, height: 900 });
        const box = await page.locator(".us-summary-grid .tone-cached dd").evaluate((element) => ({
          width: element.clientWidth, contentWidth: element.scrollWidth,
          height: element.clientHeight, contentHeight: element.scrollHeight,
        }));
        assert.equal(box.contentWidth <= box.width + 1 && box.contentHeight <= box.height + 1,
          true, `${language} cache hit rate is clipped at ${width}px: ${JSON.stringify(box)}`);
        const columns = await page.locator(".us-summary-grid").evaluate((element) =>
          getComputedStyle(element).gridTemplateColumns.split(/\s+/).length);
        assert.equal(columns, width <= 1120 ? 3 : 7, "summary variants must obey the responsive breakpoint");
        if (width === 960) await captureIntegrationView(page, `usage-narrow-${language}`);
      }
      await page.setViewportSize({ width: 1280, height: 900 });
      await captureIntegrationView(page, `usage-account-groups-${language}`);
      await select.selectOption("provider:venice");
      await page.getByText(copy.noHit, { exact: false }).waitFor();
      assert.doesNotMatch(await page.locator(".us-summary-grid").innerText(), /\(0%\)/);
      await page.goto(url + "?coldCache=1");
      await page.locator(".primary-nav button").nth(1).click();
      await page.locator(".us-source-select select").selectOption("provider:deepseek");
      await page.getByText("0 (0%)", { exact: true }).waitFor();
      assert.equal(await page.getByText(copy.noHit, { exact: false }).count(), 0);
    } finally { await browser.close(); await close(); }
  });
}

// The armed timeout is the sooner minute boundary, which stays inside one
// minute. 90s hidden is past the fixture's 45s pad, so 3h 12m becomes 3h 11m.
const ACCOUNT_RESET_HIDDEN_MS = 90_000;

test("settings reset countdowns tick while visible and stop when hidden or left", { timeout: 120_000 }, async () => {
  assert.equal(existsSync(path.join(dist, "index.html")), true, "npm test must build the renderer first");
  assert.ok(chromiumPath, "No Chromium executable is available for the Control Center renderer test.");
  const { url, close } = await serveRenderer();
  const browser = await chromium.launch({
    executablePath: chromiumPath,
    headless: true,
    args: process.platform === "linux" ? ["--no-sandbox"] : [],
  });
  const pageErrors = [];
  try {
    const page = await newEnglishTestPage(browser, { viewport: { width: 1280, height: 840 } });
    page.setDefaultTimeout(10_000);
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.clock.install();
    await page.addInitScript(() => {
      const nativeSet = window.setTimeout.bind(window);
      const nativeClear = window.clearTimeout.bind(window);
      const ids = new Map();
      window.setTimeout = (callback, delay, ...args) => {
        const id = nativeSet(callback, delay, ...args);
        if (typeof delay === "number" && delay >= 1 && delay <= 60_000) ids.set(id, delay);
        return id;
      };
      window.clearTimeout = (id) => {
        ids.delete(id);
        return nativeClear(id);
      };
      window.__accountResetTimers = () => ids.size;
      window.__accountResetDelay = () => (ids.size === 1 ? [...ids.values()][0] : null);
    });
    await page.goto(`${url}?healthPollOnceMs=86400000`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const secondary = page.locator(".subscription-account-row").filter({ hasText: "Secondary account" });
    await secondary.getByText("resets in 3h 12m", { exact: false }).waitFor();
    const initialDelay = await page.evaluate(() => window.__accountResetDelay());
    assert.equal(await page.evaluate(() => window.__accountResetTimers()), 1, "settings should arm one reset tick");
    assert.ok(initialDelay >= 1 && initialDelay <= 60_000, `the tick is the next minute boundary, got ${initialDelay}`);

    await page.evaluate(() => {
      const state = { value: "visible" };
      const prototype = Document.prototype;
      Object.defineProperty(prototype, "visibilityState", {
        configurable: true,
        get() { return state.value; },
      });
      Object.defineProperty(prototype, "hidden", {
        configurable: true,
        get() { return state.value === "hidden"; },
      });
      document.__resetVisibility = state;
      window.__setResetVisibility = (value) => {
        state.value = value;
        document.dispatchEvent(new Event("visibilitychange"));
      };
    });
    await page.evaluate(() => window.__setResetVisibility("hidden"));
    assert.equal(await page.evaluate(() => window.__accountResetTimers()), 0, "hiding the document clears the tick");
    await page.clock.fastForward(ACCOUNT_RESET_HIDDEN_MS);
    assert.match(await secondary.innerText(), /resets in 3h 12m/);
    assert.doesNotMatch(await secondary.innerText(), /resets in 3h 11m/);

    await page.evaluate(() => window.__setResetVisibility("visible"));
    await secondary.getByText("resets in 3h 11m", { exact: false }).waitFor();
    const shownDelay = await page.evaluate(() => window.__accountResetDelay());
    assert.equal(await page.evaluate(() => window.__accountResetTimers()), 1, "showing the document arms the tick again");
    assert.ok(shownDelay >= 1 && shownDelay <= 60_000, `the tick stays on a minute boundary, got ${shownDelay}`);
    await page.locator(".primary-nav button").nth(0).click();
    await page.locator(".page-scroll-dashboard h1").waitFor();
    assert.equal(await page.evaluate(() => window.__accountResetTimers()), 0, "leaving settings clears the tick");
    assert.deepEqual(pageErrors, [], `renderer errors: ${pageErrors.join("; ")}`);
  } finally {
    await browser.close();
    await close();
  }
});
