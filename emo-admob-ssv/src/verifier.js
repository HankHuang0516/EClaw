'use strict';

/**
 * AdMob rewarded-ad SSV callback verifier.
 *
 * Google's spec (https://developers.google.com/admob/android/ssv):
 *   • The verifiable query string is the original one WITHOUT the trailing
 *     `&signature=…&key_id=…` — sig is over everything preceding those two
 *     parameters, keeping the '&' separators intact.
 *   • Signature is web-safe base64 (URL-safe alphabet, no padding), holding
 *     an ASN.1 DER-encoded ECDSA (P-256 / secp256r1) signature over SHA-256
 *     of the message bytes.
 *   • The signing key is one of the entries at
 *     https://gstatic.com/admob/reward/verifier-keys.json, identified by key_id.
 *
 * Callback query fields (all string-valued in the URL):
 *   ad_network, ad_unit, reward_amount, reward_item, timestamp,
 *   transaction_id, user_id, custom_data, signature, key_id
 *
 * `custom_data` carries the DEVICE binding we set client-side when we
 * request the ad (base64url-encoded JSON `{"deviceId":"...", "nonce":"..."}`
 * or a plain deviceId string — we accept either). Never trust user_id for
 * quota — always resolve deviceId from custom_data.
 */

const crypto = require('crypto');
const { KeyCache } = require('./keyCache');
const { InMemoryReplayGuard } = require('./replayGuard');
const { InMemoryRateLimiter } = require('./rateLimiter');

const DEFAULT_FRESHNESS_MS = 60_000; // 60s

/**
 * @typedef {Object} VerifyResult
 * @property {boolean} valid
 * @property {string}  [reason]         Rejection code (see REASONS below).
 * @property {string}  [deviceId]       Resolved device binding on success.
 * @property {number}  [rewardAmount]   Parsed reward_amount on success.
 * @property {string}  [transactionId]  Google-provided txn id on success.
 * @property {string}  [rewardItem]     Reward item slug on success.
 */

const REASONS = Object.freeze({
  MALFORMED: 'malformed',
  MISSING_SIGNATURE: 'missing_signature',
  MISSING_KEY_ID: 'missing_key_id',
  UNKNOWN_KEY_ID: 'unknown_key_id',
  BAD_SIGNATURE: 'bad_signature',
  STALE_TIMESTAMP: 'stale_timestamp',
  REPLAY: 'replay',
  RATE_LIMIT: 'rate_limit',
  BAD_CUSTOM_DATA: 'bad_custom_data',
});

/**
 * Reconstruct the signed payload from the raw query string.
 *
 * Per spec, the signed prefix is `<qs>` such that the full URL is
 * `<qs>&signature=<sig>&key_id=<kid>`. We locate the FIRST occurrence of
 * `&signature=` (or `signature=` if it's the leading param, though Google
 * always places it last) and cut there. This avoids URL-decoding pitfalls
 * where re-encoding `%2F` vs `/` would change the byte stream.
 *
 * @param {string} rawQuery e.g. "ad_network=1&ad_unit=…&signature=…&key_id=…"
 * @returns {{ signedPayload: string, signature: string, keyId: string } | null}
 */
function splitSignedPayload(rawQuery) {
  if (typeof rawQuery !== 'string' || rawQuery.length === 0) return null;
  // Strip a leading '?' if present.
  const qs = rawQuery.startsWith('?') ? rawQuery.slice(1) : rawQuery;

  // Find `signature=` — either at start or after a `&`.
  const sigMatch = /(?:^|&)signature=([^&]*)/.exec(qs);
  if (!sigMatch) return null;
  const sigStart = sigMatch.index; // may be 0 or the position of the preceding '&'
  const signedPayload = sigStart === 0 ? '' : qs.slice(0, sigStart);
  const signature = sigMatch[1];

  const kidMatch = /(?:^|&)key_id=([^&]*)/.exec(qs);
  if (!kidMatch) return null;
  const keyId = kidMatch[1];

  if (!signedPayload) return null; // Spec requires at least one preceding param.
  return { signedPayload, signature, keyId };
}

/**
 * Decode Google's web-safe base64 signature into a Buffer.
 * @param {string} sig
 */
function decodeWebSafeBase64(sig) {
  if (typeof sig !== 'string') return null;
  const normalized = sig.replace(/-/g, '+').replace(/_/g, '/');
  const pad = normalized.length % 4;
  const padded = pad === 0 ? normalized : normalized + '='.repeat(4 - pad);
  try {
    return Buffer.from(padded, 'base64');
  } catch (_) {
    return null;
  }
}

/**
 * Resolve the deviceId binding from the `custom_data` field.
 *
 * We accept two encodings (caller decides which they emit client-side):
 *   1. Plain string: `custom_data=devabc123` -> deviceId = "devabc123"
 *   2. base64url-JSON: `{"deviceId":"...","nonce":"..."}`
 *
 * @param {string} customData URL-decoded value.
 * @returns {string|null}
 */
function resolveDeviceId(customData) {
  if (typeof customData !== 'string' || customData.length === 0) return null;
  // Try base64url JSON first.
  try {
    const normalized = customData.replace(/-/g, '+').replace(/_/g, '/');
    const pad = normalized.length % 4;
    const padded = pad === 0 ? normalized : normalized + '='.repeat(4 - pad);
    const decoded = Buffer.from(padded, 'base64').toString('utf8');
    if (decoded.startsWith('{')) {
      const parsed = JSON.parse(decoded);
      if (parsed && typeof parsed.deviceId === 'string' && parsed.deviceId) {
        return parsed.deviceId;
      }
    }
  } catch (_) {
    /* fallthrough */
  }
  // Plain string form. Guard against obviously bogus values.
  if (/^[A-Za-z0-9._-]{3,128}$/.test(customData)) return customData;
  return null;
}

/**
 * @typedef {Object} VerifierDeps
 * @property {KeyCache}              keyCache
 * @property {InMemoryReplayGuard}   replayGuard
 * @property {InMemoryRateLimiter}   rateLimiter
 * @property {() => number}          [now]              Injectable clock (tests).
 * @property {number}                [freshnessMs]      Timestamp freshness, default 60s.
 */

/**
 * Verify an AdMob SSV callback.
 *
 * @param {{ rawQuery?: string, params?: Record<string,string> }} input
 *        `rawQuery` is the raw querystring; `params` is a URL-decoded object
 *        (used for reading timestamp/user_id/custom_data etc.). Callers who
 *        only have Express's `req.query` should also pass `req.url.split('?')[1]`
 *        as `rawQuery`, because Express URL-decodes values which would break
 *        signature reconstruction.
 * @param {VerifierDeps} deps
 * @returns {Promise<VerifyResult>}
 */
async function verifyCallback(input, deps) {
  const { rawQuery, params } = input || {};
  if (!deps || !deps.keyCache || !deps.replayGuard || !deps.rateLimiter) {
    throw new Error('verifyCallback: missing dependencies');
  }
  const now = deps.now || (() => Date.now());
  const freshnessMs = typeof deps.freshnessMs === 'number' ? deps.freshnessMs : DEFAULT_FRESHNESS_MS;

  if (typeof rawQuery !== 'string' || !rawQuery) {
    return { valid: false, reason: REASONS.MALFORMED };
  }

  const split = splitSignedPayload(rawQuery);
  if (!split) return { valid: false, reason: REASONS.MALFORMED };
  const { signedPayload, signature, keyId } = split;
  if (!signature) return { valid: false, reason: REASONS.MISSING_SIGNATURE };
  if (!keyId) return { valid: false, reason: REASONS.MISSING_KEY_ID };

  // Extract decoded fields — prefer caller-supplied params, else parse.
  const decoded = params || Object.fromEntries(new URLSearchParams(rawQuery));

  // --- Rate limit (per user_id) BEFORE crypto work so a flood can't burn CPU ---
  const userId = decoded.user_id || '';
  if (!deps.rateLimiter.hit(userId)) {
    return { valid: false, reason: REASONS.RATE_LIMIT };
  }

  // --- Timestamp freshness ---
  const tsRaw = decoded.timestamp;
  const ts = Number(tsRaw);
  if (!Number.isFinite(ts) || ts <= 0) {
    return { valid: false, reason: REASONS.MALFORMED };
  }
  if (Math.abs(now() - ts) > freshnessMs) {
    return { valid: false, reason: REASONS.STALE_TIMESTAMP };
  }

  // --- Anti-replay (transaction_id) ---
  const txId = decoded.transaction_id || '';
  if (!txId) return { valid: false, reason: REASONS.MALFORMED };
  if (deps.replayGuard.has(txId)) {
    return { valid: false, reason: REASONS.REPLAY };
  }

  // --- Public key lookup (with rotation-aware refetch on miss) ---
  let entry = await deps.keyCache.get(keyId);
  if (!entry) {
    // KeyCache.get already refetches on miss; a second miss is definitively unknown.
    return { valid: false, reason: REASONS.UNKNOWN_KEY_ID };
  }

  // --- Signature verify ---
  const sigBuf = decodeWebSafeBase64(signature);
  if (!sigBuf || sigBuf.length === 0) {
    return { valid: false, reason: REASONS.BAD_SIGNATURE };
  }
  let ok = false;
  try {
    const v = crypto.createVerify('SHA256');
    v.update(signedPayload);
    v.end();
    ok = v.verify(
      { key: entry.keyObject, dsaEncoding: 'der' },
      sigBuf,
    );
  } catch (_) {
    ok = false;
  }
  if (!ok) return { valid: false, reason: REASONS.BAD_SIGNATURE };

  // --- Device binding ---
  const deviceId = resolveDeviceId(decoded.custom_data || '');
  if (!deviceId) return { valid: false, reason: REASONS.BAD_CUSTOM_DATA };

  // --- Commit replay slot AFTER all checks pass ---
  deps.replayGuard.add(txId);

  const rewardAmount = Number(decoded.reward_amount);
  return {
    valid: true,
    deviceId,
    rewardAmount: Number.isFinite(rewardAmount) ? rewardAmount : 0,
    transactionId: txId,
    rewardItem: decoded.reward_item || '',
  };
}

module.exports = {
  verifyCallback,
  splitSignedPayload,
  resolveDeviceId,
  decodeWebSafeBase64,
  REASONS,
  DEFAULT_FRESHNESS_MS,
};
