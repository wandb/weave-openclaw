// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

import type { Span } from "@opentelemetry/api";
import { setBoundedMap } from "./bounded-map.js";

export type InvokeAgentLookup =
  | { by: "traceId"; value: string }
  | { by: "runId"; value: string }
  | { by: "sessionKey"; value: string };

/**
 * Multi-keyed index into the currently-active `invoke_agent` root spans, so
 * non-mapper emit sites (subagent / session / message_received / agent_end /
 * compaction / model.usage / tool.loop / context.assembled) can find their
 * target span by whichever id their source event happens to carry.
 *
 *   - `byTrace`       — model.usage and tool.loop carry only traceId.
 *   - `byRunId`       — subagent_spawned / agent_end / run.attempt carry runId.
 *   - `bySessionKey`  — session_end / message_received may carry sessionKey.
 *   - `sessionKeyByTrace` — a sticky learned mapping so a child event missing
 *     `sessionKey` still groups under its parent's conversation id.
 *
 * Maintains all three indexes in lockstep so `unregister(span)` cleans up
 * every reference by object identity in one call — avoiding the bug class
 * where post-finalize side-channel events would addEvent on an already-ended
 * span because stale entries lingered in just one of the three maps.
 */
export class InvokeAgentIndex {
  private readonly byTrace = new Map<string, Span>();
  private readonly byRunId = new Map<string, Span>();
  private readonly bySessionKey = new Map<string, Span>();
  private readonly sessionKeyByTrace = new Map<string, string>();

  constructor(private readonly cap: number) {}

  /**
   * Index `span` as the active invoke_agent for the given traceId (always
   * required) plus optional runId and sessionKey. Bounded — the oldest entry
   * is evicted when the index exceeds `cap` per axis.
   */
  register(p: {
    span: Span;
    traceId: string;
    runId?: string;
    sessionKey?: string;
  }): void {
    setBoundedMap(this.byTrace, p.traceId, p.span, this.cap);
    if (p.runId) setBoundedMap(this.byRunId, p.runId, p.span, this.cap);
    if (p.sessionKey) {
      setBoundedMap(this.bySessionKey, p.sessionKey, p.span, this.cap);
    }
  }

  /**
   * Remove every reference to `span` from every index by object identity.
   * Called when an invoke_agent finalizes so subsequent side-channel events
   * targeting the same runId/sessionKey are silent no-ops instead of
   * addEvent'ing on a dead span.
   *
   * `sessionKeyByTrace` is a learned mapping not tied to a Span identity, so
   * it is left alone; the caller (when it has the traceId) is responsible for
   * pruning that entry alongside other per-trace bookkeeping.
   */
  unregister(span: Span): void {
    for (const [k, v] of this.byTrace) {
      if (v === span) this.byTrace.delete(k);
    }
    for (const [k, v] of this.byRunId) {
      if (v === span) this.byRunId.delete(k);
    }
    for (const [k, v] of this.bySessionKey) {
      if (v === span) this.bySessionKey.delete(k);
    }
  }

  lookup(key: InvokeAgentLookup): Span | undefined {
    switch (key.by) {
      case "traceId":
        return this.byTrace.get(key.value);
      case "runId":
        return this.byRunId.get(key.value);
      case "sessionKey":
        return this.bySessionKey.get(key.value);
    }
  }

  /**
   * Record a sticky traceId -> sessionKey association learned from any event
   * in this trace that carried sessionKey. Reused by later events that drop
   * the field (common for tool spans), so conversation grouping stays
   * coherent across a multi-turn run.
   */
  learnSessionKey(traceId: string, sessionKey: string): void {
    setBoundedMap(this.sessionKeyByTrace, traceId, sessionKey, this.cap);
  }

  sessionKeyForTrace(traceId: string): string | undefined {
    return this.sessionKeyByTrace.get(traceId);
  }

  /** Drop the learned sessionKey for a trace (called when its invoke_agent ends). */
  forgetSessionKey(traceId: string): void {
    this.sessionKeyByTrace.delete(traceId);
  }

  clear(): void {
    this.byTrace.clear();
    this.byRunId.clear();
    this.bySessionKey.clear();
    this.sessionKeyByTrace.clear();
  }
}
