---
title: "ChatGPT account modes"
description: "How the router treats each ChatGPT account mode."
---
Codex Router keeps each ChatGPT login in its own isolated profile. The feature is deliberately switch-only: selecting an account changes the native Codex login for the next restart. It does not run automatic quota or round-robin routing.

# Select an account

Choose a saved account from the account list in Control Center. The selected login remains saved under its own account profile. If Codex is open, the change is queued and applied after Codex closes; the previous login is never deleted or overwritten as another account.

# Account data and catalog

Each account keeps its own native model catalog and routed model overlay. Switching restores that account's catalog, so models unavailable to one ChatGPT plan are not shown as available under another plan. External provider credentials and subagent routes are preserved.

# Usage

Control Center reads usage from up to eight saved, usable accounts' isolated `CODEX_HOME` directories, prioritizing the selected account. An exact seven-day window is the primary line when OpenAI reports one; otherwise a window of at least seven and under twenty-eight days, otherwise the monthly window. A window of a different duration is shown beside that line and is not folded into the weekly line: ten days is labeled `10d`, not weekly. The plan type is shown when the probe returns a non-empty name; surrounding whitespace is ignored. Each shown window includes a compact relative reset time when Codex reported a future `resetsAt` (for example, “resets in 2d 4h”). At day scale the label uses days and hours. Leftover minutes round to the nearest hour, so 2 days 30 minutes reads “resets in 2d 1h”, and a remainder under 30 minutes with no hour reads “resets in 2d 0h”. An exact number of days stays “resets in 2d”. A missing, non-finite, negative, or past reset time is omitted when the probe is read. A short window is not treated as exhaustion and does not change the selected account. Returning to another account reloads that account's quota and reset time.

A saved account can be given a display label so two rows with the same email can be told apart. The label is stored on the existing account record and does not change the account id or login. A label the operator sets is shown even when it matches the generated “ChatGPT account N” pattern; an untouched generated label still yields the email as the row title. Clearing a custom label restores a unique generated name, including when the typed name copied another account's generated label. A typed name that matches a generated label after case, spacing, full-width digits, a space in “Chat GPT”, and invisible characters are folded together is refused. A new label cannot contain those invisible characters unless a joiner is part of an emoji. Labels already stored with control or bidi characters are shown without those characters, and duplicate generated names already on disk are shown as unique names; reading the pool does not rewrite the file. The email stays visible beside a custom label. Enter in the rename field saves it, and Escape cancels.

# Token refresh

Authenticated account profiles are checked for near-expiry access tokens. When a token is close to expiry, Codex Router runs the official Codex login-status refresh against that account's isolated `CODEX_HOME`, with a retry interval and no credential output. Refreshing one account does not replace another account's profile.

# Safety

The switch waits for the desktop Codex process to close and fails closed when process detection is unavailable. Profile copies reject symlinks, bind a saved account to the verified ChatGPT identity, use atomic private-file replacement, and restore the previous profile and catalog if a refresh fails. Concurrent switches are serialized.
