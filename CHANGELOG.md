# Changelog

## Unreleased

### Changed
- Rewrote plugin against `weave.genai` SDK surface. Spans flow through
  Session / Turn / LLM / Tool / SubAgent handles; gen_ai.* attribute
  writing, parent-context propagation, and OTLP transport are owned
  by the SDK.

### Removed
- `config.stripSenderWrapper` is now a no-op. v1 stripped OpenClaw's
  "Conversation info (untrusted metadata)" wrappers from prompt content
  before stamping `gen_ai.input.messages`; v2 leaves them raw. Operators
  who relied on this should remove the field; the plugin warns at start
  if it's still set to true.
- Redaction layer (`redact.ts`). Operators are expected to scrub content
  upstream if needed.
- Per-attribute truncation flags. Raw content flows to the OTLP
  exporter.
- `OPENCLAW_WEAVE_DEBUG` env (`spans` / `trace-tree`). The SDK owns
  span parenting; these knobs were diagnostic for v1's hand-rolled
  lifecycle.
- Per-event-type handler-error and per-attribute truncation rate
  limiters.
- Fine-grained `captureContent` flags (5 booleans). Collapsed to a
  single boolean (or `"on"` / `"off"`).
- Standalone `context_compacted` child span. Now emitted as a span
  event on the active invoke_agent.

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
