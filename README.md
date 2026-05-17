# weave-openclaw

Third-party OpenClaw plugin that emits agent diagnostic events as OpenTelemetry
spans to **W&B Weave's Agents observability endpoint** (`/agents/otel/v1/traces`,
`weave.*` attribute namespace).

This is the path that powers Weave's Agents tab — list of agents, per-agent
versions, multi-turn conversation chat view, search, filtering. The standard
`/otel/v1/traces` endpoint with `gen_ai.*` attrs lands spans only in the generic
Traces tab.

## What it does

Subscribes to OpenClaw's diagnostic event bus and translates the inference
loop into Weave's expected span tree:

```
invoke_agent <agent.name>     ← run.{started,completed}
  ├─ chat <model>              ← model.call.{started,completed,error}
  └─ execute_tool <tool>       ← tool.execution.{started,completed,error,blocked}
```

`chat` and `execute_tool` are sibling children of `invoke_agent`, not nested.
A multi-turn loop produces an alternating sequence of `chat` and
`execute_tool` siblings under the same `invoke_agent` root.

Conversation grouping is via `weave.conversation.id` (mapped from OpenClaw's
`sessionKey`).

The plugin owns its **own local** `BasicTracerProvider` and never registers
the OTel global, so it coexists cleanly with `diagnostics-otel`. You can run
both — diagnostics-otel keeps exporting to your generic OTLP collector, and
this plugin sends a Weave-flavored stream to W&B.

## Install

```bash
pnpm add weave-openclaw
```

Then add the block below to your OpenClaw gateway config. By default
that's `~/.openclaw/openclaw.json` (JSON5, so comments and trailing
commas are allowed); set `OPENCLAW_CONFIG_PATH` to override. If you
don't have a config yet, run `openclaw onboard` to scaffold one. The
plugin reads `WANDB_API_KEY` from the environment:

```json5
{
  plugins: {
    allow: ["weave"],
    entries: {
      weave: {
        enabled: true,
        config: { entity: "your-team", project: "your-project" },
      },
    },
  },
  diagnostics: { enabled: true },
}
```

Full configuration with every option:

```json5
{
  plugins: {
    allow: ["weave"],
    entries: {
      weave: {
        enabled: true,
        config: {
          entity: "your-team",
          project: "your-project",
          // Reads WANDB_API_KEY from env if apiKey omitted.
          // SecretRef supports source: "env" or "file"
          //   { source: "env",  provider: "default", id: "WANDB_API_KEY" }
          //   { source: "file", provider: "default", id: "/run/secrets/wandb" }
          tier: "cloud", // or "dedicated" with subdomain: "acme"
          serviceName: "openclaw-agent",
          // Optional — improves Agents tab grouping.
          agentName: "my-agent",
          agentVersion: "v1.0",
          agentDescription: "What my agent does.",
          // Off by default. Enable only when retention policy is approved.
          captureContent: {
            enabled: false,
            inputMessages: false,
            outputMessages: false,
            toolArguments: false,
            toolResults: false,
            systemInstructions: false,
          },
          // Optional. Strip OpenClaw's metadata-wrapper prefix
          // (`Conversation info` / `Sender (untrusted metadata)` / `[timestamp]`)
          // from user messages — applies to both `historyMessages` and the
          // in-flight prompt. Default false (raw, OTel-conforming): keep
          // the wrapper so the trace reflects what the LLM actually saw.
          // Set true to opt into a cleaner Weave Agents-tab chat view at
          // the cost of fidelity. Full design rationale (why default raw,
          // what competitors do, when to flip) in
          // `2026-05-03-wrapper-strip-design.md`.
          stripSenderWrapper: false,
          // Default true. Dual-emit `gen_ai.*` aliases alongside `weave.*`
          // so spans are portable to non-Weave OTel backends (Datadog,
          // Honeycomb, LangSmith, Langfuse). Set false to halve attribute
          // storage on Weave-only deployments — Weave treats both forms
          // identically via its alias resolution layer.
          emitGenAiAliases: true,
          flushIntervalMs: 5000,
        },
      },
    },
  },
  diagnostics: { enabled: true },
}
```

`diagnostics.enabled: true` is required — without it, OpenClaw doesn't emit
the diagnostic events this plugin consumes.

## Endpoint URLs

- **Cloud (multi-tenant):** `https://trace.wandb.ai/agents/otel/v1/traces`
- **Dedicated / self-managed:** `https://<subdomain>.wandb.io/traces/agents/otel/v1/traces`

(Note the dedicated path includes an extra `/traces` segment before
`/agents/otel/v1/traces` — verified against the W&B trace-server URL builder
in `weave/trace/env.py`.)

The plugin builds these from `tier` + `subdomain`. Set `endpoint` directly to
override.

## Auth

The plugin sends both header forms — the W&B Weave trace server checks
`wandb-api-key` first and falls back to HTTP Basic, so sending both maximises
compatibility across deployment versions:

- `Authorization: Basic base64("api:<WANDB_API_KEY>")` — canonical/contract
  form documented for the Weave OTel endpoint and used by Vercel AI SDK and
  Google ADK.
- `wandb-api-key: <WANDB_API_KEY>` — alternate routing path that some
  deployments check first.
- `project_id: <entity>/<project>` — required for ingest routing.

The key is resolved from (in order):

1. `apiKey: { source: "env", provider: "default", id: "WANDB_API_KEY" }` SecretRef
2. `apiKey: { source: "file", provider: "default", id: "/path/to/key" }` SecretRef
3. `apiKey: "<literal>"` (discouraged)
4. `process.env.WANDB_API_KEY` if `apiKey` is omitted

## OTel GenAI conformance

The plugin emits OpenTelemetry GenAI semantic-convention attributes per the
post-v1.36.0 registry mainline:

- **Span hierarchy** matches `docs/gen-ai/gen-ai-agent-spans.md`: `chat`
  and `execute_tool` are sibling children of `invoke_agent`. Each chat
  call and each tool execution is its own span under the agent root.
- **Span kinds** INTERNAL / CLIENT / INTERNAL per the spec.
- **Message payloads** follow `docs/gen-ai/gen-ai-input-messages.json` and
  `gen-ai-output-messages.json`: `{role, parts, finish_reason}` with
  canonical part types `text`, `tool_call`, `tool_call_response`,
  `reasoning`. Non-standard internal roles (`toolResult` from `pi-ai`,
  `custom` from `pi-agent-core`) are normalized or filtered before emit.
- **Roles** are restricted to the OTel canonical enum
  `system|user|assistant|tool`.
- **Token usage** uses `input_tokens` / `output_tokens` (post-v1.36.0
  shape; deprecated `prompt_tokens` / `completion_tokens` are not
  emitted).
- **`gen_ai.*` aliases** are dual-emitted by default for portability —
  see `emitGenAiAliases` config. The W&B Weave server resolves both
  namespaces to the same canonical columns.
- **Errors** record an `exception` span event with `exception.{type,
  message}` per `docs/general/recording-errors.md`, alongside
  `error.type` and span status `ERROR`.
- **`output.type`** is omitted when the modality is unknown (per
  "Conditionally Required" in the spec) rather than emitted as the
  empty-string sentinel.
- **`system_instructions`** is emitted as a JSON-encoded `list[str]` to
  match both the Weave clickhouse column type and the OTel registry.
- **`response.finish_reasons`** is emitted as a top-level JSON array
  alongside per-message finish_reason values inside the messages JSON.

## What gets emitted

| OpenClaw event | Weave span / signal | Key attributes |
|---|---|---|
| `run.{started,completed}` (from `pi-embedded-runner/run/attempt.ts`) | `invoke_agent <agent>` | `weave.operation.name=invoke_agent`, `weave.agent.{name,id,version,description}`, `weave.conversation.id`, `weave.outcome`, `weave.cost.usd` (cumulative across calls in the run) |
| `model.call.{started,completed,error}` | `chat <model>` | `weave.operation.name=chat`, `weave.request.model`, `weave.request.{temperature,top_p,top_k,max_tokens,seed,stop_sequences,frequency_penalty,presence_penalty,choice.count}`, `weave.response.{model,id}`, `weave.usage.{input,output,reasoning}_tokens`, `weave.usage.cache_{read,creation}.input_tokens`, `weave.latency.time_to_first_byte_ms`, `weave.output.type` |
| `tool.execution.{started,completed,error,blocked}` | `execute_tool <tool>` | `weave.operation.name=execute_tool`, `weave.tool.{name,call.id,type,description}`, `weave.tool.denied_reason`, `weave.tool.block.reason` |
| `model.usage` | (no new span) | Adds cumulative `weave.cost.usd`, `weave.usage.total.{input,output,tokens,cache_read.input,cache_creation.input}_tokens`, `weave.context.{budget,used}_tokens` to the active `invoke_agent` span. |
| `tool.loop` | (no new span) | Adds a `tool.loop` span event on the active `invoke_agent` with `weave.loop.{level,detector,count,action,message,paired_tool_name}` and `weave.tool.name`. |
| `before_compaction` + `after_compaction` (hooks) | `context_compacted` | `weave.operation.name=context_compacted`, `weave.compaction.{items_before,items_after,summary}`. |
| `subagent_spawned` + `subagent_ended` (hooks) | child `invoke_agent <agentId>` | Parented under the requester's invoke_agent for hierarchy in the Agents tab. `weave.subagent.{mode,outcome}`. |
| `context.assembled` | (no new span) | Adds `weave.context.{message_count,history_text_chars,history_image_blocks,system_prompt_chars,prompt_chars,prompt_images,budget_tokens,reserve_tokens}` to the active `invoke_agent`. |
| `agent_end` (hook) | (no new span) | Adds an `agent_end_summary` span event on the active `invoke_agent` with `weave.agent.{success,duration_ms,error}` (and `weave.agent.final_message` when content capture is enabled). |
| `run.attempt` | (no new span) | Adds a `run_attempt` span event on the active `invoke_agent` with `weave.run.attempt` (the attempt number) for retry visibility. |
| `message_received` (hook) | (no new span) | Adds a `message_received` span event capturing `weave.message.{from,channel}` (and `weave.message.content` when content capture is enabled). Surfaces the trigger inline in the trace. |
| `session_start` / `session_end` (hooks) | (no new span) | Adds `session_started` / `session_ended` span events with `weave.session.{reason,resumed_from,duration_ms,message_count}`. `session_started` is buffered until the next matching invoke_agent starts; `session_ended` is best-effort (only stamped if a run is still active). |

When `captureContent.*` flags are on, we additionally emit (with redaction
via OpenClaw's `redactSensitiveText`):

- `weave.input.messages` (JSON-stringified message array)
- `weave.output.messages` (JSON-stringified)
- `weave.system_instructions` (string)
- `weave.reasoning_content` (concatenated thinking/reasoning content from
  Anthropic-style `lastAssistant.content` parts)
- `weave.tool.call.arguments` (JSON-stringified)
- `weave.tool.call.result` (JSON-stringified)

Each content attribute is clamped to 8 KiB. When the clamp triggers, a
sibling boolean is emitted alongside (e.g. `weave.input.messages.truncated:
true`) so dashboards can filter for truncated traces without string-matching
the inline `…[truncated Nc]` marker.

> Content emission is best-effort: it depends on the underlying diagnostic
> events carrying `inputMessages`/`outputMessages`/`toolInput`/`toolOutput`/
> `systemPrompt` fields, plus the `llm_input`/`llm_output` hook captures.
> The public `DiagnosticEventPayload` type does not declare these, but the
> runtime payload may carry them. We follow the same pattern as the bundled
> `diagnostics-otel` plugin.

## Resource attributes

Every emitted span carries the following resource attributes:

- `service.name` — from `serviceName` config (default `openclaw-agent`)
- `service.version` — pinned to the plugin package version
- `wandb.entity` / `wandb.project` — used by the Weave ingest as alternate
  routing alongside the `project_id` header.

## Design notes

- **Local TracerProvider, never global.** This is what lets us run alongside
  `diagnostics-otel` without one stomping on the other. Cost: we re-translate
  the same diagnostic events that diagnostics-otel translates, which is fine.
- **Trusted events only.** We filter on `meta.trusted === true` before
  emitting any span — adversarial event sources are dropped.
- **Span correlation by OpenClaw spanId.** We store active spans in a
  `Map<openclawSpanId, otelSpan>` keyed by `evt.trace.spanId` so we can
  match `started` → `completed` events and resolve parents from
  `evt.trace.parentSpanId`.
- **Per-call hook state.** `llm_input`/`llm_output` captures key by `callId`
  (resolved via `model_call_started`) so multi-call agent loops attribute
  prompts/completions to the correct chat span instead of overwriting each
  other under a shared `runId`.
- **Bounded attribute payloads.** Every string attribute is run through
  `redactSensitiveText` and clamped to 8 KiB. JSON content is also array-trimmed.
- **Side-channel buffering.** `model.usage` and `tool.loop` events dispatch
  synchronously while `model.call.*` and `tool.execution.*` are async-queued,
  so they can race ahead of the invoke_agent span. The plugin buffers cost /
  loop data by traceId and replays it when the invoke_agent span starts.
- **No content emission unless explicitly opted in** via `captureContent.*`.

## Capabilities

**Diagnostic events subscribed (via `onInternalDiagnosticEvent`):**
- `run.{started,completed}` (canonical invoke_agent root from `pi-embedded-runner`)
- `model.call.{started,completed,error}`
- `tool.execution.{started,completed,error,blocked}`
- `model.usage` (cost rollup on invoke_agent)
- `tool.loop` (loop-detector span event)
- `context.assembled` (token-budget attrs)
- `run.attempt` (retry tracking)

`harness.run.{started,completed,error}` from `harness/v2.ts` are intentionally
**not** subscribed: the runtime emits `harness.run.started` without an
explicit trace context (auto-generated `spanId`) but emits `harness.run.completed`
with `result.diagnosticTrace` (a different `spanId`), so spanId-keyed correlation
breaks for the started/completed pair. `run.{started,completed}` thread the
same `diagnosticRunBase` through both emits and share a `spanId`. Tradeoff:
pre-attempt errors (`harness.prepare`/`harness.start` throwing before
`runEmbeddedAttempt`) emit only `harness.run.error` and do not produce a
Weave span. These bootstrap failures are rare; user-visible run/model errors
arrive through `run.completed` with `outcome: "error"`.

**Hooks subscribed (via `api.on`):**
- `model_call_started`, `llm_input`, `llm_output` (call-scoped capture)
- `before_tool_call`, `after_tool_call` (tool args/result capture)
- `before_compaction`, `after_compaction` (context_compacted span)
- `subagent_spawned`, `subagent_ended` (child invoke_agent linkage)
- `agent_end` (final-state fallback)
- `message_received` (inbound boundary)
- `session_start`, `session_end` (session lifecycle)

**Service registered:** OTel trace exporter against
`/agents/otel/v1/traces`.

**Configuration:** see `openclaw.plugin.json` for the full schema.

## Production-readiness

- **SDK preflight.** At plugin load time the plugin verifies the host
  OpenClaw exposes `api.on` and `api.registerService`; if not, it logs a
  clear "incompatible plugin SDK; requires pluginApi >=2026.4.25" and
  refuses to load instead of crashing later with `undefined is not a
  function`.
- **Exporter health monitoring.** OTLP export failures are surfaced via
  rate-limited `ctx.logger.warn` (first failure per 60s window, with a
  suppressed-count summary at the next window boundary). Replaces silent
  drops by `BatchSpanProcessor`.
- **Failure-isolation.** Mapper exceptions inside `handleEvent` are caught
  and rate-limited per event type, so a malformed event class can't flood
  logs.
- **API key hygiene.** Error messages logged via `ctx.logger` are scrubbed
  for `Authorization: Basic ...`, `wandb-api-key`, and `api_key`/`api-key`
  values before emission.

## Limitations (v1)

- Tool calls render as raw JSON in Weave's UI (Weave-side limit for
  OTel-emitted tool spans).
- Spans for events emitted before this plugin's subscription registers
  (e.g. very early gateway startup) are dropped.
- No metrics emitted (planned: `gen_ai.client.token.usage` /
  `gen_ai.client.operation.duration` histograms). Weave Agents tab doesn't
  surface metrics; deferred until multi-vendor/Grafana use case appears.
- Streaming per-chunk timing (`time_to_first_chunk`, per-token latency)
  isn't yet available — `time_to_first_byte_ms` is captured.
- **`weave.tool.definitions` deferred:** OpenClaw's plugin SDK currently
  exposes no hook that carries the resolved tool list. Will land once
  upstream support exists.
- `weave.cost.*`, `weave.tool.block.reason`, `weave.usage.total.*`,
  `weave.loop.*`, `weave.context.*`, and `weave.subagent.*` are extensions
  beyond Weave's documented Agents semconv. They land in the trace
  server's `custom_attrs_*` maps and remain queryable, but won't get
  dedicated columns until the schema absorbs them.

## Debug logging

`OPENCLAW_WEAVE_DEBUG` is comma-separated. Recognised flags:

- `spans` — log every span creation (`name`, `traceId`, `spanId`,
  `parentSpanId`, `parentResolved`) and every orphan drop. Useful when
  Weave's Agents tab shows tool/chat spans as separate "turns" instead
  of nested under their `invoke_agent` — the log tells you whether the
  parent linkage is failing.
- `trace-tree` — after every span start/finalize, dump the full set of
  currently-active spans grouped by `traceId` with parent-child
  indentation. Shows whether the tree shape is correct (one
  `invoke_agent` with `chat`/`execute_tool` descendants) or wrong
  (siblings, duplicates, orphans). Combine with `spans` for full
  diagnosis: `OPENCLAW_WEAVE_DEBUG=spans,trace-tree`.

Logs go through `ctx.logger.debug` (falls back to `.info` if the host
logger doesn't have `.debug`). The API key is never logged.

## Troubleshooting

### Plugin loaded but no spans show up in Weave

Walk this checklist top-to-bottom:

1. **Confirm the plugin is enabled.** Search the gateway log for the
   line `weave: exporting to https://...`. If absent, the plugin
   didn't activate — check the entries below it for
   `weave: config.entity is required`, `weave: configuration error`,
   or `[weave] incompatible plugin SDK`.
2. **Confirm `diagnostics.enabled: true`** is set in the gateway
   config. Without it, OpenClaw doesn't emit the diagnostic events
   this plugin consumes, so there is nothing to translate to spans.
3. **Confirm entity/project match the W&B project in your browser.**
   The startup line prints `project=<entity>/<project>`; that string
   must match the URL slug of the Weave project you're inspecting.
4. **Confirm the auth source.** The same startup line prints
   `auth=env:WANDB_API_KEY` (or `file:...` / `env:<custom>` /
   `literal`). If this is `env:WANDB_API_KEY` and you set the key in
   a different env var, the plugin is reading the wrong key.

### Export-failure warnings in the gateway log

The plugin emits at most one `weave: export failure: <msg>` warning
per 60-second window, with a one-line `weave: hint: <action>`
appended when the error shape is recognised:

| Hint phrase | Most likely cause | Fix |
|---|---|---|
| `check WANDB_API_KEY is valid and has access to the configured entity/project` | 401/403 — auth or authorization failure | Verify the key is current; confirm the team owns the entity/project. |
| `endpoint URL not found; verify tier/subdomain or endpoint override resolves to a real traces URL` | 404 — wrong tier/subdomain | For dedicated, double-check `subdomain`. For self-managed, use the `endpoint` override and confirm it ends in `/agents/otel/v1/traces`. |
| `Weave backend returned 5xx; retries continue` | Transient backend issue | Wait — the OTel BatchSpanProcessor retries automatically. Spans buffered while the link is down may be dropped if the gateway restarts. |
| `network error reaching Weave; check DNS/proxy/egress` | DNS/proxy/firewall | Confirm the gateway host can reach `trace.wandb.ai` (or your dedicated subdomain) on 443. |

When no hint is appended, the heuristic didn't recognise the error
shape; the raw message is the only signal. File a bug if you see this
class of failure regularly.

### Need more detail

Set `OPENCLAW_WEAVE_DEBUG=spans,trace-tree` in the gateway environment
to get per-span creation logs and a tree dump of currently-active
spans on every start/finalize. See the
[Debug logging](#debug-logging) section above for the full flag list.
The API key is never written to debug logs.

## License

MIT
