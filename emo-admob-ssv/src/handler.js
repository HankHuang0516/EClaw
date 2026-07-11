'use strict';

/**
 * Express handler stub for the AdMob SSV callback.
 *
 * The I2 gateway (Railway) will mount this at `GET /admob/ssv` — the URL
 * you register in the AdMob console. On a valid callback we call the
 * caller-supplied `onValidReward({ deviceId, amount, transactionId, rewardItem })`,
 * which is where the emotional-app pipeline bumps the SSV-only quota row.
 *
 * We always respond 200 to AdMob even on rejection, to prevent Google from
 * retrying a definitively-bad callback into a loop. (Retry-worthy failures
 * are 5xx — reserved for our own downstream/hook errors.)
 */

const { verifyCallback, REASONS } = require('./verifier');

/**
 * @typedef {Object} RewardHookInput
 * @property {string} deviceId
 * @property {number} amount
 * @property {string} transactionId
 * @property {string} rewardItem
 */

/**
 * Build an Express handler bound to the given deps + hook.
 *
 * @param {{
 *   keyCache: import('./keyCache').KeyCache,
 *   replayGuard: import('./replayGuard').InMemoryReplayGuard,
 *   rateLimiter: import('./rateLimiter').InMemoryRateLimiter,
 *   onValidReward: (r: RewardHookInput) => Promise<void>|void,
 *   logger?: { info?: Function, warn?: Function, error?: Function },
 *   freshnessMs?: number,
 *   now?: () => number,
 * }} deps
 * @returns {(req: any, res: any) => Promise<void>}
 */
function createHandler(deps) {
  if (!deps || typeof deps.onValidReward !== 'function') {
    throw new Error('createHandler: onValidReward hook is required');
  }
  const logger = deps.logger || {};

  return async function handleSsvCallback(req, res) {
    // Reconstruct the raw query string. Prefer `req.url` (undecoded) — Express's
    // `req.query` has already URL-decoded values which breaks signature bytes.
    let rawQuery = '';
    if (typeof req.originalUrl === 'string' && req.originalUrl.includes('?')) {
      rawQuery = req.originalUrl.split('?')[1];
    } else if (typeof req.url === 'string' && req.url.includes('?')) {
      rawQuery = req.url.split('?')[1];
    }
    const params = req.query && typeof req.query === 'object' ? req.query : undefined;

    let result;
    try {
      result = await verifyCallback({ rawQuery, params }, {
        keyCache: deps.keyCache,
        replayGuard: deps.replayGuard,
        rateLimiter: deps.rateLimiter,
        freshnessMs: deps.freshnessMs,
        now: deps.now,
      });
    } catch (err) {
      logger.error && logger.error('[emo-admob-ssv] verify threw', err);
      return res.status(500).json({ ok: false, reason: 'verify_error' });
    }

    if (!result.valid) {
      logger.warn && logger.warn('[emo-admob-ssv] rejected', { reason: result.reason });
      // 200 OK so Google doesn't retry-storm; body is diagnostic only.
      return res.status(200).json({ ok: false, reason: result.reason });
    }

    try {
      await deps.onValidReward({
        deviceId: result.deviceId,
        amount: result.rewardAmount,
        transactionId: result.transactionId,
        rewardItem: result.rewardItem,
      });
    } catch (err) {
      logger.error && logger.error('[emo-admob-ssv] onValidReward threw', err);
      // 5xx invites Google to retry — but we've committed the replay slot so a
      // retry will 200/replay. That's fine: caller's hook should be idempotent
      // on transactionId anyway.
      return res.status(500).json({ ok: false, reason: 'hook_error' });
    }

    logger.info && logger.info('[emo-admob-ssv] credited', {
      deviceId: result.deviceId,
      amount: result.rewardAmount,
      transactionId: result.transactionId,
    });
    return res.status(200).json({ ok: true });
  };
}

module.exports = { createHandler, REASONS };
