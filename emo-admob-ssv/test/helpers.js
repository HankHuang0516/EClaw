'use strict';

/**
 * Test helpers: synthetic P-256 keypair + signer that mimics AdMob's SSV
 * signing (ECDSA-SHA256 over the pre-`&signature=&key_id=` query prefix,
 * DER-encoded, then web-safe base64 without padding).
 *
 * We use synthetic keys because Google does not expose stable test vectors
 * — the SSV "test-ad" path signs live and only their prod keys verify.
 * The crypto operations exercised here are identical to production.
 */

const crypto = require('crypto');

function generateTestKey() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pem = publicKey.export({ type: 'spki', format: 'pem' });
  return { privateKey, publicKey, pem };
}

/** web-safe base64, no padding */
function toWebSafeBase64(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

/**
 * Build a signed callback query string.
 * @param {object} fields query fields (already URL-safe values ok — we don't re-encode).
 * @param {{ keyId: string, privateKey: crypto.KeyObject }} signer
 */
function signQuery(fields, signer) {
  const order = [
    'ad_network',
    'ad_unit',
    'reward_amount',
    'reward_item',
    'timestamp',
    'transaction_id',
    'user_id',
    'custom_data',
  ];
  const parts = [];
  for (const k of order) {
    if (fields[k] === undefined) continue;
    parts.push(`${k}=${encodeURIComponent(String(fields[k]))}`);
  }
  const signedPayload = parts.join('&');

  const s = crypto.createSign('SHA256');
  s.update(signedPayload);
  s.end();
  const sigDer = s.sign({ key: signer.privateKey, dsaEncoding: 'der' });
  const signature = toWebSafeBase64(sigDer);

  return `${signedPayload}&signature=${signature}&key_id=${signer.keyId}`;
}

/**
 * Build a `KeyCache`-compatible fetch stub that serves a Google-shaped
 * `verifier-keys.json` body containing the provided synthetic keys.
 * @param {Array<{ keyId: string, pem: string }>} entries
 */
function makeFetchStub(entries) {
  let calls = 0;
  const stub = async (_url) => {
    calls++;
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          keys: entries.map((e) => ({ keyId: e.keyId, pem: e.pem, base64: '(unused)' })),
        };
      },
    };
  };
  Object.defineProperty(stub, 'calls', { get: () => calls });
  return stub;
}

module.exports = { generateTestKey, signQuery, toWebSafeBase64, makeFetchStub };
