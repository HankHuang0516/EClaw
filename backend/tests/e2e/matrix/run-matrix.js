/**
 * Cross-surface E2E matrix runner — OODA-R Phase 3 #8 (card_42ffca0d29ce22b369d55ca4).
 *
 * Runs every FLOW × PLATFORM from matrix-def.js, captures a screenshot + verdict
 * per cell, writes summary.json + summary.txt + PNGs to the artifact dir, and
 * exits non-zero if ANY implemented cell fails — so CI can gate on it.
 *
 * Drivers that are not yet implemented are reported as `pending` (loud, counted
 * separately) — never silently passed. Each driver returns {ok, detail}.
 *
 * Usage: node run-matrix.js   [BASE_URL env, default https://eclawbot.com]
 * Env: MATRIX_BASE (target origin), MATRIX_ARTIFACT_DIR, PLAYWRIGHT_CHROMIUM_EXECUTABLE
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');

const { PLATFORMS, FLOWS } = require('./matrix-def.js');
const { DRIVERS } = require('./drivers.js');
const { sweepLeftoverMarkerCards } = require('./sweep-leftovers.js');

const BASE = process.env.MATRIX_BASE || 'https://eclawbot.com';
const ARTIFACT_DIR = process.env.MATRIX_ARTIFACT_DIR || path.join(os.tmpdir(), 'eclaw-e2e-matrix');
const CHROMIUM_EXECUTABLE = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ||
    (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);

async function run() {
    fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
    // Run-scoped token for write-flow markers (data isolation + self-clean).
    const runId = process.env.MATRIX_RUN_ID || ('r' + Date.now().toString(36));
    // #3985: archive marker cards a previous run's deferred cleanup left behind,
    // BEFORE this run seeds its own. Best-effort — never reds the gate.
    await sweepLeftoverMarkerCards({
        base: BASE,
        deviceId: process.env.MATRIX_TEST_DEVICE_ID,
        deviceSecret: process.env.MATRIX_TEST_DEVICE_SECRET,
        runId,
    });
    const browser = await chromium.launch({ executablePath: CHROMIUM_EXECUTABLE });
    const results = [];

    for (const platform of PLATFORMS) {
        const context = await browser.newContext({
            viewport: platform.viewport,
            userAgent: platform.userAgent,
        });
        for (const flow of FLOWS) {
            const cell = { flow: flow.key, platform: platform.key, title: flow.title };
            const driver = DRIVERS[flow.key];
            if (typeof driver !== 'function') {
                cell.status = 'pending';
                cell.detail = 'driver not implemented';
                results.push(cell);
                continue;
            }
            const page = await context.newPage();
            const shot = path.join(ARTIFACT_DIR, `${flow.key}__${platform.key}.png`);
            try {
                const r = await driver(page, { base: BASE, platform, runId });
                // A driver may report `transient: true` when a prod 503/429 survived its
                // own retry window (secret-bound flows hit live prod). That's infra, not a
                // product regression — surfaced loudly but does NOT red the required gate.
                cell.status = r.transient ? 'transient' : (r.ok ? 'pass' : 'fail');
                cell.detail = r.detail || '';
            } catch (e) {
                cell.status = 'fail';
                cell.detail = 'threw: ' + (e && e.message || String(e));
            }
            try { await page.screenshot({ path: shot }); cell.screenshot = path.basename(shot); } catch (_) {}
            await page.close();
            results.push(cell);
        }
        await context.close();
    }
    await browser.close();
    return results;
}

function summarize(results) {
    const counts = { pass: 0, fail: 0, pending: 0, transient: 0 };
    for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1;
    const lines = [];
    lines.push(`EClaw cross-surface E2E matrix — ${BASE}`);
    lines.push(`cells=${results.length}  pass=${counts.pass}  fail=${counts.fail}  pending=${counts.pending}  transient=${counts.transient}`);
    lines.push('');
    for (const r of results) {
        const mark = r.status === 'pass' ? 'PASS'
            : r.status === 'fail' ? 'FAIL'
            : r.status === 'transient' ? 'TRNS'
            : 'PEND';
        lines.push(`[${mark}] ${r.flow} × ${r.platform}  ${r.detail ? '— ' + r.detail : ''}`);
    }
    if (counts.transient) {
        lines.push('');
        lines.push(`NOTE: ${counts.transient} cell(s) TRANSIENT — a prod 503/429 survived the driver's retry window (live infra blip, not a product regression). Reported loudly but does NOT red the gate. A persistent pattern across runs warrants prod investigation.`);
    }
    if (counts.pending) {
        lines.push('');
        lines.push(`NOTE: ${counts.pending} cell(s) PENDING — all 5 drivers are supposed to exist, so a PENDING cell means a flow key lost its driver in drivers.js (regression / bad merge). This FAILS the gate. Restore the missing driver.`);
    }
    return { counts, text: lines.join('\n') };
}

run().then((results) => {
    const { counts, text } = summarize(results);
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'summary.json'), JSON.stringify({ base: BASE, counts, results }, null, 2));
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'summary.txt'), text + '\n');
    process.stdout.write(text + '\n');
    process.stdout.write(`\nArtifacts: ${ARTIFACT_DIR}\n`);
    // CI gate: all 5 flow drivers are now implemented, so PENDING is no longer an
    // expected transient state — a pending cell means a flow key lost its driver
    // (regression / bad merge) and MUST fail the gate, same as a real failing cell.
    process.exit((counts.fail > 0 || counts.pending > 0) ? 1 : 0);
}).catch((e) => {
    process.stderr.write('matrix runner crashed: ' + (e && e.stack || e) + '\n');
    process.exit(2);
});
