'use strict';

/**
 * api_refs.js — bidirectional reference index for portal `?` icon.
 *
 * Spec: docs/specs/portal-bidirectional-refs.md (PR #3124 + #3131 amendments).
 *
 * Endpoint:
 *   GET /api/refs?from=<id>&deviceId=<uuid>&botSecret=<hex>&entityId=<n>
 *
 * Index sources (scanned every REFS_SCAN_INTERVAL_MS, default 5 min):
 *   - kanban_cards: description, title, linked_prev_card_id, linked_next_card_id
 *   - kanban_card_dependencies: (card_id ↔ depends_on_card_id)
 *   - kanban_card_links: (source_card_id ↔ target_card_id)
 *   - kanban_comments: text
 *   - docs/specs/**\/*.md (git working tree at HEAD on main)
 *   - docs/research/**\/*.md
 *   - gh pr list --state all --limit 200 --json number,title,body,url,state,updatedAt
 *
 * Cache:
 *   - In-memory: Map<"<deviceId>|<kind>|<id>", Ref[]>
 *   - Disk warm-start: backend/.cache/refs.json (in .gitignore)
 *
 * Gated by env flag ECLAW_REFS_INDEX_ENABLED (default off in prod); flag off →
 * endpoint returns `{success:true, refs:[]}` so `?` popover renders empty
 * without breaking the UI (per spec §8 rollback).
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { Pool } = require('pg');
const safeEqual = require('./safe-equal');

const execFileAsync = promisify(execFile);

const SCAN_INTERVAL_MS = parseInt(process.env.ECLAW_REFS_SCAN_INTERVAL_MS || '300000', 10); // 5 min default
const CACHE_DIR = path.join(__dirname, '.cache');
const CACHE_FILE = path.join(CACHE_DIR, 'refs.json');
const REPO_ROOT = path.resolve(__dirname, '..');

// ── Regex patterns (mirror reference-parser.js + spec §3.2) ───────────────────
const CARD_RE = /\bcard_([a-f0-9]{24})\b/gi;
const SPEC_RE = /docs\/specs\/([\w-]+)\.md/g;
const RESEARCH_RE = /docs\/research\/([\w-]+)\.md/g;
const PR_RE = /#(\d{3,5})\b/g;

const REF_KINDS = ['card', 'spec', 'doc', 'pr'];

// ── Helpers ───────────────────────────────────────────────────────────────────

function normalizeFromId(rawFromId) {
    if (!rawFromId || typeof rawFromId !== 'string') return null;
    if (rawFromId.startsWith('card_')) return { kind: 'card', id: rawFromId.toLowerCase() };
    if (rawFromId.startsWith('docs/specs/')) return { kind: 'spec', id: rawFromId };
    if (rawFromId.startsWith('docs/research/')) return { kind: 'doc', id: rawFromId };
    if (/^\d+$/.test(rawFromId)) return { kind: 'pr', id: rawFromId };
    if (/^#\d+$/.test(rawFromId)) return { kind: 'pr', id: rawFromId.slice(1) };
    return null;
}

function cacheKey(deviceId, kind, id) {
    return `${deviceId}|${kind}|${id}`;
}

function scanText(text) {
    if (!text || typeof text !== 'string') return [];
    const out = [];
    const seen = new Set();
    const push = (kind, id) => {
        const k = `${kind}:${id}`;
        if (seen.has(k)) return;
        seen.add(k);
        out.push({ kind, id });
    };
    let m;
    CARD_RE.lastIndex = 0;
    while ((m = CARD_RE.exec(text)) !== null) push('card', 'card_' + m[1].toLowerCase());
    SPEC_RE.lastIndex = 0;
    while ((m = SPEC_RE.exec(text)) !== null) push('spec', 'docs/specs/' + m[1] + '.md');
    RESEARCH_RE.lastIndex = 0;
    while ((m = RESEARCH_RE.exec(text)) !== null) push('doc', 'docs/research/' + m[1] + '.md');
    PR_RE.lastIndex = 0;
    while ((m = PR_RE.exec(text)) !== null) push('pr', m[1]);
    return out;
}

function truncateLabel(s) {
    if (!s) return '';
    const t = String(s).replace(/\s+/g, ' ').trim();
    return t.length > 80 ? t.slice(0, 77) + '…' : t;
}

// ── Scanners ──────────────────────────────────────────────────────────────────

async function scanKanbanCards(pool, deviceId) {
    // Returns array of { from: {kind,id,label}, refs: [{kind, id}] }
    const cards = await pool.query(
        `SELECT id, title, description, linked_prev_card_id, linked_next_card_id
         FROM kanban_cards
         WHERE device_id = $1 AND archived = false`,
        [deviceId]
    );
    const out = [];
    for (const row of cards.rows) {
        const from = { kind: 'card', id: row.id, label: truncateLabel(row.title) };
        const refs = scanText((row.title || '') + '\n' + (row.description || ''));
        if (row.linked_prev_card_id) refs.push({ kind: 'card', id: row.linked_prev_card_id });
        if (row.linked_next_card_id) refs.push({ kind: 'card', id: row.linked_next_card_id });
        out.push({ from, refs });
    }
    return out;
}

async function scanKanbanComments(pool, deviceId) {
    const rows = await pool.query(
        `SELECT card_id, text FROM kanban_comments
         WHERE device_id = $1 AND is_system = false`,
        [deviceId]
    );
    const byCard = new Map();
    for (const r of rows.rows) {
        const refs = scanText(r.text || '');
        if (!byCard.has(r.card_id)) byCard.set(r.card_id, []);
        byCard.get(r.card_id).push(...refs);
    }
    return byCard;
}

async function scanKanbanDependencies(pool, deviceId) {
    const rows = await pool.query(
        `SELECT card_id, depends_on_card_id FROM kanban_card_dependencies WHERE device_id = $1`,
        [deviceId]
    );
    return rows.rows.map(r => ({ from: r.card_id, to: r.depends_on_card_id }));
}

async function scanKanbanLinks(pool, deviceId) {
    const rows = await pool.query(
        `SELECT source_card_id, target_card_id FROM kanban_card_links WHERE device_id = $1`,
        [deviceId]
    );
    return rows.rows.map(r => ({ from: r.source_card_id, to: r.target_card_id }));
}

function scanDocsTree(subdir) {
    const dir = path.join(REPO_ROOT, 'docs', subdir);
    if (!fs.existsSync(dir)) return [];
    const out = [];
    for (const fname of fs.readdirSync(dir)) {
        if (!fname.endsWith('.md')) continue;
        const fullPath = path.join(dir, fname);
        const relId = `docs/${subdir}/${fname}`;
        let body = '';
        let title = fname.replace(/\.md$/, '');
        try {
            body = fs.readFileSync(fullPath, 'utf8');
            const h1Match = body.match(/^#\s+(.+)$/m);
            if (h1Match) title = h1Match[1].trim();
        } catch (_) { /* skip unreadable */ }
        const kind = subdir === 'specs' ? 'spec' : 'doc';
        out.push({
            from: { kind, id: relId, label: truncateLabel(title) },
            refs: scanText(body),
        });
    }
    return out;
}

async function scanGhPrs() {
    try {
        const { stdout } = await execFileAsync('gh', [
            'pr', 'list',
            '--state', 'all',
            '--limit', '200',
            '--json', 'number,title,body,url,state,updatedAt',
        ], { cwd: REPO_ROOT, maxBuffer: 16 * 1024 * 1024, timeout: 30000 });
        const prs = JSON.parse(stdout);
        return prs.map(pr => ({
            from: {
                kind: 'pr',
                id: String(pr.number),
                label: truncateLabel(pr.title),
            },
            refs: scanText((pr.title || '') + '\n' + (pr.body || '')),
        }));
    } catch (_err) {
        // gh unavailable / not authed: degrade gracefully (no PR refs this scan)
        return [];
    }
}

// ── Index build ───────────────────────────────────────────────────────────────

function freshIndex() {
    // forward[key] = Set<refKey>     (out refs from key)
    // reverse[refKey] = Set<key>     (in refs into refKey)
    // labels[key] = "human label"    (for both sides)
    return { forward: new Map(), reverse: new Map(), labels: new Map() };
}

function keyOf(kind, id) { return `${kind}|${id}`; }
function parseKey(k) {
    const idx = k.indexOf('|');
    return { kind: k.slice(0, idx), id: k.slice(idx + 1) };
}

function addEdge(idx, fromKind, fromId, toKind, toId) {
    if (!REF_KINDS.includes(fromKind) || !REF_KINDS.includes(toKind)) return;
    const a = keyOf(fromKind, fromId);
    const b = keyOf(toKind, toId);
    if (a === b) return; // self-loop
    if (!idx.forward.has(a)) idx.forward.set(a, new Set());
    if (!idx.reverse.has(b)) idx.reverse.set(b, new Set());
    idx.forward.get(a).add(b);
    idx.reverse.get(b).add(a);
}

function setLabel(idx, kind, id, label) {
    if (!label) return;
    const k = keyOf(kind, id);
    if (!idx.labels.has(k)) idx.labels.set(k, label);
}

async function buildIndexForDevice(pool, deviceId) {
    const idx = freshIndex();

    // Kanban cards: text refs + linked_prev/_next
    const cardScans = await scanKanbanCards(pool, deviceId);
    for (const entry of cardScans) {
        setLabel(idx, entry.from.kind, entry.from.id, entry.from.label);
        for (const r of entry.refs) {
            addEdge(idx, entry.from.kind, entry.from.id, r.kind, r.id);
        }
    }

    // Kanban comments: ref expressions in user-authored comment text
    const commentByCard = await scanKanbanComments(pool, deviceId);
    for (const [cardId, refs] of commentByCard.entries()) {
        for (const r of refs) addEdge(idx, 'card', cardId, r.kind, r.id);
    }

    // Structured kanban edges
    const deps = await scanKanbanDependencies(pool, deviceId);
    for (const d of deps) addEdge(idx, 'card', d.from, 'card', d.to);

    const links = await scanKanbanLinks(pool, deviceId);
    for (const l of links) addEdge(idx, 'card', l.from, 'card', l.to);

    // Docs
    for (const entry of scanDocsTree('specs')) {
        setLabel(idx, entry.from.kind, entry.from.id, entry.from.label);
        for (const r of entry.refs) addEdge(idx, entry.from.kind, entry.from.id, r.kind, r.id);
    }
    for (const entry of scanDocsTree('research')) {
        setLabel(idx, entry.from.kind, entry.from.id, entry.from.label);
        for (const r of entry.refs) addEdge(idx, entry.from.kind, entry.from.id, r.kind, r.id);
    }

    // PRs
    for (const entry of await scanGhPrs()) {
        setLabel(idx, entry.from.kind, entry.from.id, entry.from.label);
        for (const r of entry.refs) addEdge(idx, entry.from.kind, entry.from.id, r.kind, r.id);
    }

    return idx;
}

function lookupRefs(idx, deviceId, kind, id) {
    const k = keyOf(kind, id);
    const out = [];
    const fwd = idx.forward.get(k);
    if (fwd) {
        for (const refK of fwd) {
            const { kind: rk, id: rid } = parseKey(refK);
            out.push({
                kind: rk,
                id: rid,
                label: idx.labels.get(refK) || rid,
                direction: 'out',
            });
        }
    }
    const rev = idx.reverse.get(k);
    if (rev) {
        for (const refK of rev) {
            const { kind: rk, id: rid } = parseKey(refK);
            out.push({
                kind: rk,
                id: rid,
                label: idx.labels.get(refK) || rid,
                direction: 'in',
            });
        }
    }
    // Dedup (kind, id, direction)
    const seen = new Set();
    const dedup = [];
    for (const r of out) {
        const dk = `${r.kind}|${r.id}|${r.direction}`;
        if (seen.has(dk)) continue;
        seen.add(dk);
        dedup.push(r);
    }
    return dedup;
}

// ── Cache persistence ─────────────────────────────────────────────────────────

function indexToJson(idx) {
    const labels = {};
    for (const [k, v] of idx.labels.entries()) labels[k] = v;
    const forward = {};
    for (const [k, v] of idx.forward.entries()) forward[k] = Array.from(v);
    return { labels, forward };
}

function indexFromJson(json) {
    const idx = freshIndex();
    if (!json || typeof json !== 'object') return idx;
    if (json.labels) {
        for (const k of Object.keys(json.labels)) idx.labels.set(k, json.labels[k]);
    }
    if (json.forward) {
        for (const k of Object.keys(json.forward)) {
            const arr = json.forward[k] || [];
            idx.forward.set(k, new Set(arr));
            for (const b of arr) {
                if (!idx.reverse.has(b)) idx.reverse.set(b, new Set());
                idx.reverse.get(b).add(k);
            }
        }
    }
    return idx;
}

function writeCache(deviceIndices) {
    try {
        if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
        const payload = { v: 1, updatedAt: new Date().toISOString(), devices: {} };
        for (const [deviceId, idx] of deviceIndices.entries()) {
            payload.devices[deviceId] = indexToJson(idx);
        }
        fs.writeFileSync(CACHE_FILE, JSON.stringify(payload), 'utf8');
    } catch (_) { /* best-effort warm-start; cold-start always works */ }
}

function readCache() {
    try {
        if (!fs.existsSync(CACHE_FILE)) return new Map();
        const raw = fs.readFileSync(CACHE_FILE, 'utf8');
        const payload = JSON.parse(raw);
        const out = new Map();
        for (const deviceId of Object.keys(payload.devices || {})) {
            out.set(deviceId, indexFromJson(payload.devices[deviceId]));
        }
        return out;
    } catch (_) {
        return new Map();
    }
}

// ── Auth helper ───────────────────────────────────────────────────────────────
// Mirrors the kanban.js / mission.js authenticate() pattern so the portal calls
// from kanban.html (which already pass deviceSecret) and bot calls (which pass
// botSecret + entityId) both work. Refs reads are device-scoped, so any valid
// credential pair for the device is accepted.
function authDevice(devices, req) {
    const params = { ...(req.query || {}), ...(req.body || {}) };
    const { deviceId, deviceSecret, botSecret, entityId } = params;
    if (!deviceId) return null;
    const device = devices?.[deviceId];
    if (!device) return null;
    if (deviceSecret && safeEqual(device.deviceSecret, deviceSecret)) return deviceId;
    if (botSecret) {
        // entities is an object map keyed by entityId.
        const entities = device.entities || {};
        if (entityId !== undefined && entityId !== null && entityId !== '') {
            const entity = entities[entityId] || entities[parseInt(entityId, 10)];
            if (entity && safeEqual(entity.botSecret, botSecret)) return deviceId;
        } else {
            // Fall through: any entity on the device with matching botSecret.
            for (const k of Object.keys(entities)) {
                if (safeEqual(entities[k]?.botSecret, botSecret)) return deviceId;
            }
        }
    }
    return null;
}

// ── Factory ───────────────────────────────────────────────────────────────────

function createRefsModule(devices, helpers = {}) {
    const { serverLog } = helpers;
    const pool = helpers.pool || new Pool({
        connectionString: process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/realbot',
    });
    const log = serverLog || ((..._args) => {});
    const router = express.Router();

    const ENABLED = process.env.ECLAW_REFS_INDEX_ENABLED === '1' ||
                    process.env.ECLAW_REFS_INDEX_ENABLED === 'true';

    // deviceId → Index
    let deviceIndices = readCache();
    let scanTimer = null;
    let scanInFlight = false;

    async function refreshAllDevices() {
        if (scanInFlight) return;
        scanInFlight = true;
        try {
            // Discover devices: union of currently-known devices + cached
            const ids = new Set(Object.keys(devices || {}));
            for (const id of deviceIndices.keys()) ids.add(id);
            const next = new Map();
            for (const deviceId of ids) {
                try {
                    next.set(deviceId, await buildIndexForDevice(pool, deviceId));
                } catch (e) {
                    // keep previous index if scan fails for this device
                    const prev = deviceIndices.get(deviceId);
                    if (prev) next.set(deviceId, prev);
                    log && log('refs.scan.device_error', { deviceId, err: e?.message });
                }
            }
            deviceIndices = next;
            writeCache(deviceIndices);
            log && log('refs.scan.complete', { devices: deviceIndices.size });
        } finally {
            scanInFlight = false;
        }
    }

    function startScanLoop() {
        if (!ENABLED) return;
        if (scanTimer) return;
        // kick off an initial scan, then on interval
        refreshAllDevices().catch(() => {});
        scanTimer = setInterval(() => {
            refreshAllDevices().catch(() => {});
        }, SCAN_INTERVAL_MS);
        if (typeof scanTimer.unref === 'function') scanTimer.unref();
    }

    function stopScanLoop() {
        if (scanTimer) {
            clearInterval(scanTimer);
            scanTimer = null;
        }
    }

    // GET /api/refs?from=<id>
    router.get('/refs', async (req, res) => {
        if (!ENABLED) {
            return res.json({ success: true, refs: [], from: null, enabled: false });
        }
        const deviceId = authDevice(devices, req);
        if (!deviceId) return res.status(401).json({ success: false, error: 'unauthorized' });

        const rawFrom = req.query.from;
        const from = normalizeFromId(rawFrom);
        if (!from) return res.status(400).json({ success: false, error: 'invalid_from' });

        const idx = deviceIndices.get(deviceId);
        if (!idx) {
            // No scan has populated this device yet; trigger background scan and return empty.
            refreshAllDevices().catch(() => {});
            return res.json({ success: true, refs: [], from: { ...from, label: from.id }, warming: true });
        }

        const refs = lookupRefs(idx, deviceId, from.kind, from.id);
        const label = idx.labels.get(keyOf(from.kind, from.id)) || from.id;
        return res.json({
            success: true,
            from: { ...from, label },
            refs,
        });
    });

    // GET /api/refs/health — admin/debug
    router.get('/refs/health', (req, res) => {
        return res.json({
            success: true,
            enabled: ENABLED,
            scanIntervalMs: SCAN_INTERVAL_MS,
            devices: deviceIndices.size,
            cacheFile: CACHE_FILE,
        });
    });

    startScanLoop();

    return {
        router,
        // Exposed for tests / shutdown:
        _internals: {
            refreshAllDevices,
            stopScanLoop,
            getIndex: (deviceId) => deviceIndices.get(deviceId),
            indexToJson,
            indexFromJson,
            scanText,
            normalizeFromId,
            cacheKey,
            buildIndexForDevice,
            lookupRefs,
            keyOf,
        },
    };
}

module.exports = createRefsModule;
module.exports._private = {
    scanText,
    normalizeFromId,
    cacheKey,
    keyOf,
    truncateLabel,
};
