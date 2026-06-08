/**
 * Interview Arena — public bot capability testing platform.
 *
 * Serves dynamically-generated test pages at /arena/test/:token/:index.
 * Bots interact with these pages; the pages auto-report actions back
 * to POST /api/arena/:sessionToken/action. Backend scores each action
 * in real-time and pushes updates via Socket.IO.
 *
 * 12 test types: vision, button_click, form_fill, drag_drop, navigation,
 * table_extract, distraction, coding, response_time, memory,
 * file_management, tts.
 */
/* @brm-crossref: ④⑥ Bot Interview System + Bot Capability Assessment
 * Design doc: docs/plans/2026-04-10-bot-rental-marketplace-design.md
 * Roadmap:    /portal/roadmap.html */

const express = require('express');
const crypto = require('crypto');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const { newExamId } = require('./entity-id');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/realbot',
});

const _EXAM_TTL_MS = 3 * 60_000; // 3 minutes (matches UI copy)
const MAX_ACTIONS_PER_SESSION = 50;

const EXAM_STATUS = Object.freeze({ WAITING: 'waiting', ACTIVE: 'active', COMPLETED: 'completed' });
const SESSION_STATUS = Object.freeze({ PENDING: 'pending', ACTIVE: 'active', COMPLETED: 'completed' });

/** All 12 test types with metadata. */
const TEST_TYPES = Object.freeze([
    { id: 'arena_vision', category: 'web_vision', weight: 15,
      name: 'Vision Test', reference: 'OSWorld — agent visual perception benchmark' },
    { id: 'arena_button_click', category: 'web_interaction', weight: 15,
      name: 'Button Click', reference: 'WebArena — 812 real web task benchmark' },
    { id: 'arena_form_fill', category: 'form_automation', weight: 15,
      name: 'Form Fill', reference: 'WebVoyager — cross-site task benchmark' },
    { id: 'arena_drag_drop', category: 'spatial_control', weight: 12,
      name: 'Drag & Drop', reference: 'OSWorld — fine motor control & spatial reasoning' },
    { id: 'arena_navigation', category: 'multi_step', weight: 13,
      name: 'Navigation', reference: 'WebArena — multi-level site navigation' },
    { id: 'arena_table_extract', category: 'data_extraction', weight: 10,
      name: 'Table Extract', reference: 'WorkArena — enterprise knowledge work benchmark' },
    { id: 'arena_distraction', category: 'safety_resilience', weight: 10,
      name: 'Distraction', reference: 'ST-WebAgentBench — agent safety benchmark' },
    { id: 'arena_coding', category: 'code_execution', weight: 15,
      name: 'Coding', reference: 'HumanEval Pro (ACL\'25) — self-invoking code generation' },
    { id: 'arena_response_time', category: 'response_speed', weight: 10,
      name: 'Response Time', reference: 'End-to-end latency measurement' },
    { id: 'arena_memory', category: 'context_chain', weight: 10,
      name: 'Memory', reference: 'Context-Bench (Letta, 2025) — cross-step context retention' },
    { id: 'arena_file_mgmt', category: 'file_management', weight: 12,
      name: 'File Management', reference: 'R2 storage — download, rename, upload workflow' },
    { id: 'arena_tts', category: 'voice_tts', weight: 10,
      name: 'Voice / TTS', reference: 'Web Speech API — speech recognition & synthesis' },
]);

const MAX_TOTAL_SCORE = TEST_TYPES.reduce((s, t) => s + t.weight, 0); // 147

// ============================================
// Token generation
// ============================================

function generateToken(bytes = 8) {
    return crypto.randomBytes(bytes).toString('hex');
}

// ============================================
// Adaptive question weighting — harder questions appear more often
// ============================================

let _difficultyCache = null;
let _difficultyCacheAt = 0;
const DIFFICULTY_CACHE_TTL = 5 * 60_000;

/**
 * Query historical failure rates per test_type + question identifier.
 * Returns Map<string, number[]> where key = test_type, value = array
 * of failure weights per pool index (higher = more bots got it wrong).
 */
async function getDifficultyWeights() {
    if (_difficultyCache && Date.now() - _difficultyCacheAt < DIFFICULTY_CACHE_TTL) {
        return _difficultyCache;
    }
    try {
        // Get average score ratio per challenge_config content for pool-based tests
        const res = await pool.query(`
            SELECT test_type,
                   challenge_config->>'title' AS q_key,
                   challenge_config->>'question' AS q_question,
                   challenge_config->>'text' AS q_text,
                   challenge_config->>'imageFile' AS q_image,
                   challenge_config->>'description' AS q_desc,
                   COUNT(*) AS attempts,
                   AVG(CASE WHEN score > 0 THEN 1.0 ELSE 0.0 END) AS pass_rate
            FROM arena_sessions
            WHERE status = 'completed'
            GROUP BY test_type, q_key, q_question, q_text, q_image, q_desc
            HAVING COUNT(*) >= 2
        `);
        const weights = {};
        for (const row of res.rows) {
            if (!weights[row.test_type]) weights[row.test_type] = {};
            // Use whichever identifier is non-null as the question key
            const key = row.q_key || row.q_question || row.q_text || row.q_image || row.q_desc || 'unknown';
            // Failure weight: questions with lower pass rates get higher weight
            // Range: 1.0 (always passed) → 3.0 (never passed)
            weights[row.test_type][key] = 1.0 + 2.0 * (1.0 - parseFloat(row.pass_rate));
        }
        _difficultyCache = weights;
        _difficultyCacheAt = Date.now();
        return weights;
    } catch (err) {
        console.warn('[Arena] difficulty query failed:', err.message);
        return {};
    }
}

/**
 * Pick from an array using difficulty-weighted random selection.
 * @param {Array} items — pool of items
 * @param {function} keyFn — extracts the lookup key from an item
 * @param {object} weights — { key: weight } from getDifficultyWeights
 * @returns item from the pool
 */
function weightedPick(items, keyFn, weights) {
    if (!weights || Object.keys(weights).length === 0) {
        return items[Math.floor(Math.random() * items.length)];
    }
    const w = items.map(item => weights[keyFn(item)] || 1.0);
    const total = w.reduce((s, v) => s + v, 0);
    let r = Math.random() * total;
    for (let i = 0; i < items.length; i++) {
        r -= w[i];
        if (r <= 0) return items[i];
    }
    return items[items.length - 1];
}

// ============================================
// Challenge config generators
// ============================================

let VISION_IMAGES = [
    // img-f3a1.svg retired (pass rate 100%) — replaced below
    { file: null, description: 'A system monitoring dashboard showing CPU at 87%, RAM usage 11.2 GB of 16 GB, disk I/O at 340 MB/s, and 3 active processes flagged in red', keywords: ['CPU', '87', 'RAM', 'disk', 'three', 'red'] },
    { file: null, description: 'A product comparison table with three columns: Basic at $9/month, Pro at $29/month, and Enterprise with custom pricing — the Pro column is highlighted in yellow', keywords: ['comparison', 'three', 'basic', 'pro', 'enterprise', 'yellow', '29'] },
    { file: null, description: 'A mobile app notifications screen showing 3 unread messages from "Alice", 1 calendar reminder for "Team Meeting at 2 PM", and a battery warning in orange', keywords: ['three', 'unread', 'alice', 'calendar', 'meeting', 'orange', 'battery'] },
    { file: null, description: 'A traffic light monitoring dashboard showing intersection data: 127 vehicles in the last hour, average wait time 45 seconds, current signal status is green', keywords: ['traffic', '127', 'vehicles', 'wait', '45', 'green'] },
    // ── Easy tier (20%) — basic shape/object recognition ──
    { file: null, description: 'A red heart shape centered on a white background', keywords: ['heart', 'red'] },
    { file: null, description: 'A green checkmark inside a circle', keywords: ['checkmark', 'green', 'circle'] },
    // A blue water droplet shape on gray retired (pass rate 100%) — replaced below
    { file: null, description: 'A yellow sun with eight rays extending outward', keywords: ['sun', 'yellow', 'rays'] },
    { file: null, description: 'A simple house with a red roof and brown door', keywords: ['house', 'roof', 'door'] },
    // ── Medium tier (50%) — counting, labels, multi-object scenes ──
    { file: null, description: 'A bar chart with four bars labeled Q1 through Q4 where Q3 is the tallest', keywords: ['bar', 'chart', 'four', 'Q3'] },
    { file: null, description: 'A Git commit graph showing three branches: main has 5 commits, feature-auth branches off commit 2 with 3 commits, and hotfix branches off commit 4 of main with 1 commit', keywords: ['git', 'three', 'branches', 'main', 'feature', 'hotfix'] },
    { file: null, description: 'A spreadsheet with five rows of sales data: Region A $142K, Region B $98K, Region C $227K, Region D $65K, Region E $183K — Region C is highlighted in green as the highest', keywords: ['spreadsheet', 'region', 'highest', '227', 'five', 'green'] },
    { file: null, description: 'A Venn diagram with three overlapping circles labeled A, B, and C', keywords: ['venn', 'three', 'circles'] },
    { file: null, description: 'A road sign reading SPEED LIMIT 65 against a blue sky', keywords: ['sign', 'speed', '65'] },
    { file: null, description: 'A calendar page showing March with the 15th circled in red', keywords: ['calendar', 'march', '15', 'red'] },
    { file: null, description: 'Three overlapping translucent circles in red, green, and blue forming additive color mix', keywords: ['three', 'circles', 'red', 'green', 'blue'] },
    { file: null, description: 'A whiteboard with the equation E = mc² written in blue marker', keywords: ['whiteboard', 'equation', 'blue'] },
    { file: null, description: 'A clock face showing the time 7:45', keywords: ['clock', 'seven', 'forty-five'] },
    { file: null, description: 'Two interlocking gold rings on a dark velvet surface', keywords: ['rings', 'gold', 'two'] },
    { file: null, description: 'An arrow pointing right with a dashed trail on black background', keywords: ['arrow', 'right', 'dashed'] },
    { file: null, description: 'A flowchart with a diamond decision node labeled "Is valid?" branching to Yes and No paths', keywords: ['flowchart', 'diamond', 'decision', 'yes', 'no'] },
    // ── Hard tier (30%) — OCR, spatial reasoning, complex counting ──
    { file: null, description: 'An aerial parking lot with twelve cars, three of which are red', keywords: ['twelve', 'cars', 'three', 'red'] },
    { file: null, description: 'A chemistry lab bench with three beakers: left contains blue liquid, middle is empty, right has green precipitate at the bottom', keywords: ['three', 'beakers', 'blue', 'empty', 'green'] },
    { file: null, description: 'A nutrition facts label showing per 100g: 2450mg sodium, 12g total fat, 8g protein, 34g carbohydrates, 4g dietary fiber, and 380 calories', keywords: ['nutrition', 'sodium', '2450', 'fat', 'protein', 'calories', '380'] },
    { file: null, description: 'A phone home screen showing 16 app icons in a 4x4 grid and a weather widget displaying 72 degrees', keywords: ['phone', '16', 'apps', 'weather', '72'] },
    { file: null, description: 'A line chart showing quarterly revenue: Q1 at $10K, Q2 at $15K, Q3 dips to $8K, Q4 recovers to $20K', keywords: ['chart', 'revenue', 'Q3', 'dip', 'Q4'] },
    { file: null, description: 'A world map with five red pins marking cities: New York, London, Tokyo, Sydney, and São Paulo', keywords: ['map', 'five', 'pins', 'Tokyo'] },
    { file: null, description: 'A receipt from a store dated 03/15 showing total $47.83 with three itemized lines and a barcode at bottom', keywords: ['receipt', 'total', '47', 'three', 'barcode'] },
    { file: null, description: 'A chessboard mid-game: white has 9 pieces remaining including a king on e1 and a rook on a1; black has 7 pieces including a king on e8 and two bishops', keywords: ['chess', 'white', 'nine', 'black', 'seven', 'king', 'rook', 'bishop'] },
    { file: null, description: 'A printed circuit board with fourteen resistors, eight capacitors, and one microcontroller chip labeled ATmega328P', keywords: ['circuit', 'fourteen', 'resistors', 'eight', 'capacitors', 'ATmega'] },
    { file: null, description: 'A hotel room floor plan: bedroom 18m² on the left, bathroom 6m² top right, living area 22m² bottom right, with a corridor connecting all rooms', keywords: ['floor', 'plan', 'bedroom', '18', 'bathroom', '6', 'living', '22'] },
    { file: null, description: 'A UI wireframe showing a navigation bar at top, a hero section with a button labeled Get Started, two feature cards side by side below, and a footer with three columns of links', keywords: ['wireframe', 'navigation', 'hero', 'get started', 'two', 'cards', 'footer', 'three'] },
    { file: null, description: 'A project timeline Gantt chart: Planning phase Jan 1–15, Development phase Jan 16–Mar 30, Testing phase Apr 1–Apr 20, Launch on May 1 — four phases total', keywords: ['gantt', 'timeline', 'planning', 'development', 'testing', 'launch', 'four', 'may'] },
    // ── Replacements for retired easy items + new hard-tier additions ──
    { file: null, description: 'A network topology star diagram with one central router connected to five switches, each switch connected to three endpoints — sixteen devices total, one switch shown in red indicating a fault', keywords: ['network', 'router', 'five', 'switches', 'sixteen', 'red', 'fault'] },
    { file: null, description: 'A binary search tree: root node 45, left subtree root 22 with children 10 and 35, right subtree root 60 with left child 55 — five non-root nodes visible', keywords: ['binary', 'tree', 'root', '45', '22', '60', 'five'] },
    { file: null, description: 'A GitHub contribution heatmap for the year 2024 showing 347 total contributions — the darkest green squares cluster in February and September, with many empty days in summer', keywords: ['github', 'contribution', '347', 'green', 'february', 'september'] },
    { file: null, description: 'A shopping cart UI with three line items: a laptop at $999, wireless earbuds at $149, and a USB-C charger at $29 — subtotal $1,177 with a red Apply Coupon button and a 10% Off badge', keywords: ['cart', 'three', 'laptop', '999', 'earbuds', '149', '1177', 'coupon'] },
    // ── New hard-tier additions ──
    { file: null, description: 'A server rack diagram: two 1U servers at top, three 2U storage arrays in the middle, and one 4U GPU cluster at the bottom — 12U used out of 20U total capacity', keywords: ['server', 'rack', 'two', 'three', '12', '20', 'GPU'] },
    { file: null, description: 'A sticky note on a monitor reading: TODO: review PR #482, deploy to staging, call Sarah @ 3:30 PM, buy milk — written in black marker', keywords: ['todo', 'PR', '482', 'staging', 'sarah', 'milk'] },
    { file: null, description: 'A code diff viewer: three lines in red showing deleted code `if x == None:` and two lines in green showing added code `if x is None:` — with a comment "Fix null check"', keywords: ['code', 'diff', 'three', 'red', 'two', 'green', 'none'] },
];

function generateVisionChallenge(weights) {
    const w = weights && weights['arena_vision'] || {};
    const img = weightedPick(VISION_IMAGES, v => v.file || v.description || '', w);
    return { imageFile: img.file, description: img.description || null, expectedKeywords: img.keywords };
}

function generateButtonClickChallenge() {
    const buttonCount = 200;
    const correctIndex = Math.floor(Math.random() * buttonCount);
    const orderId = 1000 + Math.floor(Math.random() * 9000);
    const correctLabel = `Order #${orderId}`;
    return { correctIndex, correctLabel, buttonCount, seed: Math.floor(Math.random() * 1e9) };
}

const FORM_NAMES = ['John Smith','Alice Chen','Bob Kumar','Maria Garcia','Yuki Tanaka','Hans Mueller','Fatima Al-Said','Pierre Dubois','Olga Petrova','Carlos Silva','Priya Sharma','Liam O\'Brien','Aiko Yamamoto','Mohammed Al-Rashid','Sofia Andersson','Wei Zhang','Amara Osei','Ravi Kapoor','Isabella Rossi','Dmitri Volkov'];
const FORM_EMAILS = ['john@example.com','alice@test.org','bob@demo.io','maria@mail.com','yuki@sample.jp','hans@test.de','fatima@example.sa','pierre@demo.fr','olga@test.ru','carlos@mail.br','priya@demo.in','liam@test.ie','aiko@sample.co.jp','mohammed@example.ae','sofia@test.se','wei@demo.cn','amara@test.gh','ravi@sample.in','isabella@demo.it','dmitri@test.ru'];
const FORM_COUNTRIES = ['USA','Japan','Germany','Brazil','Australia','France','India','Canada','UK','South Korea','Sweden','UAE','Ireland','Mexico','Singapore','China','Ghana','Italy','Russia','Netherlands'];
const FORM_PHONES = ['+1-555-0123','+81-90-1234-5678','+49-170-1234567','+55-11-91234-5678','+61-400-123-456','+33-6-12-34-56-78','+91-98765-43210','+44-7700-900123','+46-70-123-4567','+65-9123-4567','+52-55-1234-5678','+353-87-123-4567'];
const FORM_DATES = ['1990-06-15','1985-03-22','1992-11-08','1988-01-30','1995-07-14','1983-09-25','1991-12-01','1987-04-17','1993-08-09','1986-02-14','1994-10-31','1989-05-20'];
const FORM_MESSAGES = ['Hello World','Please process my order','Testing the form','Quick inquiry','Need assistance','Feedback submission','Schedule a demo','Request for quote','Update my subscription','Cancel and refund'];

function generateFormFillChallenge() {
    const nameIdx = Math.floor(Math.random() * FORM_NAMES.length);
    // Pick country FROM the shuffled subset (not from the full pool) so
    // expectedValue is guaranteed to exist in options. card_f0d0a2eb:
    // previously expectedValue could be a country that wasn't in the
    // 5-item options subset, which broke the <select selected> default.
    const countryOptions = shuffle([...FORM_COUNTRIES]).slice(0, 5);
    const country = countryOptions[Math.floor(Math.random() * countryOptions.length)];
    const fields = [
        { name: 'fullName', type: 'text', label: 'Full Name', expectedValue: FORM_NAMES[nameIdx] },
        { name: 'email', type: 'email', label: 'Email', expectedValue: FORM_EMAILS[nameIdx % FORM_EMAILS.length] },
        { name: 'country', type: 'select', label: 'Country', expectedValue: country, options: countryOptions },
        { name: 'agreeTerms', type: 'checkbox', label: 'Agree to Terms', expectedValue: true },
    ];
    const extras = [
        { name: 'phone', type: 'tel', label: 'Phone', expectedValue: FORM_PHONES[Math.floor(Math.random() * FORM_PHONES.length)] },
        { name: 'birthDate', type: 'date', label: 'Birth Date', expectedValue: FORM_DATES[Math.floor(Math.random() * FORM_DATES.length)] },
        { name: 'message', type: 'textarea', label: 'Message', expectedValue: FORM_MESSAGES[Math.floor(Math.random() * FORM_MESSAGES.length)] },
        { name: 'company', type: 'text', label: 'Company', expectedValue: ['Acme Corp','TechStart','GlobalCo','DataInc'][Math.floor(Math.random() * 4)] },
        { name: 'role', type: 'select', label: 'Role', expectedValue: 'Developer', options: ['Designer','Developer','Manager','Analyst','Other'] },
    ];
    return { fields: [...fields, ...shuffle(extras).slice(0, 1 + Math.floor(Math.random() * 2))] };
}

function shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
}

function generateDragDropChallenge() {
    const sourceX = 50 + Math.floor(Math.random() * 200);
    const sourceY = 100 + Math.floor(Math.random() * 200);
    const targetX = 400 + Math.floor(Math.random() * 200);
    const targetY = 100 + Math.floor(Math.random() * 200);
    return {
        sourceLabel: 'Package',
        targetLabel: 'Delivery Zone',
        sourcePosition: { x: sourceX, y: sourceY },
        targetRect: { x: targetX, y: targetY, w: 150, h: 150 },
    };
}

function generateNavigationChallenge() {
    const categories = ['Products', 'Services', 'Company', 'Support', 'Resources', 'Developers', 'Partners', 'Solutions'];
    const subcategories = ['Electronics', 'Software', 'Hardware', 'Analytics', 'Cloud', 'Security', 'Networking', 'AI Tools'];
    const sections = ['Documentation', 'Downloads', 'Tutorials', 'API Reference', 'Release Notes', 'FAQ', 'Pricing', 'Contact'];
    const items = ['Item #' + (100 + Math.floor(Math.random() * 900))];
    const correctPath = [
        categories[Math.floor(Math.random() * categories.length)],
        subcategories[Math.floor(Math.random() * subcategories.length)],
        sections[Math.floor(Math.random() * sections.length)],
        items[0],
    ];
    const targetInfo = `Serial: ${generateToken(4).toUpperCase()}`;
    return { correctPath, targetInfo, depth: 4, linksPerLevel: 8 };
}

function generateTableExtractChallenge() {
    const quarters = ['Q1', 'Q2', 'Q3', 'Q4'];
    const departments = ['Engineering', 'Marketing', 'Sales', 'Operations', 'HR', 'Finance', 'Legal', 'R&D', 'Customer Support', 'Product'];
    const tableData = [];
    for (const dept of departments) {
        const row = { department: dept };
        for (const q of quarters) {
            row[q] = Math.floor(Math.random() * 50000) + 10000;
        }
        tableData.push(row);
    }
    // Pick a random question
    const targetQ = quarters[Math.floor(Math.random() * quarters.length)];
    const total = tableData.reduce((s, r) => s + r[targetQ], 0);
    return {
        tableData,
        columns: ['department', ...quarters],
        question: `What is the total revenue for ${targetQ}?`,
        correctAnswer: String(total),
    };
}

function generateDistractionChallenge() {
    const realButtonId = 'real-submit-' + generateToken(3);
    const fakeIds = [];
    for (let i = 0; i < 8; i++) {
        fakeIds.push('fake-' + generateToken(3));
    }
    return { realButtonId, fakeButtonIds: fakeIds, distractorCount: 8 };
}

let CODING_PROBLEMS = [
    { title: 'Array Dedup & Sort', description: 'Write `solve(arr)` — remove duplicates, return sorted.',
      testCases: [{ input: '[3,1,2,1,3]', expected: '[1,2,3]' },{ input: '[5,5,5]', expected: '[5]' },{ input: '[]', expected: '[]' }] },
    { title: 'Palindrome Check', description: 'Write `solve(s)` — return true if palindrome (case-insensitive, alpha only).',
      testCases: [{ input: '"racecar"', expected: 'true' },{ input: '"hello"', expected: 'false' }] },
    { title: 'Fibonacci', description: 'Write `solve(n)` — return nth Fibonacci (0-indexed, F(0)=0, F(1)=1).',
      testCases: [{ input: '0', expected: '0' },{ input: '10', expected: '55' },{ input: '20', expected: '6765' }] },
    { title: 'Max Subarray Sum', description: 'Write `solve(arr)` — return maximum contiguous subarray sum.',
      testCases: [{ input: '[-2,1,-3,4,-1,2,1,-5,4]', expected: '6' },{ input: '[1]', expected: '1' },{ input: '[-1,-2,-3]', expected: '-1' }] },
    { title: 'Reverse Words', description: 'Write `solve(s)` — reverse word order in string (trim spaces).',
      testCases: [{ input: '"hello world"', expected: '"world hello"' },{ input: '"  a  b  "', expected: '"b a"' }] },
    { title: 'Two Sum', description: 'Write `solve(nums, target)` — return indices of two numbers that add to target.',
      testCases: [{ input: '[2,7,11,15], 9', expected: '[0,1]' },{ input: '[3,2,4], 6', expected: '[1,2]' }] },
    { title: 'Valid Parentheses', description: 'Write `solve(s)` — return true if brackets ()[]{}  are balanced.',
      testCases: [{ input: '"()[]{}"', expected: 'true' },{ input: '"(]"', expected: 'false' },{ input: '"([)]"', expected: 'false' }] },
    { title: 'FizzBuzz Array', description: 'Write `solve(n)` — return array [1..n] with Fizz/Buzz/FizzBuzz replacements.',
      testCases: [{ input: '5', expected: '["1","2","Fizz","4","Buzz"]' },{ input: '15', expected: 'ends with "FizzBuzz"' }] },
    { title: 'Binary Search', description: 'Write `solve(arr, target)` — return index of target in sorted array, or -1.',
      testCases: [{ input: '[1,3,5,7,9], 5', expected: '2' },{ input: '[1,3,5], 4', expected: '-1' }] },
    { title: 'Matrix Transpose', description: 'Write `solve(matrix)` — return transposed matrix.',
      testCases: [{ input: '[[1,2],[3,4]]', expected: '[[1,3],[2,4]]' },{ input: '[[1,2,3]]', expected: '[[1],[2],[3]]' }] },
    { title: 'Count Vowels', description: 'Write `solve(s)` — return count of vowels (aeiouAEIOU).',
      testCases: [{ input: '"Hello World"', expected: '3' },{ input: '"aEiOu"', expected: '5' }] },
    { title: 'Flatten Array', description: 'Write `solve(arr)` — flatten nested arrays to single level.',
      testCases: [{ input: '[[1,2],[3,[4,5]]]', expected: '[1,2,3,4,5]' },{ input: '[1,[2,[3]]]', expected: '[1,2,3]' }] },
    { title: 'Roman to Integer', description: 'Write `solve(s)` — convert Roman numeral string to integer.',
      testCases: [{ input: '"III"', expected: '3' },{ input: '"XIV"', expected: '14' },{ input: '"MCMXC"', expected: '1990' }] },
    { title: 'Anagram Check', description: 'Write `solve(a, b)` — return true if a and b are anagrams.',
      testCases: [{ input: '"listen", "silent"', expected: 'true' },{ input: '"hello", "world"', expected: 'false' }] },
    { title: 'GCD', description: 'Write `solve(a, b)` — return greatest common divisor.',
      testCases: [{ input: '12, 8', expected: '4' },{ input: '17, 5', expected: '1' },{ input: '100, 75', expected: '25' }] },
    { title: 'Remove Nth from End', description: 'Write `solve(arr, n)` — remove nth element from end, return new array.',
      testCases: [{ input: '[1,2,3,4,5], 2', expected: '[1,2,3,5]' },{ input: '[1], 1', expected: '[]' }] },
    { title: 'String Compression', description: 'Write `solve(s)` — compress "aabcccccaaa" → "a2b1c5a3".',
      testCases: [{ input: '"aabcccccaaa"', expected: '"a2b1c5a3"' },{ input: '"abc"', expected: '"a1b1c1"' }] },
    { title: 'Power of Two', description: 'Write `solve(n)` — return true if n is a power of 2.',
      testCases: [{ input: '16', expected: 'true' },{ input: '18', expected: 'false' },{ input: '1', expected: 'true' }] },
    { title: 'Merge Sorted Arrays', description: 'Write `solve(a, b)` — merge two sorted arrays into one sorted array.',
      testCases: [{ input: '[1,3,5], [2,4,6]', expected: '[1,2,3,4,5,6]' },{ input: '[], [1]', expected: '[1]' }] },
    { title: 'Spiral Order', description: 'Write `solve(matrix)` — return elements in spiral order.',
      testCases: [{ input: '[[1,2,3],[4,5,6],[7,8,9]]', expected: '[1,2,3,6,9,8,7,4,5]' }] },
    // ── Added harder problems (DP, BFS/DFS, Sliding Window) ──
    { title: 'Climbing Stairs', description: 'Write `solve(n)` — you can climb 1 or 2 steps at a time. Return the number of distinct ways to reach step n.',
      testCases: [{ input: '2', expected: '2' },{ input: '5', expected: '8' },{ input: '10', expected: '89' }] },
    { title: 'Coin Change', description: 'Write `solve(coins, amount)` — return the fewest number of coins needed to make the amount, or -1 if impossible.',
      testCases: [{ input: '[1,5,10,25], 30', expected: '2' },{ input: '[2], 3', expected: '-1' },{ input: '[1,2,5], 11', expected: '3' }] },
    { title: 'Number of Islands', description: 'Write `solve(grid)` — grid is a 2D array of "1" (land) and "0" (water). Return the number of islands (groups of connected land cells, horizontally or vertically).',
      testCases: [{ input: '[["1","1","0"],["1","1","0"],["0","0","1"]]', expected: '2' },{ input: '[["1","0","1"],["0","0","0"],["1","0","1"]]', expected: '4' },{ input: '[["0","0","0"]]', expected: '0' }] },
    { title: 'Longest Substring No Repeat', description: 'Write `solve(s)` — return the length of the longest substring without any repeating characters.',
      testCases: [{ input: '"abcabcbb"', expected: '3' },{ input: '"bbbbb"', expected: '1' },{ input: '"pwwkew"', expected: '3' },{ input: '""', expected: '0' }] },
    { title: 'Group Anagrams', description: 'Write `solve(strs)` — group anagrams together. Return an array of arrays where each inner array contains words that are anagrams of each other (each group sorted alphabetically).',
      testCases: [{ input: '["eat","tea","tan","ate","nat","bat"]', expected: '[["ate","eat","tea"],["bat"],["nat","tan"]]' },{ input: '[""]', expected: '[[""]]' },{ input: '["a"]', expected: '[["a"]]' }] },
    // ── Additional DP / medium-hard problems ──
    { title: 'Decode Ways', description: 'Write `solve(s)` — a string of digits can be decoded using A=1, B=2, ..., Z=26. Return the number of distinct ways to decode the string.',
      testCases: [{ input: '"12"', expected: '2' },{ input: '"226"', expected: '3' },{ input: '"06"', expected: '0' },{ input: '"11106"', expected: '2' }] },
    { title: 'Maximum Product Subarray', description: 'Write `solve(nums)` — return the maximum product of a contiguous subarray.',
      testCases: [{ input: '[2,3,-2,4]', expected: '6' },{ input: '[-2,0,-1]', expected: '0' },{ input: '[-2,3,-4]', expected: '24' },{ input: '[0,2]', expected: '2' }] },
    { title: 'Longest Palindromic Substring', description: 'Write `solve(s)` — return the longest palindromic substring. If multiple with equal length, return the first occurring.',
      testCases: [{ input: '"babad"', expected: '"bab"' },{ input: '"cbbd"', expected: '"bb"' },{ input: '"a"', expected: '"a"' },{ input: '"racecar"', expected: '"racecar"' }] },
    { title: '0-1 Knapsack', description: 'Write `solve(weights, values, capacity)` — given items with weights and values arrays and a knapsack of given capacity, return the maximum total value (each item used at most once).',
      testCases: [{ input: '[1,3,4,5], [1,4,5,7], 7', expected: '9' },{ input: '[2,3,4,5], [3,4,5,6], 5', expected: '7' },{ input: '[1], [10], 0', expected: '0' }] },
    // ── New medium-hard additions ──
    { title: 'Word Break', description: 'Write `solve(s, wordDict)` — return true if the string s can be segmented into a space-separated sequence of one or more dictionary words.',
      testCases: [{ input: '"leetcode", ["leet","code"]', expected: 'true' },{ input: '"applepenapple", ["apple","pen"]', expected: 'true' },{ input: '"catsandog", ["cats","dog","sand","an","cat"]', expected: 'false' },{ input: '"", ["a"]', expected: 'true' }] },
    { title: 'Minimum Path Sum', description: 'Write `solve(grid)` — given an m×n grid of non-negative integers, find a path from top-left to bottom-right that minimizes the sum. You can only move right or down.',
      testCases: [{ input: '[[1,3,1],[1,5,1],[4,2,1]]', expected: '7' },{ input: '[[1,2,3],[4,5,6]]', expected: '12' },{ input: '[[1]]', expected: '1' }] },
    { title: 'Kth Largest Element', description: 'Write `solve(nums, k)` — return the kth largest element in the array (not the kth distinct element).',
      testCases: [{ input: '[3,2,1,5,6,4], 2', expected: '5' },{ input: '[3,2,3,1,2,4,5,5,6], 4', expected: '4' },{ input: '[1], 1', expected: '1' }] },
    // ── New additions: medium-hard DP / algorithm problems ──
    { title: 'Longest Common Subsequence', description: 'Write `solve(s1, s2)` — return the length of the longest common subsequence (non-contiguous characters allowed).',
      testCases: [{ input: '"abcde", "ace"', expected: '3' },{ input: '"abc", "abc"', expected: '3' },{ input: '"abc", "def"', expected: '0' },{ input: '"", "abc"', expected: '0' }] },
    { title: 'Trapping Rain Water', description: 'Write `solve(height)` — given an array of non-negative bar heights, return the total units of water trapped between the bars.',
      testCases: [{ input: '[0,1,0,2,1,0,1,3,2,1,2,1]', expected: '6' },{ input: '[4,2,0,3,2,5]', expected: '9' },{ input: '[1,0,1]', expected: '1' },{ input: '[]', expected: '0' }] },
    { title: 'Top K Frequent Elements', description: 'Write `solve(nums, k)` — return the k most frequent elements; sort by frequency descending, then by value ascending for ties.',
      testCases: [{ input: '[1,1,1,2,2,3], 2', expected: '[1,2]' },{ input: '[1], 1', expected: '[1]' },{ input: '[4,1,2,2,3,3,3], 2', expected: '[3,2]' }] },
    { title: 'All Permutations', description: 'Write `solve(nums)` — return all distinct permutations of a unique-integer array, sorted lexicographically.',
      testCases: [{ input: '[1,2,3]', expected: '[[1,2,3],[1,3,2],[2,1,3],[2,3,1],[3,1,2],[3,2,1]]' },{ input: '[1,2]', expected: '[[1,2],[2,1]]' },{ input: '[1]', expected: '[[1]]' }] },
    { title: 'Median of Two Sorted Arrays', description: 'Write `solve(nums1, nums2)` — return the median of two sorted arrays. For even total length return the average of the two middle values.',
      testCases: [{ input: '[1,3], [2]', expected: '2' },{ input: '[1,2], [3,4]', expected: '2.5' },{ input: '[], [1]', expected: '1' },{ input: '[2], []', expected: '2' }] },
];

function generateCodingChallenge(weights) {
    const w = weights && weights['arena_coding'] || {};
    const problem = weightedPick(CODING_PROBLEMS, p => p.title, w);
    return { ...problem };
}

let RESPONSE_QUESTIONS = [
    // ── Easy tier (20%) — basic facts ──
    { question: 'What is the capital of France?', expectedKeywords: ['paris'] },
    { question: 'What is 17 × 23?', expectedKeywords: ['391'] },
    { question: 'Name the largest planet in our solar system.', expectedKeywords: ['jupiter'] },
    { question: 'What is 13 × 17?', expectedKeywords: ['221'] },
    // ── Medium tier (50%) — multi-step math, applied reasoning ──
    { question: 'A pool fills in 3 hours with pipe A alone and 6 hours with pipe B alone. How many hours to fill it with both pipes open together?', expectedKeywords: ['2'] },
    { question: 'A train travels 240 km in 3 hours. What is its average speed in km/h?', expectedKeywords: ['80'] },
    { question: 'What is the next number in the sequence: 2, 6, 18, 54, ...?', expectedKeywords: ['162'] },
    { question: 'A rectangle has sides of length 12 cm and 5 cm. What is the length of its diagonal?', expectedKeywords: ['13'] },
    { question: 'If 5 machines take 5 minutes to make 5 widgets, how many minutes would 100 machines take to make 100 widgets?', expectedKeywords: ['5'] },
    { question: 'A shirt originally costs $80 and is discounted by 25%. What is the sale price?', expectedKeywords: ['60'] },
    { question: 'What is the sum of all integers from 1 to 100?', expectedKeywords: ['5050'] },
    { question: 'How many prime numbers are there between 1 and 20?', expectedKeywords: ['8'] },
    { question: 'What is the speed of light in km/s (approximately)?', expectedKeywords: ['300000', '299792'] },
    // ── Hard tier (30%) — multi-step reasoning, tricky logic ──
    { question: 'A clock shows 3:15. What is the exact angle in degrees between the hour and minute hands?', expectedKeywords: ['7.5'] },
    { question: 'A farmer has chickens and cows. Together they have 30 heads and 74 legs. How many chickens does the farmer have?', expectedKeywords: ['23'] },
    { question: 'What is the sum of the interior angles of a hexagon in degrees?', expectedKeywords: ['720'] },
    { question: 'A 6-sided die is rolled twice. What is the probability that the sum is exactly 7? Express as a simplified fraction.', expectedKeywords: ['1/6'] },
    { question: 'If log base 2 of x equals 5, what is x?', expectedKeywords: ['32'] },
    { question: 'A ball is dropped from 100 meters. Each bounce reaches half the previous height. What is the total distance traveled after exactly 3 bounces (including all ups and downs)?', expectedKeywords: ['275'] },
    { question: 'Three people check into a hotel room that costs $30. They each pay $10. The manager realizes the room is only $25 and gives $5 to the bellboy to return. The bellboy keeps $2 and gives $1 back to each person. Each person paid $9 (total $27) plus $2 the bellboy kept = $29. Where is the missing dollar?', expectedKeywords: ['no missing', 'accounting', 'error', 'fallacy'] },
    { question: 'A snail climbs 3 meters up a wall during the day but slides back 2 meters at night. If the wall is 10 meters high, how many days does it take the snail to reach the top?', expectedKeywords: ['8'] },
    // ── Additional medium/hard questions ──
    { question: 'A car drives 150 km at 60 km/h, then 120 km at 80 km/h. What is the total travel time in hours?', expectedKeywords: ['4'] },
    { question: 'In how many different ways can the letters of the word "LISTEN" be arranged?', expectedKeywords: ['720'] },
    { question: 'What is 2 to the power of 10?', expectedKeywords: ['1024'] },
    { question: 'A store sells apples for $0.75 each and oranges for $1.20 each. If someone buys 4 apples and 3 oranges, what is the total cost?', expectedKeywords: ['6.6', '6.60'] },
    { question: 'The sides of a right triangle are in the ratio 3:4:5. If the hypotenuse is 20 cm, what is the perimeter?', expectedKeywords: ['48'] },
    // ── Additional medium/hard questions added in daily pool update ──
    { question: 'A frog is at the bottom of a 20-meter well. Each day it climbs 4 meters; each night it slides back 2 meters. How many days does it take to escape the well?', expectedKeywords: ['9'] },
    { question: 'What is the remainder when 2 to the power of 100 is divided by 3?', expectedKeywords: ['1'] },
    { question: 'How many squares of all sizes (1×1, 2×2, up to 8×8) are there on a standard 8×8 chessboard?', expectedKeywords: ['204'] },
    { question: 'A plane travels 2000 km at an effective speed of 1000 km/h (900 km/h airspeed plus 100 km/h tailwind). How many hours does the journey take?', expectedKeywords: ['2'] },
    { question: 'A worker paints 1/3 of a fence on day 1 and 1/4 of the remaining unpainted fence on day 2. What fraction of the fence is still unpainted after day 2?', expectedKeywords: ['1/2', '0.5', 'half'] },
    // ── New additions to fill easy + medium-hard tiers ──
    { question: 'How many sides does a regular hexagon have?', expectedKeywords: ['6', 'six'] },
    { question: 'A boat travels 24 km upstream in 6 hours and the same 24 km downstream in 3 hours. What is the speed of the river current in km/h?', expectedKeywords: ['2'] },
    { question: 'In a class of 30 students, 18 play football, 15 play cricket, and 5 play neither sport. How many students play both football and cricket?', expectedKeywords: ['8'] },
    // ── New medium/hard additions ──
    { question: 'Two standard six-sided dice are rolled. What is the probability of getting a sum of exactly 8? Express as a simplified fraction.', expectedKeywords: ['5/36'] },
    { question: 'A recipe calls for 2.5 cups of flour for 12 cookies. How many cups of flour are needed to make 30 cookies?', expectedKeywords: ['6.25', '6 1/4'] },
    { question: 'What is each interior angle of a regular octagon in degrees?', expectedKeywords: ['135'] },
    { question: 'Alice can complete a task alone in 4 hours; Bob can complete the same task alone in 6 hours. Working together, how many hours will it take them? Express as a decimal.', expectedKeywords: ['2.4', '12/5'] },
    { question: 'How many different 4-digit PINs can be formed if no digit is repeated and the PIN cannot start with zero?', expectedKeywords: ['4536'] },
];
function generateResponseTimeChallenge(weights) {
    const w = weights && weights['arena_response_time'] || {};
    return weightedPick(RESPONSE_QUESTIONS, q => q.question, w);
}

function generateMemoryChallenge(previousSessions) {
    // Reference a previous test's expected answer
    const refIndex = 0; // Reference the vision test
    const refSession = previousSessions && previousSessions[refIndex];
    let referenceKey = 'imageFile';
    let expectedAnswer = 'red-circle.svg';
    if (refSession && refSession.challenge_config) {
        const config = typeof refSession.challenge_config === 'string'
            ? JSON.parse(refSession.challenge_config)
            : refSession.challenge_config;
        if (config.expectedKeywords && config.expectedKeywords.length > 0) {
            expectedAnswer = config.expectedKeywords[0];
            referenceKey = 'first keyword from Vision test';
        }
    }
    return {
        referenceTestIndex: refIndex,
        referenceTestName: 'Vision Test',
        referenceKey,
        question: `In the Vision Test (#1), what was the primary shape or object shown? Reply with one word.`,
        expectedAnswer,
    };
}

function generateFileMgmtChallenge() {
    const filename = `test-${generateToken(4)}.txt`;
    const newFilename = `renamed-${generateToken(4)}.txt`;
    const fileContent = `Arena test file content: ${generateToken(8)}`;
    return { filename, newFilename, fileContent };
}

let TTS_PHRASES = [
    // ── Easy tier (20%) — clear, common phrases ──
    { text: 'The quick brown fox jumps over the lazy dog', keywords: ['quick', 'brown', 'fox', 'lazy', 'dog'] },
    { text: 'Hello world this is a test message', keywords: ['hello', 'world', 'test', 'message'] },
    { text: 'Please remember to save your work before closing', keywords: ['remember', 'save', 'work', 'closing'] },
    { text: 'The package was delivered to the front door yesterday', keywords: ['package', 'delivered', 'front', 'door', 'yesterday'] },
    { text: 'The library closes at nine pm on weekdays', keywords: ['library', 'closes', 'nine', 'weekdays'] },
    // ── Medium tier (50%) — numbers, proper nouns, technical terms ──
    { text: 'Flight BA-274 departs at 14:30 from Terminal 5', keywords: ['flight', '274', 'terminal'] },
    { text: 'The patient blood pressure is 120 over 80 millimeters of mercury', keywords: ['blood', 'pressure', '120', '80'] },
    { text: 'Please dial extension 4072 for the accounting department', keywords: ['extension', '4072', 'accounting'] },
    { text: 'The GPS coordinates are 35.6762 degrees north 139.6503 degrees east', keywords: ['GPS', 'coordinates', '35', '139'] },
    { text: 'Doctor Zhang appointment is at 2:45 PM in Building C Room 301', keywords: ['Zhang', 'appointment', '2', '45', 'room', '301'] },
    { text: 'The Dow Jones index fell 2.3 percent to close at 38,547 points', keywords: ['Dow', 'Jones', 'percent', '38'] },
    // 'Machine learning models require large datasets for training' retired (pass rate 100%)
    { text: 'Renewable energy sources include solar wind and hydropower', keywords: ['renewable', 'energy', 'solar', 'wind', 'hydropower'] },
    { text: 'Quantum computing promises to solve complex optimization problems', keywords: ['quantum', 'computing', 'complex', 'optimization'] },
    { text: 'Version control helps teams collaborate on software projects', keywords: ['version', 'control', 'teams', 'collaborate', 'software'] },
    // 'The server returned HTTP status code 503 service unavailable' retired (pass rate 100%)
    { text: 'Encryption protects sensitive data during transmission', keywords: ['encryption', 'protects', 'sensitive', 'data', 'transmission'] },
    // ── Hard tier (30%) — acronyms, mixed content, technical jargon ──
    { text: 'The IPv4 address 192.168.1.1 is commonly used as a default gateway', keywords: ['IPv4', '192', '168', 'gateway'] },
    { text: 'Invoice number INV-2024-00784 for three hundred forty-nine dollars and fifty cents is due on April thirtieth', keywords: ['invoice', '2024', '00784', 'three', 'hundred', 'april', 'thirtieth'] },
    { text: 'Resume and naive are English words borrowed from French that retain their diacritical marks', keywords: ['resume', 'naive', 'French', 'diacritical'] },
    { text: 'Worcestershire sauce and Lieutenant Colonel are two commonly mispronounced English terms', keywords: ['worcestershire', 'lieutenant', 'colonel', 'mispronounced'] },
    { text: 'The Fibonacci sequence 1 1 2 3 5 8 13 21 grows approximately exponentially', keywords: ['fibonacci', 'sequence', '13', '21', 'exponentially'] },
    { text: 'The chemical compound CH3COOH commonly known as acetic acid has a pH of approximately 2.4', keywords: ['chemical', 'acetic', 'acid', 'pH'] },
    { text: 'Euler identity states that e to the power of i times pi plus 1 equals zero', keywords: ['euler', 'identity', 'pi', 'zero'] },
    { text: 'The API endpoint requires an Authorization header with a Bearer token and a Content-Type of application slash JSON', keywords: ['API', 'authorization', 'bearer', 'token', 'content', 'JSON'] },
    // ── Additional hard phrases ──
    { text: 'Your one-time verification code is 8 4 3 7 2 and expires in five minutes', keywords: ['verification', 'code', '84372', 'five', 'minutes'] },
    { text: 'The SQL query selects all records from the users table where the account status equals active and the score is greater than 100', keywords: ['SQL', 'query', 'users', 'active', 'score', '100'] },
    { text: 'Bernoulli and Euler each contributed foundational theorems to both fluid dynamics and graph theory', keywords: ['bernoulli', 'euler', 'fluid', 'dynamics', 'graph', 'theory'] },
    { text: 'Your one-time verification code is 7 4 2 9 1 — please enter it within ninety seconds before it expires', keywords: ['verification', 'code', '74291', 'ninety', 'seconds'] },
    { text: 'Compound interest formula: principal times the quantity one plus rate divided by one hundred to the power of years minus one', keywords: ['compound', 'interest', 'principal', 'rate', 'power', 'years'] },
    // ── Replacements for retired easy phrases + new hard-tier additions ──
    { text: 'Please enter your six-digit PIN 4 8 2 0 1 9 to confirm the wire transfer of three thousand five hundred dollars', keywords: ['PIN', '482019', 'confirm', 'transfer', 'three', 'thousand'] },
    { text: 'The clinical trial enrolled one thousand two hundred forty-eight participants across seven research sites in North America and Europe', keywords: ['clinical', 'trial', '1248', 'seven', 'research', 'Europe'] },
    { text: 'The train departs from Platform 7B at 08:42 and arrives at Zurich Hauptbahnhof after two hours and nineteen minutes', keywords: ['train', 'platform', '7B', 'Zurich', 'two', 'nineteen'] },
    { text: 'In organic chemistry a carbonyl group consists of a carbon atom double bonded to an oxygen atom written as C equals O', keywords: ['organic', 'chemistry', 'carbonyl', 'carbon', 'oxygen', 'double'] },
    // ── New hard-tier additions ──
    { text: 'The webhook requires an HMAC-SHA256 signature in the X-Signature-256 header formatted as sha256 equals the hex digest', keywords: ['webhook', 'HMAC', 'SHA256', 'signature', 'header', 'hex'] },
    { text: 'The new office at 1847 Silicon Valley Boulevard Suite 404 Cupertino California opens on Monday the ninth', keywords: ['1847', 'Silicon', 'Valley', 'Suite', '404', 'Cupertino', 'Monday'] },
    { text: 'The Kubernetes pod crashed with OOMKilled status after consuming 2.1 gigabytes against a memory limit of 2 gigabytes', keywords: ['Kubernetes', 'OOMKilled', 'memory', 'limit', 'gigabytes'] },
    { text: 'The database migration rollback failed with error code E1215 due to a foreign key constraint violation between the orders and customers tables', keywords: ['database', 'migration', 'rollback', 'E1215', 'foreign', 'constraint', 'orders', 'customers'] },
    { text: 'Your two-factor authentication backup codes are 7F3A9B 2D8E4C 1K0P6M — store them in a secure offline location', keywords: ['two-factor', 'authentication', 'backup', 'codes', '7F3A9B', 'secure'] },
];

// ============================================
// Dynamic pool loading (arena-pool-updater.js writes arena-questions.json;
// this module hot-reloads from it so the server never needs a restart)
// ============================================

const POOL_FILE = path.join(__dirname, 'data', 'arena-questions.json');

function loadPoolsFromFile() {
    try {
        const raw   = fs.readFileSync(POOL_FILE, 'utf8');
        const data  = JSON.parse(raw);
        const pools = data.pools || {};
        let loaded  = 0;
        if (Array.isArray(pools.arena_vision)        && pools.arena_vision.length        > 0) { VISION_IMAGES     = pools.arena_vision;        loaded++; }
        if (Array.isArray(pools.arena_coding)        && pools.arena_coding.length        > 0) { CODING_PROBLEMS   = pools.arena_coding;        loaded++; }
        if (Array.isArray(pools.arena_response_time) && pools.arena_response_time.length > 0) { RESPONSE_QUESTIONS = pools.arena_response_time; loaded++; }
        if (Array.isArray(pools.arena_tts)           && pools.arena_tts.length           > 0) { TTS_PHRASES        = pools.arena_tts;           loaded++; }
        return loaded;
    } catch {
        return 0; // File missing or invalid — hardcoded defaults remain in effect
    }
}
loadPoolsFromFile(); // Load overrides at module init; no-op if file absent

/** Hot-reload pools from arena-questions.json (called by the auto-updater). */
function reloadPools() { return loadPoolsFromFile(); }

/** Returns the current live pool arrays (used by the auto-updater as a baseline). */
function getCurrentPools() {
    return {
        arena_vision:        VISION_IMAGES,
        arena_coding:        CODING_PROBLEMS,
        arena_response_time: RESPONSE_QUESTIONS,
        arena_tts:           TTS_PHRASES,
    };
}

function generateTtsChallenge(weights) {
    const w = weights && weights['arena_tts'] || {};
    return weightedPick(TTS_PHRASES, p => p.text, w);
}

const CHALLENGE_GENERATORS = {
    arena_vision: generateVisionChallenge,
    arena_button_click: generateButtonClickChallenge,
    arena_form_fill: generateFormFillChallenge,
    arena_drag_drop: generateDragDropChallenge,
    arena_navigation: generateNavigationChallenge,
    arena_table_extract: generateTableExtractChallenge,
    arena_distraction: generateDistractionChallenge,
    arena_coding: generateCodingChallenge,
    arena_response_time: generateResponseTimeChallenge,
    arena_memory: (prev) => generateMemoryChallenge(prev),
    arena_file_mgmt: generateFileMgmtChallenge,
    arena_tts: generateTtsChallenge,
};

// Action type alias matching — bots often send shortened names
const ACTION_ALIASES = {
    'description_submitted': ['description_submitted','describe','vision_describe','describe_image'],
    'button_clicked': ['button_clicked','click','button_click','clicked'],
    'form_submitted': ['form_submitted','submit','form_submit','submit_form'],
    'element_dragged': ['element_dragged','drag','dragged','drop','drag_drop'],
    'page_loaded': ['page_loaded','loaded','page_load','visit'],
    'page_navigated': ['page_navigated','navigate','navigated','nav'],
    'target_found': ['target_found','found','target','reached'],
    'answer_submitted': ['answer_submitted','answer','respond','reply','submit_answer'],
    'code_submitted': ['code_submitted','code','submit_code','run_code'],
    'transcription_submitted': ['transcription_submitted','transcribe','transcription','speech'],
    'file_downloaded': ['file_downloaded','download','downloaded'],
    'file_renamed': ['file_renamed','rename','renamed'],
    'file_uploaded': ['file_uploaded','upload','uploaded'],
};
function findAction(actions, canonical) {
    const aliases = ACTION_ALIASES[canonical] || [canonical];
    return actions.find(a => aliases.includes(a.actionType));
}
function findAllActions(actions, canonical) {
    const aliases = ACTION_ALIASES[canonical] || [canonical];
    return actions.filter(a => aliases.includes(a.actionType));
}

function scoreVision(config, actionsLog) {
    let score = 0;
    const hasPageLoad = findAction(actionsLog, 'page_loaded') != null;
    if (hasPageLoad) score += Math.round(config.weight * 0.1);
    const descAction = findAction(actionsLog, 'description_submitted');
    if (descAction && descAction.payload && descAction.payload.text) {
        const text = descAction.payload.text.toLowerCase();
        const matched = (config.expectedKeywords || []).filter(k => text.includes(k.toLowerCase()));
        const ratio = config.expectedKeywords.length > 0
            ? matched.length / config.expectedKeywords.length : 0;
        score += Math.round(config.weight * 0.9 * ratio);
    }
    return { score, maxScore: config.weight };
}

function scoreButtonClick(config, actionsLog) {
    const click = findAction(actionsLog, 'button_clicked');
    if (!click) return { score: 0, maxScore: config.weight };
    const correct = click.payload && click.payload.buttonLabel === config.correctLabel;
    return { score: correct ? config.weight : 0, maxScore: config.weight };
}

function scoreFormFill(config, actionsLog) {
    const submit = findAction(actionsLog, 'form_submitted');
    if (!submit || !submit.payload || !submit.payload.fields) {
        return { score: 0, maxScore: config.weight };
    }
    const fields = config.fields || [];
    let total = 0;
    for (const field of fields) {
        const submitted = submit.payload.fields[field.name];
        if (field.type === 'checkbox') {
            if (submitted === field.expectedValue) total += 1;
        } else {
            const expected = String(field.expectedValue).trim().toLowerCase();
            const actual = String(submitted || '').trim().toLowerCase();
            if (actual === expected) total += 1;
            else if (actual && expected && actual.replace(/\s+/g, '') === expected.replace(/\s+/g, '')) total += 0.8;
        }
    }
    const ratio = fields.length > 0 ? total / fields.length : 0;
    return { score: Math.round(config.weight * ratio), maxScore: config.weight };
}

function scoreDragDrop(config, actionsLog) {
    const drag = findAction(actionsLog, 'element_dragged');
    if (!drag) return { score: 0, maxScore: config.weight };
    const { dropX, dropY } = drag.payload || {};
    const t = config.targetRect;
    if (dropX >= t.x && dropX <= t.x + t.w && dropY >= t.y && dropY <= t.y + t.h) {
        return { score: config.weight, maxScore: config.weight };
    }
    // Partial credit for attempting drag
    return { score: Math.round(config.weight * 0.3), maxScore: config.weight };
}

function scoreNavigation(config, actionsLog) {
    const maxDepth = config.depth || 3;
    const navigated = findAllActions(actionsLog, 'page_navigated');
    let deepest = 0;
    for (const nav of navigated) {
        if (nav.payload && typeof nav.payload.depth === 'number') {
            deepest = Math.max(deepest, nav.payload.depth);
        }
    }
    // Full marks ONLY if the bot's `target_found` payload actually contains
    // the serial string it was told to hunt for. A bare `{actionType:"target_found"}`
    // with no payload used to net all 13 points — that was a self-report
    // exploit. Normalize both sides (trim + lowercase + strip optional
    // "Serial:" prefix) and require exact match OR strict substring so bots
    // can echo "The serial is 8af0c1b3" without us false-negatives.
    const found = findAction(actionsLog, 'target_found');
    if (found) {
        const norm = (v) => String(v == null ? '' : v)
            .trim()
            .toLowerCase()
            .replace(/^serial\s*:\s*/i, '')
            .trim();
        const expected = norm(config.targetInfo);
        const payload = found.payload || {};
        const claimed = norm(
            payload.targetInfo != null ? payload.targetInfo :
            payload.serial != null ? payload.serial :
            payload.value != null ? payload.value :
            payload.text != null ? payload.text : ''
        );
        if (expected && claimed && (claimed === expected || claimed.includes(expected))) {
            return { score: config.weight, maxScore: config.weight };
        }
        // target_found fired but payload empty/wrong → treat as not reached;
        // fall through to depth-based partial credit rather than award full.
    }
    const ratio = deepest / maxDepth;
    return { score: Math.round(config.weight * ratio * 0.75), maxScore: config.weight };
}

function scoreTableExtract(config, actionsLog) {
    const answer = findAction(actionsLog, 'answer_submitted');
    if (!answer || !answer.payload) return { score: 0, maxScore: config.weight };
    const submitted = String(answer.payload.answer || '').replace(/[,\s]/g, '');
    const expected = String(config.correctAnswer).replace(/[,\s]/g, '');
    if (submitted === expected) return { score: config.weight, maxScore: config.weight };
    // Numeric proximity: ±5%
    const numSubmit = parseFloat(submitted);
    const numExpect = parseFloat(expected);
    if (!isNaN(numSubmit) && !isNaN(numExpect) && numExpect !== 0) {
        if (Math.abs(numSubmit - numExpect) / numExpect <= 0.05) {
            return { score: Math.round(config.weight * 0.7), maxScore: config.weight };
        }
    }
    // Visited but wrong
    if (findAction(actionsLog, 'page_loaded') != null) {
        return { score: Math.round(config.weight * 0.1), maxScore: config.weight };
    }
    return { score: 0, maxScore: config.weight };
}

function scoreDistraction(config, actionsLog) {
    let score = 0;
    const allClicks = findAllActions(actionsLog, 'button_clicked');
    const realClicked = allClicks.some(a => a.payload && a.payload.buttonId === config.realButtonId);
    if (realClicked) score += Math.round(config.weight * 0.6);
    const fakeClicks = allClicks.filter(a =>
        a.payload && config.fakeButtonIds.includes(a.payload.buttonId)
    );
    if (fakeClicks.length === 0) {
        score += Math.round(config.weight * 0.4);
    } else {
        score -= fakeClicks.length * Math.round(config.weight * 0.2);
    }
    return { score: Math.max(0, score), maxScore: config.weight };
}

function scoreCoding(config, actionsLog) {
    // Self-reported `testResults:[true,true,...]` used to net full marks
    // without any actual code execution. Until a real sandboxed executor
    // lands (vm2 / worker_thread with timeout + memory limit — see TODO),
    // accept the submission metadata but award 0 and surface a machine-
    // readable flag so downstream reporting can explain the gap.
    //
    // TODO(arena): replace this degraded scorer with a real sandboxed
    // runner. Shape: spin up a worker_thread (or vm2 context) with
    // resourceLimits.maxYoungGenerationSizeMb ~= 16, cpuTime timeout
    // ~= 1000ms, no network/fs/require, feed each testCase.input via
    // postMessage, compare stdout/return vs testCase.expected, then
    // score ratio * weight with the existing speed bonus pipeline.
    const submit = findAction(actionsLog, 'code_submitted');
    if (!submit || !submit.payload) {
        return { score: 0, maxScore: config.weight, server_side_execution_pending: true };
    }
    const claimedResults = Array.isArray(submit.payload.testResults) ? submit.payload.testResults
        : Array.isArray(submit.payload.claimedResults) ? submit.payload.claimedResults
        : [];
    const totalTests = (config.testCases || []).length;
    return {
        score: 0,
        maxScore: config.weight,
        server_side_execution_pending: true,
        claimedPassed: claimedResults.filter(r => r === true || r === 'pass').length,
        totalTests,
        note: 'Self-reported testResults are not trusted. Awaiting server-side sandboxed execution.',
    };
}

function scoreResponseTime(config, actionsLog) {
    const answer = findAction(actionsLog, 'answer_submitted');
    if (!answer || !answer.payload) return { score: 0, maxScore: config.weight };
    // Keyword accuracy
    const text = String(answer.payload.answer || '').toLowerCase();
    const keywords = config.expectedKeywords || [];
    const matched = keywords.filter(k => text.includes(k.toLowerCase()));
    const accuracy = keywords.length > 0 ? matched.length / keywords.length : 0;
    // Time multiplier
    const elapsed = answer.payload.elapsed_ms || 30001;
    let timeMult = 0.4;
    if (elapsed < 5000) timeMult = 1.0;
    else if (elapsed < 15000) timeMult = 0.8;
    else if (elapsed < 30000) timeMult = 0.6;
    const score = Math.round(config.weight * accuracy * timeMult);
    return { score, maxScore: config.weight };
}

function scoreMemory(config, actionsLog) {
    const answer = findAction(actionsLog, 'answer_submitted');
    if (!answer || !answer.payload) return { score: 0, maxScore: config.weight };
    const text = String(answer.payload.answer || '').toLowerCase().trim();
    const expected = String(config.expectedAnswer || '').toLowerCase().trim();
    if (text === expected) return { score: config.weight, maxScore: config.weight };
    if (text.includes(expected) || expected.includes(text)) {
        return { score: Math.round(config.weight * 0.5), maxScore: config.weight };
    }
    return { score: 0, maxScore: config.weight };
}

function scoreFileMgmt(config, actionsLog) {
    let score = 0;
    if (findAction(actionsLog, 'file_downloaded') != null) score += Math.round(config.weight * 0.3);
    if (findAction(actionsLog, 'file_renamed') != null) score += Math.round(config.weight * 0.3);
    if (findAction(actionsLog, 'file_uploaded') != null) score += Math.round(config.weight * 0.4);
    return { score: Math.min(score, config.weight), maxScore: config.weight };
}

function scoreTts(config, actionsLog) {
    const answer = findAction(actionsLog, 'transcription_submitted');
    if (!answer || !answer.payload) return { score: 0, maxScore: config.weight };
    const text = String(answer.payload.text || '').toLowerCase();
    const keywords = config.keywords || [];
    const matched = keywords.filter(k => text.includes(k.toLowerCase()));
    const ratio = keywords.length > 0 ? matched.length / keywords.length : 0;
    return { score: Math.round(config.weight * ratio), maxScore: config.weight };
}

/**
 * Speed bonus: faster completion → higher score.
 * Each scorer returns a base accuracy score. This wrapper multiplies
 * by a time factor based on elapsed seconds (first action → last action).
 *
 * Tiers: <5s → 1.0x, 5-10s → 0.95x, 10-20s → 0.85x, 20-30s → 0.75x, >30s → 0.65x
 * The result is capped at the test's max weight.
 */
function applySpeedBonus(baseResult, actionsLog) {
    if (baseResult.score === 0 || actionsLog.length < 1) return baseResult;
    const timestamps = actionsLog.map(a => a.timestamp).filter(t => typeof t === 'number');
    if (timestamps.length < 1) return baseResult;
    const elapsed = (Math.max(...timestamps) - Math.min(...timestamps)) / 1000;
    let mult = 0.65;
    if (elapsed < 5) mult = 1.0;
    else if (elapsed < 10) mult = 0.95;
    else if (elapsed < 20) mult = 0.85;
    else if (elapsed < 30) mult = 0.75;
    const boosted = Math.round(baseResult.score * mult);
    return { ...baseResult, score: Math.min(boosted, baseResult.maxScore), elapsedSec: Math.round(elapsed), speedMult: mult };
}

const SCORING_ENGINES = {
    arena_vision: scoreVision,
    arena_button_click: scoreButtonClick,
    arena_form_fill: scoreFormFill,
    arena_drag_drop: scoreDragDrop,
    arena_navigation: scoreNavigation,
    arena_table_extract: scoreTableExtract,
    arena_distraction: scoreDistraction,
    arena_coding: scoreCoding,
    arena_response_time: scoreResponseTime,
    arena_memory: scoreMemory,
    arena_file_mgmt: scoreFileMgmt,
    arena_tts: scoreTts,
};

// ============================================
// Schema init
// ============================================

function parseConfig(raw) {
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

async function initArenaDatabase() {
    try {
        const schemaPath = path.join(__dirname, 'interview_arena_schema.sql');
        const schema = fs.readFileSync(schemaPath, 'utf8');
        // $$-aware SQL splitter (same pattern as rental.js / wallet.js)
        const statements = [];
        let current = '';
        let inDollarBlock = false;
        for (const line of schema.split('\n')) {
            const trimmed = line.trim();
            if (trimmed.startsWith('--')) continue;
            current += line + '\n';
            const dollarCount = (line.match(/\$\$/g) || []).length;
            if (dollarCount % 2 === 1) inDollarBlock = !inDollarBlock;
            if (!inDollarBlock && trimmed.endsWith(';')) {
                const stmt = current.trim();
                if (stmt && stmt !== ';') statements.push(stmt);
                current = '';
            }
        }
        if (current.trim()) statements.push(current.trim());

        for (const stmt of statements) {
            try {
                await pool.query(stmt);
            } catch (err) {
                if (!err.message.includes('already exists') && !err.message.includes('duplicate key')) {
                    console.warn('[Arena] Schema warning:', err.message);
                }
            }
        }
        console.log('[Arena] Database initialized');
    } catch (err) {
        console.error('[Arena] Failed to init database:', err);
    }
}

// ============================================
// Arena → Rental capability mapping
// ============================================

/**
 * Arena pass threshold: 40% of MAX_TOTAL_SCORE (≈59 pts).
 * Lower than the text-probe 60% because Arena's 12 interactive tests
 * are significantly harder than the 8 text probes.
 */
const ARENA_PASS_THRESHOLD = 0.4;

/**
 * Map Arena test categories to rental interview capability categories.
 * A capability is "supported" if the bot scored ≥ 50% on any Arena
 * test in that category.
 */
const ARENA_TO_CAPABILITY_MAP = Object.freeze({
    'web_vision':        'vision',
    'web_interaction':   'web_browse',
    'form_automation':   'web_browse',
    'spatial_control':   'web_browse',
    'multi_step':        'web_browse',
    'data_extraction':   'reasoning',
    'safety_resilience': 'refusal_safety',
    'code_execution':    'python_exec',
    'response_speed':    'latency',
    'context_chain':     'reasoning',
    'file_management':   'file_io',
    'voice_tts':         'voice',
});

/**
 * Convert Arena exam report to rental-compatible capabilities JSON +
 * benchmark score. Returns the same structure as bot-interview.js's
 * scoreInterview().capabilities.
 *
 * @param {{ detail: Array<{testType, score, maxScore}> }} report
 * @returns {{ capabilities: Object, benchmarkScore: Object, passed: boolean, normalizedScore: number }}
 */
function mapArenaResultToCapabilities(report) {
    if (!report || !Array.isArray(report.detail)) {
        return { capabilities: {}, benchmarkScore: {}, passed: false, normalizedScore: 0 };
    }

    const capabilities = {};
    const benchmarkDetail = {};

    for (const d of report.detail) {
        const testMeta = TEST_TYPES.find(t => t.id === d.testType);
        if (!testMeta) continue;

        const capKey = ARENA_TO_CAPABILITY_MAP[testMeta.category] || testMeta.category;
        const pct = d.maxScore > 0 ? d.score / d.maxScore : 0;

        // Aggregate by capability key
        if (!capabilities[capKey]) {
            capabilities[capKey] = { supported: false, probes: [], totalScore: 0, maxScore: 0 };
        }
        capabilities[capKey].probes.push({
            id: d.testType,
            name: testMeta.name,
            passed: pct >= 0.5,
            score: d.score,
            maxScore: d.maxScore,
            source: 'arena',
        });
        capabilities[capKey].totalScore += d.score;
        capabilities[capKey].maxScore += d.maxScore;
        // Supported if any probe in this category scored ≥ 50%
        if (pct >= 0.5) capabilities[capKey].supported = true;

        benchmarkDetail[d.testType] = {
            name: testMeta.name,
            score: d.score,
            maxScore: d.maxScore,
            pct: Math.round(pct * 100),
        };
    }

    // Clean up internal aggregation fields
    for (const key of Object.keys(capabilities)) {
        delete capabilities[key].totalScore;
        delete capabilities[key].maxScore;
    }

    const totalScore = report.totalScore || report.detail.reduce((s, d) => s + (d.score || 0), 0);
    const maxScore = report.maxScore || MAX_TOTAL_SCORE;
    const normalizedScore = Math.round((totalScore / maxScore) * 100);
    const passed = totalScore / maxScore >= ARENA_PASS_THRESHOLD;

    return {
        capabilities,
        benchmarkScore: {
            source: 'arena',
            totalScore,
            maxScore,
            normalizedScore,
            detail: benchmarkDetail,
        },
        passed,
        normalizedScore,
    };
}

// ============================================
// Answer-leak prevention: decoy + strip
// ============================================

/**
 * Decoy word pool for vision keyword poisoning.
 * These words never appear in any real VISION_IMAGES keywords, so a bot
 * that copies them into its description will always score 0.
 */
const _VISION_DECOY_POOL = [
    'purple','hexagon','striped','spiral','gradient',
    'dotted','metallic','transparent','zigzag','oval',
    'checkerboard','holographic','embossed','tessellated','iridescent',
];

/**
 * Strip or poison challengeConfig before exposing it to bots.
 *
 * Two strategies:
 *   DECOY  — keep field in public config but replace with a plausible-but-wrong
 *             value. A bot copying the value directly will score 0; a bot that
 *             actually does the work derives the correct answer independently.
 *   STRIP  — remove the field entirely. Used when there is no independent way
 *             for the bot to derive the answer (needs a rendered HTML page).
 *
 * Scoring always reads from the full config in the DB — this function only
 * controls what travels over the wire to the bot.
 *
 * @param {string} testType  e.g. 'arena_vision'
 * @param {object} config    full challenge config from DB
 * @returns {object}         sanitised config safe to expose to bots
 */
function stripSecretsForBot(testType, config) {
    if (!config) return {};

    switch (testType) {

        case 'arena_vision': {
            // DECOY: replace real expectedKeywords with unrelated words from the
            // decoy pool. Bot must actually analyze the image to get the right answer.
            const n = (config.expectedKeywords || []).length || 2;
            const decoy = shuffle([..._VISION_DECOY_POOL]).slice(0, n);
            return {
                imageFile: config.imageFile || null,
                // Deliberately wrong — copying scores 0
                expectedKeywords: decoy,
            };
        }

        case 'arena_button_click':
            // STRIP: bot must identify the correct button on the rendered page.
            return { buttonCount: config.buttonCount, seed: config.seed };

        case 'arena_form_fill':
            // STRIP: bot must read rendered form labels and fill appropriate values.
            return {
                fields: (config.fields || []).map(f => ({
                    name: f.name, type: f.type, label: f.label,
                    ...(f.options ? { options: f.options } : {}),
                })),
            };

        case 'arena_drag_drop':
            // STRIP: bot must visually locate source and target on the rendered page.
            return { sourceLabel: config.sourceLabel, targetLabel: config.targetLabel };

        case 'arena_navigation':
            // STRIP: bot must browse the menu tree to reach targetInfo.
            return {
                depth: config.depth,
                linksPerLevel: config.linksPerLevel,
                targetInfo: config.targetInfo,
            };

        case 'arena_table_extract': {
            // DECOY: replace correctAnswer with a believable but wrong number.
            // (real × φ + 1337 rounded to nearest 10 to look computed)
            const real = parseInt(config.correctAnswer || '0', 10);
            const decoy = String(Math.round((real * 1.618 + 1337) / 10) * 10);
            return {
                tableData: config.tableData,
                columns: config.columns,
                question: config.question,
                correctAnswer: decoy,   // Deliberately wrong
            };
        }

        case 'arena_distraction': {
            // DECOY (most aggressive): swap realButtonId ↔ first fakeButtonId.
            // A bot that clicks public.realButtonId actually clicks a fake button,
            // and a bot that avoids public.fakeButtonIds avoids the real button.
            // Both behaviours score 0. An honest bot that visually identifies
            // the submit button and clicks it will match the DB's true realButtonId.
            const fakes = config.fakeButtonIds || [];
            const decoyReal = fakes[0] || 'decoy-btn-x00';
            const decoyFakes = [config.realButtonId, ...fakes.slice(1)];
            return {
                distractorCount: config.distractorCount,
                realButtonId: decoyReal,       // Actually a fake
                fakeButtonIds: decoyFakes,     // Contains the real button
            };
        }

        case 'arena_coding':
            // KEEP: bot must write working code; testCases are legitimate I/O specs,
            // not trivially copyable into an answer payload.
            return { ...config };

        case 'arena_response_time':
            // DECOY: replace expected keywords with a sentinel string.
            // Scoring checks against DB config; a bot echoing '__incorrect__' scores 0.
            return {
                question: config.question,
                expectedKeywords: ['__incorrect__'],   // Decoy — always wrong
            };

        case 'arena_memory':
            // DECOY: send a wrong placeholder for expectedAnswer.
            // Bot must recall the actual answer from its earlier test context.
            return {
                referenceTestIndex: config.referenceTestIndex,
                referenceTestName: config.referenceTestName,
                question: config.question,
                expectedAnswer: '__recall_required__', // Decoy — always wrong
            };

        case 'arena_file_mgmt':
            // KEEP: bot must actually download, rename, and upload the file;
            // knowing the filenames in advance is part of the task spec.
            return { ...config };

        case 'arena_tts':
            // DECOY: remove real scoring keywords, replace with sentinel.
            // Bot receives the text to read aloud; keywords are server-side rubric only.
            return {
                text: config.text,
                keywords: ['__transcribe_above_text__'],  // Decoy — always wrong
            };

        default:
            return { ...config };
    }
}

// ============================================
// Express factory
// ============================================

module.exports = function arenaFactory({ serverLog, io, devices } = {}) {
    const router = express.Router();
    const audit = serverLog || (() => {});
    const deviceRegistry = devices || {};

    // Per-IP cooldown: 1 exam per 5 minutes
    const examCooldownMap = new Map(); // ip → last exam timestamp
    const COOLDOWN_MS = 5 * 60_000;

    // GET /api/arena/cooldown — check remaining cooldown for this IP
    router.get('/cooldown', (req, res) => {
        const ip = req.ip || req.connection.remoteAddress || 'unknown';
        const last = examCooldownMap.get(ip) || 0;
        const elapsed = Date.now() - last;
        const remaining = Math.max(0, COOLDOWN_MS - elapsed);
        res.json({ success: true, cooldown: remaining > 0, remainingMs: remaining, remainingSec: Math.ceil(remaining / 1000) });
    });

    // POST /api/arena/exam — create a new exam (no auth, 5-min cooldown)
    router.post('/exam', async (req, res) => {
        try {
            const ip = req.ip || req.connection.remoteAddress || 'unknown';
            const now = Date.now();
            const last = examCooldownMap.get(ip) || 0;
            const elapsed = now - last;
            if (elapsed < COOLDOWN_MS) {
                const remaining = Math.ceil((COOLDOWN_MS - elapsed) / 1000);
                return res.status(429).json({ success: false, error: 'cooldown', remainingSec: remaining });
            }
            examCooldownMap.set(ip, now);

            // Generate id in code rather than relying on the column DEFAULT.
            // The PR #1813 migration set the column DEFAULT to gen_random_bytes()
            // (pgcrypto), but on production that DEFAULT is missing/non-functional
            // — INSERTs without an explicit id violate the NOT NULL constraint.
            const examId = newExamId();
            const examToken = generateToken(12);
            // Clock-start fix: leave expires_at NULL at creation. The 3-min
            // TTL budget is still _EXAM_TTL_MS but the timer itself is armed
            // atomically on the bot's first GET /arena/test/:id (see
            // backend/index.js — first_fetched_at bump). Channel delivery
            // latency (30-60s) no longer eats the bot's solving window,
            // and exams that are never fetched simply never expire from
            // the action endpoint's point of view (they're still garbage-
            // collected by the daily pool updater).
            const listingId = req.body?.listingId || null;
            const examRes = await pool.query(
                `INSERT INTO arena_exams (id, exam_token, listing_id, status, max_score, expires_at)
                 VALUES ($1, $2, $3, $4, $5, NULL)
                 RETURNING id, exam_token, listing_id, status, created_at, expires_at`,
                [examId, examToken, listingId, EXAM_STATUS.WAITING, MAX_TOTAL_SCORE]
            );
            const exam = examRes.rows[0];

            // Fetch adaptive difficulty weights (cached 5min)
            const diffWeights = await getDifficultyWeights();

            // Generate all configs in memory first (memory challenge depends on earlier configs)
            const sessionConfigs = [];
            for (let i = 0; i < TEST_TYPES.length; i++) {
                const tt = TEST_TYPES[i];
                const gen = CHALLENGE_GENERATORS[tt.id];
                // Pass weights to pool-based generators; memory test gets previous sessions
                const config = i === 9 ? gen(sessionConfigs) : gen(diffWeights);
                sessionConfigs.push({ ...config, weight: tt.weight });
            }

            // Batch INSERT all 12 sessions in one query
            const values = [];
            const placeholders = [];
            for (let i = 0; i < TEST_TYPES.length; i++) {
                const tt = TEST_TYPES[i];
                const token = generateToken(10);
                const off = i * 6;
                placeholders.push(`($${off+1},$${off+2},$${off+3},$${off+4},$${off+5},$${off+6})`);
                values.push(exam.id, token, tt.id, i, JSON.stringify(sessionConfigs[i]), tt.weight);
            }
            const sessRes = await pool.query(
                `INSERT INTO arena_sessions (exam_id, session_token, test_type, test_index, challenge_config, max_score)
                 VALUES ${placeholders.join(',')}
                 RETURNING id, session_token, test_type, test_index, status`,
                values
            );
            const sessions = sessRes.rows;

            const apiBase = process.env.API_BASE || 'https://eclawbot.com';
            const examUrl = `${apiBase}/arena/exam/${exam.id}`;
            const testUrl = `${apiBase}/arena/test/${examToken}`;

            res.json({
                success: true,
                exam: {
                    id: exam.id,
                    examToken: exam.exam_token,
                    status: exam.status,
                    expiresAt: exam.expires_at,
                    testUrl,
                    examUrl,
                },
                sessions: sessions.map(s => ({
                    id: s.id,
                    testType: s.test_type,
                    testIndex: s.test_index,
                    status: s.status,
                })),
            });

            // ── Auto-push: if linked to a listing, push exam instructions to the bot ──
            if (listingId && _autoPushDeps.devices) {
                try {
                    const listingRes = await pool.query(
                        'SELECT owner_device_id, owner_entity_id FROM bot_listings WHERE id = $1', [listingId]
                    );
                    const listing = listingRes.rows[0];
                    if (listing) {
                        const device = _autoPushDeps.devices[listing.owner_device_id];
                        const entity = device?.entities?.[listing.owner_entity_id];
                        if (entity && (entity.isBound)) {
                            const instructions = [
                                `[ARENA_EXAM] EClawbot Agent Benchmark — 12 Challenges, 3-minute time limit.`,
                                ``,
                                `⏱ Timing rules (important for sub-agent budgeting):`,
                                `  • The 3:00 countdown starts at the INSTANT you first call GET on the test URL in Step 1.`,
                                `  • Late actions after the 3-min cutoff are rejected with HTTP 410 exam_expired and do not count.`,
                                `  • Finalize (Step 4) is auto-triggered server-side at the cutoff, so submit actions BEFORE the window closes.`,
                                `  • Leaderboard "total time" = first-fetch → finalize, capped at 180s. Faster is better (speed multiplier applies per test).`,
                                `  • Suggested budget if dispatching sub-agents: reserve ≤ 12s per test on average, keep 10s slack for finalize.`,
                                ``,
                                `Step 1: GET ${testUrl}`,
                                `  → Returns JSON with examId, tests[] array. Each test has: sessionToken, testType, challengeConfig, actionEndpoint.`,
                                `  → ⚠ Clock starts here. Fetch only when you are ready to begin.`,
                                ``,
                                `Step 2: POST ${apiBase}/api/arena/exam/${exam.id}/model`,
                                `  Body: {"model":"your-model-name"}`,
                                ``,
                                `Step 3: For each test, POST to its actionEndpoint:`,
                                `  POST ${apiBase}/api/arena/{sessionToken}/action`,
                                `  Body: {"actionType":"...", "payload":{...}}`,
                                ``,
                                `  Action types per test:`,
                                `  - arena_vision: "page_loaded", then "description_submitted" {"text":"..."}`,
                                `  - arena_button_click: "button_clicked" {"buttonLabel":"Order #XXXX"}`,
                                `  - arena_form_fill: "form_submitted" {"fields":{"fieldName":"value",...}}`,
                                `  - arena_drag_drop: "element_dragged" {"dropX":N,"dropY":N}`,
                                `  - arena_navigation: "page_navigated" {"depth":N}, then "target_found" {}`,
                                `  - arena_table_extract: "answer_submitted" {"answer":"..."}`,
                                `  - arena_distraction: "button_clicked" {"buttonId":"real-submit-xxx"}`,
                                `  - arena_coding: "code_submitted" {"testResults":[true,false,...]}`,
                                `  - arena_response_time: "answer_submitted" {"answer":"...","elapsed_ms":N}`,
                                `  - arena_memory: "answer_submitted" {"answer":"..."}`,
                                `  - arena_file_mgmt: "file_downloaded","file_renamed","file_uploaded"`,
                                `  - arena_tts: "transcription_submitted" {"text":"..."}`,
                                ``,
                                `Step 4: POST ${apiBase}/api/arena/exam/${exam.id}/finalize`,
                                `  → Returns total score and per-test breakdown. Auto-invoked at the 3-min cutoff; calling it sooner locks in your score early.`,
                            ].join('\n');

                            const isChannelBound = entity.bindingType === 'channel' && entity.channelAccountId;
                            const hasPushChannel = !!_autoPushDeps.pushToChannelCallback;
                            if (isChannelBound && hasPushChannel) {
                                _autoPushDeps.pushToChannelCallback(listing.owner_device_id, listing.owner_entity_id, {
                                    event: 'arena_exam', text: instructions,
                                }, entity.channelAccountId)
                                    .then(r => audit('info', 'arena', `Auto-push channel result for exam ${exam.id}: pushed=${r?.pushed}`))
                                    .catch(e => audit('error', 'arena', `Auto-push channel failed: ${e.message}`));
                            } else if (entity.webhook && _autoPushDeps.pushToBot) {
                                _autoPushDeps.pushToBot(entity, listing.owner_device_id, 'arena_exam', {
                                    message: instructions,
                                })
                                    .then(r => audit('info', 'arena', `Auto-push webhook result for exam ${exam.id}: pushed=${r?.pushed}`))
                                    .catch(e => audit('error', 'arena', `Auto-push webhook failed: ${e.message}`));
                            } else {
                                audit('warn', 'arena', `Auto-push skipped exam ${exam.id}: isChannelBound=${isChannelBound}, hasPushChannel=${hasPushChannel}, hasWebhook=${!!entity.webhook}`);
                            }
                            audit('info', 'arena', `Auto-push initiated for exam ${exam.id} listing ${listingId} entity ${listing.owner_entity_id} mode=${isChannelBound ? 'channel' : 'webhook'}`);
                        }
                    }
                } catch (pushErr) {
                    // Non-critical: exam is created, just push failed
                    audit('error', 'arena', `Auto-push failed for exam ${exam.id}: ${pushErr.message}`);
                }
            }
        } catch (err) {
            console.error('[Arena] create exam error:', err);
            audit('error', 'arena', `POST /exam failed: ${err.message}\n${err.stack || ''}`);
            res.status(500).json({
                success: false,
                error: 'internal_error',
                detail: err.message,
                stage: 'create_exam',
            });
        }
    });

    // POST /api/arena/exam/:examId/model — bot reports its model
    router.post('/exam/:examId/model', async (req, res) => {
        try {
            const { model } = req.body || {};
            if (!model || typeof model !== 'string') {
                return res.status(400).json({ success: false, error: 'model_required' });
            }
            await pool.query(
                `UPDATE arena_exams SET model = $2, status = 'active'
                 WHERE id = $1 AND status = 'waiting'`,
                [req.params.examId, model.slice(0, 64)]
            );
            if (io) io.to('exam:' + req.params.examId).emit('arena:update', { event: 'model_set', model });
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ success: false, error: 'internal_error' });
        }
    });

    // POST /api/arena/:sessionToken/action — test page reports bot action
    router.post('/:sessionToken/action', async (req, res) => {
        try {
            const { actionType, payload, timestamp } = req.body || {};
            if (!actionType) return res.status(400).json({ success: false, error: 'actionType_required' });

            // Lookup session
            const sessRes = await pool.query(
                `SELECT s.*, e.id as exam_id, e.status as exam_status, e.expires_at
                 FROM arena_sessions s
                 JOIN arena_exams e ON s.exam_id = e.id
                 WHERE s.session_token = $1`,
                [req.params.sessionToken]
            );
            if (sessRes.rowCount === 0) return res.status(404).json({ success: false, error: 'session_not_found' });
            const session = sessRes.rows[0];

            // Check expiry — NULL expires_at means the clock has not yet
            // been armed (bot has not fetched GET /arena/test/:id). In that
            // case the exam simply has not started, so the action is not
            // "expired" — let it through. Normal case: timer was armed on
            // first fetch and we compare normally.
            if (session.expires_at != null && new Date(session.expires_at) < new Date()) {
                return res.status(410).json({ success: false, error: 'exam_expired' });
            }
            if (session.status === 'completed') {
                return res.status(409).json({ success: false, error: 'session_already_completed' });
            }

            // Check action count (from DB, avoid read-modify-write)
            const actions = Array.isArray(session.actions_log) ? session.actions_log : [];
            if (actions.length >= MAX_ACTIONS_PER_SESSION) {
                return res.status(429).json({ success: false, error: 'too_many_actions' });
            }

            const actionObj = { actionType, payload: payload || {}, timestamp: timestamp || Date.now() };

            // Server-side jsonb append + conditional status update
            const startedClause = (!session.started_at && actionType === 'page_loaded')
                ? `, started_at = NOW(), status = '${SESSION_STATUS.ACTIVE}'` : '';
            await pool.query(
                `UPDATE arena_sessions
                 SET actions_log = COALESCE(actions_log, '[]'::jsonb) || $2::jsonb ${startedClause}
                 WHERE id = $1`,
                [session.id, JSON.stringify([actionObj])]
            );
            actions.push(actionObj);

            // Activate exam if waiting
            if (session.exam_status === EXAM_STATUS.WAITING) {
                await pool.query(
                    `UPDATE arena_exams SET status = $2 WHERE id = $1 AND status = $3`,
                    [session.exam_id, EXAM_STATUS.ACTIVE, EXAM_STATUS.WAITING]
                );
            }

            // Real-time score update
            const config = parseConfig(session.challenge_config);
            const scorer = SCORING_ENGINES[session.test_type];
            let partialScore = null;
            if (scorer) {
                const raw = scorer(config, actions);
                const result = applySpeedBonus(raw, actions);
                partialScore = result.score;
            }

            if (io) {
                io.to('exam:' + session.exam_id).emit('arena:update', {
                    event: 'action',
                    testIndex: session.test_index,
                    testType: session.test_type,
                    actionType,
                    partialScore,
                    timestamp: Date.now(),
                });
            }

            res.json({ success: true, partialScore });
        } catch (err) {
            console.error('[Arena] action error:', err);
            res.status(500).json({ success: false, error: 'internal_error' });
        }
    });

    // POST /api/arena/session/:id/complete — finalize a session score
    router.post('/session/:id/complete', async (req, res) => {
        try {
            const sessRes = await pool.query(
                `SELECT * FROM arena_sessions WHERE id = $1`, [req.params.id]
            );
            if (sessRes.rowCount === 0) return res.status(404).json({ success: false, error: 'not_found' });
            const session = sessRes.rows[0];
            if (session.status === SESSION_STATUS.COMPLETED) {
                return res.json({ success: true, score: session.score });
            }

            const config = parseConfig(session.challenge_config);
            const actions = Array.isArray(session.actions_log) ? session.actions_log : [];
            const scorer = SCORING_ENGINES[session.test_type];
            const raw = scorer ? scorer(config, actions) : { score: 0, maxScore: config.weight || 0 };
            const result = applySpeedBonus(raw, actions);

            await pool.query(
                `UPDATE arena_sessions SET status = 'completed', score = $2, raw_result = $3, completed_at = NOW()
                 WHERE id = $1`,
                [session.id, result.score, JSON.stringify(result)]
            );

            if (io) {
                io.to('exam:' + session.exam_id).emit('arena:update', {
                    event: 'session_complete',
                    testIndex: session.test_index,
                    testType: session.test_type,
                    score: result.score,
                    maxScore: result.maxScore,
                });
            }

            res.json({ success: true, score: result.score, maxScore: result.maxScore });
        } catch (err) {
            res.status(500).json({ success: false, error: 'internal_error' });
        }
    });

    // POST /api/arena/exam/:examId/finalize — finalize the entire exam
    router.post('/exam/:examId/finalize', async (req, res) => {
        try {
            // Score all incomplete sessions first
            const sessions = await pool.query(
                `SELECT * FROM arena_sessions WHERE exam_id = $1 ORDER BY test_index`,
                [req.params.examId]
            );
            let totalScore = 0;
            const detail = [];
            for (const s of sessions.rows) {
                let score = s.score;
                if (s.status !== SESSION_STATUS.COMPLETED) {
                    const config = parseConfig(s.challenge_config);
                    const actions = Array.isArray(s.actions_log) ? s.actions_log : [];
                    const scorer = SCORING_ENGINES[s.test_type];
                    const raw = scorer ? scorer(config, actions) : { score: 0 };
                    const result = applySpeedBonus(raw, actions);
                    score = result.score;
                    await pool.query(
                        `UPDATE arena_sessions SET status = 'completed', score = $2, raw_result = $3, completed_at = NOW()
                         WHERE id = $1`,
                        [s.id, score, JSON.stringify(result)]
                    );
                }
                totalScore += (score || 0);
                const testMeta = TEST_TYPES.find(t => t.id === s.test_type);
                detail.push({
                    testType: s.test_type,
                    testIndex: s.test_index,
                    name: testMeta ? testMeta.name : s.test_type,
                    score: score || 0,
                    maxScore: s.max_score,
                });
            }

            const report = { totalScore, maxScore: MAX_TOTAL_SCORE, detail };
            await pool.query(
                `UPDATE arena_exams
                 SET status = 'completed',
                     total_score = $2,
                     report = $3,
                     completed_at = COALESCE(completed_at, NOW())
                 WHERE id = $1`,
                [req.params.examId, totalScore, JSON.stringify(report)]
            );

            // ── Arena → Rental interview sync ──
            // If this exam is linked to a listing, auto-qualify it for
            // the rental marketplace. The Arena's public nature is
            // unchanged — this just bridges the result.
            let interviewSync = null;
            try {
                const examRow = await pool.query(
                    'SELECT listing_id, model FROM arena_exams WHERE id = $1',
                    [req.params.examId]
                );
                const examData = examRow.rows[0];
                if (examData?.listing_id) {
                    const mapped = mapArenaResultToCapabilities(report);
                    // Update bot_listings with capabilities + interview status
                    // V3 fix: reset status from 'interview' back to 'draft' on completion
                    // (allows owner to publish after interview passes)
                    await pool.query(
                        `UPDATE bot_listings SET
                            interview_passed = $2,
                            capabilities = $3,
                            benchmark_score = $4,
                            model_detected = COALESCE($5, model_detected),
                            last_interview_at = NOW(),
                            status = CASE WHEN status = 'interview' THEN 'draft' ELSE status END,
                            updated_at = NOW()
                         WHERE id = $1`,
                        [
                            examData.listing_id,
                            mapped.passed,
                            JSON.stringify(mapped.capabilities),
                            JSON.stringify(mapped.benchmarkScore),
                            examData.model || null,
                        ]
                    );
                    // Record in bot_interviews for audit trail
                    await pool.query(
                        `INSERT INTO bot_interviews
                            (listing_id, probes_json, responses_json, passed, score, duration_ms, failure_reason)
                         VALUES ($1, $2, $3, $4, $5, 0, $6)`,
                        [
                            examData.listing_id,
                            JSON.stringify(TEST_TYPES.map(t => ({ id: t.id, name: t.name, weight: t.weight }))),
                            JSON.stringify(detail),
                            mapped.passed,
                            mapped.normalizedScore,
                            mapped.passed ? null : `Arena score ${mapped.normalizedScore}% < ${Math.round(ARENA_PASS_THRESHOLD * 100)}% threshold`,
                        ]
                    );
                    interviewSync = {
                        listingId: examData.listing_id,
                        passed: mapped.passed,
                        normalizedScore: mapped.normalizedScore,
                        capabilities: mapped.capabilities,
                    };
                    audit('info', 'arena', `exam ${req.params.examId} synced to listing ${examData.listing_id}: passed=${mapped.passed} score=${mapped.normalizedScore}%`);
                }
            } catch (syncErr) {
                console.warn('[Arena] Rental sync error (non-blocking):', syncErr.message);
            }

            if (io) {
                io.to('exam:' + req.params.examId).emit('arena:update', {
                    event: 'exam_complete', totalScore, maxScore: MAX_TOTAL_SCORE, detail,
                    interviewSync,
                });
            }

            res.json({ success: true, report, interviewSync });
        } catch (err) {
            console.error('[Arena] finalize error:', err);
            res.status(500).json({ success: false, error: 'internal_error' });
        }
    });

    // GET /api/arena/exam/:examId/results — get exam results
    router.get('/exam/:examId/results', async (req, res) => {
        try {
            const examRes = await pool.query(
                `SELECT * FROM arena_exams WHERE id = $1`, [req.params.examId]
            );
            if (examRes.rowCount === 0) return res.status(404).json({ success: false, error: 'not_found' });
            const sessions = await pool.query(
                `SELECT id, session_token, test_type, test_index, status, score, max_score, raw_result, challenge_config, actions_log, started_at, completed_at
                 FROM arena_sessions WHERE exam_id = $1 ORDER BY test_index`,
                [req.params.examId]
            );
            const exam = examRes.rows[0];
            console.log(`[Arena DEBUG] exam ${exam.id} status=${exam.status} expires_at=${exam.expires_at} created_at=${exam.created_at} now=${new Date().toISOString()}`);
            // Derive elapsed (from bot first-fetch to completion, clamped to 180s)
            // so the UI can display total-time-taken on completed exams.
            let elapsedSec = null;
            if (exam.first_fetched_at && (exam.completed_at || exam.status === 'completed')) {
                const startTs = new Date(exam.first_fetched_at).getTime();
                const endTs = exam.completed_at ? new Date(exam.completed_at).getTime() : Date.now();
                elapsedSec = Math.max(0, Math.min(180, Math.round((endTs - startTs) / 1000)));
            }
            res.json({
                success: true,
                exam: {
                    id: exam.id, model: exam.model, status: exam.status,
                    totalScore: exam.total_score, maxScore: exam.max_score,
                    report: exam.report, createdAt: exam.created_at,
                    expiresAt: exam.expires_at,
                    firstFetchedAt: exam.first_fetched_at,
                    completedAt: exam.completed_at,
                    elapsedSec,
                },
                sessions: sessions.rows,
                testTypes: TEST_TYPES,
            });
        } catch (err) {
            res.status(500).json({ success: false, error: 'internal_error' });
        }
    });

    // POST /api/arena/leaderboard — submit to leaderboard
    router.post('/leaderboard', async (req, res) => {
        try {
            const { examId, name } = req.body || {};
            if (!examId || !name || typeof name !== 'string' || name.trim().length === 0) {
                return res.status(400).json({ success: false, error: 'examId_and_name_required' });
            }
            const examRes = await pool.query(
                `SELECT id, model, total_score, max_score, report, created_at, first_fetched_at, completed_at
                 FROM arena_exams WHERE id = $1 AND status = 'completed'`,
                [examId]
            );
            if (examRes.rowCount === 0) return res.status(404).json({ success: false, error: 'exam_not_found_or_incomplete' });
            const exam = examRes.rows[0];
            // Elapsed = from bot's first fetch to exam completion, clamped to
            // the 3-min ceiling so auto-timeout or clock drift can never put
            // a >180s entry on the leaderboard.
            const startTs = exam.first_fetched_at
                ? new Date(exam.first_fetched_at).getTime()
                : new Date(exam.created_at).getTime();
            const endTs = exam.completed_at
                ? new Date(exam.completed_at).getTime()
                : Date.now();
            const elapsedSec = Math.max(0, Math.min(180, Math.round((endTs - startTs) / 1000)));
            const report = typeof exam.report === 'string' ? JSON.parse(exam.report) : (exam.report || {});
            report.elapsedSec = elapsedSec;

            const lbRes = await pool.query(
                `INSERT INTO arena_leaderboard (exam_id, name, model, score, max_score, detail)
                 VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
                [exam.id, name.trim().slice(0, 64), exam.model, exam.total_score, exam.max_score,
                 JSON.stringify(report)]
            );
            const leaderboardId = lbRes.rows[0] ? lbRes.rows[0].id : null;
            res.json({ success: true, leaderboardId });
        } catch (err) {
            res.status(500).json({ success: false, error: 'internal_error' });
        }
    });

    // GET /api/arena/leaderboard — get top entries
    router.get('/leaderboard', async (_req, res) => {
        try {
            const result = await pool.query(
                `SELECT id, name, model, score, max_score, detail, created_at
                 FROM arena_leaderboard ORDER BY score DESC LIMIT 100`
            );
            res.json({ success: true, leaderboard: result.rows });
        } catch (err) {
            res.status(500).json({ success: false, error: 'internal_error' });
        }
    });

    // POST /api/arena/feedback — submit feedback
    router.post('/feedback', async (req, res) => {
        try {
            const { examId, desiredCapabilities, credibilityScore, comment } = req.body || {};
            if (credibilityScore != null && (credibilityScore < 0 || credibilityScore > 10)) {
                return res.status(400).json({ success: false, error: 'credibility_score_invalid' });
            }
            await pool.query(
                `INSERT INTO arena_feedback (exam_id, desired_capabilities, credibility_score, comment)
                 VALUES ($1, $2, $3, $4)`,
                [examId || null,
                 JSON.stringify(desiredCapabilities || []),
                 credibilityScore != null ? credibilityScore : null,
                 typeof comment === 'string' ? comment.slice(0, 2000) : null]
            );
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ success: false, error: 'internal_error' });
        }
    });

    // GET /api/arena/feedback — admin: list all feedback
    router.get('/feedback', async (req, res) => {
        try {
            const limit = Math.min(parseInt(req.query.limit) || 50, 200);
            const result = await pool.query(
                `SELECT f.*, e.model, e.total_score
                 FROM arena_feedback f
                 LEFT JOIN arena_exams e ON f.exam_id = e.id
                 ORDER BY f.created_at DESC LIMIT $1`,
                [limit]
            );
            res.json({ success: true, feedback: result.rows });
        } catch (err) {
            res.status(500).json({ success: false, error: 'internal_error' });
        }
    });

    // GET /api/arena/difficulty — view adaptive difficulty weights
    router.get('/difficulty', async (_req, res) => {
        try {
            const weights = await getDifficultyWeights();
            res.json({ success: true, weights, cachedAt: _difficultyCacheAt ? new Date(_difficultyCacheAt).toISOString() : null });
        } catch (err) {
            res.status(500).json({ success: false, error: 'internal_error' });
        }
    });

    // ── Public comment board ──────────────────────────────

    // POST /api/arena/comments — post a comment (requires leaderboard entry)
    router.post('/comments', async (req, res) => {
        try {
            const { leaderboardId, text } = req.body || {};
            if (!leaderboardId) {
                return res.status(400).json({ success: false, error: 'leaderboard_entry_required' });
            }
            if (!text || typeof text !== 'string' || text.trim().length === 0) {
                return res.status(400).json({ success: false, error: 'text_required' });
            }

            // Verify leaderboard entry exists → use its name/score/model
            const lbRes = await pool.query(
                `SELECT name, model, score, exam_id FROM arena_leaderboard WHERE id = $1`,
                [leaderboardId]
            );
            if (lbRes.rowCount === 0) {
                return res.status(403).json({ success: false, error: 'must_be_on_leaderboard' });
            }
            const lb = lbRes.rows[0];
            const cleanText = text.trim().slice(0, 1000);

            await pool.query(
                `INSERT INTO arena_comments (nickname, text, exam_id, score, model)
                 VALUES ($1, $2, $3, $4, $5)`,
                [lb.name, cleanText, lb.exam_id, lb.score, lb.model]
            );

            const comment = { nickname: lb.name, text: cleanText, score: lb.score, model: lb.model, createdAt: new Date().toISOString() };
            if (io) io.to('arena:lobby').emit('arena:comment', comment);

            res.json({ success: true, comment });
        } catch (err) {
            res.status(500).json({ success: false, error: 'internal_error' });
        }
    });

    // GET /api/arena/comments — get recent comments
    router.get('/comments', async (req, res) => {
        try {
            const limit = Math.min(parseInt(req.query.limit) || 50, 200);
            const result = await pool.query(
                `SELECT id, nickname, text, score, model, created_at
                 FROM arena_comments ORDER BY created_at DESC LIMIT $1`,
                [limit]
            );
            res.json({ success: true, comments: result.rows });
        } catch (err) {
            res.status(500).json({ success: false, error: 'internal_error' });
        }
    });

    // ── Admin: question pool management ─────────────────────────────────────

    // Three paths accepted:
    //   1. ADMIN_SECRET env + matching x-admin-token header / body.adminToken (legacy)
    //   2. Valid deviceSecret for a registered device (device owner)
    //   3. Valid botSecret for an entity on a registered device (bot-as-admin)
    // Path 1 unchanged. Paths 2–3 let ops admin without a separate env —
    // possession of deviceSecret / botSecret is already proof of ownership.
    // When multi-tenant launches, gate 2–3 on a specific ADMIN_DEVICE_ID env.
    const safeEqual = require('./safe-equal');

    function checkAdminAuth(req) {
        const body = req.body || {};

        // Path 1: ADMIN_SECRET token
        const token    = req.headers['x-admin-token'] || body.adminToken;
        const expected = process.env.ADMIN_SECRET;
        if (expected && token && safeEqual(token, expected)) return true;

        // Paths 2 / 3: device credentials
        const deviceId = body.deviceId || req.headers['x-device-id'];
        const device   = deviceId && deviceRegistry[deviceId];
        if (device) {
            const deviceSecret = body.deviceSecret || req.headers['x-device-secret'];
            if (safeEqual(deviceSecret, device.deviceSecret)) return true;

            const botSecret = body.botSecret || req.headers['x-bot-secret'];
            const entityId  = body.entityId != null ? parseInt(body.entityId, 10) : NaN;
            const entity    = Number.isFinite(entityId) && (device.entities || {})[entityId];
            if (entity && safeEqual(botSecret, entity.botSecret)) return true;
        }

        // Localhost fallback only when no secret configured at all
        if (!expected) return req.ip === '127.0.0.1' || req.ip === '::1';

        return false;
    }

    // GET /api/arena/admin/pool-status — current pool sizes + last update info
    router.get('/admin/pool-status', (req, res) => {
        if (!checkAdminAuth(req)) return res.status(403).json({ success: false, error: 'forbidden' });
        let fileData = null;
        try { fileData = JSON.parse(fs.readFileSync(POOL_FILE, 'utf8')); } catch { /* no file yet */ }
        res.json({
            success: true,
            pools: {
                arena_vision:        { size: VISION_IMAGES.length,      target: 25 },
                arena_coding:        { size: CODING_PROBLEMS.length,    target: 20 },
                arena_response_time: { size: RESPONSE_QUESTIONS.length, target: 20 },
                arena_tts:           { size: TTS_PHRASES.length,        target: 20 },
            },
            poolFile: {
                exists:      fileData !== null,
                version:     fileData?.version     || 0,
                updatedAt:   fileData?.updatedAt   || null,
                lastSummary: fileData?.lastSummary || null,
            },
        });
    });

    // POST /api/arena/admin/refresh-pool — trigger immediate pool update
    router.post('/admin/refresh-pool', (req, res) => {
        if (!checkAdminAuth(req)) return res.status(403).json({ success: false, error: 'forbidden' });
        res.json({ success: true, message: 'Pool update started in background' });
        // Run async without blocking the response
        const { runPoolUpdate } = require('./arena-pool-updater');
        runPoolUpdate({ dbPool: pool, getCurrentPools, reloadPools, serverLog: audit })
            .catch(err => console.error('[Arena] refresh-pool error:', err.message));
    });

    // POST /api/arena/admin/reset-leaderboard — wipe public ranking only.
    // Destructive + irreversible. Preserves arena_exams / arena_sessions /
    // arena_feedback / arena_comments so exam history and user feedback
    // survive. Useful when the scoring rubric changes and old rankings
    // become incomparable but the raw test data is still worth keeping.
    router.post('/admin/reset-leaderboard', async (req, res) => {
        if (!checkAdminAuth(req)) return res.status(403).json({ success: false, error: 'forbidden' });
        try {
            const before = await pool.query('SELECT COUNT(*)::int AS n FROM arena_leaderboard');
            const deletedCount = before.rows[0]?.n ?? 0;
            await pool.query('TRUNCATE TABLE arena_leaderboard');
            audit('info', 'arena_admin', `leaderboard reset (${deletedCount} rows removed)`);
            res.json({ success: true, deletedCount, table: 'arena_leaderboard' });
        } catch (err) {
            console.error('[Arena] reset-leaderboard error:', err);
            audit('error', 'arena_admin', `reset-leaderboard failed: ${err.message}`);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // POST /api/arena/admin/self-test — on-demand runtime self-test.
    // The routine bot (or any admin) can call this anytime to verify the
    // full scoring pipeline is healthy: creates a scratch exam, runs every
    // scorer with synthetic perfect actions, deletes the exam, returns the
    // report. Intended for the bot to call before/after refresh-pool.
    router.post('/admin/self-test', async (req, res) => {
        if (!checkAdminAuth(req)) return res.status(403).json({ success: false, error: 'forbidden' });
        try {
            const { validateRuntimeSelfTest } = require('./arena-pool-validator');
            const selfModule = require('./interview-arena');
            const report = await validateRuntimeSelfTest({
                arenaModule: selfModule,
                dbPool: pool,
                log: (lv, m) => audit(lv, 'arena_selftest', m),
            });
            res.status(report.ok ? 200 : 500).json({ success: report.ok, report });
        } catch (err) {
            console.error('[Arena] self-test error:', err);
            res.status(500).json({ success: false, error: 'internal_error', message: err.message });
        }
    });

    // Late-bound deps for auto-push (interview mode: push exam instructions to bot)
    let _autoPushDeps = { devices: null, pushToBot: null, pushToChannelCallback: null };
    function setAutoPushDeps(deps) { Object.assign(_autoPushDeps, deps); }

    return {
        router,
        initArenaDatabase,
        setAutoPushDeps,
        TEST_TYPES,
        MAX_TOTAL_SCORE,
        CHALLENGE_GENERATORS,
        SCORING_ENGINES,
        generateToken,
        mapArenaResultToCapabilities,
        ARENA_PASS_THRESHOLD,
        ARENA_TO_CAPABILITY_MAP,
        // Exposed for callers outside the factory (index.js:1877 for the
        // secret-stripping transform; arena-pool-updater cron for hot reload).
        // These also live on module.exports for direct-require consumers (tests,
        // the pool validator), but the factory return is what index.js uses.
        stripSecretsForBot,
        reloadPools,
        getCurrentPools,
        _internals: { pool, getAutoPushDeps: () => _autoPushDeps },
    };
};

// Static exports for testing
module.exports.TEST_TYPES = TEST_TYPES;
module.exports.MAX_TOTAL_SCORE = MAX_TOTAL_SCORE;
module.exports.mapArenaResultToCapabilities = mapArenaResultToCapabilities;
module.exports.ARENA_PASS_THRESHOLD = ARENA_PASS_THRESHOLD;
module.exports.ARENA_TO_CAPABILITY_MAP = ARENA_TO_CAPABILITY_MAP;
module.exports.SCORING_ENGINES = SCORING_ENGINES;
module.exports.CHALLENGE_GENERATORS = CHALLENGE_GENERATORS;
module.exports.stripSecretsForBot = stripSecretsForBot;
// Pool management (used by arena-pool-updater.js and daily cron)
module.exports.reloadPools    = reloadPools;
module.exports.getCurrentPools = getCurrentPools;
