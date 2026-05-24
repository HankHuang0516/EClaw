#!/usr/bin/env node
/**
 * One-time audited backfill of `blocks`-type entries in kanban_card_dependencies
 * for known roadmap chains. Scope B from card_fb242499f71a6c8ba7a663d6 — explicitly
 * NOT a runtime title-parser. Edges are hardcoded; the script resolves titles to
 * cardIds at runtime, prints every proposed edge, and only writes when `--apply`
 * is passed AND every edge in a chain resolves cleanly.
 *
 * Usage (device-secret path):
 *   API_BASE=https://eclawbot.com \
 *   DEVICE_ID=480def4c-... DEVICE_SECRET=... ENTITY_ID=2 \
 *     node backend/scripts/backfill-roadmap-dependencies.js [--apply] [--device=<id>]
 *
 * Usage (bot-secret path — when running as an entity):
 *   API_BASE=https://eclawbot.com \
 *   DEVICE_ID=... BOT_SECRET=... ENTITY_ID=2 \
 *     node backend/scripts/backfill-roadmap-dependencies.js [--apply]
 *
 * Without --apply: dry-run, prints proposals, exits 0.
 * With --apply: posts each edge via POST /api/mission/card/:cardId/dependency.
 * Idempotent — the API returns {created:false} on existing edges.
 *
 * Chains are picked from in-flight roadmap work as of 2026-05-24 (see card_fb2424
 * description). Add new chains by editing `CHAINS` below — don't add a fuzzy
 * title matcher, since unintended edges are worse than missing edges (per #1's
 * scope-B sign-off: "audited, not parsed").
 */

'use strict';

const https = require('https');
const http = require('http');
const { URL } = require('url');

// Chains: each entry is [source-title-regex, target-title-regex], where
// source DEPENDS ON target. Source becomes nudge-suppressed until target=done.
// Card titles use the prefix `[Roadmap/<section>] <code> — ...`.
const CHAINS = [
    // Hermes roadmap: H1 -> H2 -> H3, H2 -> H4
    { source: /\[Roadmap\/Hermes\]\s*H2\b/i, target: /\[Roadmap\/Hermes\]\s*H1\b/i, note: 'Hermes H2 depends on H1' },
    { source: /\[Roadmap\/Hermes\]\s*H3\b/i, target: /\[Roadmap\/Hermes\]\s*H2\b/i, note: 'Hermes H3 depends on H2' },
    { source: /\[Roadmap\/Hermes\]\s*H4\b/i, target: /\[Roadmap\/Hermes\]\s*H2\b/i, note: 'Hermes H4 depends on H2' },
    // Desktop roadmap: D0 -> D1 -> D2/D3/D4
    { source: /\[Roadmap\/Desktop\]\s*D1\b/i, target: /\[Roadmap\/Desktop\]\s*D0\b/i, note: 'Desktop D1 depends on D0' },
    { source: /\[Roadmap\/Desktop\]\s*D2\b/i, target: /\[Roadmap\/Desktop\]\s*D1\b/i, note: 'Desktop D2 depends on D1' },
    { source: /\[Roadmap\/Desktop\]\s*D3\b/i, target: /\[Roadmap\/Desktop\]\s*D1\b/i, note: 'Desktop D3 depends on D1' },
    { source: /\[Roadmap\/Desktop\]\s*D4\b/i, target: /\[Roadmap\/Desktop\]\s*D1\b/i, note: 'Desktop D4 depends on D1' },
];

function parseArgs(argv) {
    const out = { apply: false, device: process.env.DEVICE_ID || null };
    for (const a of argv.slice(2)) {
        if (a === '--apply') out.apply = true;
        else if (a.startsWith('--device=')) out.device = a.slice(9);
    }
    return out;
}

function request(method, urlStr, body) {
    return new Promise((resolve, reject) => {
        const url = new URL(urlStr);
        const lib = url.protocol === 'https:' ? https : http;
        const opts = {
            method,
            hostname: url.hostname,
            port: url.port || (url.protocol === 'https:' ? 443 : 80),
            path: url.pathname + url.search,
            headers: { 'Content-Type': 'application/json' },
        };
        const req = lib.request(opts, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null });
                } catch (_) {
                    resolve({ status: res.statusCode, body: data });
                }
            });
        });
        req.on('error', reject);
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

async function main() {
    const opts = parseArgs(process.argv);
    const apiBase = process.env.API_BASE || 'https://eclawbot.com';
    const deviceId = opts.device;
    const deviceSecret = process.env.DEVICE_SECRET;
    const botSecret = process.env.BOT_SECRET;
    const entityId = process.env.ENTITY_ID ? parseInt(process.env.ENTITY_ID, 10) : 2;

    if (!deviceId || (!deviceSecret && !botSecret)) {
        console.error('Missing DEVICE_ID + (DEVICE_SECRET or BOT_SECRET) env. Aborting.');
        process.exit(1);
    }

    const authMode = deviceSecret ? 'deviceSecret' : 'botSecret';
    const authQs = deviceSecret
        ? `deviceSecret=${encodeURIComponent(deviceSecret)}`
        : `botSecret=${encodeURIComponent(botSecret)}`;

    console.log(`[backfill] API=${apiBase} device=${deviceId} entity=${entityId} auth=${authMode} apply=${opts.apply}`);

    // 1. Fetch all non-archived cards for this device.
    const cardsUrl = `${apiBase}/api/mission/cards?deviceId=${encodeURIComponent(deviceId)}&${authQs}&entityId=${entityId}`;
    const cardsResp = await request('GET', cardsUrl);
    if (cardsResp.status !== 200 || !cardsResp.body) {
        console.error(`Failed to fetch cards: HTTP ${cardsResp.status}`, cardsResp.body);
        process.exit(1);
    }
    const cards = cardsResp.body.cards || cardsResp.body.data || cardsResp.body;
    if (!Array.isArray(cards)) {
        console.error('Unexpected /api/mission/cards shape — expected an array under cards/data:', Object.keys(cardsResp.body));
        process.exit(1);
    }
    console.log(`[backfill] fetched ${cards.length} cards`);

    // 2. Resolve each chain to {sourceId, targetId} via title regex.
    const proposals = [];
    const skipped = [];
    for (const chain of CHAINS) {
        const sources = cards.filter(c => chain.source.test(c.title || ''));
        const targets = cards.filter(c => chain.target.test(c.title || ''));
        if (sources.length === 0 || targets.length === 0) {
            skipped.push({ ...chain, reason: `no match (sources=${sources.length}, targets=${targets.length})` });
            continue;
        }
        if (sources.length > 1 || targets.length > 1) {
            // Ambiguous — don't auto-pick, list candidates and skip.
            skipped.push({
                ...chain,
                reason: `ambiguous (sources=${sources.length}: ${sources.map(c => c.id).join(',')}, targets=${targets.length}: ${targets.map(c => c.id).join(',')})`,
            });
            continue;
        }
        proposals.push({
            cardId: sources[0].id,
            cardTitle: sources[0].title,
            dependsOnCardId: targets[0].id,
            dependsOnTitle: targets[0].title,
            note: chain.note,
        });
    }

    // 3. Print plan.
    console.log('\n[backfill] === PROPOSED EDGES ===');
    for (const p of proposals) {
        console.log(`  ${p.cardId}  ${truncate(p.cardTitle, 40)}`);
        console.log(`    DEPENDS ON  ${p.dependsOnCardId}  ${truncate(p.dependsOnTitle, 40)}`);
        console.log(`    (${p.note})`);
    }
    if (skipped.length > 0) {
        console.log('\n[backfill] === SKIPPED ===');
        for (const s of skipped) console.log(`  ${s.note} — ${s.reason}`);
    }

    if (!opts.apply) {
        console.log('\n[backfill] dry-run — pass --apply to write rows. Exiting 0.');
        return;
    }

    // 4. Apply via POST.
    console.log('\n[backfill] === APPLYING ===');
    let created = 0;
    let already = 0;
    let failed = 0;
    for (const p of proposals) {
        const url = `${apiBase}/api/mission/card/${encodeURIComponent(p.cardId)}/dependency`;
        const body = {
            deviceId,
            entityId,
            dependsOnCardId: p.dependsOnCardId,
            dependencyType: 'blocks',
        };
        if (deviceSecret) body.deviceSecret = deviceSecret;
        else body.botSecret = botSecret;
        const resp = await request('POST', url, body);
        if (resp.status === 200 && resp.body && resp.body.success) {
            if (resp.body.created) {
                console.log(`  ✓ ${p.cardId} -> ${p.dependsOnCardId}  (created)`);
                created++;
            } else {
                console.log(`  · ${p.cardId} -> ${p.dependsOnCardId}  (already exists)`);
                already++;
            }
        } else {
            console.log(`  ✗ ${p.cardId} -> ${p.dependsOnCardId}  HTTP ${resp.status}  ${JSON.stringify(resp.body)}`);
            failed++;
        }
    }
    console.log(`\n[backfill] done. created=${created} already=${already} failed=${failed}`);
    if (failed > 0) process.exit(2);
}

function truncate(s, n) {
    if (!s) return '';
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

main().catch((err) => {
    console.error('[backfill] fatal:', err);
    process.exit(1);
});
