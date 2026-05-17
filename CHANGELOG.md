# Changelog

## [0.0.1] — Initial release (2026-05-16)

Initial release of `weave-openclaw`: an OpenClaw third-party plugin
that emits agent diagnostic events as OpenTelemetry spans to W&B Weave's
Agents OTel endpoint (`weave.*` attribute namespace, `/agents/otel/v1/traces`).

### Operator ergonomics
- Startup log reports `auth`, `tier`, `flushIntervalMs`,
  `captureContent`, `emitGenAiAliases`, and `stripSenderWrapper`
  alongside `project`, `service`, and `agentVersion`. The W&B API key
  is never logged.
- OTLP export failures include a one-line `weave: hint:` after the
  rate-limited warning when the error shape is recognised
  (401/403 → auth, 404 → endpoint, 5xx → backend, ENOTFOUND/
  ECONNREFUSED → network).
- README `Troubleshooting` section covers the most common failure
  patterns.
