'use strict';

const crypto = require('crypto');

/**
 * Timing-safe string comparison to prevent timing side-channel attacks on secrets.
 * Returns false if either value is falsy or they differ in length.
 */
function safeEqual(a, b) {
    if (!a || !b) return false;
    const bufA = Buffer.from(String(a));
    const bufB = Buffer.from(String(b));
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
}

module.exports = safeEqual;
