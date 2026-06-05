# Security policy

## Reporting a vulnerability

Please report security issues privately through GitHub's
[private vulnerability reporting](https://github.com/wandb/weave-openclaw/security/advisories/new)
rather than opening a public issue. We will acknowledge your report and keep
you updated on a fix.

## What this plugin does with your data

`weave-openclaw` is an observability plugin. While it is running it exports a
trace of your OpenClaw agent activity to [W&B Weave](https://wandb.ai/site/weave),
a hosted service. Understand this data flow before enabling it; see
[Data and privacy](./README.md#data-and-privacy) in the README for the full
breakdown.

### Conversation content

- `captureContent` defaults to on. With it on, the plugin sends the full text
  of prompts, model replies, system instructions, and tool inputs and results
  to W&B.
- The plugin does **not** redact this content. Secrets, file contents, and
  personal data your agents handle are transmitted as-is. Scrub sensitive
  data upstream if you need to.
- Set `captureContent: false` to export only trace structure and run-level
  token and cost totals, with no message text. The plugin logs a notice at
  startup whenever content capture is on.

### Where data is sent

By default, traces go to W&B's cloud at `wandb.ai` over HTTPS. Set
`WANDB_BASE_URL` to send them to a dedicated or self-hosted W&B install you
control instead. Retention, access control, and deletion are governed by your
W&B account and plan.

### Credentials

Your W&B API key is resolved from plugin config, the `WANDB_API_KEY`
environment variable, or `~/.netrc`. It is used only to authenticate with W&B
and is never written to traces or logs; `/weave status` and the startup log
report only the key's source (for example `WANDB_API_KEY env`), never the key
itself.

## Supported versions

Security fixes are released against the latest published version on npm.
