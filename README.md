# weave-openclaw

Third-party OpenClaw plugin that emits agent diagnostic events as OpenTelemetry
spans to **W&B Weave's Agents observability endpoint** via the
[Weave Node SDK](https://github.com/wandb/weave/tree/master/sdks/node)
(`gen_ai.*` semantic conventions, with `weave.*` extensions for fields without
a `gen_ai.*` counterpart).

This is the path that powers Weave's Agents tab — list of agents, per-agent
versions, multi-turn conversation chat view, search, filtering. The plugin
delegates transport, auth, endpoint derivation, and the OTLP exporter to the
Weave SDK; it owns the OpenClaw-side event-to-span translation.

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

Conversation grouping is via `gen_ai.conversation.id` (mapped from OpenClaw's
`sessionKey`).

The plugin uses the Weave Node SDK's `getWeaveTracer()` to emit spans through
the SDK's pre-configured provider, which is kept separate from the OTel global
registry. You can run this plugin alongside `diagnostics-otel`: diagnostics-otel
keeps exporting to your generic OTLP collector, and this plugin sends a
Weave-flavored stream to W&B.

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
        // Required for the plugin to subscribe to llm_input / llm_output /
        // agent_end. Without it, OpenClaw's runtime blocks those hooks and
        // your Weave Agents-tab spans land WITHOUT input/output text or
        // tool args/results. Look for `[plugins] typed hook "llm_input"
        // blocked` in the gateway log if you're seeing empty traces.
        hooks: { allowConversationAccess: true },
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
          serviceName: "openclaw-agent",
          // Optional — improves Agents tab grouping.
          agentName: "my-agent",
          agentVersion: "v1.0",
          agentDescription: "What my agent does.",
          // ON by default. By the time you've granted entity/project,
          // exported WANDB_API_KEY, and flipped allowConversationAccess
          // above, you've consented to W&B receiving conversation data,
          // making the plugin useless out-of-the-box for the sake of a
          // fifth gate would be theater. Set { enabled: false } for a
          // hard off (compliance / retention policy), or flip individual
          // sub-flags for granular opt-out (each defaults to true; only
          // explicit false disables). All captured strings pass through
          // OpenClaw's redactSensitiveText before emission.
          captureContent: {
            enabled: true,
            inputMessages: true,
            outputMessages: true,
            toolArguments: true,
            toolResults: true,
            systemInstructions: true,
          },
          // Optional. Strip OpenClaw's metadata-wrapper prefix
          // (`Conversation info` / `Sender (untrusted metadata)` /
          // `[timestamp]`) from user messages. Applies to both
          // `historyMessages` and the in-flight prompt.
          //
          // Default false. Raw matches OTel `gen_ai.input.messages`
          // semantics (store what the LLM actually saw), which is
          // also what Phoenix, Helicone, LangSmith, Langfuse, and
          // OpenLLMetry do. Keeping the wrapper also preserves
          // prompt-injection visibility (an attacker who sneaks
          // text into wrapper fields appears verbatim in the
          // trace) and surfaces wrapper-format bugs in OpenClaw
          // itself.
          //
          // Set true to strip for a cleaner Weave Agents-tab chat
          // view, at the cost of fidelity and OTel conformance.
          stripSenderWrapper: false,
          flushIntervalMs: 5000,
        },
      },
    },
  },
  diagnostics: { enabled: true },
}
```

`diagnostics.enabled: true` is required, without it OpenClaw doesn't emit
the diagnostic events this plugin consumes.

Endpoint and auth resolution is delegated to the Weave Node SDK. The plugin
calls `weave.init('${entity}/${project}')` at startup, which reads
`WANDB_BASE_URL` (default `https://api.wandb.ai`, dedicated installs set it
to their install host), `WF_TRACE_SERVER_URL` (full trace-server URL
override), and `WANDB_API_KEY` (or `~/.netrc`) the same way the Weave Python
and Node SDKs do. If `apiKey` is supplied in plugin config, the plugin pushes
it into `process.env.WANDB_API_KEY` before calling `init()`.

## Auth

API-key resolution order (plugin-side):

1. `apiKey: { source: "env", provider: "default", id: "WANDB_API_KEY" }` SecretRef
2. `apiKey: { source: "file", provider: "default", id: "/path/to/key" }` SecretRef
3. `apiKey: "<literal>"` (discouraged)
4. `process.env.WANDB_API_KEY` if `apiKey` is omitted

If a config-supplied key resolves, the plugin assigns it to
`process.env.WANDB_API_KEY` before calling `weave.init()`. From there the SDK
takes over: it adds the HTTP Basic `Authorization` header and the `project_id`
routing header on every OTLP request to `/agents/otel/v1/traces`. The SDK
also reads `~/.netrc` (`machine api.wandb.ai`) when the env var is unset.

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
- **`gen_ai.*` attributes are emitted as the primary namespace.** The
  plugin uses `weave.*` only for fields that have no `gen_ai.*` counterpart
  (compaction, cost, subagent, session, agent.version, request.* knobs,
  etc.). The W&B Weave server resolves both namespaces to the same
  canonical columns.
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
| `run.{started,completed}` (from `pi-embedded-runner/run/attempt.ts`) | `invoke_agent <agent>` | `gen_ai.operation.name=invoke_agent`, `gen_ai.agent.name`, `weave.agent.{id,version,description}`, `gen_ai.conversation.id`, `weave.outcome`, `weave.cost.usd` (cumulative across calls in the run) |
| `model.call.{started,completed,error}` | `chat <model>` | `gen_ai.operation.name=chat`, `gen_ai.request.model`, `weave.request.{temperature,top_p,top_k,max_tokens,seed,stop_sequences,frequency_penalty,presence_penalty,choice.count}`, `gen_ai.response.model`, `weave.response.id`, `gen_ai.usage.{input,output}_tokens`, `gen_ai.usage.reasoning.output_tokens`, `gen_ai.usage.cache_{read,creation}.input_tokens`, `weave.latency.time_to_first_byte_ms`, `gen_ai.output.type` |
| `tool.execution.{started,completed,error,blocked}` | `execute_tool <tool>` | `gen_ai.operation.name=execute_tool`, `gen_ai.tool.name`, `gen_ai.tool.call.id`, `weave.tool.{type,description}`, `weave.tool.denied_reason`, `weave.tool.block.reason` |
| `model.usage` | (no new span) | Adds cumulative `weave.cost.usd`, `weave.usage.total.{input,output,tokens,cache_read.input,cache_creation.input}_tokens`, `weave.context.{budget,used}_tokens` to the active `invoke_agent` span. |
| `tool.loop` | (no new span) | Adds a `tool.loop` span event on the active `invoke_agent` with `weave.loop.{level,detector,count,action,message,paired_tool_name}` and `gen_ai.tool.name`. |
| `before_compaction` + `after_compaction` (hooks) | `context_compacted` | `weave.operation.name=context_compacted`, `weave.compaction.{items_before,items_after,summary}`. (The compaction operation name stays on `weave.*` because `context_compacted` is not a member of OTel's `gen_ai.operation.name` enum.) |
| `subagent_spawned` + `subagent_ended` (hooks) | child `invoke_agent <agentId>` | Parented under the requester's invoke_agent for hierarchy in the Agents tab. `weave.subagent.{mode,outcome}`. |
| `context.assembled` | (no new span) | Adds `weave.context.{message_count,history_text_chars,history_image_blocks,system_prompt_chars,prompt_chars,prompt_images,budget_tokens,reserve_tokens}` to the active `invoke_agent`. |
| `agent_end` (hook) | (no new span) | Adds an `agent_end_summary` span event on the active `invoke_agent` with `weave.agent.{success,duration_ms,error}` (and `weave.agent.final_message` when content capture is enabled). |
| `run.attempt` | (no new span) | Adds a `run_attempt` span event on the active `invoke_agent` with `weave.run.attempt` (the attempt number) for retry visibility. |
| `message_received` (hook) | (no new span) | Adds a `message_received` span event capturing `weave.message.{from,channel}` (and `weave.message.content` when content capture is enabled). Surfaces the trigger inline in the trace. |
| `session_start` / `session_end` (hooks) | (no new span) | Adds `session_started` / `session_ended` span events with `weave.session.{reason,resumed_from,duration_ms,message_count}`. `session_started` is buffered until the next matching invoke_agent starts; `session_ended` is best-effort (only stamped if a run is still active). |

When `captureContent.*` flags are on, we additionally emit (with redaction
via OpenClaw's `redactSensitiveText`):

- `gen_ai.input.messages` (JSON-stringified message array)
- `gen_ai.output.messages` (JSON-stringified)
- `gen_ai.system_instructions` (string)
- `weave.reasoning_content` (concatenated thinking/reasoning content from
  Anthropic-style `lastAssistant.content` parts; no `gen_ai.*` counterpart)
- `gen_ai.tool.call.arguments` (JSON-stringified)
- `gen_ai.tool.call.result` (JSON-stringified)

Each content attribute is clamped to 8 KiB. When the clamp triggers, a
sibling boolean is emitted alongside (e.g. `gen_ai.input.messages.truncated:
true`) so dashboards can filter for truncated traces without string-matching
the inline `…[truncated Nc]` marker.

> Content emission is best-effort: it depends on the underlying diagnostic
> events carrying `inputMessages`/`outputMessages`/`toolInput`/`toolOutput`/
> `systemPrompt` fields, plus the `llm_input`/`llm_output` hook captures.
> The public `DiagnosticEventPayload` type does not declare these, but the
> runtime payload may carry them. We follow the same pattern as the bundled
> `diagnostics-otel` plugin.

## Resource attributes

Resource attributes are stamped by the Weave Node SDK on every span:

- `wandb.entity` / `wandb.project` — used by the Weave ingest as alternate
  routing alongside the `project_id` header.
- `weave.sdk.version` / `weave.sdk.language` — SDK-version provenance.

The plugin-supplied `serviceName` is surfaced in `/weave status` for
operator visibility but is not currently stamped onto the OTel resource by
the SDK.

## Design notes

- **Transport via the Weave Node SDK.** `weave.init()` + `getWeaveTracer()`
  own provider, processor, exporter, auth, endpoint, and resource
  attributes. The plugin focuses on event-to-span translation, content
  capture, and concurrent-run-safe state management.
- **Per-run state, not async-context.** OpenClaw runs agents concurrently on
  per-session lanes, with fire-and-forget parallel hook dispatch. The SDK's
  high-level `startTurn` / `startLLM` APIs use a process-wide-default
  AsyncLocalStorage state that is single-flight and unsafe for this plugin;
  we use `getWeaveTracer()` directly and key our own per-run span registry
  by OpenClaw `spanId`.
- **Trusted events only.** We filter on `meta.trusted === true` before
  emitting any span; adversarial event sources are dropped.
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

**Service registered:** wires the Weave Node SDK (`weave.init()` +
`getWeaveTracer()`) and subscribes to the diagnostic event stream.

**Configuration:** see `openclaw.plugin.json` for the full schema.

## Production-readiness

- **SDK preflight.** At plugin load time the plugin verifies the host
  OpenClaw exposes `api.on` and `api.registerService`; if not, it logs a
  clear "incompatible plugin SDK; requires pluginApi >=2026.4.25" and
  refuses to load instead of crashing later with `undefined is not a
  function`.
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

1. **Confirm the plugin is enabled.** Run `/weave status` in any
   OpenClaw chat surface (or check the gateway log for
   `weave: starting ...`). If the lifecycle is `disabled` /
   `config-error` / `not-started`, the plugin didn't activate. Look
   for `weave: config.entity is required`, `weave: configuration
   error`, or `[weave] incompatible plugin SDK` in the log.
2. **Confirm `diagnostics.enabled: true`** is set in the gateway
   config. Without it, OpenClaw doesn't emit the diagnostic events
   this plugin consumes, so there is nothing to translate to spans.
3. **Confirm entity/project match the W&B project in your browser.**
   `/weave status` prints `project=<entity>/<project>`; that string
   must match the URL slug of the Weave project you're inspecting.
4. **Confirm the auth source.** `/weave status` prints
   `auth=WANDB_API_KEY env` (or `env:<custom>` / `file:...` /
   `literal`). If this is `WANDB_API_KEY env` and you set the key in
   a different env var, the plugin is reading the wrong key.

### Spans land but input/output text is empty

Look in the gateway log for:

```
[plugins] typed hook "llm_input"  blocked because non-bundled plugins must set
                                  plugins.entries.weave.hooks.allowConversationAccess=true
[plugins] typed hook "llm_output" blocked ...
[plugins] typed hook "agent_end"  blocked ...
```

OpenClaw's runtime gates content-bearing hooks behind an operator opt-in.
The plugin's manifest declares `policy.allowConversationAccess: true`, but
for third-party plugins the gateway also requires you to flip
`plugins.entries.weave.hooks.allowConversationAccess: true` in your config.
Two-key consent. Once you set it and restart the gateway, `llm_input` /
`llm_output` / `agent_end` will fire and content attrs populate normally.

Span structure (`invoke_agent` / `chat` / `execute_tool`) and cost / usage
data come through diagnostic events, not hooks, so they keep working even
without the hooks gate flipped.

### Export failures

Export failure logging is now owned by the Weave Node SDK. Common shapes:

| Symptom | Most likely cause | Fix |
|---|---|---|
| 401 / 403 from `trace.wandb.ai` | Invalid or scope-limited API key | Verify the key is current; confirm the team owns the entity/project. Run `wandb login` to refresh `~/.netrc`. |
| 404 from the agents endpoint | Wrong base or trace-server URL | For dedicated installs, set `WANDB_BASE_URL` to your install host. For self-managed / proxy, set `WF_TRACE_SERVER_URL` to the trace-server URL. |
| Connection refused / DNS error | DNS, proxy, or firewall | Confirm the gateway host can reach `trace.wandb.ai` (cloud) or your install host (dedicated) on 443. |

### Need more detail

Set `OPENCLAW_WEAVE_DEBUG=spans,trace-tree` in the gateway environment
to get per-span creation logs and a tree dump of currently-active
spans on every start/finalize. See the
[Debug logging](#debug-logging) section above for the full flag list.
The API key is never written to debug logs.

## License

MIT
