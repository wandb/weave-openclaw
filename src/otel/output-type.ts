// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

/**
 * Detect the modality of a chat completion's `lastAssistant` payload for
 * `weave.output.type` / `gen_ai.output.type`. Maps to OTel's enum
 * `text|json|image|speech` (which Weave mirrors plus the empty-string
 * sentinel as the ClickHouse default).
 *
 * Precedence (first match wins):
 *   1. Any image part         -> "image"
 *   2. Any audio/speech part  -> "speech"
 *   3. Any text part          -> "text"
 *   4. Tool-use only          -> "json"
 *   5. Otherwise              -> undefined  (caller MUST omit the attr)
 *
 * Returns `undefined` when modality is genuinely unknown so callers can
 * omit the attribute entirely. Per OTel semconv `gen_ai.output.type` is
 * "Conditionally Required" — emitting an empty-string sentinel pollutes
 * downstream modality filters.
 */
export type WeaveOutputType = "text" | "json" | "image" | "speech";

export function detectOutputType(lastAssistant: unknown): WeaveOutputType | undefined {
  if (lastAssistant === undefined || lastAssistant === null) return undefined;
  if (typeof lastAssistant !== "object") return undefined;
  const la = lastAssistant as Record<string, unknown>;

  // Plain string content -> text.
  if (typeof la.content === "string") {
    return la.content.length > 0 ? "text" : undefined;
  }
  if (!Array.isArray(la.content)) return undefined;
  const parts = la.content;
  if (parts.length === 0) return undefined;

  let hasImage = false;
  let hasSpeech = false;
  let hasText = false;
  let hasToolUse = false;
  for (const p of parts) {
    if (!p || typeof p !== "object") continue;
    const t = (p as { type?: unknown }).type;
    if (t === "image") hasImage = true;
    else if (t === "audio" || t === "speech") hasSpeech = true;
    else if (t === "text") hasText = true;
    else if (t === "tool_use") hasToolUse = true;
  }
  if (hasImage) return "image";
  if (hasSpeech) return "speech";
  if (hasText) return "text";
  if (hasToolUse) return "json";
  return undefined;
}
