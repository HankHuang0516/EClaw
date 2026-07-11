'use strict';

/**
 * Anti-replay guard for AdMob SSV callbacks.
 *
 * Google may retry a delivery, and a malicious client may re-post an old query
 * string to try to double-credit itself. We reject any `transaction_id` seen
 * within the last `ttlMs` (default 24h — Google recommends >= the ad-network's
 * retry window).
 *
 * NOTE: This in-memory Map + LRU eviction is a single-process sample. Production
 * with >1 replica MUST swap the storage for Redis / Postgres / an atomic
 * `SETNX transaction_id EX 86400`-style primitive so replays across replicas
 * are caught. `RemoteReplayGuard` interface: `has(id)` + `add(id, expiresAt)`.
 */

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 200_000;

class InMemoryReplayGuard {
  /**
   * @param {{ ttlMs?: number, maxEntries?: number, now?: () => number }} [opts]
   */
  constructor(opts = {}) {
    this.ttlMs = typeof opts.ttlMs === 'number' ? opts.ttlMs : DEFAULT_TTL_MS;
    this.maxEntries = typeof opts.maxEntries === 'number' ? opts.maxEntries : DEFAULT_MAX_ENTRIES;
    this.now = opts.now || (() => Date.now());
    /** @type {Map<string, number>} id -> expiresAt (ms). Map preserves insertion order → LRU. */
    this.entries = new Map();
  }

  /**
   * @param {string} txId
   * @returns {boolean} true if this txId was already recorded and is still fresh.
   */
  has(txId) {
    if (!txId) return false;
    const exp = this.entries.get(txId);
    if (exp == null) return false;
    if (exp <= this.now()) {
      this.entries.delete(txId);
      return false;
    }
    return true;
  }

  /**
   * Mark a txId as seen. No-op if already present.
   * @param {string} txId
   */
  add(txId) {
    if (!txId) return;
    this._sweep();
    this.entries.set(txId, this.now() + this.ttlMs);
    if (this.entries.size > this.maxEntries) {
      // Evict oldest (insertion-order iteration).
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
  }

  /** @private */
  _sweep() {
    // Amortized: only sweep when we're near cap.
    if (this.entries.size < this.maxEntries * 0.9) return;
    const now = this.now();
    for (const [id, exp] of this.entries) {
      if (exp <= now) this.entries.delete(id);
      else break; // Map iterates in insertion order; earliest expiries first.
    }
  }
}

module.exports = { InMemoryReplayGuard, DEFAULT_TTL_MS, DEFAULT_MAX_ENTRIES };
