# Grok reasoning and request timings

Grok OAuth accepts both a scalar `reasoning_effort` and the Responses
`reasoning: { effort, summary }` object. Router copies the final reasoning
choice, after any subagent override, into LiteLLM's supported `extra_body`
at the owned Responses-to-Chat boundary. The locked gateway otherwise drops
the effort for generic OpenAI-compatible Chat models; a deployment-level
`allowed_openai_params` does not reach its nested Chat call. The forwarder
normalizes either representation into the upstream Responses effort. An
omitted effort stays omitted; Router does not invent a default here. Existing
model-specific aliases and xhigh support remain unchanged. API-key Grok and
other providers retain their existing reasoning paths.

## Reading stage timings

`[grok-timing]` JSON records in the service log join the Router and OAuth
forwarder by `requestId`, also present in `usage-events.jsonl`. The Router owns
this correlation ID; it is sent only to the local gateway and forwarder, never
to xAI. Each forwarder attempt has a separate `upstreamRequestId`.

All `*Ms` marks are elapsed milliseconds from receipt **in that process**,
measured with a monotonic clock. Subtract marks in the same record; do not
subtract Router marks from forwarder marks. `startedAt` is wall time for
correlation. Missing marks mean the stage was not observed, not zero latency.

| Boundary | Marks and interpretation |
| --- | --- |
| Router preparation | `preparedMs`: routing and request adaptation completed |
| Gateway | `firstGatewayDispatchMs` to `firstGatewayHeadersMs`: first gateway request to response headers |
| Forwarder preparation | `parsedMs`, `preparedMs`: JSON parsing and upstream request adaptation |
| Local concurrency queue | Per attempt: `dispatchMs - queuedMs` |
| Upstream headers | Per attempt: `headersMs - dispatchMs`, including transport and provider scheduling |
| Upstream output | Per attempt: `firstEventMs`, `firstReasoningMs`, `firstTextMs`, `firstToolMs`, `firstToolReadyMs`, `terminalMs` |
| Forwarder release | `firstActionMs`: first text or tool action released to the gateway; post-tool actions may wait for a certified terminal |
| Codex-facing stream | Router `firstReasoningMs`, `firstTextMs`, `firstToolMs`, `terminalMs`, observed after its output transformations |
| Completion | `totalMs` and transport `outcome`; semantic success is separately recorded as `terminal: completed` |

Attempt HTTP errors, transport errors, cancellation, and a stream ending
without a semantic terminal remain distinct. A finished HTTP response alone
does not prove a successful model turn. Preparation-to-queue time can include
authentication and CLI-version work; it is not reported as queue time. The
Router records only the first gateway dispatch/headers; gateway retries can
produce multiple forwarder records with the same correlation ID. These
records are for ordinary Grok OAuth requests, not a complete compaction or
cross-provider failover trace.

Diagnostics are bounded and contain no prompts, tool arguments/results,
reasoning text, credentials, URLs, or arbitrary error messages. They remain
available in quiet mode. Requested and forwarded effort are recorded
separately; aliases may legitimately differ. Unknown/absent effort is `null`.
These timings locate delay at observable boundaries; they do not measure
provider-internal compute time or establish a speed improvement by themselves.

## Verification

`node scripts/verify-grok-service-tier.mjs .venv/bin/python` exercises the
generated production configuration through Router, the locked LiteLLM gateway,
the real forwarder, and a synthetic loopback provider. It covers all advertised
OAuth efforts with and without summaries, scalar effort, HTTP streaming,
HTTP JSON, WebSocket, post-tool completion and repair. Delayed-terminal cases
verify that upstream tool readiness and action release are measured separately.
Focused tests additionally cover child overrides, failed/incomplete/missing
terminals, cancellation, timing bounds and log privacy. No live quota is used.
