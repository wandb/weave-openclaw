# weave-openclaw

OpenClaw third-party plugin that emits agent diagnostic events as
OpenTelemetry spans to W&B Weave's Agents observability endpoint via
the [Weave Node SDK](https://github.com/wandb/weave/tree/master/sdks/node).
Powers the **Agents tab** in Weave: list of agents, per-agent
versions, multi-turn conversation chat view, search, filtering.

For the span hierarchy, emitted attributes, OTel GenAI conformance
notes, design rationale, and known limitations, see
[`docs/architecture.md`](docs/architecture.md).

## Install

```bash
pnpm add weave-openclaw
```

## Configure

Add the block below to your OpenClaw gateway config. By default that's
`~/.openclaw/openclaw.json` (JSON5, so comments and trailing commas
are allowed); set `OPENCLAW_CONFIG_PATH` to override. Run
`openclaw onboard` to scaffold one if you don't have a config yet.
The plugin reads `WANDB_API_KEY` from the environment:

```json5
{
  plugins: {
    allow: ["weave"],
    entries: {
      weave: {
        enabled: true,
        config: { entity: "your-team", project: "your-project" },
        // Required for the plugin to subscribe to llm_input /
        // llm_output / agent_end. Without it, OpenClaw blocks those
        // hooks and your Weave spans land without input/output text
        // or tool args/results. Look for `[plugins] typed hook
        // "llm_input" blocked` in the gateway log if traces are empty.
        hooks: { allowConversationAccess: true },
      },
    },
  },
  diagnostics: { enabled: true },
}
```

`diagnostics.enabled: true` is required: without it OpenClaw does not
emit the diagnostic events this plugin consumes.

### All options

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
          // SecretRef supports source: "env" or "file":
          //   { source: "env",  provider: "default", id: "WANDB_API_KEY" }
          //   { source: "file", provider: "default", id: "/run/secrets/wandb" }
          serviceName: "openclaw-agent",
          // Optional: improves Agents tab grouping.
          agentName: "my-agent",
          agentVersion: "v1.0",
          agentDescription: "What my agent does.",
          // ON by default. Pass `false` or `"off"` for a hard off
          // (compliance / retention policy). Plugin does NOT redact
          // captured strings; scrub upstream if needed.
          captureContent: true,
          flushIntervalMs: 5000,
        },
      },
    },
  },
  diagnostics: { enabled: true },
}
```

## Auth

API-key resolution order:

1. `apiKey: { source: "env", provider: "default", id: "WANDB_API_KEY" }` SecretRef
2. `apiKey: { source: "file", provider: "default", id: "/path/to/key" }` SecretRef
3. `apiKey: "<literal>"` (discouraged)
4. `process.env.WANDB_API_KEY` if `apiKey` is omitted

Endpoint and auth resolution are delegated to the Weave Node SDK. It
reads `WANDB_BASE_URL` (default `https://api.wandb.ai`; dedicated
installs set this to their install host), `WF_TRACE_SERVER_URL` (full
trace-server URL override), and `WANDB_API_KEY` (or `~/.netrc`) the
same way the Weave Python and Node SDKs do.

## Verify

After restarting the gateway, run `/weave status` in any OpenClaw chat
surface (or check the gateway log for `weave: starting ...`). Status
reports lifecycle (`running` / `disabled` / `config-error` /
`not-started`) plus the resolved project, service, and auth source.

## Troubleshooting

### Plugin loaded but no spans show up

1. Run `/weave status`. If lifecycle is `disabled` / `config-error` /
   `not-started`, the plugin did not activate. Look in the gateway log
   for `weave: config.entity is required`, `weave: configuration
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

OpenClaw gates content-bearing hooks behind an operator opt-in. Flip
`plugins.entries.weave.hooks.allowConversationAccess: true` in your
config and restart the gateway. Span structure (`invoke_agent` /
`chat` / `execute_tool`) and cost / usage data come through diagnostic
events, not hooks, so they keep working even without the gate flipped.

### Export failures

| Symptom | Most likely cause | Fix |
|---|---|---|
| 401 / 403 from `trace.wandb.ai` | Invalid or scope-limited API key | Verify the key is current; confirm the team owns the entity/project. Run `wandb login` to refresh `~/.netrc`. |
| 404 from the agents endpoint | Wrong base or trace-server URL | For dedicated installs, set `WANDB_BASE_URL` to your install host. For self-managed / proxy, set `WF_TRACE_SERVER_URL` to the trace-server URL. |
| Connection refused / DNS error | DNS, proxy, or firewall | Confirm the gateway host can reach `trace.wandb.ai` (cloud) or your install host (dedicated) on 443. |

## License

MIT
