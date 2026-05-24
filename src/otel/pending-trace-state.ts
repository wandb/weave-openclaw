// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

import type { Span } from "@opentelemetry/api";
import { setBoundedMap } from "./bounded-map.js";

export type PendingToolLoop = {
  name: "tool.loop";
  attrs: Record<string, string | number | boolean>;
};

/**
 * Per-trace and per-sessionKey buffers for side-channel data that may arrive
 * before — or alongside — its target `invoke_agent` span exists.
 *
 * The OpenClaw runtime dispatches `model.usage`, `tool.loop`,
 * `context.assembled`, and `session_start` independently of the main span
 * lifecycle, so a usage event for a run can fire before downstream listeners
 * observe `run.started`. We buffer until the invoke_agent appears, then
 * stamp/replay.
 *
 * Buffered data splits into two categories:
 *
 *   - **Running state** (`cost`, `usage`, `context`) — continuously updated
 *     by subsequent `model.usage` / `context.assembled` events. Stamped on
 *     the live span mid-flight by the service's handlers; `hydrate*` brings
 *     a freshly-opened span up to current values without clearing them; cost
 *     and usage get a final defensive stamp on `finalize*` (in case the last
 *     update arrived between the last mid-flight stamp and run.completed),
 *     then everything is cleared.
 *
 *   - **One-shot buffers** (`tool.loop` events, pending `session_start`) —
 *     replayed exactly once on `hydrate*` and cleared from the buffer so the
 *     next invoke_agent for the same trace/session doesn't see them again.
 *
 * FIFO-bounded per Map to defend against unbounded growth.
 */
export class PendingTraceState {
  private readonly costByTrace = new Map<string, number>();
  private readonly usageByTrace = new Map<string, Record<string, number>>();
  private readonly toolLoopsByTrace = new Map<string, PendingToolLoop[]>();
  private readonly contextByTrace = new Map<string, Record<string, number>>();
  private readonly sessionStartByKey = new Map<string, { resumedFrom?: string }>();

  constructor(private readonly cap: number) {}

  /**
   * Accumulate `addend` into the cumulative-cost bucket for `traceId`.
   * Returns the new running total. NaN/non-finite addends are ignored and
   * the current total is returned unchanged.
   */
  addCost(traceId: string, addend: number): number | undefined {
    if (!Number.isFinite(addend)) return this.costByTrace.get(traceId);
    const prev = this.costByTrace.get(traceId) ?? 0;
    const total = prev + addend;
    setBoundedMap(this.costByTrace, traceId, total, this.cap);
    return total;
  }

  /**
   * Merge `patch` into the per-trace aggregate-usage bucket. Returns the
   * merged snapshot so the caller can stamp it directly on the invoke_agent
   * span when it already exists.
   */
  mergeUsage(
    traceId: string,
    patch: Record<string, number>,
  ): Record<string, number> {
    const prev = this.usageByTrace.get(traceId) ?? {};
    const merged = { ...prev, ...patch };
    if (Object.keys(merged).length > 0) {
      setBoundedMap(this.usageByTrace, traceId, merged, this.cap);
    }
    return merged;
  }

  /**
   * Buffer a tool.loop span-event for later replay on the invoke_agent.
   * If the span already exists, callers should add the event directly rather
   * than going through this method.
   */
  bufferToolLoop(traceId: string, ev: PendingToolLoop): void {
    const pending = this.toolLoopsByTrace.get(traceId) ?? [];
    pending.push(ev);
    setBoundedMap(this.toolLoopsByTrace, traceId, pending, this.cap);
  }

  /**
   * Set the latest context.assembled snapshot for this trace. Replaces (not
   * merges) the prior snapshot — context.assembled fires on each turn with
   * the current authoritative numbers.
   */
  setContext(traceId: string, snapshot: Record<string, number>): void {
    if (Object.keys(snapshot).length === 0) return;
    setBoundedMap(this.contextByTrace, traceId, snapshot, this.cap);
  }

  /**
   * Buffer a session_start event by sessionKey for stamping on the next
   * invoke_agent that starts with that key. Overwrites any prior pending
   * entry — only the most recent session_start matters.
   */
  bufferSessionStart(sessionKey: string, p: { resumedFrom?: string }): void {
    setBoundedMap(this.sessionStartByKey, sessionKey, p, this.cap);
  }

  getCost(traceId: string): number | undefined {
    return this.costByTrace.get(traceId);
  }

  getUsage(traceId: string): Record<string, number> | undefined {
    return this.usageByTrace.get(traceId);
  }

  getContext(traceId: string): Record<string, number> | undefined {
    return this.contextByTrace.get(traceId);
  }

  /**
   * Initialise a freshly-opened invoke_agent span with current per-trace
   * state. Two categories of work:
   *
   *   - **Running state** (cost, usage, context): stamp current values on
   *     the span. NOT cleared — they keep being updated by subsequent
   *     `model.usage` / `context.assembled` events. The handlers will
   *     re-stamp the live span mid-flight as updates arrive.
   *   - **One-shot buffers** (tool.loop events, pending session_start):
   *     replay each exactly once and clear from the buffer. A future
   *     invoke_agent for the same trace/session must not see them again.
   */
  hydrateInvokeAgentSpan(p: {
    span: Span;
    traceId: string;
    sessionKey?: string;
  }): void {
    // Running state: stamp without clearing.
    const cost = this.costByTrace.get(p.traceId);
    if (typeof cost === "number" && Number.isFinite(cost)) {
      p.span.setAttribute("weave.cost.usd", cost);
    }
    const usage = this.usageByTrace.get(p.traceId);
    if (usage) {
      for (const [k, v] of Object.entries(usage)) p.span.setAttribute(k, v);
    }
    const context = this.contextByTrace.get(p.traceId);
    if (context) {
      for (const [k, v] of Object.entries(context)) p.span.setAttribute(k, v);
    }
    // One-shots: replay exactly once, then clear.
    const loops = this.toolLoopsByTrace.get(p.traceId);
    if (loops) {
      for (const ev of loops) p.span.addEvent(ev.name, ev.attrs);
      this.toolLoopsByTrace.delete(p.traceId);
    }
    if (p.sessionKey) {
      const pendingSession = this.sessionStartByKey.get(p.sessionKey);
      if (pendingSession) {
        const evAttrs: Record<string, string | number | boolean> = {};
        if (pendingSession.resumedFrom) {
          evAttrs["weave.session.resumed_from"] = pendingSession.resumedFrom;
        }
        p.span.addEvent("session_started", evAttrs);
        this.sessionStartByKey.delete(p.sessionKey);
      }
    }
  }

  /**
   * Stamp final running totals (cost, usage) on the invoke_agent span and
   * clear all per-trace buckets. Mid-flight stamping has already written
   * current values to the span; the re-stamp here is defensive against the
   * case where a `model.usage` event arrived between the last mid-flight
   * stamp and run.completed.
   *
   * Context is intentionally NOT re-stamped: it's a snapshot (each
   * `context.assembled` replaces the prior value rather than accumulating),
   * so whatever's on the span is already the latest authoritative value.
   *
   * `sessionStartByKey` is intentionally NOT touched: it's keyed by
   * sessionKey, not traceId, and may legitimately be consumed by the next
   * invoke_agent in the same session.
   */
  finalizeInvokeAgentSpan(p: { span: Span; traceId: string }): void {
    const cost = this.costByTrace.get(p.traceId);
    if (typeof cost === "number" && Number.isFinite(cost)) {
      p.span.setAttribute("weave.cost.usd", cost);
    }
    const usage = this.usageByTrace.get(p.traceId);
    if (usage) {
      for (const [k, v] of Object.entries(usage)) p.span.setAttribute(k, v);
    }
    this.costByTrace.delete(p.traceId);
    this.usageByTrace.delete(p.traceId);
    this.contextByTrace.delete(p.traceId);
    this.toolLoopsByTrace.delete(p.traceId);
  }

  clear(): void {
    this.costByTrace.clear();
    this.usageByTrace.clear();
    this.toolLoopsByTrace.clear();
    this.contextByTrace.clear();
    this.sessionStartByKey.clear();
  }
}
