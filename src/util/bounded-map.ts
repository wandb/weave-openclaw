// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

/**
 * Shared FIFO cap for every plugin-owned Map. One number, one knob: turn
 * it up if a real workload hits the bound, but every map shares the same
 * bound so memory growth is bounded uniformly.
 */
export const BOUNDED_MAP_CAP = 4096;

/**
 * Set a key on a Map with FIFO size bound. If the Map is at capacity AND the
 * key is new, the oldest entry (first-inserted) is evicted before insert.
 * Maps in JS preserve insertion order, so this is O(1).
 *
 * Used to defend against unbounded growth when an event stream is interrupted
 * mid-flight (gateway crash, dropped conversation) and would otherwise leave
 * dangling per-trace state forever.
 */
export function setBoundedMap<K, V>(
  map: Map<K, V>,
  key: K,
  value: V,
  cap: number,
): void {
  if (map.size >= cap && !map.has(key)) {
    const oldestKey = map.keys().next().value;
    if (oldestKey !== undefined) {
      map.delete(oldestKey);
    }
  }
  map.set(key, value);
}
