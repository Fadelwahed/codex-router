# ChatGPT native account switching

Codex Router keeps each ChatGPT login in its own isolated profile. The feature is deliberately switch-only: selecting an account changes the native Codex login for the next restart. It does not run automatic quota or round-robin routing.

## Select an account

Choose a saved account from the account list in Control Center. The selected login remains saved under its own account profile. If Codex is open, the change is queued and applied after Codex closes; the previous login is never deleted or overwritten as another account.

## Account data and catalog

Each account keeps its own native model catalog and routed model overlay. Switching restores that account's catalog, so models unavailable to one ChatGPT plan are not shown as available under another plan. External provider credentials and subagent routes are preserved.

## Usage

Control Center reads usage from up to eight saved, usable accounts' isolated `CODEX_HOME` directories, prioritizing the selected account. It shows the weekly window when OpenAI reports one, otherwise the monthly window. A second window of a different duration is shown beside that line, including the plan type when the probe returned one. Each shown window includes a compact relative reset time when Codex reported a future `resetsAt` (for example, “resets in 2d 4h”). A missing or past reset time is omitted. A short window is not treated as exhaustion and does not change the selected account. Returning to another account reloads that account's quota and reset time.

## Token refresh

Authenticated account profiles are checked for near-expiry access tokens. When a token is close to expiry, Codex Router runs the official Codex login-status refresh against that account's isolated `CODEX_HOME`, with a retry interval and no credential output. Refreshing one account does not replace another account's profile.

## Safety

The switch waits for the desktop Codex process to close and fails closed when process detection is unavailable. Profile copies reject symlinks, bind a saved account to the verified ChatGPT identity, use atomic private-file replacement, and restore the previous profile and catalog if a refresh fails. Concurrent switches are serialized.
