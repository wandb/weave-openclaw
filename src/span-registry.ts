// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

import {
  context as otelContext,
  trace as otelTrace,
  type Context,
  type Span,
  type SpanKind,
  type Tracer,
} from "@opentelemetry/api";
import { setBoundedMap } from "./bounded-map.js";

export type DebugLogger = { debug: (msg: string) => void };

export type ResolveParentResult =
  | { kind: "ok"; ctx: Context; resolved: boolean }
  | { kind: "orphan-drop"; reason: string };

export type OpenSpanParams = {
  spanName: string;
  spanKind: SpanKind;
  /**
   * When supplied, the new span is indexed in `activeSpans` so future events
   * can resolve it as a parent and `closeSpan` can finalize it. Omit for
   * one-shot spans (compaction, subagent) that don't need lookup.
   */
  openclawSpanId?: string;
  openclawParentSpanId?: string;
  attrs: Record<string, string | number | boolean>;
  startTimeMs: number;
  /**
   * When true, the span may still be created even if `openclawParentSpanId`
   * is set but unresolved — the span becomes a trace root. Used for
   * legitimately-rootable spans (invoke_agent) and intentionally-unrooted
   * subagent spans (no requesterRunId).
   *
   * When false (default), an unresolved parent triggers orphan-drop.
   */
  allowRootless?: boolean;
};

export type OpenSpanResult =
  | { kind: "ok"; span: Span; parentResolved: boolean }
  | { kind: "orphan-drop"; reason: string }
  | { kind: "duplicate"; existing: Span };

export type CloseSpanParams = {
  openclawSpanId: string;
  endTimeMs: number;
  status: { code: 0 | 1 | 2; message?: string };
  attrs?: Record<string, string | number | boolean>;
  exception?: { name: string; message: string };
};

/**
 * Owns the lifecycle of OTel spans keyed by OpenClaw `spanId`. Provides:
 *
 *   - Parent resolution (`resolveParent`) — the single source of truth for the
 *     "drop a child span when its parent isn't active" policy. All emit sites
 *     (mapper-driven, compaction, subagent) call into this so the policy
 *     can't drift across them.
 *   - Span creation with bounded indexing (`openSpan`) — caller-side spanId
 *     lookup is needed so future events can claim this span as their parent
 *     and `closeSpan` can finalize it. One-shot spans (compaction, subagent)
 *     omit `openclawSpanId` and skip indexing.
 *   - Tree dump (`dumpTree`) — debug-mode visualisation of currently-active
 *     spans grouped by traceId, with parent linkage shown via indentation.
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

  /**
   * Look up an active span by its OpenClaw `spanId`. Returns undefined when
   * the span has already been closed or was never tracked.
   */
  get(openclawSpanId: string): Span | undefined {
    return this.activeSpans.get(openclawSpanId);
  }

  size(): number {
    return this.activeSpans.size;
  }

  /**
   * Resolve a parent OTel `Context` from an OpenClaw parent spanId. Returns
   * `{ kind: "ok" }` with the resolved context (or the current active context
   * when no parent was claimed), or `{ kind: "orphan-drop" }` when a parent
   * was claimed but isn't in `activeSpans` and `allowRootless` is false.
   */
  resolveParent(
    parentOpenclawSpanId: string | undefined,
    allowRootless: boolean,
  ): ResolveParentResult {
    let ctx = otelContext.active();
    let resolved = false;
    if (parentOpenclawSpanId) {
      const parentSpan = this.activeSpans.get(parentOpenclawSpanId);
      if (parentSpan) {
        ctx = otelTrace.setSpan(ctx, parentSpan);
        resolved = true;
      }
    }
    if (parentOpenclawSpanId && !resolved && !allowRootless) {
      return { kind: "orphan-drop", reason: "parent-not-in-activeSpans" };
    }
    return { kind: "ok", ctx, resolved };
  }

  /**
   * Resolve parent context, create the span, and (if `openclawSpanId` is
   * supplied) index it for future lookup. Idempotent on duplicate
   * `openclawSpanId` — returns `{ kind: "duplicate", existing }` rather than
   * creating a second span.
   */
  openSpan(p: OpenSpanParams): OpenSpanResult {
    if (p.openclawSpanId !== undefined) {
      const existing = this.activeSpans.get(p.openclawSpanId);
      if (existing) return { kind: "duplicate", existing };
    }
    const parent = this.resolveParent(
      p.openclawParentSpanId,
      p.allowRootless ?? false,
    );
    if (parent.kind === "orphan-drop") {
      return { kind: "orphan-drop", reason: parent.reason };
    }
    const span = this.tracer.startSpan(
      p.spanName,
      {
        kind: p.spanKind,
        attributes: p.attrs,
        startTime: new Date(p.startTimeMs),
      },
      parent.ctx,
    );
    if (p.openclawSpanId !== undefined) {
      setBoundedMap(this.activeSpans, p.openclawSpanId, span, this.cap);
      this.spanMeta.set(p.openclawSpanId, {
        name: p.spanName,
        parentOpenclawSpanId: p.openclawParentSpanId,
      });
    }
    return { kind: "ok", span, parentResolved: parent.resolved };
  }

  /**
   * Finalize an indexed span: set extra attrs, optionally record an exception
   * event, set status, end at the given time, and drop the indexing entry.
   * Returns the closed span (or undefined when the spanId was never tracked /
   * was already closed) so callers can perform last-minute cleanup keyed by
   * Span identity.
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
      p.status.message
        ? { code: p.status.code, message: p.status.message }
        : { code: p.status.code },
    );
    span.end(new Date(p.endTimeMs));
    this.activeSpans.delete(p.openclawSpanId);
    this.spanMeta.delete(p.openclawSpanId);
    return span;
  }

  /**
   * End every currently-tracked span (used during service teardown so spans
   * for in-flight runs are flushed rather than leaked). Errors during end()
   * are swallowed — at this point we've already lost the conversation.
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
      const ctxIds = span.spanContext();
      const node: Node = {
        openclawSpanId,
        name: meta.name,
        parentOpenclawSpanId: meta.parentOpenclawSpanId,
      };
      const list = byTrace.get(ctxIds.traceId) ?? [];
      list.push(node);
      byTrace.set(ctxIds.traceId, list);
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
