/**
 * Arena Question Pool Validator
 *
 * Verifies that a question pool (freshly generated or on disk) can be
 * executed end-to-end by the Arena runtime. Catches the class of bugs
 * where a malformed entry silently lands in arena-questions.json and
 * then blows up `GET /arena/test/:examId` with a 500 for every taker.
 *
 * Two modes:
 *   - Static (fast, no network): for each test type, run the generator,
 *     the stripSecretsForBot() transformer, and the SCORING_ENGINES
 *     scorer with both empty and "perfect" synthetic actions. Any throw,
 *     missing required field, or JSON round-trip failure is reported.
 *   - Live (HTTP): create a real exam against a running server and
 *     fetch `GET /arena/test/:examId`; any non-200 fails validation.
 *
 * Exit codes for CLI usage:
 *   0 — all validations passed
 *   1 — one or more validations failed
 *   2 — internal error (module load failure, network error, etc.)
 *
 * CLI:
 *   node backend/arena-pool-validator.js                # static validation of current pool file
 *   node backend/arena-pool-validator.js --live=https://eclawbot.com
 */

'use strict';

const fs = require('fs');
const path = require('path');

const arenaModule = require('./interview-arena');
const poolUpdater = require('./arena-pool-updater');

const {
    TEST_TYPES,
    CHALLENGE_GENERATORS,
    SCORING_ENGINES,
    stripSecretsForBot,
} = arenaModule;

const REPEAT_PER_TYPE = 20;       // how many draws per test type during static validation
const PERFECT_TIMESTAMP = 1;       // used as base timestamp for synthetic "perfect" actions

// ── Synthetic "perfect" action builders ─────────────────────────────────────
// A bot that does the right thing should earn ≥ 50% of the test weight.
// If the scorer returns 0 for a perfect action sequence, the config is broken.

const PERFECT_ACTIONS = {
    arena_vision: (c) => [
        { actionType: 'page_loaded', payload: {}, timestamp: PERFECT_TIMESTAMP },
        { actionType: 'description_submitted',
          payload: { text: (c.expectedKeywords || []).join(' ') },
          timestamp: PERFECT_TIMESTAMP + 1 },
    ],
    arena_button_click: (c) => [
        { actionType: 'button_clicked',
          payload: { buttonLabel: c.correctLabel },
          timestamp: PERFECT_TIMESTAMP },
    ],
    arena_form_fill: (c) => {
        const fields = {};
        for (const f of (c.fields || [])) fields[f.name] = f.expectedValue;
        return [{ actionType: 'form_submitted', payload: { fields }, timestamp: PERFECT_TIMESTAMP }];
    },
    arena_drag_drop: (c) => {
        const t = c.targetRect || { x: 0, y: 0, w: 0, h: 0 };
        return [{ actionType: 'element_dragged',
                  payload: { dropX: t.x + Math.floor(t.w / 2), dropY: t.y + Math.floor(t.h / 2) },
                  timestamp: PERFECT_TIMESTAMP }];
    },
    arena_navigation: (c) => [
        { actionType: 'page_navigated', payload: { depth: 4 }, timestamp: PERFECT_TIMESTAMP },
        // Post-anti-cheat-hardening: scorer requires the serial in payload.
        // A bare empty {} no longer scores full marks (intentional — self-
        // report exploit fix). Feed the real targetInfo so the synthetic
        // "perfect" trial still exercises the happy path.
        { actionType: 'target_found', payload: { targetInfo: c.targetInfo }, timestamp: PERFECT_TIMESTAMP + 1 },
    ],
    arena_table_extract: (c) => [
        { actionType: 'page_loaded', payload: {}, timestamp: PERFECT_TIMESTAMP },
        { actionType: 'answer_submitted',
          payload: { answer: String(c.correctAnswer ?? '') },
          timestamp: PERFECT_TIMESTAMP + 1 },
    ],
    arena_distraction: (c) => [
        { actionType: 'button_clicked',
          payload: { buttonId: c.realButtonId },
          timestamp: PERFECT_TIMESTAMP },
    ],
    arena_coding: (c) => [
        { actionType: 'code_submitted',
          payload: { testResults: (c.testCases || []).map(() => true) },
          timestamp: PERFECT_TIMESTAMP },
    ],
    arena_response_time: (c) => [
        { actionType: 'answer_submitted',
          payload: { answer: (c.expectedKeywords || []).join(' '), elapsed_ms: 4000 },
          timestamp: PERFECT_TIMESTAMP },
    ],
    arena_memory: (c) => [
        { actionType: 'answer_submitted',
          payload: { answer: String(c.expectedAnswer ?? '') },
          timestamp: PERFECT_TIMESTAMP },
    ],
    arena_file_mgmt: () => [
        { actionType: 'file_downloaded', payload: {}, timestamp: PERFECT_TIMESTAMP },
        { actionType: 'file_renamed', payload: {}, timestamp: PERFECT_TIMESTAMP + 1 },
        { actionType: 'file_uploaded', payload: {}, timestamp: PERFECT_TIMESTAMP + 2 },
    ],
    arena_tts: (c) => [
        { actionType: 'transcription_submitted',
          payload: { text: (c.keywords || []).join(' ') },
          timestamp: PERFECT_TIMESTAMP },
    ],
};

// ── Config shape assertions per test type ───────────────────────────────────
// These guard against "stripSecretsForBot passes but the UI/scorer blows up".

const CONFIG_REQUIRED_FIELDS = {
    arena_vision:        ['expectedKeywords'],  // description OR imageFile also required (checked below)
    arena_button_click:  ['correctLabel', 'buttonCount'],
    arena_form_fill:     ['fields'],
    arena_drag_drop:     ['targetRect', 'sourcePosition'],
    arena_navigation:    ['correctPath', 'targetInfo', 'depth'],
    arena_table_extract: ['tableData', 'columns', 'question', 'correctAnswer'],
    arena_distraction:   ['realButtonId', 'fakeButtonIds'],
    arena_coding:        ['title', 'description', 'testCases'],
    arena_response_time: ['question', 'expectedKeywords'],
    arena_memory:        ['question', 'expectedAnswer'],
    arena_file_mgmt:     ['filename', 'newFilename', 'fileContent'],
    arena_tts:           ['text', 'keywords'],
};

// ── Core static validator ───────────────────────────────────────────────────

function validateConfigShape(testType, config) {
    const issues = [];
    if (!config || typeof config !== 'object') {
        issues.push(`${testType}: generator returned non-object config`);
        return issues;
    }
    const required = CONFIG_REQUIRED_FIELDS[testType] || [];
    for (const field of required) {
        if (config[field] === undefined || config[field] === null) {
            issues.push(`${testType}: missing required field "${field}"`);
        }
    }
    // Type-specific shape checks
    if (testType === 'arena_vision') {
        if (!config.imageFile && !config.description) {
            issues.push('arena_vision: both imageFile and description are empty');
        }
        if (!Array.isArray(config.expectedKeywords) || config.expectedKeywords.length === 0) {
            issues.push('arena_vision: expectedKeywords must be a non-empty array');
        }
    }
    if (testType === 'arena_form_fill') {
        if (!Array.isArray(config.fields) || config.fields.length === 0) {
            issues.push('arena_form_fill: fields must be a non-empty array');
        } else {
            for (const f of config.fields) {
                if (!f.name || !f.type || f.expectedValue === undefined) {
                    issues.push(`arena_form_fill: field missing name/type/expectedValue: ${JSON.stringify(f)}`);
                }
            }
        }
    }
    if (testType === 'arena_coding') {
        if (!Array.isArray(config.testCases) || config.testCases.length === 0) {
            issues.push('arena_coding: testCases must be a non-empty array');
        }
    }
    if (testType === 'arena_table_extract') {
        if (!Array.isArray(config.tableData) || config.tableData.length === 0) {
            issues.push('arena_table_extract: tableData must be a non-empty array');
        }
    }
    if (testType === 'arena_distraction') {
        if (!Array.isArray(config.fakeButtonIds) || config.fakeButtonIds.length === 0) {
            issues.push('arena_distraction: fakeButtonIds must be a non-empty array');
        }
    }
    if (testType === 'arena_drag_drop') {
        const t = config.targetRect || {};
        if (typeof t.x !== 'number' || typeof t.y !== 'number' ||
            typeof t.w !== 'number' || typeof t.h !== 'number') {
            issues.push('arena_drag_drop: targetRect must have numeric x/y/w/h');
        }
    }
    return issues;
}

function runOneTrial(testType, previousConfigs) {
    const issues = [];
    const warnings = [];
    const generator = CHALLENGE_GENERATORS[testType];
    if (!generator) return { issues: [`${testType}: no generator registered`], warnings };

    // 1. Generate
    let config;
    try {
        // arena_memory is special — takes an array of previous session-like objects
        config = testType === 'arena_memory'
            ? generator(previousConfigs.map(c => ({ challenge_config: c })))
            : generator(/* weights */ null);
    } catch (err) {
        return { issues: [`${testType}: generator threw: ${err.message}`], warnings };
    }

    // 2. Shape check
    issues.push(...validateConfigShape(testType, config));

    // 3. JSON round-trip (PostgreSQL JSONB + HTTP JSON must not lose data)
    let roundTripped;
    try {
        roundTripped = JSON.parse(JSON.stringify(config));
    } catch (err) {
        issues.push(`${testType}: config is not JSON serializable: ${err.message}`);
        return { issues, warnings };
    }

    // 4. stripSecretsForBot (the exact transform that /arena/test/:examId runs)
    let stripped;
    try {
        stripped = stripSecretsForBot(testType, roundTripped);
    } catch (err) {
        issues.push(`${testType}: stripSecretsForBot threw: ${err.message}`);
        return { issues, warnings };
    }
    if (!stripped || typeof stripped !== 'object') {
        issues.push(`${testType}: stripSecretsForBot returned non-object`);
    }

    // 5. Scoring with empty actions (must not throw; must return 0 or near-0)
    const scorer = SCORING_ENGINES[testType];
    if (!scorer) {
        issues.push(`${testType}: no scoring engine registered`);
    } else {
        const configWithWeight = { ...config, weight: (TEST_TYPES.find(t => t.id === testType) || {}).weight || 10 };
        try {
            const empty = scorer(configWithWeight, []);
            if (!empty || typeof empty.score !== 'number') {
                issues.push(`${testType}: scorer(empty) returned invalid result: ${JSON.stringify(empty)}`);
            }
        } catch (err) {
            issues.push(`${testType}: scorer threw on empty actions: ${err.message}`);
        }

        // 6. Scoring with perfect synthetic actions — must score > 0
        //    EXCEPTION: arena_coding currently degrades to score=0 by design
        //    (anti-cheat: self-reported testResults are not trusted until a
        //    real sandboxed executor lands). For coding we just verify the
        //    scorer surfaces the server_side_execution_pending:true flag
        //    and an expected shape — no "> 0" assertion.
        const perfectBuilder = PERFECT_ACTIONS[testType];
        if (perfectBuilder) {
            try {
                const actions = perfectBuilder(configWithWeight);
                const result = scorer(configWithWeight, actions);
                if (!result || typeof result.score !== 'number') {
                    issues.push(`${testType}: scorer(perfect) returned invalid result: ${JSON.stringify(result)}`);
                } else if (testType === 'arena_coding') {
                    if (result.score !== 0 || result.server_side_execution_pending !== true) {
                        issues.push(`arena_coding: expected degraded {score:0, server_side_execution_pending:true} shape, got ${summarize(result)}`);
                    }
                } else if (result.score === 0) {
                    issues.push(`${testType}: perfect action sequence scored 0 — scorer or config mismatch (config=${summarize(config)})`);
                } else if (result.score > result.maxScore) {
                    // Note: not a hard failure — the real runtime clamps via applySpeedBonus.
                    // But still report as a warning so known-benign cases are visible.
                    warnings.push(`${testType}: perfect action sequence scored ${result.score} > maxScore ${result.maxScore} (clamped at runtime)`);
                }
            } catch (err) {
                issues.push(`${testType}: scorer threw on perfect actions: ${err.message}`);
            }
        }
    }

    return { issues, warnings };
}

function summarize(obj) {
    const s = JSON.stringify(obj);
    return s.length > 120 ? s.slice(0, 117) + '…' : s;
}

/**
 * Run static validation over all 12 test types, REPEAT_PER_TYPE draws each.
 *
 * @param {object} [opts]
 * @param {number} [opts.repeats=REPEAT_PER_TYPE] — draws per test type
 * @param {string[]} [opts.only] — restrict to these test type ids
 * @returns {{ ok: boolean, issues: string[], trials: number, byType: Record<string, {trials: number, fails: number}> }}
 */
function validateStatic(opts = {}) {
    const repeats = opts.repeats || REPEAT_PER_TYPE;
    const only    = opts.only ? new Set(opts.only) : null;
    const typesToRun = TEST_TYPES.filter(t => !only || only.has(t.id));

    const issues = [];
    const warnings = [];
    const byType = {};
    let trials = 0;

    for (const tt of typesToRun) {
        byType[tt.id] = { trials: 0, fails: 0, warns: 0 };
    }

    // arena_memory depends on prior sessions' configs — gather them per exam
    for (let round = 0; round < repeats; round++) {
        const priorConfigs = [];
        for (const tt of typesToRun) {
            byType[tt.id].trials++;
            trials++;
            const trial = runOneTrial(tt.id, priorConfigs);
            if (trial.issues.length) {
                byType[tt.id].fails++;
                issues.push(...trial.issues.map(i => `[round ${round + 1}] ${i}`));
            }
            if (trial.warnings.length) {
                byType[tt.id].warns++;
                warnings.push(...trial.warnings.map(w => `[round ${round + 1}] ${w}`));
            }
            // Re-run the generator to capture a prior config (arena_memory peeks at first test's config)
            try {
                const g = CHALLENGE_GENERATORS[tt.id];
                priorConfigs.push(tt.id === 'arena_memory'
                    ? g(priorConfigs.map(c => ({ challenge_config: c })))
                    : g(null));
            } catch { /* already reported */ }
        }
    }

    return { ok: issues.length === 0, issues, warnings, trials, byType };
}

/**
 * Validate a specific pools object (before writing to disk). Temporarily
 * swaps the module's in-memory pools with the provided ones so the
 * generators draw from the candidate data.
 *
 * Safety: always restores the original pools in a finally block, even if
 * validation throws.
 */
function validateCandidatePools(pools, opts = {}) {
    const log = opts.log || (() => {});
    // Snapshot current pools
    const poolFile = poolUpdater.POOL_FILE;
    const hadFile = fs.existsSync(poolFile);
    const backup = hadFile ? fs.readFileSync(poolFile, 'utf8') : null;

    try {
        // Write candidate to the pool file so reloadPools() picks it up
        fs.mkdirSync(path.dirname(poolFile), { recursive: true });
        fs.writeFileSync(poolFile, JSON.stringify({
            version: -1, updatedAt: new Date().toISOString(), pools,
        }, null, 2));
        // Force the arena module to re-load its in-memory arrays
        if (typeof arenaModule.reloadPools === 'function') arenaModule.reloadPools();
        log('info', 'Candidate pools loaded into memory for validation');
        return validateStatic(opts);
    } finally {
        // Restore
        if (backup !== null) {
            fs.writeFileSync(poolFile, backup);
        } else if (fs.existsSync(poolFile)) {
            fs.unlinkSync(poolFile);
        }
        if (typeof arenaModule.reloadPools === 'function') arenaModule.reloadPools();
        log('info', 'Original pools restored after validation');
    }
}

// ── Live validator ──────────────────────────────────────────────────────────
// Creates a real exam against a running server, fetches it, submits perfect
// synthetic actions for every session, finalizes, and verifies a positive
// total_score. This is the strongest proof that the full scoring pipeline
// (DB → stripSecretsForBot → action route → scorer → finalize) is healthy.

async function validateLive(baseUrl, opts = {}) {
    const log = opts.log || (() => {});
    const fetchFn = globalThis.fetch;
    if (typeof fetchFn !== 'function') {
        return { ok: false, issues: ['global fetch() unavailable (need Node 18+)'], stage: 'init' };
    }
    baseUrl = baseUrl.replace(/\/+$/, '');
    log('info', `Creating live exam at ${baseUrl} …`);

    // 1. Create exam
    let examId;
    try {
        const res = await fetchFn(`${baseUrl}/api/arena/exam`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
        });
        if (res.status === 429) {
            return { ok: false, issues: ['cooldown active — live validation skipped'], stage: 'create_exam', cooldown: true };
        }
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            return { ok: false, issues: [`create exam failed (${res.status}): ${body.slice(0, 200)}`], stage: 'create_exam' };
        }
        const data = await res.json();
        examId = data?.exam?.id;
        if (!examId) return { ok: false, issues: ['create exam returned no id'], stage: 'create_exam' };
        log('info', `Exam created: ${examId}`);
    } catch (err) {
        return { ok: false, issues: [`create exam threw: ${err.message}`], stage: 'create_exam' };
    }

    // 2. Fetch test page (this was the endpoint that 500-ed before the fix)
    let tests;
    try {
        const res = await fetchFn(`${baseUrl}/arena/test/${examId}`);
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            return { ok: false, issues: [`GET /arena/test/${examId} returned ${res.status}: ${body.slice(0, 200)}`], stage: 'fetch_tests', examId };
        }
        const data = await res.json();
        if (!Array.isArray(data.tests) || data.tests.length !== TEST_TYPES.length) {
            return { ok: false, issues: [`expected ${TEST_TYPES.length} tests, got ${data.tests?.length}`], stage: 'fetch_tests', examId };
        }
        tests = data.tests;
        log('info', `Exam fetch OK — ${tests.length} tests, action endpoints reachable`);
    } catch (err) {
        return { ok: false, issues: [`fetch tests threw: ${err.message}`], stage: 'fetch_tests', examId };
    }

    // If caller only wants to verify the fetch stage, stop here.
    if (opts.skipActions) {
        return { ok: true, issues: [], stage: 'fetch_tests', examId, testCount: tests.length };
    }

    // 3. Submit perfect synthetic actions for each session.
    // The bot-facing stripped config hides ground truth (decoy pattern), so we
    // fetch the un-stripped original via the admin lookup endpoint when available.
    // Without admin access, this exercises the /action route (proves it accepts
    // payloads without 500) but cannot guarantee a perfect score — a positive
    // total_score after finalize is still strong evidence the pipeline works.
    const actionIssues = [];
    for (const test of tests) {
        const builder = PERFECT_ACTIONS[test.testType];
        if (!builder) continue;
        // Config seen here is the stripped bot-facing view. Use it as the
        // scorer input anyway — it at least exercises the action route.
        const configGuess = { ...test.challengeConfig, weight: test.maxScore };
        let actions;
        try {
            actions = builder(configGuess);
        } catch (err) {
            actionIssues.push(`${test.testType}: synthetic action builder threw: ${err.message}`);
            continue;
        }
        for (const a of actions) {
            try {
                const res = await fetchFn(`${baseUrl}/api/arena/${test.sessionToken}/action`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ actionType: a.actionType, payload: a.payload }),
                });
                if (!res.ok) {
                    const body = await res.text().catch(() => '');
                    actionIssues.push(`${test.testType} ${a.actionType} returned ${res.status}: ${body.slice(0, 120)}`);
                }
            } catch (err) {
                actionIssues.push(`${test.testType} ${a.actionType} threw: ${err.message}`);
            }
        }
    }
    if (actionIssues.length) {
        // Any non-2xx from /action is a real bug — the route itself should
        // accept well-formed payloads even if the answer is wrong.
        return { ok: false, issues: actionIssues.slice(0, 10), stage: 'submit_actions', examId };
    }
    log('info', `All ${tests.length} sessions accepted synthetic actions`);

    // 4. Finalize
    let report;
    try {
        const res = await fetchFn(`${baseUrl}/api/arena/exam/${examId}/finalize`, { method: 'POST' });
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            return { ok: false, issues: [`finalize returned ${res.status}: ${body.slice(0, 200)}`], stage: 'finalize', examId };
        }
        report = await res.json();
    } catch (err) {
        return { ok: false, issues: [`finalize threw: ${err.message}`], stage: 'finalize', examId };
    }

    // 5. Verify a positive score came back — empirical proof the scorer runs.
    const totalScore = report?.report?.totalScore ?? report?.totalScore ?? 0;
    const maxScore   = report?.report?.maxScore   ?? report?.maxScore   ?? 0;
    if (totalScore <= 0) {
        return {
            ok: false,
            issues: [`finalize returned totalScore=${totalScore}/${maxScore} — scoring pipeline is not awarding points`],
            stage: 'finalize', examId, totalScore, maxScore,
        };
    }
    log('info', `Finalize OK — totalScore=${totalScore}/${maxScore}`);
    return { ok: true, issues: [], stage: 'finalize', examId, totalScore, maxScore, testCount: tests.length };
}

// ── In-process runtime self-test ────────────────────────────────────────────
// Runs the full create-exam → strip → score → finalize pipeline WITHOUT HTTP,
// by reusing the live DB pool and the factory's in-memory arena module.
// This is what the pool updater cron calls after writing a new pool file.

async function validateRuntimeSelfTest({ arenaModule, dbPool, log }) {
    const trace = log || (() => {});
    const out = { ok: false, issues: [], stage: 'init' };

    if (!arenaModule || !dbPool) {
        out.issues.push('arenaModule + dbPool required');
        return out;
    }
    const strip = arenaModule.stripSecretsForBot || require('./interview-arena').stripSecretsForBot;
    if (typeof strip !== 'function') {
        out.issues.push('stripSecretsForBot not accessible on arenaModule or module.exports');
        return out;
    }

    // 1. Create a scratch exam directly in DB (skip 5-min IP cooldown).
    // Generate id explicitly — the column DEFAULT can be missing/broken on
    // production (PR #1813 migration didn't always re-set the new DEFAULT).
    // Mirrors the live POST /api/arena/exam path so this test catches the
    // same NOT-NULL violation real users would hit.
    const { newExamId } = require('./entity-id');
    const examId = newExamId();
    const examToken = 'selftest-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const expiresAt = new Date(Date.now() + 30 * 60_000);
    try {
        await dbPool.query(
            `INSERT INTO arena_exams (id, exam_token, status, max_score, expires_at)
             VALUES ($1, $2, 'waiting', $3, $4)`,
            [examId, examToken, arenaModule.MAX_TOTAL_SCORE || 147, expiresAt]
        );
    } catch (err) {
        out.issues.push(`insert arena_exams failed: ${err.message}`);
        out.stage = 'create_exam';
        return out;
    }
    trace('info', `Self-test exam ${examId} created`);

    try {
        // 2. Generate 12 sessions + insert.
        const configs = [];
        for (let i = 0; i < TEST_TYPES.length; i++) {
            const tt = TEST_TYPES[i];
            const gen = CHALLENGE_GENERATORS[tt.id];
            const config = tt.id === 'arena_memory'
                ? gen(configs.map(c => ({ challenge_config: c })))
                : gen(null);
            configs.push({ ...config, weight: tt.weight });
        }

        const sessionTokens = [];
        for (let i = 0; i < TEST_TYPES.length; i++) {
            const tt = TEST_TYPES[i];
            const tok = 'selftest-' + Math.random().toString(36).slice(2, 12);
            sessionTokens.push(tok);
            try {
                await dbPool.query(
                    `INSERT INTO arena_sessions (exam_id, session_token, test_type, test_index, challenge_config, max_score)
                     VALUES ($1, $2, $3, $4, $5, $6)`,
                    [examId, tok, tt.id, i, JSON.stringify(configs[i]), tt.weight]
                );
            } catch (err) {
                out.issues.push(`insert session ${tt.id}: ${err.message}`);
                out.stage = 'create_sessions';
                return out;
            }
        }

        // 3. Read back every session (JSONB round-trip) and run the EXACT
        // transform + scoring path the live routes use.
        const sessRes = await dbPool.query(
            `SELECT session_token, test_type, test_index, challenge_config, max_score
             FROM arena_sessions WHERE exam_id = $1 ORDER BY test_index`,
            [examId]
        );
        let totalScore = 0;
        const perTest = [];
        for (const s of sessRes.rows) {
            const config = typeof s.challenge_config === 'string'
                ? JSON.parse(s.challenge_config) : s.challenge_config;

            // (a) stripSecretsForBot must not throw — this is the exact call
            //     index.js:1877 makes for GET /arena/test/:examId.
            try {
                const stripped = strip(s.test_type, config);
                if (!stripped || typeof stripped !== 'object') {
                    out.issues.push(`${s.test_type}: stripSecretsForBot returned non-object`);
                }
            } catch (err) {
                out.issues.push(`${s.test_type}: stripSecretsForBot threw: ${err.message}`);
                continue;
            }

            // (b) Score with perfect synthetic actions.
            const builder = PERFECT_ACTIONS[s.test_type];
            const scorer  = SCORING_ENGINES[s.test_type];
            if (!builder || !scorer) {
                out.issues.push(`${s.test_type}: missing builder or scorer`);
                continue;
            }
            try {
                const actions = builder({ ...config, weight: s.max_score });
                const result  = scorer({ ...config, weight: s.max_score }, actions);
                if (!result || typeof result.score !== 'number') {
                    out.issues.push(`${s.test_type}: scorer returned invalid result`);
                    continue;
                }
                // arena_coding intentionally scores 0 until server-side
                // sandboxed execution lands (anti-cheat: self-reported
                // testResults are not trusted). Skip the "score > 0" gate
                // for this one test type and instead verify the degraded
                // shape carries the pending flag.
                if (s.test_type === 'arena_coding') {
                    if (result.server_side_execution_pending !== true) {
                        out.issues.push(`arena_coding: expected server_side_execution_pending:true flag, got ${JSON.stringify(result)}`);
                    }
                    perTest.push({ testType: s.test_type, score: result.score, maxScore: result.maxScore, pending: true });
                    continue;
                }
                if (result.score <= 0) {
                    out.issues.push(`${s.test_type}: perfect actions scored 0 — scoring flow broken for this test type`);
                    continue;
                }
                totalScore += Math.min(result.score, result.maxScore);
                perTest.push({ testType: s.test_type, score: result.score, maxScore: result.maxScore });
            } catch (err) {
                out.issues.push(`${s.test_type}: scorer threw: ${err.message}`);
            }
        }

        out.totalScore = totalScore;
        out.maxScore   = arenaModule.MAX_TOTAL_SCORE || 147;
        out.perTest    = perTest;
        out.stage      = 'scored';

        if (out.issues.length === 0) {
            // Require at least 50% of the max score from synthetic perfect
            // actions — lower than that means ≥1 scorer is silently broken.
            const threshold = Math.floor(out.maxScore * 0.5);
            if (totalScore < threshold) {
                out.issues.push(`totalScore ${totalScore} < expected ≥ ${threshold} (50% of ${out.maxScore})`);
            } else {
                out.ok = true;
            }
        }
    } finally {
        // 4. Clean up — sessions cascade-delete via FK.
        try {
            await dbPool.query(`DELETE FROM arena_exams WHERE id = $1`, [examId]);
            trace('info', `Self-test exam ${examId} deleted`);
        } catch (err) {
            trace('warn', `Self-test cleanup failed: ${err.message}`);
        }
    }

    return out;
}

// ── CLI ─────────────────────────────────────────────────────────────────────

if (require.main === module) {
    (async () => {
        const args = process.argv.slice(2);
        const liveArg = args.find(a => a.startsWith('--live'));
        const onlyArg = args.find(a => a.startsWith('--only='));
        const only = onlyArg ? onlyArg.slice('--only='.length).split(',') : null;

        console.log('── Arena Pool Validator ──');
        console.log('Running static validation…');
        const staticResult = validateStatic({ only });
        console.log(`\nStatic: ${staticResult.ok ? 'PASS' : 'FAIL'} (${staticResult.trials} trials)`);
        for (const [t, s] of Object.entries(staticResult.byType)) {
            const warn = s.warns > 0 ? ` (${s.warns} warn)` : '';
            console.log(`  ${t}: ${s.trials - s.fails}/${s.trials} OK${warn}`);
        }
        if (!staticResult.ok) {
            console.log('\nIssues:');
            for (const issue of staticResult.issues.slice(0, 50)) console.log('  - ' + issue);
            if (staticResult.issues.length > 50) console.log(`  (+${staticResult.issues.length - 50} more)`);
        }
        if (staticResult.warnings && staticResult.warnings.length) {
            console.log(`\nWarnings (${staticResult.warnings.length}, non-blocking):`);
            // dedupe for readability
            const unique = [...new Set(staticResult.warnings)].slice(0, 10);
            for (const w of unique) console.log('  ! ' + w);
            if (staticResult.warnings.length > unique.length) {
                console.log(`  (+${staticResult.warnings.length - unique.length} more — likely duplicates)`);
            }
        }

        let liveResult = null;
        if (liveArg) {
            const baseUrl = liveArg.includes('=')
                ? liveArg.split('=')[1]
                : (args[args.indexOf(liveArg) + 1] || 'https://eclawbot.com');
            console.log(`\nRunning live validation against ${baseUrl}…`);
            liveResult = await validateLive(baseUrl, { log: (l, m) => console.log(`  [${l}] ${m}`) });
            console.log(`Live: ${liveResult.ok ? 'PASS' : 'FAIL'}${liveResult.cooldown ? ' (cooldown — skipped)' : ''}`);
            if (!liveResult.ok && !liveResult.cooldown) {
                for (const issue of liveResult.issues) console.log('  - ' + issue);
            }
        }

        const failed = !staticResult.ok || (liveResult && !liveResult.ok && !liveResult.cooldown);
        process.exit(failed ? 1 : 0);
    })().catch(err => {
        console.error('Validator crashed:', err);
        process.exit(2);
    });
}

module.exports = {
    validateStatic,
    validateCandidatePools,
    validateLive,
    validateRuntimeSelfTest,
    CONFIG_REQUIRED_FIELDS,
    PERFECT_ACTIONS,
};
