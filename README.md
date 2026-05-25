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
          // ON by default. Pass `false` or `"off"` for a hard off
          // (compliance / retention policy). Plugin does NOT redact
          // captured strings — scrub upstream if needed.
          captureContent: true,
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
| `model.call.{started,completed,error}` | `chat <model>` | `gen_ai.operation.name=chat`, `gen_ai.request.model`, `gen_ai.usage.{input,output}_tokens` (when surfaced via `llm_output`) |
| `tool.execution.{started,completed,error,blocked}` | `execute_tool <tool>` | `gen_ai.operation.name=execute_tool`, `gen_ai.tool.name`, `gen_ai.tool.call.id` |
| `model.usage` | (no new span) | Adds cumulative `weave.cost.usd`, `weave.usage.total.{input,output,tokens,cache_read.input,cache_creation.input}_tokens`, `weave.context.{budget,used}_tokens` to the active `invoke_agent` span. |
| `tool.loop` | (no new span) | Adds a `tool.loop` span event on the active `invoke_agent` with `weave.loop.{level,detector,count,action,message,paired_tool_name}` and `gen_ai.tool.name`. |
| `before_compaction` + `after_compaction` (hooks) | (no new span) | Adds a `context_compacted` span event on the active `invoke_agent` Turn with `items_before`, `items_after`, `tokens`. |
| `subagent_spawned` + `subagent_ended` (hooks) | child `subagent` span | Parented under the requester's invoke_agent for hierarchy in the Agents tab. Subagent metadata (`weave.agent.id`, `weave.subagent.mode`, `weave.agent.description`, `gen_ai.conversation.id`) is stamped on a `subagent_spawned` event on the parent Turn because the SDK's `SubAgent` handle does not currently expose an enrichment surface. |
| `context.assembled` | (no new span) | Adds `weave.context.{message_count,history_text_chars,history_image_blocks,system_prompt_chars,prompt_chars,prompt_images,budget_tokens,reserve_tokens}` to the active `invoke_agent`. |
| `agent_end` (hook) | (no new span) | Stamps `weave.agent.{success,duration_ms,error}` as attributes on the active `invoke_agent` Turn (and `weave.agent.final_message` when content capture is enabled). |
| `run.attempt` | (no new span) | Adds a `run_attempt` span event on the active `invoke_agent` with `weave.run.attempt` (the attempt number) for retry visibility. |
| `message_received` (hook) | (no new span) | Adds a `message_received` span event capturing `weave.message.{from,channel}` (and `weave.message.content` when content capture is enabled). Surfaces the trigger inline in the trace. |
| `session_start` / `session_end` (hooks) | `Session` handle | Opens a Weave `Session` keyed by `sessionKey` on `session_start`; subsequent `run.started` events for that sessionKey use it as the parent. `session_end` closes the handle. |

When `captureContent` is on (the default), the plugin additionally emits:

- `gen_ai.input.messages` (system + history + user prompt, as the SDK's
  `LLM.record({ inputMessages })` payload)
- `gen_ai.output.messages` (assistant text, as the SDK's
  `LLM.record({ outputMessages })` payload)
- `gen_ai.tool.call.arguments` (JSON-stringified, stamped on the `Tool` handle)
- `gen_ai.tool.call.result` (JSON-stringified, stamped on the `Tool` handle)

Content is emitted raw — the v1 redaction layer was removed in v2 in favor
of upstream scrubbing. Operators with PII/PHI constraints should redact in
the agent runtime before content reaches the diagnostic event stream, or
turn `captureContent` off.

## Resource attributes

Resource attributes are stamped by the Weave Node SDK on every span:

- `wandb.entity` / `wandb.project` — used by the Weave ingest as alternate
  routing alongside the `project_id` header.
- `weave.sdk.version` / `weave.sdk.language` — SDK-version provenance.

The plugin-supplied `serviceName` is surfaced in `/weave status` for
operator visibility but is not currently stamped onto the OTel resource by
the SDK.

## Design notes

- **Transport via the Weave Node SDK.** `weave.init()` owns the provider,
  batch processor, OTLP exporter, auth, endpoint resolution, and resource
  attributes. The plugin owns event-to-span translation and per-run state.
- **Per-run state via SDK handles.** Each `Session` / `Turn` / `LLM` /
  `Tool` / `SubAgent` returned by the SDK is stored in a Map keyed by the
  upstream OpenClaw id (`sessionKey`, `runId`, `callId`, `toolCallId`).
  Finalize events look up the handle and call `.end()` on it.
- **Concurrent runs.** OpenClaw runs agents concurrently on per-session
  lanes. The SDK's `start*` factories install ambient state via
  AsyncLocalStorage that is single-flight per async chain; the plugin
  wraps each SDK construction in `runIsolated()` so concurrent runs do
  not collide on the ambient state.
- **Trusted events only.** We filter on `meta.trusted === true` before
  acting on any diagnostic event.
- **`llm_input` is per-call, `llm_output` is per-attempt.** `llm_input`
  arrives with a callId via `model_call_started` and is captured under the
  callId-keyed bucket. `llm_output` fires once per attempt with all
  assistant texts; `closeRunChatSpans` (called from `run.completed`)
  attributes texts to each chat span positionally.
- **No content emission unless `captureContent` is on** (default: on).

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
  clear message and refuses to load instead of crashing later with
  `undefined is not a function`.
- **Bounded per-run state.** Each registry Map is FIFO-evicted at 4096
  entries to defend against unbounded growth from interrupted event
  streams (gateway crash mid-session, dropped conversation).

## Limitations

- Tool calls render as raw JSON in Weave's UI (Weave-side limit for
  OTel-emitted tool spans).
- No metrics emitted (e.g. `gen_ai.client.token.usage` /
  `gen_ai.client.operation.duration` histograms). Weave Agents tab doesn't
  surface metrics yet; deferred until that surface exists.
- Streaming per-chunk timing (`time_to_first_chunk`, per-token latency)
  isn't yet captured.
- Subagent metadata is currently stamped as a `subagent_spawned` event on
  the parent Turn rather than on the subagent's own span, because the
  Weave Node SDK's `SubAgent` handle does not expose an enrichment surface
  (`setAttribute` / `addEvent`). Will move to the subagent span once
  upstream support lands.
- `weave.*` attributes for cost, usage totals, loop detection, context
  sizing, and run-attempt are plugin extensions beyond Weave's documented
  Agents semconv. They land in the trace server's `custom_attrs_*` maps
  and remain queryable but do not yet have dedicated columns.

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

## License

MIT
