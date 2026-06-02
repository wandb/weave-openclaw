# weave-openclaw

[![npm version](https://img.shields.io/npm/v/weave-openclaw.svg)](https://www.npmjs.com/package/weave-openclaw)
[![CI](https://github.com/wandb/weave-openclaw/actions/workflows/ci.yml/badge.svg)](https://github.com/wandb/weave-openclaw/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/weave-openclaw.svg)](./LICENSE)
[![node](https://img.shields.io/node/v/weave-openclaw.svg)](./package.json)

This is an OpenClaw plugin that sends a record of what your agents do to
[W&B Weave](https://wandb.ai/site/weave), so you can see and search it all
in one dashboard. Once it's running, every agent run, model call, and tool
call shows up in the **Agents** tab of your Weave project, along with the
full conversation, token usage, and cost.

## Requirements

- Node.js >= 22
- OpenClaw >= 2026.4.25
- A free W&B account and a project. Sign up at [wandb.ai](https://wandb.ai)
  if you don't have one.

## Install

Install it with OpenClaw's plugin manager. This works from any directory,
so you don't have to be inside a particular project:

```bash
openclaw plugins install weave-openclaw
```

Use the full name `weave-openclaw`; `weave` on its own is the W&B SDK, not
this plugin. This registers the plugin with your gateway. You don't import
it in your own code; the gateway loads it from the config you set up next.

## Quickstart

1. Get a W&B API key at [wandb.ai/authorize](https://wandb.ai/authorize)
   and export it:

   ```bash
   export WANDB_API_KEY=<your-key>
   ```

2. Add the plugin to your OpenClaw gateway config (by default
   `~/.openclaw/openclaw.json`; run `openclaw onboard` to create one):

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

3. Restart the gateway. In any OpenClaw chat, run `/weave status` to confirm
   the plugin says `running`. Your traces will appear at
   `wandb.ai/<entity>/<project>/weave/agents`.

Two settings above are easy to miss, and your traces won't be complete
without them:

- `diagnostics.enabled: true`: without this, OpenClaw doesn't report what
  your agents are doing, so there's nothing for the plugin to send.
- `hooks.allowConversationAccess: true`: OpenClaw treats prompts and
  replies as sensitive and won't hand them to a third-party plugin unless
  you opt in here. Without it, your model-call spans lose the prompts,
  responses, and per-call token counts, and your tool spans lose their
  inputs and results. Trace structure and run-level cost and token
  totals still come through.

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
          // To read the key from a file instead:
          //   apiKey: { source: "file", provider: "default", id: "/run/secrets/wandb" }
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

### Where the plugin finds your API key

It checks these in order and uses the first one it finds:

1. The `apiKey` you set in config (from an environment variable or a file)
2. A plain `apiKey` string in config
3. The `WANDB_API_KEY` environment variable
4. Your `~/.netrc`, which `wandb login` fills in for you

You can also put `WANDB_API_KEY=...` in `~/.openclaw/.env`. OpenClaw loads
that file into the gateway's environment at startup, so it feeds option 3
above. A key already set in your shell takes precedence.

Most people don't need to change where traces are sent. If you're on a
dedicated or self-hosted W&B install, set the `WANDB_BASE_URL` environment
variable to your install's address; the plugin and the `wandb` command-line
tools read it the same way.

## What gets recorded

When everything is connected, each trace includes:

- Every **agent run**, with its name and a running total of cost and tokens
- Every **model call**, with the model name and how many tokens went in and out
- Every **tool call**, with the tool name and its result

With content recording on (the default), the full input and output messages
and the tool inputs and results are saved too. Extra details like subagents,
retries, and context compaction are recorded as well.

## Viewing your traces

After you restart the gateway, run an agent through OpenClaw. Within a few
seconds (set by `flushIntervalMs`) your traces appear at:

```
https://wandb.ai/<entity>/<project>/weave/agents
```

Open the **Agents** tab in the left nav for the conversation view and
per-agent grouping, or the **Traces** tab for the full step-by-step view.
The complete Weave docs are at [weave-docs.wandb.ai](https://weave-docs.wandb.ai/).

## Troubleshooting

### The plugin is loaded but nothing shows up

1. Run `/weave status`. If it doesn't say `running`, the plugin didn't
   start. The usual causes are a missing `entity` or `project`, or an
   out-of-date plugin. The gateway log says which.
2. Make sure `diagnostics.enabled: true` is in your config.
3. Make sure `entity` and `project` match the project you're looking at.
   `/weave status` prints them as `project=<entity>/<project>`.
4. Check which key is being used. `/weave status` prints `auth=...`. If it
   points at the wrong place, fix the key.
5. If runs appear but the model calls, tool calls, or messages are empty,
   you likely need `hooks.allowConversationAccess: true` (see below).

### Traces show up but the messages are blank

This means OpenClaw is hiding the conversation text. Set
`hooks.allowConversationAccess: true` in your config (under
`plugins.entries.weave`) and restart the gateway. The span structure and
run-level cost and token totals come through either way; the prompts, model
responses, per-call token counts, and tool inputs and results need this
setting. If you check the gateway log, you'll see lines about hooks being
"blocked."

### Traces aren't reaching W&B

| What you see | Likely cause | What to do |
|---|---|---|
| A `401` or `403` error | The API key is wrong or doesn't have access | Check that the key is current and that your team owns the entity and project. `wandb login` refreshes it. |
| A `404` error | Wrong server address | On a dedicated or self-hosted install, set `WANDB_BASE_URL` to your install's address. |
| Connection refused or DNS error | Network, proxy, or firewall | Make sure the machine running the gateway can reach W&B (or your install) on port 443. |
