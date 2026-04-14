/**
 * Apple OAuth unit tests — JWK→PEM conversion and token verification round-trip.
 *
 * These tests use crypto-generated RSA keys to validate that our hand-rolled
 * JWK→PEM encoder produces a PEM that jsonwebtoken can verify tokens against.
 */

const crypto = require('crypto');
const jwt = require('jsonwebtoken');

/**
 * Copy of appleJwkToPem from backend/auth.js.
 * Kept in sync manually; if you change the production copy, update this too.
 */
function appleJwkToPem(jwk) {
    const nBuf = Buffer.from(jwk.n, 'base64url');
    const eBuf = Buffer.from(jwk.e, 'base64url');

    function encodeLength(len) {
        if (len < 128) return Buffer.from([len]);
        const bytes = [];
        let v = len;
        while (v > 0) { bytes.unshift(v & 0xff); v >>= 8; }
        return Buffer.concat([Buffer.from([0x80 | bytes.length]), Buffer.from(bytes)]);
    }
    function encodeInteger(buf) {
        const needsPad = buf[0] & 0x80;
        const content = needsPad ? Buffer.concat([Buffer.from([0x00]), buf]) : buf;
        return Buffer.concat([Buffer.from([0x02]), encodeLength(content.length), content]);
    }

    const n = encodeInteger(nBuf);
    const e = encodeInteger(eBuf);
    const rsaSeq = Buffer.concat([n, e]);
    const rsaSeqEncoded = Buffer.concat([Buffer.from([0x30]), encodeLength(rsaSeq.length), rsaSeq]);

    const algOid = Buffer.from('300d06092a864886f70d0101010500', 'hex');
    const bitStringContent = Buffer.concat([Buffer.from([0x00]), rsaSeqEncoded]);
    const bitString = Buffer.concat([Buffer.from([0x03]), encodeLength(bitStringContent.length), bitStringContent]);
    const spki = Buffer.concat([algOid, bitString]);
    const outer = Buffer.concat([Buffer.from([0x30]), encodeLength(spki.length), spki]);

    const b64 = outer.toString('base64');
    const lines = b64.match(/.{1,64}/g).join('\n');
    return `-----BEGIN PUBLIC KEY-----\n${lines}\n-----END PUBLIC KEY-----\n`;
}

/**
 * Generate an RSA keypair and export the public key as both PEM and JWK.
 */
function generateRsaKeypair() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048
    });
    const jwk = publicKey.export({ format: 'jwk' });
    const publicPem = publicKey.export({ format: 'pem', type: 'spki' }).toString();
    const privatePem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    return { jwk, publicPem, privatePem, privateKey };
}

describe('appleJwkToPem', () => {
    it('converts RSA JWK to a PEM that matches Node crypto export', () => {
        const { jwk, publicPem } = generateRsaKeypair();
        const ourPem = appleJwkToPem(jwk);
        // Strip whitespace for comparison — base64 content should be identical
        const norm = (s) => s.replace(/\s+/g, '');
        expect(norm(ourPem)).toBe(norm(publicPem));
    });

    it('produces a PEM that jsonwebtoken can verify a signed token against', () => {
        const { jwk, privatePem } = generateRsaKeypair();
        const pem = appleJwkToPem(jwk);

        // Sign a token that mimics Apple's identity token shape
        const payload = {
            iss: 'https://appleid.apple.com',
            aud: 'com.eclawbot.app',
            sub: '001234.abc123.5678',
            email: 'apple-user@example.com',
            email_verified: 'true',
            iat: Math.floor(Date.now() / 1000),
            exp: Math.floor(Date.now() / 1000) + 600
        };
        const token = jwt.sign(payload, privatePem, {
            algorithm: 'RS256',
            header: { kid: 'test-key-id' }
        });

        // Verify with our reconstructed PEM
        const verified = jwt.verify(token, pem, {
            algorithms: ['RS256'],
            audience: 'com.eclawbot.app',
            issuer: 'https://appleid.apple.com'
        });

        expect(verified.sub).toBe('001234.abc123.5678');
        expect(verified.email).toBe('apple-user@example.com');
    });

    it('rejects tokens with wrong audience', () => {
        const { jwk, privatePem } = generateRsaKeypair();
        const pem = appleJwkToPem(jwk);

        const token = jwt.sign(
            { iss: 'https://appleid.apple.com', aud: 'com.other.app', sub: 'x' },
            privatePem,
            { algorithm: 'RS256', expiresIn: '10m', header: { kid: 'k' } }
        );

        expect(() => jwt.verify(token, pem, {
            algorithms: ['RS256'],
            audience: 'com.eclawbot.app',
            issuer: 'https://appleid.apple.com'
        })).toThrow(/audience/i);
    });

    it('rejects tokens with wrong issuer', () => {
        const { jwk, privatePem } = generateRsaKeypair();
        const pem = appleJwkToPem(jwk);

        const token = jwt.sign(
            { iss: 'https://fake.com', aud: 'com.eclawbot.app', sub: 'x' },
            privatePem,
            { algorithm: 'RS256', expiresIn: '10m', header: { kid: 'k' } }
        );

        expect(() => jwt.verify(token, pem, {
            algorithms: ['RS256'],
            audience: 'com.eclawbot.app',
            issuer: 'https://appleid.apple.com'
        })).toThrow(/issuer/i);
    });

    it('rejects expired tokens', () => {
        const { jwk, privatePem } = generateRsaKeypair();
        const pem = appleJwkToPem(jwk);

        const token = jwt.sign(
            {
                iss: 'https://appleid.apple.com',
                aud: 'com.eclawbot.app',
                sub: 'x',
                iat: Math.floor(Date.now() / 1000) - 7200,
                exp: Math.floor(Date.now() / 1000) - 3600
            },
            privatePem,
            { algorithm: 'RS256', header: { kid: 'k' } }
        );

        expect(() => jwt.verify(token, pem, {
            algorithms: ['RS256'],
            audience: 'com.eclawbot.app',
            issuer: 'https://appleid.apple.com'
        })).toThrow(/expired/i);
    });

    it('handles JWK with leading zero byte in modulus correctly', () => {
        // Edge case: Apple JWK modulus may decode to a buffer starting with 0x80+ which
        // our encoder should prepend 0x00 to keep the ASN.1 INTEGER positive.
        const { jwk, privatePem } = generateRsaKeypair();
        const pem = appleJwkToPem(jwk);

        // Just ensure roundtrip works — the specific byte layout is tested by "matches Node crypto export"
        const token = jwt.sign({ sub: 'x' }, privatePem, {
            algorithm: 'RS256',
            expiresIn: '1m',
            header: { kid: 'k' }
        });
        expect(() => jwt.verify(token, pem, { algorithms: ['RS256'] })).not.toThrow();
    });
});
