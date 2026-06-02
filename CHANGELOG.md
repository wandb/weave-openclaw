# Changelog

## [0.1.0] — Initial release

Initial release of `weave-openclaw`: an OpenClaw third-party plugin
that emits agent diagnostic events as OpenTelemetry spans to W&B
Weave's Agents endpoint via the `weave.genai` Node SDK.

### Emits
- `invoke_agent`, `chat`, `execute_tool` spans following the OTel
  GenAI semantic conventions (post-v1.36.0 registry).
- `gen_ai.input.messages` / `gen_ai.output.messages` payloads when
  `captureContent` is enabled (default: on).
- `weave.*` extension attributes for cost, usage totals, loop
  detection, compaction, context sizing, and run-attempt, stamped on
  the active Turn via the SDK's `setAttribute` / `addEvent` surface.

### Operator ergonomics
- Startup log reports `project`, `service`, `agentVersion`, `auth`,
  and `captureContent`.
- `/weave status` command surfaces lifecycle, config (including
  `flushIntervalMs`), and counts.
- README covers install, configure, and a troubleshooting checklist.
