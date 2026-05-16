# Changelog

## Unreleased

### Added
- Startup log now reports `auth`, `tier`, `flushIntervalMs`,
  `captureContent`, `emitGenAiAliases`, and `stripSenderWrapper`
  alongside the existing fields. The W&B API key is never logged.
- OTLP export failures now include a one-line `weave: hint:` after
  the warning when the error shape is recognised (401/403 auth,
  404 endpoint, 5xx backend, network/DNS).
- README `Troubleshooting` section covers the most common failure
  patterns.

### Changed
- `resolveWandbApiKey` returns `{ key, source }` instead of `string`.
  Internal API — no public consumers.

## [0.0.1] — Initial release (2026-05-04)

Initial release of `weave-openclaw`: an OpenClaw third-party plugin
that emits agent diagnostic events as OpenTelemetry spans to W&B Weave's
Agents OTel endpoint (`weave.*` attribute namespace, `/agents/otel/v1/traces`).
