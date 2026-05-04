// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

import { redactSensitiveText } from "openclaw/plugin-sdk/security-runtime";

/**
 * Soft budget for a single span attribute's serialized JSON. OTel's
 * `OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT` defaults to "no limit"; most SDKs
 * mirror that. We pick a generous-but-bounded budget so:
 *
 *   - Real conversations (10–50 messages, occasional 50KB tool result) pass
 *     through untouched. As an LLM-observability tool the whole point is to
 *     show what was sent — eagerly eliding it defeats the purpose.
 *   - We still have a safety net against pathological inputs (e.g. a skill
 *     returning a 50 MB blob) that would otherwise blow up OTLP's ~4 MiB
 *     request limit and lose the entire span.
 *
 * 256 KiB was picked over the previous 8 KiB after producer-side truncation
 * was found to corrupt JSON arrays in `weave.input.messages`, which in turn
 * caused Weave's `_normalize_raw_messages` to fall back to wrapping the
 * entire malformed string as one fake user message. With 256 KiB, real
 * traces effectively never hit `shrinkJsonValueToFit`. Post-mortem:
 * `2026-05-03-wandb-bug-report-input-messages-empty.md`.
 */
const MAX_ATTRIBUTE_CHARS = 256 * 1024;
/**
 * Soft cap on array length applied during the recursive `walk`. Real-world
 * conversations rarely exceed this; well below the cap, `walk` is a no-op
 * and the size-based `shrinkJsonValueToFit` is what enforces the byte
 * budget. The cap exists as a defense against pathological inputs only.
 *
 * When triggered, `walk` keeps the LAST `MAX_ARRAY_ITEMS` items (the most
 * recent messages in a chat history) and prepends a marker. Keeping the
 * tail matters: the in-flight user prompt is the very last item in
 * `weave.input.messages`, and the previous behavior (`slice(0, 32)`)
 * silently dropped it whenever history exceeded 32 turns.
 */
const MAX_ARRAY_ITEMS = 256;
/**
 * Floor a string-leaf can be truncated to before we stop trying to shrink it
 * further. Keeps the truncated value useful (you can still see what kind of
 * text it was) without hitting infinite-shrink cycles on tiny strings.
 */
const MIN_STRING_KEEP_AFTER_SHRINK = 64;
/**
 * Headroom reserved when truncating a primitive-string root: 2 chars for the
 * JSON-stringify quotes, ~24 chars for the `…[truncated Nc]` marker so the
 * total `JSON.stringify(result).length` actually fits under `MAX_ATTRIBUTE_CHARS`.
 */
const ROOT_STRING_FRAME_BUDGET = 2 + 24;

/**
 * Sanitize a string for emission as a span attribute:
 * - run OpenClaw's secret redaction
 * - hard-clamp to MAX_ATTRIBUTE_CHARS to keep payloads bounded
 * - returns undefined for empty strings (so callers can skip attribute set)
 */
export function sanitizeAttrString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const redacted = redactSensitiveText(value);
  if (redacted.length === 0) {
    return undefined;
  }
  return redacted.length > MAX_ATTRIBUTE_CHARS
    ? `${redacted.slice(0, MAX_ATTRIBUTE_CHARS)}…[truncated ${redacted.length - MAX_ATTRIBUTE_CHARS}c]`
    : redacted;
}

/**
 * JSON-stringify a structured value (array or object) with redaction applied
 * to string leaves. Trims arrays to MAX_ARRAY_ITEMS to keep payloads bounded.
 * Returns undefined when the input doesn't yield a useful payload.
 *
 * When the serialized output would exceed `MAX_ATTRIBUTE_CHARS`, we
 * **structurally** truncate so the result is still valid JSON — see
 * `shrinkJsonValueToFit` for the algorithm. Byte-level slicing here used to
 * produce malformed JSON that Weave's trace server fallback-wrapped as a
 * single user message containing the entire mangled blob (verified against
 * `_normalize_raw_messages` on master).
 */
export function sanitizeAttrJson(value: unknown): string | undefined {
  return sanitizeAttrJsonWithFlag(value)?.value;
}

/**
 * Same as `sanitizeAttrString`, but returns a flag indicating whether the
 * `MAX_ATTRIBUTE_CHARS` clamp triggered. Used by callers that want to emit
 * a sibling `*._truncated: true` attribute so dashboards can filter for
 * truncated traces without string-matching the inline `…[truncated Nc]`
 * marker.
 */
export type SanitizedWithFlag = { value: string; truncated: boolean };

export function sanitizeAttrStringWithFlag(
  value: unknown,
): SanitizedWithFlag | undefined {
  if (typeof value !== "string") return undefined;
  const redacted = redactSensitiveText(value);
  if (redacted.length === 0) return undefined;
  if (redacted.length > MAX_ATTRIBUTE_CHARS) {
    return {
      value: `${redacted.slice(0, MAX_ATTRIBUTE_CHARS)}…[truncated ${redacted.length - MAX_ATTRIBUTE_CHARS}c]`,
      truncated: true,
    };
  }
  return { value: redacted, truncated: false };
}

export function sanitizeAttrJsonWithFlag(
  value: unknown,
): SanitizedWithFlag | undefined {
  if (value === undefined || value === null) return undefined;
  const sanitized = walk(value, 0);
  if (sanitized === undefined) return undefined;
  let serialized: string;
  try {
    serialized = JSON.stringify(sanitized);
  } catch {
    return undefined;
  }
  if (serialized.length === 0) return undefined;
  if (serialized.length <= MAX_ATTRIBUTE_CHARS) {
    return { value: serialized, truncated: false };
  }
  // Over budget. Structurally truncate so the result remains valid JSON.
  // Why this matters: the Weave trace server's `_normalize_raw_messages`
  // does `json.loads(value)` on `weave.input.messages` /
  // `weave.output.messages` and falls back to wrapping the whole malformed
  // string as a single `{role, content, ""}` if parsing fails. The previous
  // byte-slice strategy reliably produced malformed JSON whenever the
  // serialized array exceeded 8 KiB (a long tool-result content was the
  // common trigger), causing the server to store an entire conversation
  // history as one giant `content` blob instead of a parsed message list.
  const shrunk = shrinkJsonValueToFit(sanitized, MAX_ATTRIBUTE_CHARS);
  let result: string;
  try {
    result = JSON.stringify(shrunk);
  } catch {
    return undefined;
  }
  return { value: result, truncated: true };
}

/**
 * Shrink a sanitized JSON value so `JSON.stringify(result).length <= maxChars`
 * while keeping the result valid JSON. Mutates the input.
 *
 * **Three-phase strategy designed to preserve the in-flight tail message.**
 * For `weave.input.messages` the last item in the root array is the prompt
 * the user just sent — eliding it makes the trace useless as a debug tool.
 * Same for `weave.output.messages` (latest assistant turn).
 *
 *   1. **Shrink string leaves OUTSIDE the protected tail.** When the root is
 *      a non-empty array, Phase 1 won't touch the subtree at the last index.
 *      Iteratively halve the longest string leaf elsewhere (never below
 *      `MIN_STRING_KEEP_AFTER_SHRINK`), with the existing `…[truncated Nc]`
 *      marker so the truncation is visible to humans.
 *   2. **Drop oldest array items.** If still over budget after Phase 1,
 *      drop items from the head of the root array. The protected tail is
 *      never dropped.
 *   3. **Last resort: shrink anywhere, including the protected tail.** Only
 *      reached if the protected item alone exceeds `maxChars` — i.e. the
 *      user just pasted a 300 KiB blob. Falls back to the same iterative
 *      string-leaf halving but with no protection.
 *
 * Root primitive strings are char-truncated directly, reserving headroom for
 * the JSON-stringify quotes. Object roots have no protection (no notion of
 * "tail").
 *
 * Always produces valid JSON. Guaranteed to terminate (string slack runs
 * out, array shrinks to length 1, or the loop iteration cap fires).
 *
 * @internal exported for tests.
 */
export function shrinkJsonValueToFit(value: unknown, maxChars: number): unknown {
  if (typeof value === "string") {
    const innerBudget = Math.max(
      MIN_STRING_KEEP_AFTER_SHRINK,
      maxChars - ROOT_STRING_FRAME_BUDGET,
    );
    if (value.length <= innerBudget) return value;
    return `${value.slice(0, innerBudget)}…[truncated ${value.length - innerBudget}c]`;
  }
  const isRootArray = Array.isArray(value);
  // Index of the protected tail item — the in-flight prompt for
  // weave.input.messages or the latest assistant turn for
  // weave.output.messages. Phases 1 and 2 never touch it.
  let protectedIndex =
    isRootArray && (value as unknown[]).length > 0
      ? (value as unknown[]).length - 1
      : -1;
  // Phase 1: shrink string leaves outside the protected tail.
  for (let iter = 0; iter < 512; iter++) {
    if (JSON.stringify(value).length <= maxChars) return value;
    const target = findLongestStringRef(value, protectedIndex);
    if (!target || target.value.length <= MIN_STRING_KEEP_AFTER_SHRINK) break;
    const newLen = Math.max(
      MIN_STRING_KEEP_AFTER_SHRINK,
      Math.floor(target.value.length / 2),
    );
    target.set(
      `${target.value.slice(0, newLen)}…[truncated ${target.value.length - newLen}c]`,
    );
  }
  // Phase 2: drop array items from the head, keeping the protected tail.
  if (isRootArray) {
    const arr = value as unknown[];
    while (arr.length > 1 && JSON.stringify(value).length > maxChars) {
      arr.shift();
    }
    protectedIndex = arr.length > 0 ? arr.length - 1 : -1;
  }
  // Phase 3: last resort — shrink any string, including in the protected
  // tail. Only reached if the protected item alone exceeds maxChars.
  for (let iter = 0; iter < 512; iter++) {
    if (JSON.stringify(value).length <= maxChars) return value;
    const target = findLongestStringRef(value);
    if (!target || target.value.length <= MIN_STRING_KEEP_AFTER_SHRINK) break;
    const newLen = Math.max(
      MIN_STRING_KEEP_AFTER_SHRINK,
      Math.floor(target.value.length / 2),
    );
    target.set(
      `${target.value.slice(0, newLen)}…[truncated ${target.value.length - newLen}c]`,
    );
  }
  return value;
}

type StringLeafRef = { value: string; set: (next: string) => void };

/**
 * Walk `root` and return a mutable reference to the longest string leaf, or
 * `undefined` if there are no strings deep in the structure. The returned
 * `set` closure overwrites that string leaf in its parent.
 *
 * If `skipRootArrayIndex >= 0` and `root` is an array, the subtree at
 * `root[skipRootArrayIndex]` is skipped entirely. Used by
 * `shrinkJsonValueToFit` Phase 1 to protect the in-flight tail message
 * (the user's prompt at the end of `weave.input.messages`).
 *
 * Cannot mutate a root primitive in place (no parent to set on); callers
 * should handle the `typeof root === "string"` case before calling.
 */
function findLongestStringRef(
  root: unknown,
  skipRootArrayIndex: number = -1,
): StringLeafRef | undefined {
  let best: StringLeafRef | undefined;
  const visit = (node: unknown, setter: (v: string) => void): void => {
    if (typeof node === "string") {
      if (!best || node.length > best.value.length) {
        best = { value: node, set: setter };
      }
      return;
    }
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        const idx = i;
        visit(node[idx], (v) => {
          node[idx] = v;
        });
      }
      return;
    }
    if (node && typeof node === "object") {
      const obj = node as Record<string, unknown>;
      for (const k of Object.keys(obj)) {
        visit(obj[k], (v) => {
          obj[k] = v;
        });
      }
    }
  };
  if (typeof root === "string") return undefined;
  // Top-level: iterate root manually so we can skip the protected index.
  if (Array.isArray(root)) {
    for (let i = 0; i < root.length; i++) {
      if (i === skipRootArrayIndex) continue;
      const idx = i;
      visit(root[idx], (v) => {
        (root as unknown[])[idx] = v;
      });
    }
  } else if (root && typeof root === "object") {
    const obj = root as Record<string, unknown>;
    for (const k of Object.keys(obj)) {
      visit(obj[k], (v) => {
        obj[k] = v;
      });
    }
  }
  return best;
}

function walk(value: unknown, depth: number): unknown {
  if (depth > 6) {
    return "[depth-limit]";
  }
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "string") {
    return redactSensitiveText(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    // Keep the LAST `MAX_ARRAY_ITEMS` items so the most recent turn
    // (specifically the in-flight user prompt at the tail of
    // `weave.input.messages`) survives. `slice(0, N)` would silently drop
    // it whenever history exceeds the cap. Marker is prepended so the
    // server-side `_normalize_raw_messages` shows it before the older
    // surviving items, not after the latest one.
    const tail = value.slice(-MAX_ARRAY_ITEMS).map((v) => walk(v, depth + 1));
    if (value.length > MAX_ARRAY_ITEMS) {
      tail.unshift(`…[${value.length - MAX_ARRAY_ITEMS} more]`);
    }
    return tail;
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = walk(v, depth + 1);
    }
    return out;
  }
  return undefined;
}
