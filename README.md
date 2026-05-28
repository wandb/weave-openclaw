# weave-openclaw

[![npm version](https://img.shields.io/npm/v/weave-openclaw.svg)](https://www.npmjs.com/package/weave-openclaw)
[![CI](https://github.com/wandb/weave-openclaw/actions/workflows/ci.yml/badge.svg)](https://github.com/wandb/weave-openclaw/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/weave-openclaw.svg)](./LICENSE)
[![node](https://img.shields.io/node/v/weave-openclaw.svg)](./package.json)

OpenClaw third-party plugin that exports agent diagnostic events as
OpenTelemetry GenAI spans to [W&B Weave](https://wandb.ai/site/weave),
via the [Weave Node SDK](https://github.com/wandb/weave/tree/master/sdks/node).
Traces land in the **Agents** tab of your Weave project: per-agent
version history, multi-turn conversation chat view, tool calls, cost,
search, and filtering.

## Requirements

- Node.js >= 22
- OpenClaw >= 2026.4.25 (plugin API)
- A W&B account and project. Sign up at [wandb.ai](https://wandb.ai)
  if you don't have one.

## Install

```bash
pnpm add weave-openclaw
```

The plugin is loaded by the OpenClaw gateway through its config; you
do not import it from application code.

## Quickstart

1. Grab a W&B API key at [wandb.ai/authorize](https://wandb.ai/authorize)
   and export it:

   ```bash
   export WANDB_API_KEY=<your-key>
   ```

2. Add the plugin to your OpenClaw gateway config (default
   `~/.openclaw/openclaw.json`, JSON5 so comments and trailing commas
   are allowed; run `openclaw onboard` to scaffold one):

   ```json5
   {
     diagnostics: { enabled: true },
     plugins: {
       allow: ["weave"],
       entries: {
         weave: {
           enabled: true,
           config: { entity: "your-team", project: "your-project" },
           hooks: { allowConversationAccess: true },
         },
       },
     },
   }
   ```

3. Restart the gateway. Run `/weave status` in any OpenClaw chat
   surface to confirm the plugin is `running`. Traces will appear at
   `wandb.ai/<entity>/<project>`.

Two flags above are easy to miss:

- `diagnostics.enabled: true`: without it OpenClaw does not emit the
  diagnostic events this plugin consumes.
- `hooks.allowConversationAccess: true`: without it OpenClaw blocks
  the content-bearing hooks (`llm_input`, `llm_output`, `agent_end`)
  and Weave spans land without input/output text or tool args/results.

## Configuration reference

```json5
{
  plugins: {
    entries: {
      weave: {
        enabled: true,
        config: {
          entity: "your-team",
          project: "your-project",
          // Reads WANDB_API_KEY from env if apiKey is omitted.
          // SecretRef supports source: "env" or "file":
          //   { source: "env",  provider: "default", id: "WANDB_API_KEY" }
          //   { source: "file", provider: "default", id: "/run/secrets/wandb" }
          // Plain string is supported but discouraged.
          apiKey: { source: "env", provider: "default", id: "WANDB_API_KEY" },
          serviceName: "openclaw-agent",
          // Optional, improves Agents tab grouping.
          agentName: "my-agent",
          agentVersion: "v1.0",
          agentDescription: "What my agent does.",
          // ON by default. Set to false for a hard off (compliance or
          // retention policy). The plugin does not redact captured
          // strings; scrub upstream if needed.
          captureContent: true,
          flushIntervalMs: 5000,
        },
        hooks: { allowConversationAccess: true },
      },
    },
  },
}
```

### Auth resolution order

1. `apiKey` SecretRef (`source: "env"` or `source: "file"`)
2. `apiKey` literal string
3. `process.env.WANDB_API_KEY`
4. `~/.netrc` entry for the Weave host (populated by `wandb login`)

Endpoint and auth are delegated to the Weave Node SDK. It reads
`WANDB_BASE_URL` (default `https://api.wandb.ai`; dedicated installs
set this to their install host) and `WF_TRACE_SERVER_URL` (full
trace-server URL override) the same way the Weave Python and Node
SDKs do.

## What gets captured

Per the [OTel GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/):

| Span | Emitted on | Key attributes |
|---|---|---|
| `invoke_agent <agent>` | per agent run | `gen_ai.agent.name`, `gen_ai.conversation.id`, cumulative cost and token usage |
| `chat <model>` | per model call | `gen_ai.request.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens` |
| `execute_tool <tool>` | per tool execution | `gen_ai.tool.name`, `gen_ai.tool.call.id` |

When `captureContent` is on (default), input/output messages, tool
arguments, and tool results are also emitted following the
`gen_ai.input.messages` / `gen_ai.output.messages` payload shape.
Subagents, compaction events, loop detection, retry attempts, and
context sizing are stamped as additional attributes and span events.

## Viewing your traces in Weave

After restarting the gateway, drive an agent through OpenClaw. Within
a few seconds (controlled by `flushIntervalMs`) traces land at:

```
https://wandb.ai/<entity>/<project>
```

Open the **Agents** tab in the left nav for the multi-turn chat view
and per-agent version grouping; open **Traces** for the raw span
tree. Full Weave docs are at [weave-docs.wandb.ai](https://weave-docs.wandb.ai/).

## Troubleshooting

### Plugin loaded but no spans show up

1. Run `/weave status`. If lifecycle is `disabled`, `config-error`,
   or `not-started`, the plugin did not activate. Check the gateway
   log for `weave: config.entity is required`, `weave: configuration
   error`, or `[weave] incompatible plugin SDK`.
2. Confirm `diagnostics.enabled: true` in the gateway config.
3. Confirm entity/project match the URL slug of the Weave project
   you're inspecting. `/weave status` prints `project=<entity>/<project>`.
4. Confirm the auth source. `/weave status` prints `auth=...`. If it
   says `WANDB_API_KEY env` but you set the key in a different env
   var, the plugin is reading the wrong key.

### Spans land but input/output text is empty

Look in the gateway log for:

```
[plugins] typed hook "llm_input"  blocked because non-bundled plugins must set
                                  plugins.entries.weave.hooks.allowConversationAccess=true
[plugins] typed hook "llm_output" blocked ...
[plugins] typed hook "agent_end"  blocked ...
```

OpenClaw gates content-bearing hooks behind an operator opt-in. Set
`plugins.entries.weave.hooks.allowConversationAccess: true` in your
config and restart the gateway. Span structure and cost/usage data
come through diagnostic events, not hooks, so those keep working
even without the gate flipped.

### Export failures

| Symptom | Most likely cause | Fix |
|---|---|---|
| 401 / 403 from `trace.wandb.ai` | Invalid or scope-limited API key | Verify the key is current and the team owns the entity/project. `wandb login` refreshes `~/.netrc`. |
| 404 from the agents endpoint | Wrong base or trace-server URL | For dedicated installs, set `WANDB_BASE_URL` to your install host. For self-managed or proxy, set `WF_TRACE_SERVER_URL` to the trace-server URL. |
| Connection refused / DNS error | DNS, proxy, or firewall | Confirm the gateway host can reach `trace.wandb.ai` (cloud) or your install host (dedicated) on 443. |

## License

MIT, see [LICENSE](./LICENSE).
