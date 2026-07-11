'use strict';

/**
 * Sliding-window per-user rate limiter for AdMob SSV callbacks.
 *
 * A single `user_id` calling more than `maxHits` times within `windowMs`
 * is treated as fraud (bot farm / replay chain / stolen SDK). Default 5/min.
 *
 * As with the replay guard, this is a single-process sample; production
 * should back it with Redis (e.g. `INCR key EX 60`).
 */

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX_HITS = 5;

class InMemoryRateLimiter {
  /**
   * @param {{ windowMs?: number, maxHits?: number, now?: () => number }} [opts]
   */
  constructor(opts = {}) {
    this.windowMs = typeof opts.windowMs === 'number' ? opts.windowMs : DEFAULT_WINDOW_MS;
    this.maxHits = typeof opts.maxHits === 'number' ? opts.maxHits : DEFAULT_MAX_HITS;
    this.now = opts.now || (() => Date.now());
    /** @type {Map<string, number[]>} userId -> sorted hit timestamps within window */
    this.hits = new Map();
  }

  /**
   * Record a call for `userId`. Returns true when the call is under the cap
   * (allowed), false when the cap is exceeded (fraud). We store the timestamp
   * regardless so repeated attempts stay blocked until the window slides.
   * @param {string} userId
   * @returns {boolean}
   */
  hit(userId) {
    if (!userId) return true; // No user => can't scope; caller decides.
    const now = this.now();
    const cutoff = now - this.windowMs;
    const arr = this.hits.get(userId) || [];
    // Drop expired timestamps.
    let firstFresh = 0;
    while (firstFresh < arr.length && arr[firstFresh] <= cutoff) firstFresh++;
    const fresh = firstFresh === 0 ? arr : arr.slice(firstFresh);
    fresh.push(now);
    this.hits.set(userId, fresh);
    return fresh.length <= this.maxHits;
  }

  /**
   * Non-mutating check: would the next hit succeed?
   * @param {string} userId
   */
  peek(userId) {
    if (!userId) return true;
    const now = this.now();
    const cutoff = now - this.windowMs;
    const arr = this.hits.get(userId) || [];
    let firstFresh = 0;
    while (firstFresh < arr.length && arr[firstFresh] <= cutoff) firstFresh++;
    const freshCount = arr.length - firstFresh;
    return freshCount < this.maxHits;
  }
}

module.exports = { InMemoryRateLimiter, DEFAULT_WINDOW_MS, DEFAULT_MAX_HITS };
