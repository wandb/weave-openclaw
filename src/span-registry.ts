// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

import {
  context as otelContext,
  trace as otelTrace,
  type Span,
  type SpanKind,
  type Tracer,
} from "@opentelemetry/api";
import { setBoundedMap } from "./bounded-map.js";

export type DebugLogger = { debug: (msg: string) => void };

export type OpenSpanParams = {
  spanName: string;
  spanKind: SpanKind;
  /**
   * When set, the new span is indexed in `activeSpans` so future events can
   * resolve it as a parent and `closeSpan` can finalize it. Omit for one-shot
   * spans (compaction, subagent) that need parent resolution + creation but
   * not lookup.
   */
  openclawSpanId?: string;
  /**
   * OpenClaw spanId of the claimed parent. Recorded in `spanMeta` for the
   * trace-tree debug dump and used in span-create / orphan-drop log lines.
   * Independent of `parentSpan` — for the subagent/InvokeAgentIndex case
   * where the parent is looked up by runId rather than spanId, leave this
   * undefined.
   */
  openclawParentSpanId?: string;
  /**
   * Pre-resolved parent `Span`, or undefined if the caller looked but found
   * none. Used in concert with `claimsParent` to drive the orphan-drop
   * decision.
   */
  parentSpan?: Span;
  /**
   * `true` when the caller intended to attach this span under a parent
   * (regardless of whether `parentSpan` was resolved). When `parentSpan` is
   * undefined and `claimsParent=true` and `allowRootless=false`, the span is
   * orphan-dropped.
   *
   * `false` (default) means the span is intentionally rootless — e.g.
   * subagent spawned without a requesterRunId.
   */
  claimsParent?: boolean;
  /**
   * Override the orphan-drop policy and let the span be created as a trace
   * root even when its claimed parent isn't active. Used for `invoke_agent`
   * (whose claimed parent may live in OpenClaw's upstream harness layer we
   * don't observe).
   */
  allowRootless?: boolean;
  attrs: Record<string, string | number | boolean>;
  startTimeMs: number;
  /**
   * Free-form `key=value key=value` string appended to the orphan-drop debug
   * log so callers can carry their own context (e.g. `requesterRunId=...
   * subagentRunId=...`) without forcing it into the type system.
   */
  debugContext?: string;
};

export type OpenSpanResult =
  | { kind: "ok"; span: Span; parentResolved: boolean }
  | { kind: "orphan-drop"; reason: string }
  | { kind: "duplicate"; existing: Span };

export type CloseSpanParams = {
  openclawSpanId: string;
  endTimeMs: number;
  /** OTel SpanStatusCode (`UNSET=0`, `OK=1`, `ERROR=2`). */
  statusCode: 0 | 1 | 2;
  statusMessage?: string;
  /** Additional attrs to set immediately before ending the span. */
  attrs?: Record<string, string | number | boolean>;
  /** Exception event to record (per OTel `recording-errors.md`). */
  exception?: { name: string; message: string };
};

/**
 * Owns the lifecycle of OTel spans keyed by OpenClaw `spanId`. The single
 * source of truth for:
 *
 *   - Parent resolution + orphan-drop policy (`openSpan`) — all emit sites
 *     route through one method so the "what counts as a legitimate root"
 *     rule cannot drift across them.
 *   - Span indexing for parent linkage (`get`, `closeSpan`) — future events
 *     can claim a span by its OpenClaw spanId and finalize it.
 *   - Per-span metadata for the trace-tree debug dump (`dumpTree`) — the
 *     OTel Span API doesn't expose `parentSpanId` or `name`, so we track
 *     them alongside the indexed Span.
 *
 * FIFO-bounded to `cap` entries to defend against unbounded growth when an
 * event stream is interrupted (gateway crash, dropped conversation).
 */
export class SpanRegistry {
  private readonly activeSpans = new Map<string, Span>();
  private readonly spanMeta = new Map<
    string,
    { name: string; parentOpenclawSpanId?: string }
  >();

  constructor(
    private readonly tracer: Tracer,
    private readonly cap: number,
    private readonly debugLogger?: DebugLogger,
  ) {}

  /** Look up an indexed span by its OpenClaw `spanId`. */
  get(openclawSpanId: string): Span | undefined {
    return this.activeSpans.get(openclawSpanId);
  }

  size(): number {
    return this.activeSpans.size;
  }

  /**
   * Resolve parent, drop or create span, and (if `openclawSpanId` is set)
   * index the span for future lookup. Logs an orphan-drop line through
   * `debugLogger` when applicable. Idempotent on duplicate `openclawSpanId`.
   */
  openSpan(p: OpenSpanParams): OpenSpanResult {
    if (p.openclawSpanId !== undefined) {
      const existing = this.activeSpans.get(p.openclawSpanId);
      if (existing) return { kind: "duplicate", existing };
    }

    const claimsParent = p.claimsParent ?? false;
    const parentResolved = !!p.parentSpan;
    if (claimsParent && !parentResolved && !(p.allowRootless ?? false)) {
      this.debugLogger?.debug(
        `[weave debug] drop-orphan span=${p.spanName}${
          p.debugContext ? ` ${p.debugContext}` : ""
        } reason=parent-not-resolved`,
      );
      return { kind: "orphan-drop", reason: "parent-not-resolved" };
    }

    const active = otelContext.active();
    const parentCtx = p.parentSpan
      ? otelTrace.setSpan(active, p.parentSpan)
      : active;

    const span = this.tracer.startSpan(
      p.spanName,
      {
        kind: p.spanKind,
        attributes: p.attrs,
        startTime: new Date(p.startTimeMs),
      },
      parentCtx,
    );

    if (p.openclawSpanId !== undefined) {
      setBoundedMap(this.activeSpans, p.openclawSpanId, span, this.cap);
      this.spanMeta.set(p.openclawSpanId, {
        name: p.spanName,
        parentOpenclawSpanId: p.openclawParentSpanId,
      });
      this.debugLogger?.debug(
        `[weave debug] span-create name=${p.spanName} traceId=${span.spanContext().traceId} spanId=${p.openclawSpanId} parentSpanId=${p.openclawParentSpanId ?? "<none>"} parentResolved=${parentResolved}`,
      );
    }

    return { kind: "ok", span, parentResolved };
  }

  /**
   * Finalize an indexed span: set extra attrs, optionally record an exception
   * event, set status, end at the given time, and drop the indexing entry.
   * Returns the closed `Span` (or undefined when the spanId was never tracked
   * / was already closed) so callers can do last-mile cleanup keyed on Span
   * identity (e.g. `InvokeAgentIndex.unregister(span)`).
   */
  closeSpan(p: CloseSpanParams): Span | undefined {
    const span = this.activeSpans.get(p.openclawSpanId);
    if (!span) return undefined;
    if (p.attrs && Object.keys(p.attrs).length > 0) {
      span.setAttributes(p.attrs);
    }
    if (p.exception) {
      span.recordException(p.exception);
    }
    span.setStatus(
      p.statusMessage
        ? { code: p.statusCode, message: p.statusMessage }
        : { code: p.statusCode },
    );
    span.end(new Date(p.endTimeMs));
    this.activeSpans.delete(p.openclawSpanId);
    this.spanMeta.delete(p.openclawSpanId);
    return span;
  }

  /**
   * End every currently-indexed span (used during service teardown so spans
   * for in-flight runs are flushed rather than leaked). Errors during end()
   * are swallowed — at this point the conversation is already lost.
   */
  endAllRemaining(): void {
    for (const span of this.activeSpans.values()) {
      try {
        span.end();
      } catch {
        // ignore
      }
    }
    this.activeSpans.clear();
    this.spanMeta.clear();
  }

  /**
   * Render the active span set grouped by traceId, with indentation reflecting
   * parent linkage. Activated by `OPENCLAW_WEAVE_DEBUG=trace-tree` to diagnose
   * structural issues like "this trace has 5 invoke_agents" or "tool span is
   * a sibling of invoke_agent instead of a descendant of chat".
   */
  dumpTree(reason: string): void {
    if (!this.debugLogger) return;
    if (this.activeSpans.size === 0) {
      this.debugLogger.debug(`[weave debug] trace-tree (after ${reason}): <empty>`);
      return;
    }
    type Node = {
      openclawSpanId: string;
      name: string;
      parentOpenclawSpanId?: string;
    };
    const byTrace = new Map<string, Node[]>();
    for (const [openclawSpanId, span] of this.activeSpans) {
      const meta = this.spanMeta.get(openclawSpanId) ?? { name: "?" };
      const traceId = span.spanContext().traceId;
      const list = byTrace.get(traceId) ?? [];
      list.push({
        openclawSpanId,
        name: meta.name,
        parentOpenclawSpanId: meta.parentOpenclawSpanId,
      });
      byTrace.set(traceId, list);
    }
    const lines: string[] = [
      `[weave debug] trace-tree (after ${reason}, ${this.activeSpans.size} active span${this.activeSpans.size === 1 ? "" : "s"}):`,
    ];
    for (const [traceId, nodes] of byTrace) {
      lines.push(`  trace=${traceId}`);
      const ids = new Set(nodes.map((n) => n.openclawSpanId));
      const childrenOf = new Map<string, Node[]>();
      const roots: Node[] = [];
      for (const n of nodes) {
        if (n.parentOpenclawSpanId && ids.has(n.parentOpenclawSpanId)) {
          const list = childrenOf.get(n.parentOpenclawSpanId) ?? [];
          list.push(n);
          childrenOf.set(n.parentOpenclawSpanId, list);
        } else {
          roots.push(n);
        }
      }
      const render = (n: Node, indent: number): void => {
        lines.push(
          `${" ".repeat(indent)}${n.name} [openclawSpanId=${n.openclawSpanId}${n.parentOpenclawSpanId ? `, claimedParent=${n.parentOpenclawSpanId}` : ""}]`,
        );
        for (const c of childrenOf.get(n.openclawSpanId) ?? []) {
          render(c, indent + 2);
        }
      };
      for (const r of roots) render(r, 4);
    }
    this.debugLogger.debug(lines.join("\n"));
  }
}
