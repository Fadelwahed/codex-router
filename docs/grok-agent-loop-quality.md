# Grok agent-loop quality verification

Baseline: `8c5c128867d3b9f1bd359b9e9491d94cd65b90e1` (upstream main,
2026-10-16). All experiments use synthetic fixtures and isolated loopback
forwarders. The installed service and client configuration are unchanged.

## Final implementation and acceptance boundary

Grok 4.6/4.7 receive typed patches and a whole-line `replace_lines` facade.
The client's native executor retains filesystem ownership, permissions and
matching rules. The optional patch hook receives raw replacement arguments so
exact-match/create-only validation happens before patch execution.

The Grok schema adapter preserves complete alternatives. Proven disjoint root
operation variants become separate descriptive provider functions. Their full
constraints and root definitions remain intact; unsupported schemas stay
unchanged. The forwarder restores original client names and arguments and maps
historical calls back to the appropriate provider operation. Call IDs and
encrypted reasoning carry are preserved. Explicit caller tool choice, reserved
search names, duplicate definitions, name collisions and tool limits retain
regression coverage.

After a tool result, the provider may call another client tool or finish with
native text. A private final tool remains optional. Forcing `required` here was
removed after live traces showed prolonged text generation instead of a tool
call. A successful nonempty native final takes one generation. Only an empty
successful response may be repaired once; failed, incomplete, canceled or
truncated attempts never release held actions. A successful terminal establishes
protocol completion, not proof that the model fulfilled the user's task.

Caller sampling values are preserved, with temperature 0.7/top-p 0.95 defaults
matching [xAI guidance](https://docs.x.ai/developers/model-capabilities/text/best-practices)
and the inspected official Grok CLI.
Caller output budgets reach the Responses API; `max_output_tokens` limits visible
text, not reasoning or function arguments. No production timeout was shortened
and no generic repeat-count breaker or retry-until-success loop was introduced.

## Measurement method

Live runs use Grok 4.7 OAuth at medium effort with service tier omitted. They
exercise the actual Chat adapter and synthetic client tool loop; the original
edit campaign also uses the stock Codex patch executor. They bypass the Router
HTTP listener and LiteLLM. Separate deterministic full-hop checks cover Router →
locked LiteLLM → forwarder over HTTP JSON, SSE and WebSocket. Neither is a desktop
UI acceptance test or a matched Grok Build comparison.

Success requires the requested state transition with all unrelated fields
preserved, exactly one update, and a nonempty final answer. The arithmetic final
fixture requires just `42` (optional punctuation). Every started run, failure,
interruption and exclusion is retained. Missing telemetry remains missing.
Small synthetic samples cannot establish universal loop freedom or general speed.

## Original comparison: editing and schema correctness

[Original campaign](grok-agent-loop-quality-results.json) retains all 18 planned
slots: three fixtures × three repetitions × main/candidate, alternating arms.
The user authorized 120 generations/20 minutes including schema probes.
Each task allowed six client turns/twelve generations and a 90-second request
limit. These were experiment limits, not production timeout settings.

Edit runs 1 and 2 had a broken benchmark verifier import and are excluded from
quality denominators; both edited the file but subsequent behavior is
uninterpretable. Baseline run 5 was interrupted during that harness correction
and charged the entire 12-generation allowance. No excluded run was silently
rerun. Unaffected failed runs remain in the denominators.

| Fixture | Main | Then-current candidate | Requests per eligible run |
| --- | --- | --- | --- |
| Edit repeated context and verify | 2/2 | 2/2 | 5 vs 4 |
| Recover invalid id, then update | 0/3 | 0/3 | 6 vs 6 (limit) |
| Two sequential tools, then final | 2/2 | 2/3 | 4 vs 3 |

Recovery generated 14 invalid calls on main and zero on the candidate, but valid
reads/updates still repeated. Overall success was 4/7 vs 4/8 eligible tasks:
schema correctness improved, aggregate task success did not. Eligible edit times
were 11.193/36.132 seconds vs 10.432/8.183; this sample does not support a general
latency claim. Neither eligible arm rejected a native patch.

Usage was 83 known requests + at most 12 interrupted requests + six schema
probes. [Schema evidence](grok-schema-probes.json) also records 414 independent
validator comparisons. A separately approved three-run
[final check](grok-final-validation.json) completed 2/3 in one generation
(4.843/2.103 seconds); the other reached its 90-second harness deadline. The old
observer did not robustly decode every SSE shape, so a missing terminal in that
report cannot alone identify the upstream failure. Total usage was at most
104/120. These historical results are not retroactively credited to later code.

## Follow-up diagnosis: 60 generations

[All 19 follow-up runs](grok-loop-followup-results.json) consumed the separately
authorized 60-generation/30-minute budget. The report contains several explicitly
named stages, not one homogeneous candidate. No failing run was removed.

| Stage | Runs | Observation |
| --- | --- | --- |
| Diagnose current/auto/no-reasoning-carry | 1–6 | Normal recovery sometimes completed; disabling carry looped. One final had 967 text deltas before a transport error at 45.503 seconds. |
| Test repeated-result advisory with forced final | 7–15 | Five of six recovery cases completed; one still looped. A final generated 4,885 text deltas over 301.613 seconds before the client fetch failed. |
| Native final with advisory and sampling defaults | 16–19 | Both seeded repeat cases still looped. One arithmetic final passed, one violated the strict answer-format oracle. |

The advisory did not reliably resolve repetition and was removed. Structural
operation lowering was implemented afterward. The long final traces expose
continued provider text generation behind a forced function choice, rather than
a silent local deadlock; they do not prove every historical timeout has that
cause. The forwarder now accepts successful native text without a second
completion generation. Its transport/cancellation contracts remain covered by
fault tests.

The new observer uses the production SSE decoder for CRLF/LF, multiline data and
EOF, records timing/event kinds/terminal/usage, and seals the first terminal.
It stores no raw reasoning or argument text. Diagnostic run 4's source snapshot
was taken after a source edit while its child process still had the prior code
loaded; that run is diagnostic only, not exact-revision acceptance. Final
acceptance records source immutability per run.

## Structural correction acceptance

The user separately authorized six tasks, at most 30 generations and 20 minutes:
two normal invalid-id recoveries, two seeded three-read loops, and two arithmetic
finals. Each uses the frozen final source, six client turns and a 180-second
request deadline. Results: [acceptance telemetry](grok-loop-acceptance-results.json).

All **6/6 tasks passed**, using **13/30 provider generations**. All 13 upstream
responses completed successfully; every recorded source snapshot remained
unchanged. No generated call failed schema validation, no task hit its client
turn limit, and no request timed out.

| Fixture | Success | Requests per task | Task elapsed time |
| --- | --- | --- | --- |
| Invalid-id recovery | 2/2 | 3 / 3 | 58.800 / 11.176 seconds |
| Seeded three-read loop | 2/2 | 2 / 3 | 6.465 / 5.886 seconds |
| Arithmetic post-tool final | 2/2 | 1 / 1 | 1.747 / 4.506 seconds |

Both seeded loops selected the update immediately; one then read back the state
before finishing. Every recovery task performed exactly one update and preserved
all other fields. The first request received headers in 1.425 seconds but its
first decoded event only at 50.128 seconds and completed at 52.465 seconds.
Latency variability remains; the local full test suite was running concurrently,
so these wall times are not an isolated performance benchmark. These observations support
fixture-level loop recovery and single-generation completion, not a universal
speedup or elimination of all upstream stalls.

The original main recovery result was 0/3; the final candidate recovery result
is 4/4 including seeded loops. These were separate sequential campaigns, not a
new randomized paired comparison. Earlier 0/3 results and failed advisory runs
remain published alongside the final result.

## Regression verification

- `npm run check`: passed (syntax, seven app definitions, 101 changelog fragments).
- Full local suite before the last test-fixture correction: 5,440 tests,
  5,400 passed, one failed, 39 skipped. The sole failure expected text to
  trigger recovery; it now uses an empty successful answer, preserving the
  selected-attempt reasoning assertion. Its module then passed 5/5.
- Combined final schema/forwarder/turn/carry/observer contracts: **276/276 passed**.
- Real stock Codex patch parser: **18/18 scenarios passed**.
- Router → locked LiteLLM → forwarder: **24/24 scenarios passed**, including
  tool alternatives, sampling/output budget preservation, and one-generation
  completion over HTTP JSON, SSE and WebSocket.
- Final live acceptance: **6/6 passed**, 13 generations, source unchanged.

The PR's checks and description record the subsequent full-suite/CI outcome for
its exact head. The earlier full-suite failure above remains visible rather
than being rewritten as an all-green initial run.

Reproduce the local boundary proofs with:

```sh
npm run check
npm test
node scripts/verify-grok-structured-patch-codec.mjs /absolute/path/to/codex
node scripts/verify-grok-service-tier.mjs /absolute/path/to/locked-venv/python
```

Live scripts require `--live --yes` and a separately authorized budget. Optional
AJV is version checked, not installed automatically. The acceptance command is
`node scripts/verify-grok-loop-followup.mjs --mode=final --acceptance --live --yes`.
An existing exhausted report cannot silently reset its budget.

Full-suite investigation also repaired test fixtures: Antigravity slow-body tests
now wait for observed body-read startup; overlay cancellation waits until its
process owner is ready; app-server tests distinguish authenticated startup
prewarm sockets from the one generation request; auto-review fixture imports its
path-dependent module after setting isolated state. These are fixture corrections,
not changes to those production providers or cancellation implementations.

Source digests are represented as `{path, sha256}` entries because GitGuardian
misidentified two OAuth-named digest-map entries as credentials. All prior digest
values and measurements were preserved and compared after normalization. No
security scan or detector was disabled.
