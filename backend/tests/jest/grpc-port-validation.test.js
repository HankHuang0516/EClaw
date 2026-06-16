'use strict';

const fs = require('fs');
const path = require('path');

const indexSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'index.js'), 'utf8');

describe('gRPC port validation — guard against bad GRPC_PORT env (card_e0a7e1ca)', () => {
    test('grpcPort fallback variable is computed once as port+1', () => {
        expect(indexSrc).toMatch(/const fallbackPort = port \+ 1;/);
    });

    test('parseInt receives explicit radix 10 (defensive against leading-zero / octal)', () => {
        expect(indexSrc).toMatch(/parseInt\(process\.env\.GRPC_PORT \|\| fallbackPort,\s*10\)/);
    });

    test('out-of-range guard rejects values >= 65536, < 0, or non-integers', () => {
        expect(indexSrc).toMatch(/!Number\.isInteger\(grpcPort\)\s*\|\|\s*grpcPort < 0\s*\|\|\s*grpcPort >= 65536/);
    });

    test('on bad value, warns + falls back to PORT+1 (does not throw / crash gRPC init)', () => {
        expect(indexSrc).toMatch(/\[gRPC\] Invalid GRPC_PORT[\s\S]*?falling back to PORT\+1[\s\S]*?grpcPort = fallbackPort/);
    });

    test('grpcPort is let (reassignable) not const (so fallback reassign compiles)', () => {
        expect(indexSrc).toMatch(/let grpcPort = parseInt\(process\.env\.GRPC_PORT/);
    });
});

// Pure unit test of the validation logic in isolation (no module load)
describe('gRPC port validation — boundary contract', () => {
    function validatePort(envVal, fallback) {
        let p = parseInt(envVal || fallback, 10);
        if (!Number.isInteger(p) || p < 0 || p >= 65536) return fallback;
        return p;
    }

    test('80801 (the prod incident value) → fallback', () => {
        expect(validatePort('80801', 8081)).toBe(8081);
    });

    test('65535 (max valid) → accepted', () => {
        expect(validatePort('65535', 8081)).toBe(65535);
    });

    test('65536 (off-by-one over max) → fallback', () => {
        expect(validatePort('65536', 8081)).toBe(8081);
    });

    test('0 (valid lower bound) → accepted', () => {
        expect(validatePort('0', 8081)).toBe(0);
    });

    test('-1 (below min) → fallback', () => {
        expect(validatePort('-1', 8081)).toBe(8081);
    });

    test('empty string → fallback (parseInt of fallback)', () => {
        expect(validatePort('', 8081)).toBe(8081);
    });

    test('non-numeric "abc" → fallback (NaN rejected)', () => {
        expect(validatePort('abc', 8081)).toBe(8081);
    });

    test('typical 8081 → accepted', () => {
        expect(validatePort('8081', 8081)).toBe(8081);
    });

    test('undefined env → fallback', () => {
        expect(validatePort(undefined, 8081)).toBe(8081);
    });
});
