/**
 * Unit tests for org-fwd-filter — guards orgChartForward() against silently
 * routing low-signal noise (JSON parse errors, bare timeout markers, one-word
 * acks) up the org chart and into the user's channel.
 */

const { isLowSignalFwd, ORG_FWD_MIN_BODY_LEN } = require('../../org-fwd-filter');
const { tKanban, statusLabel, TRANSLATIONS } = require('../../i18n/kanban-notifications');

describe('isLowSignalFwd()', () => {
    describe('falsy / trivial bodies', () => {
        it('returns true for null / undefined / empty', () => {
            expect(isLowSignalFwd(null)).toBe(true);
            expect(isLowSignalFwd(undefined)).toBe(true);
            expect(isLowSignalFwd('')).toBe(true);
            expect(isLowSignalFwd('   ')).toBe(true);
        });

        it('returns true for bodies shorter than ORG_FWD_MIN_BODY_LEN', () => {
            expect(isLowSignalFwd('hi')).toBe(true);
            expect(isLowSignalFwd('a b c')).toBe(true);
            const justUnder = 'x'.repeat(ORG_FWD_MIN_BODY_LEN - 1);
            expect(isLowSignalFwd(justUnder)).toBe(true);
        });

        it('returns false for bodies at or above ORG_FWD_MIN_BODY_LEN with content', () => {
            const exactlyAt = 'meaningful !'; // 12 chars
            expect(exactlyAt.length).toBe(ORG_FWD_MIN_BODY_LEN);
            expect(isLowSignalFwd(exactlyAt)).toBe(false);
        });
    });

    describe('JSON parse error noise (the original Mac_E flood)', () => {
        it('suppresses "Unexpected non-whitespace character after JSON"', () => {
            expect(isLowSignalFwd('Unexpected non-whitespace character after JSON at position 42')).toBe(true);
        });

        it('suppresses "Unexpected token X in JSON"', () => {
            expect(isLowSignalFwd('Unexpected token < in JSON at position 0')).toBe(true);
        });

        it('suppresses "Unexpected end of JSON"', () => {
            expect(isLowSignalFwd('Unexpected end of JSON input')).toBe(true);
        });

        it('suppresses "SyntaxError: Unexpected ..."', () => {
            expect(isLowSignalFwd('SyntaxError: Unexpected token } in JSON at position 17')).toBe(true);
        });

        it('suppresses bare "at position N" stack trace fragments', () => {
            expect(isLowSignalFwd('at position 1234')).toBe(true);
        });

        it('suppresses bare "line N column M" parse fragments', () => {
            expect(isLowSignalFwd('line 3 column 12')).toBe(true);
        });
    });

    describe('timeout marker noise (the Hermes empty FWD loop)', () => {
        it('suppresses "[Hermes 回應超時]"', () => {
            expect(isLowSignalFwd('[Hermes 回應超時]')).toBe(true);
        });

        it('suppresses "[#3 回應超時]"', () => {
            expect(isLowSignalFwd('[#3 回應超時]')).toBe(true);
        });

        it('suppresses "[Hermes response timeout]" (case-insensitive)', () => {
            expect(isLowSignalFwd('[Hermes response timeout]')).toBe(true);
            expect(isLowSignalFwd('[HERMES RESPONSE TIMEOUT]')).toBe(true);
        });

        it('does NOT suppress a timeout marker that comes with extra context', () => {
            expect(isLowSignalFwd('[Hermes 回應超時] retrying with backoff=30s, attempt=3')).toBe(false);
        });
    });

    describe('silent sign-off echo noise (the FWD same-string ack loop)', () => {
        it('suppresses [SILENT] sign-off FWD echo control messages', () => {
            expect(isLowSignalFwd('[SILENT] #6 sign-off FWD echo (相同字串) — 已 ack 過，繼續寫 jest test + commit + PR。')).toBe(true);
            expect(isLowSignalFwd('[SILENT] #12 sign off fwd echo same string')).toBe(true);
        });

        it('does NOT suppress other silent status messages with real work', () => {
            expect(isLowSignalFwd('[SILENT] #6 PR #3028 ready; Jest passed and branch pushed')).toBe(false);
        });
    });

    describe('one-word ack noise (the ack-of-ack loop)', () => {
        it('suppresses bare "ack" / "ACK" / "ack."', () => {
            expect(isLowSignalFwd('ack')).toBe(true);
            expect(isLowSignalFwd('ACK')).toBe(true);
            expect(isLowSignalFwd('ack.')).toBe(true);
            expect(isLowSignalFwd('ack!')).toBe(true);
        });

        it('suppresses bare "ok" / "received" / "noted" / "ping" / "pong"', () => {
            expect(isLowSignalFwd('ok')).toBe(true);
            expect(isLowSignalFwd('received')).toBe(true);
            expect(isLowSignalFwd('noted')).toBe(true);
            expect(isLowSignalFwd('ping')).toBe(true);
            expect(isLowSignalFwd('pong')).toBe(true);
        });

        it('does NOT suppress an ack that carries real status', () => {
            expect(isLowSignalFwd('ack — PR #3015 merged, deploying to prod now')).toBe(false);
        });
    });

    describe('system / automation / kanban notification echoes (card_ef4f729385089025431ea8f1)', () => {
        // Repro: a kanban status-change notice pushed to the assigned bot (#1),
        // echoed by the bot, was org-forwarded up to the supervisor (#2),
        // flooding the supervisor with status noise. These verbatim system
        // strings must be suppressed before the upward forward.
        it('suppresses statusChanged echoes (todo→in_progress, in_progress→done)', () => {
            const m1 = tKanban('zh', 'statusChanged', { direction: '➡️', title: 'Hygiene Audit', from: statusLabel('zh', 'todo'), to: statusLabel('zh', 'in_progress') });
            const m2 = tKanban('zh', 'statusChanged', { direction: '➡️', title: 'Hygiene Audit', from: statusLabel('zh', 'in_progress'), to: statusLabel('zh', 'done') });
            expect(isLowSignalFwd(m1)).toBe(true);
            expect(isLowSignalFwd(m2)).toBe(true);
        });

        it('suppresses the in-card "📌 狀態更新" system-comment echo', () => {
            expect(isLowSignalFwd('📌 狀態更新：待辦 → 進行中，指派給: #1')).toBe(true);
        });

        it('suppresses cardCreated / automationTrigger / schedule / staleNudge / reviewer notices', () => {
            expect(isLowSignalFwd(tKanban('zh', 'cardCreated', { priorityIcon: '🔴', priority: 'P0', title: 'T', status: '待辦' }))).toBe(true);
            expect(isLowSignalFwd(tKanban('zh', 'automationTrigger', { title: 'T', childTitle: 'C' }))).toBe(true);
            expect(isLowSignalFwd(tKanban('zh', 'scheduleOnce', { title: 'T' }))).toBe(true);
            expect(isLowSignalFwd(tKanban('zh', 'staleNudge', { title: 'T', status: '進行中', hours: 6 }))).toBe(true);
            expect(isLowSignalFwd(tKanban('zh', 'reviewerNotify', { title: 'T', entityId: 1, reply: '\ndone' }))).toBe(true);
            expect(isLowSignalFwd(tKanban('zh', 'reviewerMovedToReview', { title: 'T', from: '進行中' }))).toBe(true);
        });

        it('suppresses card-reopened + screenshot-gate hold echoes', () => {
            expect(isLowSignalFwd('♻️ Card reopened: Hygiene Audit\nDone → In Progress')).toBe(true);
            expect(isLowSignalFwd('⏸️ Bot #1 已回報完成，但此卡開啟「截圖審查」且尚無完成截圖 — 不自動結案。')).toBe(true);
        });

        it('suppresses model-health FWD echoes (background traffic)', () => {
            expect(isLowSignalFwd('[📢 FWD from #1] MODEL_HEALTH/ACK ok')).toBe(true);
            expect(isLowSignalFwd('[📢 FWD from #3] ACK <nonce>')).toBe(true);
        });

        it('Globe-user: suppresses system notices across ALL locales (no carveouts)', () => {
            const keys = ['statusChanged', 'cardCreated', 'automationTrigger', 'scheduleOnce', 'scheduleRecurring', 'staleNudge', 'reviewerNotify', 'reviewerMovedToReview'];
            for (const lang of Object.keys(TRANSLATIONS)) {
                for (const key of keys) {
                    const msg = tKanban(lang, key, { direction: '➡️', title: 'T', from: 'A', to: 'B', priorityIcon: '🔴', priority: 'P0', status: 'S', childTitle: 'C', hours: 6, entityId: 1, reply: 'r' });
                    expect(isLowSignalFwd(msg)).toBe(true);
                }
            }
        });

        it('does NOT suppress a bot\'s OWN free-text status report (no emoji template prefix)', () => {
            // Critical false-positive guard: only the verbatim system-template
            // strings are dropped — a bot describing its own progress forwards.
            expect(isLowSignalFwd('Card 7a03c4 moved to in_progress, ETA 2h')).toBe(false);
            expect(isLowSignalFwd('Task status changed for my card — I will start now')).toBe(false);
            expect(isLowSignalFwd('狀態更新一下：我已開始處理這張卡，30 分鐘後回報')).toBe(false);
        });
    });

    describe('real messages must pass through (no false positives)', () => {
        it('lets normal status reports through', () => {
            expect(isLowSignalFwd('Card 7a03c4 moved to in_progress, ETA 2h')).toBe(false);
        });

        it('lets task completions through', () => {
            expect(isLowSignalFwd('PR #3015 ready for review — orgChartForward FWD noise filter')).toBe(false);
        });

        it('lets multi-line bodies through', () => {
            expect(isLowSignalFwd('Heads up:\nMac_E container restarted at 12:00, all jobs back online.')).toBe(false);
        });

        it('lets Chinese sentences through', () => {
            expect(isLowSignalFwd('已完成 Android i18n it locale × 845 keys 的機翻填補，待你 review。')).toBe(false);
        });

        it('lets a long ack with context through', () => {
            expect(isLowSignalFwd('收到，正在處理 card_a60568c，預計 30 分鐘內回報')).toBe(false);
        });
    });
});
