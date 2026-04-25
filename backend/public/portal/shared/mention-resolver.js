/**
 * Mention Resolver — sender-side helper that maps @-mentions inside outbound
 * text to entityIds / publicCodes, validates against the caller's intended
 * speakTo target, and surfaces conflicts.
 *
 * Why: 2026-04-25 incident — operator typed `@Hermes` in dispatch text but
 * supplied entityId 3 (Mac_E) to /api/transform. The API does not enforce
 * label↔ID consistency, so the message went to the wrong entity silently.
 * This helper closes the gap on the sender side (chat.html composer + ad-hoc
 * dispatch scripts) without changing the API surface.
 *
 * Token formats recognised in `text`:
 *   <@code>     — autocomplete-inserted token (8-char publicCode in angle wrap)
 *   @code       — bare publicCode at word boundary
 *   @name       — bare display name / character (case-insensitive)
 *   @all        — broadcast keyword (passes through; caller decides policy)
 *
 * This module is dependency-free and works in browser globals or CommonJS
 * (Jest). It does NOT mutate inputs.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.MentionResolver = factory();
    }
}(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    // 8-char alphanumeric publicCode wrapped in <@…> — autocomplete output.
    const WRAPPED_RE = /<@([a-z0-9]{4,16})>/gi;
    // Bare @word at word boundary. Excludes punctuation, allows letters/digits/underscore/CJK.
    // Hyphens permitted inside the token (e.g. "Remote-Friend") but never leading.
    // Length 2..40 to avoid false positives on lone @ or paragraph runs.
    const BARE_RE = /(^|[^\w<])@([\p{L}\p{N}_][\p{L}\p{N}_-]{1,39})/gu;
    const ALL_RE = /(^|[^\w])@all\b/i;

    /**
     * Build a normalized lookup pool from raw entity arrays.
     * @param {object} input
     * @param {Array} [input.boundEntities] - same-device entities ({entityId, publicCode, name, character})
     * @param {Array} [input.contacts]      - cross-device contacts ({publicCode, name, character, blocked?})
     * @returns {{
     *   localByCode:   Object,   // code(lower) -> { entityId, label, code }
     *   localByLabel:  Object,   // label(lower) -> { entityId, code, label }
     *   remoteByCode:  Object,   // code(lower) -> { code, name }
     *   remoteByLabel: Object    // name(lower) -> { code, name }
     * }}
     */
    function buildPool(input) {
        const pool = {
            localByCode: Object.create(null),
            localByLabel: Object.create(null),
            remoteByCode: Object.create(null),
            remoteByLabel: Object.create(null)
        };
        const bound = (input && input.boundEntities) || [];
        const contacts = (input && input.contacts) || [];

        for (const e of bound) {
            if (!e || e.entityId == null) continue;
            const label = e.name || e.character || ('Entity ' + e.entityId);
            const code = (e.publicCode || '').toLowerCase();
            const rec = { entityId: e.entityId, label: label, code: code || null };
            if (code) pool.localByCode[code] = rec;
            const lk = label.toLowerCase();
            if (lk && !pool.localByLabel[lk]) pool.localByLabel[lk] = rec;
        }
        for (const c of contacts) {
            if (!c || c.blocked || !c.publicCode) continue;
            const code = c.publicCode.toLowerCase();
            const name = c.name || c.character || c.publicCode;
            const rec = { code: code, name: name };
            pool.remoteByCode[code] = rec;
            const lk = name.toLowerCase();
            if (lk && !pool.remoteByLabel[lk]) pool.remoteByLabel[lk] = rec;
        }
        return pool;
    }

    function uniq(arr) {
        const seen = new Set();
        const out = [];
        for (const v of arr) {
            const k = typeof v === 'string' ? v.toLowerCase() : v;
            if (!seen.has(k)) {
                seen.add(k);
                out.push(v);
            }
        }
        return out;
    }

    /**
     * Parse @-mentions out of `text` and resolve them against `pool`.
     * @returns {{
     *   localEntityIds: number[],
     *   remoteCodes:    string[],
     *   allTag:         boolean,
     *   resolved:       Array<{ token: string, kind: 'local'|'remote', entityId?: number, code?: string, label: string }>,
     *   unresolved:     string[]   // @-tokens that matched nothing
     * }}
     */
    function parse(text, pool) {
        const out = {
            localEntityIds: [],
            remoteCodes: [],
            allTag: false,
            resolved: [],
            unresolved: []
        };
        if (!text || typeof text !== 'string') return out;
        if (!pool) pool = buildPool({});
        if (ALL_RE.test(text)) out.allTag = true;

        const seenTokens = new Set();
        const consider = (rawToken) => {
            const token = rawToken.toLowerCase();
            if (seenTokens.has(token)) return;
            seenTokens.add(token);
            if (token === 'all') return; // handled by allTag
            const local = pool.localByCode[token] || pool.localByLabel[token];
            if (local) {
                out.localEntityIds.push(local.entityId);
                out.resolved.push({
                    token: rawToken,
                    kind: 'local',
                    entityId: local.entityId,
                    code: local.code,
                    label: local.label
                });
                return;
            }
            const remote = pool.remoteByCode[token] || pool.remoteByLabel[token];
            if (remote) {
                out.remoteCodes.push(remote.code);
                out.resolved.push({
                    token: rawToken,
                    kind: 'remote',
                    code: remote.code,
                    label: remote.name
                });
                return;
            }
            out.unresolved.push(rawToken);
        };

        let m;
        WRAPPED_RE.lastIndex = 0;
        while ((m = WRAPPED_RE.exec(text)) !== null) consider(m[1]);
        BARE_RE.lastIndex = 0;
        while ((m = BARE_RE.exec(text)) !== null) consider(m[2]);

        out.localEntityIds = uniq(out.localEntityIds);
        out.remoteCodes = uniq(out.remoteCodes);
        out.unresolved = uniq(out.unresolved);
        return out;
    }

    /**
     * Compare parsed mentions against the caller's intended target list.
     * Returns the diff so the caller can decide policy (auto-add vs reject).
     *
     * @param {object} parsed - output of parse()
     * @param {object} targets - { local: number[], contacts: string[] }
     * @returns {{
     *   conflicts: Array<{kind:'local'|'remote', mentioned, intended, label}>,  // mention NOT in targets
     *   missingLocal:  number[],     // entityIds mentioned but not selected
     *   missingRemote: string[],     // codes mentioned but not in contact list
     *   allTag: boolean,
     *   unresolved: string[]
     * }}
     */
    function diff(parsed, targets) {
        const tLocal = new Set((targets && targets.local) || []);
        const tRemote = new Set(((targets && targets.contacts) || []).map(c => String(c).toLowerCase()));
        const conflicts = [];
        const missingLocal = [];
        const missingRemote = [];

        for (const r of parsed.resolved) {
            if (r.kind === 'local' && !tLocal.has(r.entityId)) {
                conflicts.push({ kind: 'local', mentioned: r.entityId, label: r.label, code: r.code });
                missingLocal.push(r.entityId);
            } else if (r.kind === 'remote' && !tRemote.has(r.code)) {
                conflicts.push({ kind: 'remote', mentioned: r.code, label: r.label });
                missingRemote.push(r.code);
            }
        }
        return {
            conflicts: conflicts,
            missingLocal: uniq(missingLocal),
            missingRemote: uniq(missingRemote),
            allTag: !!parsed.allTag,
            unresolved: parsed.unresolved.slice()
        };
    }

    /**
     * Convenience: parse + diff in one call.
     */
    function resolve(text, targets, poolInput) {
        const pool = (poolInput && poolInput.localByCode) ? poolInput : buildPool(poolInput || {});
        const parsed = parse(text, pool);
        const d = diff(parsed, targets || { local: [], contacts: [] });
        return Object.assign({}, parsed, d);
    }

    return { buildPool: buildPool, parse: parse, diff: diff, resolve: resolve };
}));
