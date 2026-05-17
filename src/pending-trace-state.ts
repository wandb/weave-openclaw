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
 * stamp/drain.
 *
 * Two drain hooks:
 *   - `drainOnInvokeAgentStart` — apply every buffered datum keyed by this
 *     trace (cost / aggregate usage / tool.loop events / context snapshot)
 *     and consume the per-sessionKey pending session_start.
 *   - `drainOnInvokeAgentEnd` — stamp the final cumulative cost and clear
 *     every per-trace bucket. Caller is responsible for the matching
 *     `invokeAgents.unregister(span)` and `invokeAgents.forgetSessionKey(traceId)`.
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
   * Apply every buffered datum keyed by `traceId` to the freshly-opened
   * invoke_agent `span`, and consume the per-sessionKey pending session_start
   * (if any). The cost is stamped if known, but NOT cleared — it continues
   * to accumulate from later `model.usage` events until the span finalizes.
   */
  drainOnInvokeAgentStart(p: {
    span: Span;
    traceId: string;
    sessionKey?: string;
  }): void {
    const cost = this.costByTrace.get(p.traceId);
    if (typeof cost === "number" && Number.isFinite(cost)) {
      p.span.setAttribute("weave.cost.usd", cost);
    }
    const usage = this.usageByTrace.get(p.traceId);
    if (usage) {
      for (const [k, v] of Object.entries(usage)) p.span.setAttribute(k, v);
    }
    const loops = this.toolLoopsByTrace.get(p.traceId);
    if (loops) {
      for (const ev of loops) p.span.addEvent(ev.name, ev.attrs);
      this.toolLoopsByTrace.delete(p.traceId);
    }
    const context = this.contextByTrace.get(p.traceId);
    if (context) {
      for (const [k, v] of Object.entries(context)) p.span.setAttribute(k, v);
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
   * Stamp the final cumulative cost on `span` (the authoritative final value)
   * and clear every per-trace bucket for this `traceId`. The sessionStart
   * map is intentionally not cleared here — it's keyed by sessionKey, not
   * traceId, and may be needed by a future invoke_agent in the same session.
   */
  drainOnInvokeAgentEnd(p: { span: Span; traceId: string }): void {
    const cost = this.costByTrace.get(p.traceId);
    if (typeof cost === "number" && Number.isFinite(cost)) {
      p.span.setAttribute("weave.cost.usd", cost);
    }
    this.costByTrace.delete(p.traceId);
    this.usageByTrace.delete(p.traceId);
    this.toolLoopsByTrace.delete(p.traceId);
    this.contextByTrace.delete(p.traceId);
  }

  clear(): void {
    this.costByTrace.clear();
    this.usageByTrace.clear();
    this.toolLoopsByTrace.clear();
    this.contextByTrace.clear();
    this.sessionStartByKey.clear();
  }
}
