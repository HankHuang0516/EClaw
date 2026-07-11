'use strict';

const { KeyCache, DEFAULT_KEYS_URL, DEFAULT_TTL_MS } = require('./keyCache');
const { InMemoryReplayGuard } = require('./replayGuard');
const { InMemoryRateLimiter } = require('./rateLimiter');
const {
  verifyCallback,
  splitSignedPayload,
  resolveDeviceId,
  decodeWebSafeBase64,
  REASONS,
  DEFAULT_FRESHNESS_MS,
} = require('./verifier');
const { createHandler } = require('./handler');

module.exports = {
  // Core verifier
  verifyCallback,
  splitSignedPayload,
  resolveDeviceId,
  decodeWebSafeBase64,
  REASONS,
  DEFAULT_FRESHNESS_MS,
  // Deps
  KeyCache,
  DEFAULT_KEYS_URL,
  DEFAULT_TTL_MS,
  InMemoryReplayGuard,
  InMemoryRateLimiter,
  // Express plug-in
  createHandler,
};
