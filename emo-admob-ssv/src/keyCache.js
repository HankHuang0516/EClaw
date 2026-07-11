'use strict';

/**
 * Google AdMob SSV public-key cache.
 *
 * Fetches key material from `https://gstatic.com/admob/reward/verifier-keys.json`
 * (per the AdMob SSV spec: https://developers.google.com/admob/android/ssv).
 * Caches in-memory with 24h TTL, forces a refetch on unknown `key_id` (rotation),
 * and optionally persists to disk for cold-start warmth.
 *
 * Google's response shape (as of writing, subject to change):
 *   {
 *     "keys": [
 *       { "keyId": 123456789, "pem": "-----BEGIN PUBLIC KEY-----\n...", "base64": "..." },
 *       ...
 *     ]
 *   }
 *
 * We normalize `keyId` to string for map lookup because AdMob's callback query
 * arrives as string and Google's JSON encodes it as a number.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_KEYS_URL = 'https://gstatic.com/admob/reward/verifier-keys.json';
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24h

/**
 * @typedef {Object} PublicKeyEntry
 * @property {string} keyId    Google-issued key identifier (stringified).
 * @property {string} pem      PEM-encoded ECDSA public key on P-256 (secp256r1).
 * @property {crypto.KeyObject} keyObject  Cached KeyObject for fast verify.
 */

/**
 * @typedef {Object} KeyCacheOptions
 * @property {string} [url]           Override the Google keys URL (tests).
 * @property {number} [ttlMs]         Cache TTL, default 24h.
 * @property {string} [diskCachePath] Optional path to persist keys across cold starts.
 * @property {typeof fetch} [fetchImpl] Injectable fetch (tests).
 * @property {() => number} [now]     Injectable clock (tests).
 */

class KeyCache {
  /** @param {KeyCacheOptions} [opts] */
  constructor(opts = {}) {
    this.url = opts.url || DEFAULT_KEYS_URL;
    this.ttlMs = typeof opts.ttlMs === 'number' ? opts.ttlMs : DEFAULT_TTL_MS;
    this.diskCachePath = opts.diskCachePath || null;
    this.fetchImpl = opts.fetchImpl || (typeof fetch === 'function' ? fetch : null);
    this.now = opts.now || (() => Date.now());

    /** @type {Map<string, PublicKeyEntry>} */
    this.keys = new Map();
    this.fetchedAt = 0;
    /** @type {Promise<void>|null} */
    this.inFlight = null;

    if (this.diskCachePath) {
      this._loadFromDisk();
    }
  }

  /**
   * Return the public key for `keyId`, forcing a refetch on cache-miss / stale.
   * @param {string|number} keyId
   * @returns {Promise<PublicKeyEntry|null>}
   */
  async get(keyId) {
    const id = String(keyId);
    const stale = this.now() - this.fetchedAt > this.ttlMs;

    if (this.keys.has(id) && !stale) {
      return this.keys.get(id);
    }

    // Cache miss OR stale — refetch. Key rotation is the common cache-miss case.
    await this._refresh();
    return this.keys.get(id) || null;
  }

  /** Force a refresh regardless of TTL. */
  async refresh() {
    await this._refresh();
  }

  /**
   * De-duped refresh — concurrent callers share the same in-flight fetch.
   * @private
   */
  async _refresh() {
    if (this.inFlight) return this.inFlight;
    this.inFlight = (async () => {
      try {
        if (!this.fetchImpl) {
          throw new Error('KeyCache: no fetch implementation available');
        }
        const res = await this.fetchImpl(this.url);
        if (!res || !res.ok) {
          const status = res ? res.status : 'no-response';
          throw new Error(`KeyCache: fetch failed status=${status}`);
        }
        const body = await res.json();
        this._ingest(body);
        this.fetchedAt = this.now();
        if (this.diskCachePath) this._saveToDisk(body);
      } finally {
        this.inFlight = null;
      }
    })();
    return this.inFlight;
  }

  /**
   * @param {any} body Parsed JSON from Google keys endpoint.
   * @private
   */
  _ingest(body) {
    if (!body || !Array.isArray(body.keys)) {
      throw new Error('KeyCache: malformed response — missing keys[]');
    }
    const next = new Map();
    for (const raw of body.keys) {
      if (!raw || raw.keyId == null || !raw.pem) continue;
      const id = String(raw.keyId);
      let keyObject;
      try {
        keyObject = crypto.createPublicKey({ key: raw.pem, format: 'pem' });
      } catch (err) {
        // Skip malformed key rather than throw — one bad key must not kill others.
        continue;
      }
      next.set(id, { keyId: id, pem: raw.pem, keyObject });
    }
    if (next.size === 0) {
      throw new Error('KeyCache: no usable keys parsed');
    }
    this.keys = next;
  }

  /** @private */
  _loadFromDisk() {
    try {
      const raw = fs.readFileSync(this.diskCachePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && parsed.body && typeof parsed.fetchedAt === 'number') {
        this._ingest(parsed.body);
        this.fetchedAt = parsed.fetchedAt;
      }
    } catch (_) {
      // Missing/corrupt disk cache is non-fatal; we'll refetch on first get().
    }
  }

  /**
   * @param {any} body
   * @private
   */
  _saveToDisk(body) {
    try {
      const dir = path.dirname(this.diskCachePath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        this.diskCachePath,
        JSON.stringify({ fetchedAt: this.fetchedAt, body }),
        'utf8',
      );
    } catch (_) {
      // Disk cache is best-effort.
    }
  }
}

module.exports = { KeyCache, DEFAULT_KEYS_URL, DEFAULT_TTL_MS };
