/**
 * Unit tests for org-fwd-filter — guards orgChartForward() against silently
 * routing low-signal noise (JSON parse errors, bare timeout markers, one-word
 * acks) up the org chart and into the user's channel.
 */

const { isLowSignalFwd, classifyLowSignalFwd, ORG_FWD_MIN_BODY_LEN } = require('../../org-fwd-filter');
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

    describe('Codex/openclaw runtime machine-noise forwards (card_77c4b9e2)', () => {
        // Repro (2026-06-26): #6's codex runtime auto-emitted #6_PERMISSION_HANDOFF
        // every ~1min from a benign post-exec cleanup WARN, plus periodic status
        // heartbeats. These were org-forwarded up to #2 and flooded the user's
        // chat because ORG_FWD_NOISE_PATTERNS had no matching entry.
        const HANDOFF = `#6_PERMISSION_HANDOFF
- Blocker: Codex runtime output reported permission_or_login: WARN codex_rmcp_client::stdio_server_launcher: Failed to terminate MCP process group 64526: Operation not permitted (os error 1)
- Next step: grant the required permission/login through an approved channel`;
        const HEARTBEAT = `Codex #6 status heartbeat
- Task: [task in progress - preview redacted to prevent secret leak]
- Elapsed: 30s
- Progress: bridge is still alive, codex exec is still running`;

        it('suppresses raw #N_PERMISSION_HANDOFF (pre-prefix, as orgChartForward sees it)', () => {
            expect(isLowSignalFwd(HANDOFF)).toBe(true);
            expect(isLowSignalFwd('#1_PERMISSION_HANDOFF\n- Next step: grant')).toBe(true);
        });

        it('suppresses the already-wrapped "[📢 FWD from #N] #N_PERMISSION_HANDOFF" variant', () => {
            expect(isLowSignalFwd(`[📢 FWD from #6] ${HANDOFF}`)).toBe(true);
        });

        it('suppresses "Codex #N status heartbeat" (with and without the entity number)', () => {
            expect(isLowSignalFwd(HEARTBEAT)).toBe(true);
            expect(isLowSignalFwd(`[📢 FWD from #6] ${HEARTBEAT}`)).toBe(true);
            expect(isLowSignalFwd('Codex status heartbeat\n- Elapsed: 30s\n- Progress: still running')).toBe(true);
        });

        it('suppresses Codex bridge error / watchdog / bridge status + EClaw progress update', () => {
            expect(isLowSignalFwd('Codex bridge error: socket closed unexpectedly, retrying')).toBe(true);
            expect(isLowSignalFwd('Codex watchdog recovery window is 45m 0s only if heartbeats stop')).toBe(true);
            expect(isLowSignalFwd('Codex bridge status: reconnected after transient drop')).toBe(true);
            expect(isLowSignalFwd('EClaw progress update — still polling, nothing new')).toBe(true);
        });

        it('does NOT suppress a real permission request or prose that merely mentions handoff/heartbeat', () => {
            // Critical false-positive guard: a genuine gate / real work forwards.
            expect(isLowSignalFwd('Need you to grant GitHub repo scope for the private mirror before I can push')).toBe(false);
            expect(isLowSignalFwd('I finished the permission-handoff refactor PR #3120, ready for review')).toBe(false);
            expect(isLowSignalFwd('Heartbeat metrics dashboard shipped — p99 latency down 40%')).toBe(false);
        });
    });

    describe('Chinese bot-to-bot ack / peer-heartbeat-echo noise (card_59f41e5b)', () => {
        // Repro: peers bounce "[📢 FWD from #N] 收到 🦞" / "已收到。" /
        // "收到，#6 仍在跑 …" keep-alive echoes that org-forward up and flood the
        // user's chat. These are pure acks / status echoes with no decision
        // content and must be suppressed before the upward forward.
        it('suppresses the peer-status-echo "[📢 FWD from #5] 收到，#6 仍在跑。🦞"', () => {
            expect(isLowSignalFwd('[📢 FWD from #5] 收到，#6 仍在跑。🦞')).toBe(true);
        });

        it('suppresses pure acks "[📢 FWD from #6] 收到 🦞" / "已收到。"', () => {
            expect(isLowSignalFwd('[📢 FWD from #6] 收到 🦞')).toBe(true);
            expect(isLowSignalFwd('[📢 FWD from #6] 已收到。')).toBe(true);
            expect(isLowSignalFwd('已收到。')).toBe(true);
            expect(isLowSignalFwd('收到，了解。')).toBe(true);
            expect(isLowSignalFwd('好的 🦞')).toBe(true);
        });

        it('suppresses the watchdog/last-output peer heartbeat echo', () => {
            expect(isLowSignalFwd('收到，#6 last output 9m29s 前，watchdog 35m 餘量。🦞')).toBe(true);
            expect(isLowSignalFwd('[📢 FWD from #6] 收到，#5 bridge alive，窗口 40m 仍可守')).toBe(true);
            expect(isLowSignalFwd('已收到，#1 還在跑')).toBe(true);
        });

        it('suppresses a standalone lobster mascot 🦞 (with and without FWD wrapper)', () => {
            expect(isLowSignalFwd('🦞')).toBe(true);
            expect(isLowSignalFwd('[📢 FWD from #5] 🦞')).toBe(true);
            expect(isLowSignalFwd('   🦞   ')).toBe(true);
        });

        it('CRITICAL false-positive guard: a real "收到 + actionable" report still forwards', () => {
            // The existing guard the whole feature hinges on — a status report
            // that begins with 收到 but carries a card id + ETA must NOT be eaten.
            expect(isLowSignalFwd('收到，正在處理 card_a60568c，預計 30 分鐘內回報')).toBe(false);
            expect(isLowSignalFwd('收到你的 PR #3758，我來 review')).toBe(false);
            expect(isLowSignalFwd('了解了，這個 bug 根因是 X，我修')).toBe(false);
            expect(isLowSignalFwd('收到，#6 仍在跑，但我發現 card_123 卡住了，需要你決定')).toBe(false);
            expect(isLowSignalFwd('好的，我先把 deploy 跑起來再回報結果')).toBe(false);
        });
    });

    describe('extended HANDOFF token + #5 watchdog-narration heartbeat coverage (card_59f41e5b)', () => {
        // Fix-forward extending PR #3758/#3759: two machine-noise variants were
        // verified slipping through live (classifyLowSignalFwd === null) on the
        // deployed /api/suppression-log.
        //   GAP 1: #6 now also emits #6_RESOURCE_HANDOFF (same class as
        //          #N_PERMISSION_HANDOFF) → generalize to #N_<UPPER>_HANDOFF.
        //   GAP 2: #5's live watchdog narration uses tokens (僅餘 / 即將觸發 /
        //          到期 / resource handoff / 接近 / 警戒線 …) missing from the
        //          heartbeat whitelist, incl. a #N-led variant (no 收到 prefix).

        it('GAP1: generalized #N_<UPPER>_HANDOFF (RESOURCE_HANDOFF and others) is suppressed', () => {
            // raw (pre-prefix) and FWD-wrapped, with multi-line blocker bodies
            expect(isLowSignalFwd('#1_RESOURCE_HANDOFF\n- Blocker: still waiting')).toBe(true);
            expect(classifyLowSignalFwd('#1_RESOURCE_HANDOFF\n- Blocker: still waiting')).toBe('permission_handoff');
            expect(classifyLowSignalFwd('[📢 FWD from #6] #6_RESOURCE_HANDOFF\n- Blocker: codex exec is still running, but no stdout/stderr has been observed for 45m 29s.')).toBe('permission_handoff');
            // pre-existing PERMISSION_HANDOFF still covered by the generalized token
            expect(classifyLowSignalFwd('[📢 FWD from #6] #6_PERMISSION_HANDOFF\n- Blocker: ...')).toBe('permission_handoff');
        });

        it('GAP2-A: 收到-led watchdog narration (僅餘 / 即將觸發 / handoff) is a heartbeat echo', () => {
            expect(isLowSignalFwd('收到，#6 last output 42m29s 前，watchdog 僅餘 2m30s，即將觸發 handoff。🦞')).toBe(true);
            expect(classifyLowSignalFwd('收到，#6 last output 42m29s 前，watchdog 僅餘 2m30s，即將觸發 handoff。🦞')).toBe('heartbeat');
        });

        it('GAP2-B: #N-led watchdog narration (no 收到 prefix) is a heartbeat echo', () => {
            expect(isLowSignalFwd('#6 watchdog 45m 到期，已進 resource handoff。等 #6 或 owner 決定處置。🦞')).toBe(true);
            expect(classifyLowSignalFwd('#6 watchdog 45m 到期，已進 resource handoff。等 #6 或 owner 決定處置。🦞')).toBe('heartbeat');
            expect(classifyLowSignalFwd('[📢 FWD from #5] #6 watchdog 45m 到期，已進 resource handoff。🦞')).toBe('heartbeat');
        });

        it('GAP2-C: 收到-led near-threshold heartbeat (接近 / 警戒線) is a heartbeat echo', () => {
            expect(isLowSignalFwd('收到，#6 仍在跑，但接近警戒線。🦞')).toBe(true);
            expect(classifyLowSignalFwd('收到，#6 仍在跑，但接近警戒線。🦞')).toBe('heartbeat');
        });

        it('CRITICAL false-positive guards: real work still forwards (classify === null)', () => {
            // 收到-led real reports
            expect(classifyLowSignalFwd('收到，正在處理 card_a60568c，預計 30 分鐘內回報')).toBeNull();
            expect(classifyLowSignalFwd('收到你的 PR #3758，我來 review')).toBeNull();
            expect(classifyLowSignalFwd('了解了，這個 bug 根因是 X，我修')).toBeNull();
            // #N-led real work — the new sibling pattern must NOT swallow these
            expect(classifyLowSignalFwd('#6 的 avatar bug 我修好了，PR #3760 待 review')).toBeNull();
            expect(classifyLowSignalFwd('#6 watchdog dashboard 重構完成，PR #3761')).toBeNull();
            // a heartbeat echo with an appended escalation must still forward
            expect(classifyLowSignalFwd('收到，#6 仍在跑，但我發現 card_123 卡住了，需要你決定')).toBeNull();
        });
    });

    describe('classifyLowSignalFwd() reason labels (card_59f41e5b)', () => {
        it('labels each noise category for the suppression-transparency log', () => {
            expect(classifyLowSignalFwd('Unexpected end of JSON input')).toBe('json_crash');
            expect(classifyLowSignalFwd('[Hermes 回應超時]')).toBe('timeout_marker');
            expect(classifyLowSignalFwd('[📢 FWD from #6] 收到 🦞')).toBe('ack');
            expect(classifyLowSignalFwd('已收到。')).toBe('ack');
            expect(classifyLowSignalFwd('📌 狀態更新：待辦 → 進行中')).toBe('kanban_echo');
            expect(classifyLowSignalFwd('[📢 FWD from #1] MODEL_HEALTH/ACK ok')).toBe('model_health');
            expect(classifyLowSignalFwd('#6_PERMISSION_HANDOFF\n- Next step: grant')).toBe('permission_handoff');
            expect(classifyLowSignalFwd('Codex #6 status heartbeat\n- Elapsed: 30s')).toBe('heartbeat');
            expect(classifyLowSignalFwd('收到，#6 仍在跑。🦞')).toBe('heartbeat');
            expect(classifyLowSignalFwd('🦞')).toBe('lobster');
            expect(classifyLowSignalFwd('short')).toBe('low_signal');
        });

        it('returns null for real signal (forwards)', () => {
            expect(classifyLowSignalFwd('收到，正在處理 card_a60568c，預計 30 分鐘內回報')).toBeNull();
            expect(classifyLowSignalFwd('Card 7a03c4 moved to in_progress, ETA 2h')).toBeNull();
        });

        it('isLowSignalFwd === (classifyLowSignalFwd != null) for a spread of inputs', () => {
            const samples = [
                null, '', '   ', 'ack', '🦞', '已收到。',
                '收到，正在處理 card_a60568c，預計 30 分鐘內回報',
                'Card 7a03c4 moved to in_progress, ETA 2h',
                '#6_PERMISSION_HANDOFF\n- Next step: grant',
                'meaningful !',
            ];
            for (const s of samples) {
                expect(isLowSignalFwd(s)).toBe(classifyLowSignalFwd(s) != null);
            }
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
