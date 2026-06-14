'use strict';

const fs = require('fs');
const path = require('path');

const MAP_FILE = path.resolve(__dirname, '..', '..', 'data', 'portal-page-api-map.json');
const PORTAL_DIR = path.resolve(__dirname, '..', '..', 'public', 'portal');

describe('portal-page-api-map.json — source of truth for parity audits', () => {
    let doc;

    beforeAll(() => {
        const raw = fs.readFileSync(MAP_FILE, 'utf8');
        doc = JSON.parse(raw);
    });

    test('is valid JSON with required top-level fields', () => {
        expect(doc).toBeDefined();
        expect(Array.isArray(doc.mappings)).toBe(true);
        expect(doc.mappings.length).toBeGreaterThan(0);
    });

    test('every entry has an api path and a kind', () => {
        for (const entry of doc.mappings) {
            expect(typeof entry.api).toBe('string');
            expect(entry.api.startsWith('/api/')).toBe(true);
            expect(typeof entry.kind).toBe('string');
            expect(['primary', 'secondary', 'embedded', 'none', 'deprecated']).toContain(entry.kind);
        }
    });

    test('every page filename referenced exists under backend/public/portal/', () => {
        const missing = [];
        for (const entry of doc.mappings) {
            if (entry.page == null) continue;
            const pages = Array.isArray(entry.page) ? entry.page : [entry.page];
            for (const p of pages) {
                const fp = path.join(PORTAL_DIR, p);
                if (!fs.existsSync(fp)) {
                    missing.push({ api: entry.api, page: p });
                }
            }
        }
        if (missing.length > 0) {
            const lines = missing.map(m => `  ${m.api} -> ${m.page}`).join('\n');
            throw new Error(`portal-page-api-map.json references missing portal pages:\n${lines}`);
        }
    });

    test('api paths are unique (no duplicate mappings)', () => {
        const seen = new Set();
        const dupes = [];
        for (const entry of doc.mappings) {
            if (seen.has(entry.api)) dupes.push(entry.api);
            seen.add(entry.api);
        }
        expect(dupes).toEqual([]);
    });

    test('W22 audit false-positive APIs are mapped to existing pages', () => {
        // Locks the parity gaps from GH#2973 (W22, 2026-05-27):
        // contacts, /api/entities, agent-card — all marked "missing" by the
        // audit but actually have portal coverage. Telemetry is the only
        // real gap and is covered by the new telemetry.html.
        const required = [
            '/api/contacts',
            '/api/entity/agent-card',
            '/api/entities',
            '/api/device-telemetry',
            '/api/publisher/platforms'
        ];
        for (const api of required) {
            const entry = doc.mappings.find(e => e.api === api);
            expect(entry).toBeDefined();
            expect(entry.page).not.toBeNull();
        }
    });
});
