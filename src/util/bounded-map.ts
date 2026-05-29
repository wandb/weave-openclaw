// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

const BOUNDED_MAP_CAP = 4096;

// FIFO-bounded Map: a new key at capacity evicts the oldest entry. Typed as
// BoundedMap (not Map) so the bound is visible at each declaration.
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
