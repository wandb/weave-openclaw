# weave-openclaw

Third-party OpenClaw plugin that emits agent diagnostic events as OpenTelemetry
spans to **W&B Weave's Agents observability endpoint** (`/agents/otel/v1/traces`,
`weave.*` attribute namespace).

This is the path that powers Weave's Agents tab — list of agents, per-agent
versions, multi-turn conversation chat view, search, filtering.

## Status

Initial scaffold. Functionality is layered in over a stack of follow-up PRs:

- Config: auth + endpoint resolution
- Service: OTel exporter lifecycle + `/weave status` command
- Events: LLM + tool call spans
- Events: multi-agent + lifecycle + compaction
- Privacy: content capture controls + redaction
- Release tooling and docs polish

## Install

```bash
pnpm add weave-openclaw
```

## License

MIT — see [`LICENSES/MIT.txt`](./LICENSES/MIT.txt) and [`REUSE.toml`](./REUSE.toml).
