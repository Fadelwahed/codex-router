# Grok argument contracts — 2026-10-21

## Incident boundary

The two October 21 failures at 07:39:29 and 07:40:04 UTC occurred on the installed
`e6e58674` composite, before this patch. Each xAI request completed in one attempt;
the Router then rejected a function-facade argument payload. The upstream streams
finished in 8.123 and 6.860 seconds, while the Router failed after 10.467 and
6.973 seconds. This is a local argument-restoration failure, not proof of a
provider disconnect. Original argument values and the selected facade identity
were not retained, so the triggering malformed field cannot be reconstructed.

The October 19 custom-patch incidents similarly retained only
`ambiguous_or_invalid_json` / `missing_field`. These categories alone do not prove
that the history mismatch caused those particular requests.

## Changes and acceptance boundaries

- Native patch history contains `{input: rawPatch}`, whereas current structured
  calls require `{operations: [...]}`. These now have distinct provider identities:
  `apply_patch_history_v1` and `apply_patch_structured_v1`, with collision-safe
  aliases where needed. Historical bytes, call IDs, and results are preserved.
  The history identity is never advertised as callable, and invocation fails
  closed in JSON/SSE. Current forced choices and negotiated hook history retain
  their executable contract. Original client permission instructions remain in
  a verbatim quoted reference; they are not discarded.
- Read/search/directory schemas previously allowed characters that their shell
  argument compilers rejected. Their schemas and validators now share explicit
  character/size/numeric limits. No null coercion, missing-field guessing, JSON
  repair, or retry of committed actions is introduced. Terminal commands still
  permit line breaks; file/path/regex restrictions apply only to the relevant
  read facade.
- Function-facade failures now report a fixed tool identity and a fixed category,
  such as `read_file:out_of_range`. Argument contents and provider-supplied field
  names are never incorporated into that diagnostic. Earlier ambiguity checks
  still reject duplicate JSON keys before this compiler runs.
- The macOS nested process fixture published its PID file before the write and
  signal-handler installation were complete. Atomic rename after handler setup
  closes that readiness race. A delayed-write control makes the original fixture
  fail at the PID assertion and the fixed fixture pass without lengthening the
  cleanup budget.

## Previous live experiment and limits

The explicitly approved October 19 experiment consumed all eight allowed Grok
requests, through an isolated real forwarder with synthetic patch tasks. Both
baseline and candidate produced four valid patches out of four, with one upstream
attempt each. The incident was not reproduced. The sample does not demonstrate a
lower real-world failure rate or a general latency improvement. Temporary raw
probe artifacts were subsequently lost with the temporary checkout; these are
historical observations, not fresh reproducible acceptance evidence for this
revision. No additional live generations are authorized by that consumed budget.

Fresh deterministic checks, remote CI, review, and local installation must be
reported independently. Successful synthetic contract checks do not prove that
all organic Grok argument failures have disappeared.
