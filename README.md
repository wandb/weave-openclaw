# weave-openclaw

[![npm version](https://img.shields.io/npm/v/weave-openclaw.svg)](https://www.npmjs.com/package/weave-openclaw)
[![ClawHub plugin](https://img.shields.io/badge/ClawHub-plugin-orange.svg)](https://clawhub.ai/wandb/plugins/weave-openclaw)
[![CI](https://github.com/wandb/weave-openclaw/actions/workflows/ci.yml/badge.svg)](https://github.com/wandb/weave-openclaw/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/weave-openclaw.svg)](./LICENSE)
[![node](https://img.shields.io/node/v/weave-openclaw.svg)](./package.json)

OpenClaw plugin for tracing agent runs, model calls, tool calls, tokens, and
costs in [W&B Weave](https://wandb.ai/site/weave).

> [!WARNING]
> `captureContent` defaults to `true`. Prompts, replies, and tool inputs and
> results are sent unredacted to W&B. Set it to `false` to record only trace
> structure, tokens, and costs.

## Requirements

- Node.js >= 22.14.0
- OpenClaw >= 2026.4.25
- A [W&B account](https://wandb.ai) and project

## Setup

Install the plugin:

```bash
openclaw plugins install clawhub:@wandb/weave-openclaw
```

Export a [W&B API key](https://wandb.ai/authorize):

```bash
export WANDB_API_KEY=<your-key>
```

Add the plugin to `~/.openclaw/openclaw.json`:

```js
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

Restart the gateway if needed:

```bash
openclaw gateway restart
```

Run `/weave status` in a chat. When it reports `running`, view traces at:

```text
https://wandb.ai/<entity>/<project>/weave/agents
```

`hooks.allowConversationAccess: true` allows prompts, replies, and per-call
token counts. Without it, trace structure, tool calls, and run totals still
work. `diagnostics.enabled: false` disables tracing.

See the [full setup guide](https://docs.wandb.ai/weave/guides/integrations/agents/openclaw-harness)
and [ClawHub listing](https://clawhub.ai/wandb/plugins/weave-openclaw).

## Configuration

Only `entity` and `project` are required. Everything else has a sensible
default.

```js
{
  plugins: {
    entries: {
      weave: {
        enabled: true,
        config: {
          entity: "your-team",        // your W&B team or username
          project: "your-project",    // your W&B project name

          // Leave apiKey out to use the WANDB_API_KEY environment variable.
          // File and exec SecretRefs also work with a configured OpenClaw
          // secret provider.
          // A plain key string works too, but keeping secrets out of config is safer:
          //   apiKey: "your-wandb-api-key"
          apiKey: { source: "env", provider: "default", id: "WANDB_API_KEY" },

          serviceName: "openclaw-agent",   // shown in /weave status
          // These help group and label your agents in the dashboard.
          agentName: "my-agent",
          agentVersion: "v1.0",
          agentDescription: "What my agent does.",

          // On by default. Set to false to stop recording the actual message
          // text (for example, to meet a privacy or retention policy). The
          // plugin records text as-is and does not hide sensitive values, so
          // remove them beforehand if you need to.
          captureContent: true,

          // How often (in milliseconds) traces are sent.
          flushIntervalMs: 1000,
        },
        hooks: { allowConversationAccess: true },
      },
    },
  },
}
```

Environment refs work without extra setup. File and exec refs need a matching
`secrets.providers` entry; see [OpenClaw secrets management](https://docs.openclaw.ai/gateway/secrets).

Credential lookup order:

1. `apiKey` SecretRef
2. Plain `apiKey`
3. `WANDB_API_KEY`
4. `~/.netrc`

OpenClaw also loads `WANDB_API_KEY` from `~/.openclaw/.env`. Set
`WANDB_BASE_URL` for dedicated or self-hosted W&B.

## Troubleshooting

| Problem | Check |
|---|---|
| `/weave status` is not `running` | Check `entity`, `project`, the plugin version, and gateway logs. |
| No traces | Ensure diagnostics are enabled and the configured project matches `/weave status`. |
| Blank messages or model calls | Set `hooks.allowConversationAccess: true` and restart. |
| `401` or `403` | Refresh the API key and confirm project access. |
| `404` on self-hosted W&B | Check `WANDB_BASE_URL`. |
| Connection or DNS error | Check gateway network, proxy, and firewall access to W&B. |

## Manage the plugin

```bash
openclaw plugins update weave
openclaw plugins disable weave
openclaw plugins enable weave
openclaw plugins uninstall weave
```

## Development

```bash
pnpm install --frozen-lockfile
pnpm check

openclaw plugins install --link .
openclaw gateway restart
openclaw plugins inspect weave --runtime --json
```

## License

[MIT](./LICENSE)
