/**
 * Arena Question Pool Auto-Updater
 *
 * Runs daily (cron: 0 3 * * * UTC) or on demand via
 * POST /api/arena/admin/refresh-pool.
 *
 * Algorithm:
 *   1. Query historical pass-rate data from arena_sessions
 *   2. Retire too-easy questions (weight ≤ 1.2 → pass rate ≥ 90%)
 *   3. Retire too-buggy questions (weight ≥ 2.9 AND attempts ≥ 10)
 *   4. Generate replacements via Claude API (claude-sonnet-4-6)
 *   5. Write updated pool to data/arena-questions.json
 *   6. Hot-reload in-memory arrays via arenaModule.reloadPools()
 *
 * Target difficulty: 70/100
 *   20% easy   (pass rate 80–100%)
 *   50% medium (pass rate 40–80%)
 *   30% hard   (pass rate 0–40%)
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const POOL_FILE         = path.join(__dirname, 'data', 'arena-questions.json');
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const UPDATER_MODEL     = 'claude-sonnet-4-6';
const CALL_TIMEOUT_MS   = 90_000;

// Retirement thresholds (derived from weight = 1 + 2*(1 − pass_rate))
const EASY_WEIGHT          = 1.2;  // pass rate ≥ 90% → retire
const HARD_WEIGHT          = 2.9;  // pass rate ≤ 5%  → investigate
const MIN_ATTEMPTS_HARD    = 10;   // only retire hard questions after this many real attempts

// Pool size floors — never let a pool drop below these
const POOL_TARGETS = {
    arena_vision:        25,
    arena_coding:        20,
    arena_response_time: 20,
    arena_tts:           20,
};

// ── Difficulty analysis ──────────────────────────────────────────────────────

async function fetchDifficultyStats(dbPool) {
    const res = await dbPool.query(`
        SELECT test_type,
               challenge_config->>'title'       AS q_key,
               challenge_config->>'question'    AS q_question,
               challenge_config->>'text'        AS q_text,
               challenge_config->>'imageFile'   AS q_image,
               challenge_config->>'description' AS q_desc,
               COUNT(*)                         AS attempts,
               AVG(CASE WHEN score > 0 THEN 1.0 ELSE 0.0 END) AS pass_rate
        FROM arena_sessions
        WHERE status = 'completed'
        GROUP BY test_type, q_key, q_question, q_text, q_image, q_desc
        HAVING COUNT(*) >= 2
    `);

    const stats = {};
    for (const row of res.rows) {
        if (!stats[row.test_type]) stats[row.test_type] = {};
        const key = row.q_key || row.q_question || row.q_text || row.q_image || row.q_desc || 'unknown';
        stats[row.test_type][key] = {
            passRate: parseFloat(row.pass_rate),
            attempts: parseInt(row.attempts, 10),
            weight:   1.0 + 2.0 * (1.0 - parseFloat(row.pass_rate)),
        };
    }
    return stats;
}

function analyzeRetirements(items, keyFn, typeStats) {
    const retire = [];
    const keep   = [];
    for (const item of items) {
        const stat = typeStats && typeStats[keyFn(item)];
        if (!stat) { keep.push(item); continue; }
        if (stat.weight <= EASY_WEIGHT) {
            retire.push({ item, reason: 'too_easy', ...stat });
        } else if (stat.weight >= HARD_WEIGHT && stat.attempts >= MIN_ATTEMPTS_HARD) {
            retire.push({ item, reason: 'too_buggy', ...stat });
        } else {
            keep.push(item);
        }
    }
    return { retire, keep };
}

// ── Claude API helpers ───────────────────────────────────────────────────────

const GENERATION_SYSTEM = `You are a benchmark question designer for an AI agent capability test.
Design questions that genuinely discriminate between capable and shortcutting agents.
Target difficulty: medium-to-hard — agents with real capabilities pass; those that hallucinate or cheat fail.
Respond ONLY with a valid JSON array inside a markdown json code fence. No prose.`;

async function callClaude(prompt) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

    const response = await fetch(ANTHROPIC_API_URL, {
        method: 'POST',
        headers: {
            'Content-Type':      'application/json',
            'x-api-key':         apiKey,
            'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
            model:      UPDATER_MODEL,
            max_tokens: 4096,
            system:     GENERATION_SYSTEM,
            messages:   [{ role: 'user', content: prompt }],
        }),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });

    if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`Claude API ${response.status}: ${body.slice(0, 200)}`);
    }

    const data = await response.json();
    const text = (data.content || []).find(b => b.type === 'text')?.text || '';

    // Extract JSON array — handle ```json ... ``` or bare [...]
    const fenced = text.match(/```json\s*([\s\S]*?)```/);
    const bare   = text.match(/(\[[\s\S]*?\])\s*$/);
    const raw    = fenced ? fenced[1] : (bare ? bare[1] : null);
    if (!raw) throw new Error('No JSON array found in Claude response');
    return JSON.parse(raw);
}

async function generateVisionQuestions(count) {
    const result = await callClaude(`
Generate ${count} vision challenge scene descriptions for an AI agent benchmark.
Each scene must require genuine visual analysis: counting objects, reading text/numbers, spatial layout, chart data, etc.
Avoid trivial single-object scenes; prefer realistic multi-element images with specific verifiable details.

Return a JSON array:
\`\`\`json
[{"description": "A scene description (1-2 sentences).", "keywords": ["word1", "number", "word2"]}]
\`\`\`

Rules:
- description: vivid, specific — an agent must describe FROM an actual image
- keywords: 3-6 exact words/numbers that MUST appear in a correct description
- Keywords must be objective facts visible in the scene (counts, labels, measurements, colors)
- Forbidden as keywords: purple, hexagon, striped, spiral, gradient, dotted, metallic, transparent, zigzag, oval, checkerboard, holographic, embossed, tessellated, iridescent
`);
    return result.filter(q => q.description && Array.isArray(q.keywords) && q.keywords.length >= 2);
}

async function generateCodingQuestions(count) {
    const result = await callClaude(`
Generate ${count} coding challenges for an AI agent benchmark (LeetCode Medium difficulty).
Cover diverse algorithm categories: dynamic programming, BFS/DFS, two-pointer, sliding window, tree/graph, string manipulation.

Return a JSON array:
\`\`\`json
[{
  "title": "Short Problem Title",
  "description": "Write \`solve(...args)\` — clear problem statement with input/output contract.",
  "testCases": [
    {"input": "arg1, arg2", "expected": "result_string"},
    {"input": "edge_case",  "expected": "edge_result"}
  ]
}]
\`\`\`

Rules:
- 3-5 test cases per problem; include at least one edge case (empty input, negative, zero)
- expected values: exact string representation of the return value
- Problems must have a unique, unambiguous correct answer
- Do NOT duplicate any of: Climbing Stairs, Coin Change, Number of Islands, Longest Substring No Repeat,
  Group Anagrams, 0-1 Knapsack, Decode Ways, Maximum Product Subarray, Longest Palindromic Substring,
  Two Sum, Valid Parentheses, FizzBuzz, Binary Search, Fibonacci, Matrix Transpose, Spiral Order,
  Max Subarray Sum, GCD, String Compression, Power of Two, Anagram Check, Roman to Integer
`);
    return result.filter(q => q.title && q.description && Array.isArray(q.testCases) && q.testCases.length >= 2);
}

async function generateResponseQuestions(count) {
    const result = await callClaude(`
Generate ${count} reasoning questions for an AI agent benchmark.
Mix types: multi-step arithmetic, algebra, combinatorics, basic probability, logical deduction.
Each must have exactly ONE unambiguous numeric or short-text answer.

Return a JSON array:
\`\`\`json
[{"question": "Full question sentence ending with ?", "expectedKeywords": ["exact_answer"]}]
\`\`\`

Rules:
- expectedKeywords: array containing the exact answer as a string (numbers: digits only, e.g. "42" not "forty-two")
- For fractions: use slash notation e.g. "1/4"
- Do NOT duplicate any of: pool filling (3h/6h), clock angle (3:15), farmer chicken-cow,
  hotel dollar paradox, snail wall (10m), LISTEN arrangements, right triangle 5-12-13/3-4-5,
  2^10, car travel (150km+120km), store apples+oranges, sum 1-to-100, Berlin Wall year,
  hexagon interior angles, log base 2 of x=5
`);
    return result.filter(q => q.question && Array.isArray(q.expectedKeywords) && q.expectedKeywords.length >= 1);
}

async function generateTtsPhrases(count) {
    const result = await callClaude(`
Generate ${count} TTS (text-to-speech transcription) challenge phrases for an AI agent benchmark.
These sentences are read aloud by the test system; the agent must accurately transcribe them.
Medium-to-hard: include numbers, codes, acronyms, technical terms, or proper nouns.

Return a JSON array:
\`\`\`json
[{"text": "Sentence to read aloud (15-30 words).", "keywords": ["word1", "code", "number"]}]
\`\`\`

Rules:
- text: natural English sentence; include at least one of: flight code, medical term, IP address,
  formula, financial figure, airport code, version number, or scientific name
- keywords: 3-5 specific words/codes from the sentence that verify accurate transcription
- Avoid pure random alphanumeric strings with no context
- Do NOT duplicate: Flight BA-274, IPv4 192.168.1.1, Machu Picchu 2430m,
  Worcestershire/Lieutenant Colonel, Fibonacci sequence phrase, CH3COOH acetic acid,
  Euler identity, Tokyo Narita NRT, Bernoulli+Euler fluid/graph
`);
    return result.filter(q => q.text && Array.isArray(q.keywords) && q.keywords.length >= 2);
}

// ── Pool file I/O ─────────────────────────────────────────────────────────────

function readPoolFile() {
    try {
        return JSON.parse(fs.readFileSync(POOL_FILE, 'utf8'));
    } catch {
        return null;
    }
}

function writePoolFile(data) {
    fs.mkdirSync(path.dirname(POOL_FILE), { recursive: true });
    fs.writeFileSync(POOL_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// ── Main orchestrator ─────────────────────────────────────────────────────────

/**
 * Run the daily question pool update.
 *
 * @param {object} opts
 * @param {import('pg').Pool} opts.dbPool        - PostgreSQL connection pool
 * @param {function}          opts.getCurrentPools - () → { arena_vision, arena_coding, ... }
 * @param {function}          opts.reloadPools    - () → void  (hot-reload in-memory arrays)
 * @param {function}          [opts.serverLog]    - (level, category, msg) → void
 * @returns {Promise<{retired: number, added: number, errors: string[]}>}
 */
async function runPoolUpdate({ dbPool, getCurrentPools, reloadPools, serverLog }) {
    const log = (level, msg) => serverLog
        ? serverLog(level, 'arena_updater', msg)
        : console.log(`[PoolUpdater/${level}] ${msg}`);

    log('info', `Starting daily pool update — target difficulty 70/100 — model: ${UPDATER_MODEL}`);

    const summary = { retired: 0, added: 0, errors: [] };

    // ── 1. Load current pools ─────────────────────────────────────────────────
    const fileData     = readPoolFile();
    const currentPools = fileData?.pools || getCurrentPools();

    // ── 2. Fetch difficulty stats ─────────────────────────────────────────────
    let stats = {};
    try {
        stats = await fetchDifficultyStats(dbPool);
        log('info', `Difficulty data loaded for ${Object.keys(stats).length} test type(s)`);
    } catch (err) {
        log('warn', `Difficulty fetch failed (${err.message}) — additions only`);
        summary.errors.push(`difficulty_fetch: ${err.message}`);
    }

    // ── 3. Process each updatable pool ────────────────────────────────────────
    const POOL_CONFIGS = [
        {
            key:      'arena_vision',
            keyFn:    v => v.file || v.description || '',
            generate: generateVisionQuestions,
            mapNew:   q => ({ file: null, description: q.description, keywords: q.keywords }),
        },
        {
            key:      'arena_coding',
            keyFn:    p => p.title,
            generate: generateCodingQuestions,
            mapNew:   q => q,
        },
        {
            key:      'arena_response_time',
            keyFn:    q => q.question,
            generate: generateResponseQuestions,
            mapNew:   q => q,
        },
        {
            key:      'arena_tts',
            keyFn:    p => p.text,
            generate: generateTtsPhrases,
            mapNew:   q => q,
        },
    ];

    const updatedPools = { ...currentPools };

    for (const cfg of POOL_CONFIGS) {
        try {
            const pool   = updatedPools[cfg.key] || [];
            const target = POOL_TARGETS[cfg.key];

            const { retire, keep } = analyzeRetirements(pool, cfg.keyFn, stats[cfg.key] || {});

            if (retire.length > 0) {
                const labels = retire.map(r =>
                    `"${cfg.keyFn(r.item).slice(0, 45)}…" (${r.reason}, pass=${(r.passRate * 100).toFixed(0)}%, n=${r.attempts})`
                ).join('\n    ');
                log('info', `${cfg.key}: retiring ${retire.length} question(s):\n    ${labels}`);
                summary.retired += retire.length;
            }

            // Generate enough to: top-up to target AND replace retired items (up to 4 at once)
            const needed = Math.max(0, target - keep.length) + Math.min(retire.length, 4);

            if (needed > 0) {
                log('info', `${cfg.key}: generating ${needed} new question(s)…`);
                try {
                    const generated = await cfg.generate(needed);
                    const valid = generated
                        .filter(q => q && typeof q === 'object')
                        .map(cfg.mapNew);
                    updatedPools[cfg.key] = [...keep, ...valid];
                    summary.added += valid.length;
                    log('info', `${cfg.key}: pool ${pool.length} → ${updatedPools[cfg.key].length} (+${valid.length})`);
                } catch (genErr) {
                    log('warn', `${cfg.key}: generation failed (${genErr.message}) — keeping current pool`);
                    summary.errors.push(`${cfg.key}_gen: ${genErr.message}`);
                    updatedPools[cfg.key] = pool; // safe fallback: no change
                }
            } else {
                updatedPools[cfg.key] = keep;
                log('info', `${cfg.key}: pool OK at ${keep.length} questions (no generation needed)`);
            }
        } catch (err) {
            log('warn', `${cfg.key}: processing error (${err.message})`);
            summary.errors.push(`${cfg.key}: ${err.message}`);
        }
    }

    // ── 4. Persist to JSON ────────────────────────────────────────────────────
    try {
        writePoolFile({
            version:     (fileData?.version || 0) + 1,
            updatedAt:   new Date().toISOString(),
            lastSummary: summary,
            pools:       updatedPools,
        });
        log('info', 'Pool file written to data/arena-questions.json');
    } catch (writeErr) {
        log('warn', `Pool file write failed: ${writeErr.message}`);
        summary.errors.push(`write: ${writeErr.message}`);
    }

    // ── 5. Hot-reload in-memory arrays ────────────────────────────────────────
    try {
        reloadPools();
        log('info', 'In-memory pools reloaded');
    } catch (reloadErr) {
        log('warn', `Hot-reload failed: ${reloadErr.message}`);
        summary.errors.push(`reload: ${reloadErr.message}`);
    }

    log('info', `Update complete — retired: ${summary.retired}, added: ${summary.added}, errors: ${summary.errors.length}`);
    return summary;
}

module.exports = { runPoolUpdate, readPoolFile, POOL_FILE };
