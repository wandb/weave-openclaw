// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

/**
 * Default FIFO cap shared by every plugin-owned BoundedMap. One number, one
 * knob: turn it up if a real workload hits the bound. Each map can override
 * via its constructor if it has a different growth profile.
 */
export const BOUNDED_MAP_CAP = 4096;

/**
 * Map with FIFO size bound. When `set` is called with a new key and the map
 * is at capacity, the oldest entry (first-inserted) is evicted before the
 * insert. Existing-key sets do not trigger eviction. Maps in JS preserve
 * insertion order, so eviction is O(1).
 *
 * Used to defend against unbounded growth when an event stream is
 * interrupted mid-flight (gateway crash, dropped conversation) and would
 * otherwise leave dangling per-trace state forever. Declaring a map's type
 * as `BoundedMap<K, V>` (rather than `Map<K, V>`) makes the bound visible
 * at the declaration so callers cannot forget to enforce it at the
 * call site.
 */
export class BoundedMap<K, V> extends Map<K, V> {
  private readonly cap: number;

  constructor(cap: number = BOUNDED_MAP_CAP) {
    super();
    this.cap = cap;
  }

  override set(key: K, value: V): this {
    if (this.size >= this.cap && !super.has(key)) {
      const oldest = super.keys().next().value;
      if (oldest !== undefined) {
        super.delete(oldest);
      }
    }
    return super.set(key, value);
  }
}
