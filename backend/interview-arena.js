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
    // img-d4e9.svg retired (basic shape, too easy) — replaced below
    // img-a2f5.svg retired (basic shape, too easy) — replaced below
    { file: null, description: 'A system monitoring dashboard showing CPU at 87%, RAM usage 11.2 GB of 16 GB, disk I/O at 340 MB/s, and 3 active processes flagged in red', keywords: ['CPU', '87', 'RAM', 'disk', 'three', 'red'] },
    { file: 'img-c8b3.svg', keywords: ['cat', 'orange'] },
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
    // ── Daily pool update: added 2026-06-13 ──
    // Easy tier
    { file: null, description: 'A red traffic light signal glowing against a dark background with the amber and green lights unlit', keywords: ['traffic', 'light', 'red', 'signal'] },
    { file: null, description: 'A calculator display showing the number 2048 after an equals key press', keywords: ['calculator', '2048', 'display'] },
    // Medium tier
    { file: null, description: 'An email inbox showing 7 unread messages; the top email is from "Alice Brown" with the subject "Q3 Budget Review"', keywords: ['email', 'inbox', 'seven', 'unread', 'Alice', 'Q3', 'budget'] },
    { file: null, description: 'A mobile phone screen displaying a battery icon at 23% with red fill and a "Low Battery — Connect charger" alert dialog', keywords: ['phone', 'battery', '23', 'red', 'low', 'alert'] },
    { file: null, description: 'A code editor showing a Python file with a red squiggly underline on line 7 and a popup tooltip reading "SyntaxError: unexpected EOF while parsing"', keywords: ['code', 'editor', 'python', 'error', 'line', '7', 'syntax'] },
    { file: null, description: 'An analytics dashboard with four KPI metric cards arranged in a row: Revenue $2.4M (+12%), Active Users 48K (+7%), Churn Rate 3.2% (−0.5%), NPS Score 72', keywords: ['dashboard', 'revenue', 'users', '48', 'churn', 'NPS', '72'] },
    // Hard tier
    { file: null, description: 'A partially filled 6×6 Sudoku grid where row 1 shows 1, 2, blank, 4, blank, 6 and row 2 shows blank, 5, 3, blank, 1, blank — the bottom-right 3×3 box is entirely empty', keywords: ['sudoku', 'six', 'grid', 'empty', 'row', 'partially'] },
    { file: null, description: 'A transit route diagram showing 5 bus stops in sequence: Central → Park → Museum → Library → Airport; a yellow diamond at Museum marks a transfer connection to Line 3', keywords: ['bus', 'route', 'five', 'stops', 'museum', 'transfer', 'airport', 'line'] },
    // ── Daily pool update: added 2026-06-14 ──
    // Medium tier
    { file: null, description: 'A 7-day weather forecast grid showing Mon 22°C sunny, Tue 19°C cloudy, Wed 15°C rainy, Thu 14°C rainy, Fri 18°C partly cloudy, Sat 24°C sunny, Sun 26°C sunny — temperatures drop midweek', keywords: ['weather', 'seven', 'sunny', 'rainy', 'wednesday', 'thursday', '14', '26'] },
    { file: null, description: 'An e-commerce product grid showing 6 items: a laptop at $849, headphones at $129, a mouse at $39, a keyboard at $79, a monitor at $349, and a webcam at $59 — the laptop and monitor are marked "Best Seller"', keywords: ['six', 'laptop', '849', 'headphones', 'monitor', 'best', 'seller'] },
    // Hard tier
    { file: null, description: 'A database entity-relationship diagram with five tables: users (id, name, email), orders (id, user_id, total), products (id, name, price), order_items (order_id, product_id, qty), and categories (id, name) — three foreign-key arrows are drawn in blue', keywords: ['database', 'five', 'tables', 'users', 'orders', 'products', 'foreign', 'three'] },
    { file: null, description: 'A terminal window showing git log output: 5 commits from the last 3 days — the most recent commit reads "fix: resolve null pointer in payment handler" authored by dev@company.com at 14:07', keywords: ['terminal', 'git', 'five', 'commits', 'null', 'payment', 'handler', '14:07'] },
    { file: null, description: 'A legal contract page showing clause 7.3 titled "Indemnification" with two sub-clauses (a) and (b), a highlighted sentence reading "The aggregate liability shall not exceed $50,000", and a margin annotation in red ink reading "review this"', keywords: ['contract', 'clause', '7.3', 'indemnification', 'liability', '50000', 'review'] },
    // ── Daily pool update: added 2026-06-15 ──
    // Medium tier
    { file: null, description: 'A music streaming app showing a playlist of 8 songs; track #3 titled "Ocean Drive" is currently paused at 1:47 out of a total duration of 3:42', keywords: ['playlist', 'eight', 'songs', 'paused', '1:47', '3:42', 'Ocean'] },
    { file: null, description: 'A comparison table showing four programming languages (Python, Go, Rust, JavaScript) evaluated across five criteria: speed, memory efficiency, syntax simplicity, ecosystem maturity, and learning curve — each rated 1 to 5 stars', keywords: ['comparison', 'four', 'languages', 'Python', 'Rust', 'five', 'criteria', 'stars'] },
    { file: null, description: 'A pie chart divided into five sectors: North America 38%, Europe 27%, Asia-Pacific 22%, Latin America 8%, Rest of World 5%', keywords: ['pie', 'chart', 'five', 'North America', '38', 'Europe', '27'] },
    // Hard tier
    { file: null, description: 'An electrical wiring diagram showing three parallel circuits: left circuit has a closed switch, a 10-ohm resistor, and a green LED; middle circuit has an open switch, a 47-ohm resistor, and a red LED (off); right circuit has a closed switch, a 22-ohm resistor, and a blue LED', keywords: ['wiring', 'three', 'parallel', 'switch', 'open', 'resistor', 'ohm', 'LED'] },
    { file: null, description: 'A permissions matrix table with five user roles (Admin, Editor, Viewer, Moderator, Guest) across the top and seven permissions down the side — checkmarks and X marks fill the grid; only Admin row shows all seven checkmarks', keywords: ['permissions', 'matrix', 'five', 'roles', 'admin', 'seven', 'checkmarks'] },
    { file: null, description: 'A UML sequence diagram showing three actors: Client, API Gateway, and Database — Client sends a POST /orders request, API Gateway validates the Authorization header (shown in a loop box labeled "retry up to 3 times"), makes two sequential SELECT queries to the Database, and returns a 201 Created response with an order ID', keywords: ['UML', 'sequence', 'three', 'actors', 'client', 'gateway', 'database', 'POST', '201'] },
    // ── Daily pool update: added 2026-06-16 ──
    // Easy tier
    { file: null, description: 'A blue WiFi signal icon showing 3 of 4 bars filled, indicating strong but not maximum signal strength', keywords: ['wifi', 'signal', 'three', 'bars', 'blue'] },
    // Medium tier
    { file: null, description: 'A project kanban board with four columns: Backlog (12 cards), To Do (5 cards), In Progress (3 cards), Done (28 cards) — a countdown timer in the top-right shows 6 days remaining until the sprint ends', keywords: ['kanban', 'backlog', 'twelve', 'progress', 'three', 'done', 'six', 'sprint'] },
    { file: null, description: 'A smartphone notification shade showing four notifications on a dark background at 9:41 AM: two WhatsApp messages from different contacts, one unread Gmail thread, and one system notification about a software update', keywords: ['notification', 'four', 'whatsapp', 'gmail', 'system', 'dark', '9:41'] },
    { file: null, description: 'A video call interface with six participant tiles in a 2×3 grid — two participants have their cameras off showing a black panel with initials, one participant has a raised hand icon in the corner, and the bottom control bar shows the current user\'s microphone as muted', keywords: ['video', 'call', 'six', 'tiles', 'cameras', 'off', 'raised', 'hand', 'muted'] },
    // Hard tier
    { file: null, description: 'A Kubernetes deployment YAML snippet showing apiVersion: apps/v1 with spec.replicas: 3, container resource limits of 200m CPU and 256Mi memory, and a readinessProbe on path /health port 8080 — two red ❌ validation error markers appear beside the resources.limits block', keywords: ['kubernetes', 'deployment', 'three', 'replicas', '200m', '256Mi', 'readinessProbe', 'error'] },
    { file: null, description: 'A 5×6 heatmap grid where cell color ranges from white (0) to dark red (100) — three cells stand out as darkest: row 2 col 4 shows 97, row 4 col 1 shows 94, row 5 col 6 shows 89; row 2\'s average is annotated as 42.3 on the right margin', keywords: ['heatmap', 'five', 'six', 'grid', 'row', 'col', '97', '94', 'average', '42.3'] },
    // ── Daily pool update: added 2026-06-18 ──
    // Easy tier
    { file: null, description: 'A loading progress bar at 73% completion — blue fill on a white rounded track with a "73%" percentage label centered inside the bar', keywords: ['progress', 'bar', '73', 'blue', 'loading'] },
    // Medium tier
    { file: null, description: 'A digital restaurant menu listing five dishes: Caesar Salad $12.95, Grilled Salmon $28.00, Margherita Pizza $15.50, Beef Burger $16.75, Tiramisu $8.00 — the Grilled Salmon entry has a gold star "Chef\'s Special" badge in the upper right corner', keywords: ['menu', 'five', 'dishes', 'salmon', '28', 'chef', 'special', 'badge'] },
    { file: null, description: 'A student grade report showing four subjects in a table: Mathematics 92/100, English 78/100, Physics 85/100, History 70/100 — the overall GPA calculated at the bottom reads 3.41 on a 4.0 scale', keywords: ['grade', 'four', 'mathematics', '92', 'english', '78', 'GPA', '3.41'] },
    { file: null, description: 'A two-factor authentication setup screen showing a QR code on the left and a six-digit OTP entry field on the right — a countdown timer above the field reads 28 seconds remaining and a "Resend Code" link is greyed out', keywords: ['two-factor', 'QR', 'code', 'six', 'digit', 'OTP', '28', 'seconds', 'resend'] },
    // Hard tier
    { file: null, description: 'A GitHub pull request diff view showing 3 files changed: auth.js has 12 insertions in green and 4 deletions in red, config.json has 2 insertions and 0 deletions, README.md has 1 insertion and 3 deletions — a blue comment bubble icon appears on line 47 of auth.js', keywords: ['pull request', 'three', 'files', 'auth', '12', '4', 'deletions', 'line', '47', 'comment'] },
    { file: null, description: 'A Prometheus metrics dashboard showing request rates for three endpoints: /api/login at 142 req/s, /api/data at 893 req/s, /api/upload at 23 req/s — two red alert badges are visible: /api/upload shows latency_p99 = 8.3s and /api/login shows error_rate = 12%', keywords: ['prometheus', 'three', 'endpoints', 'login', '142', 'data', '893', 'upload', '8.3', 'error', '12'] },
    // ── Daily pool update: added 2026-06-19 ──
    // Hard tier — replacing retired basic SVGs with architectural diagrams
    { file: null, description: 'A Docker Compose YAML snippet showing three services: web (image nginx:alpine, port 80:80), api (image node:18-alpine, port 3000:3000, depends_on db), and db (image postgres:15, environment POSTGRES_DB=appdb) — a depends_on arrow links api to db', keywords: ['docker', 'three', 'services', 'nginx', 'api', 'node', 'postgres', 'depends_on', 'appdb'] },
    { file: null, description: 'An AWS architecture diagram showing a VPC with two availability zones — each zone contains a public subnet with one EC2 t3.medium instance and a private subnet with one RDS db.t3.large instance; an Application Load Balancer spans both zones at the top; total of 2 EC2 instances and 2 RDS instances visible', keywords: ['AWS', 'VPC', 'two', 'availability', 'zones', 'EC2', 't3', 'RDS', 'Load Balancer'] },
    // Medium tier
    { file: null, description: 'A mobile payment confirmation screen: payment of $34.99 to "Coffee Republic" — a green animated checkmark dominates the center, card last-4 digits shown as ****8521, and a timestamp of 10:23 AM Oct 3 appears below the merchant name', keywords: ['payment', '34.99', 'Coffee Republic', '8521', '10:23', 'checkmark', 'green'] },
    { file: null, description: 'An infrastructure cost report table with five columns (Service, Region, vCPUs, Monthly Cost, Status) and eight data rows — the grand total row reads $8,234.50; the most expensive row is EC2 r6i.4xlarge in us-east-1 at $2,340 per month marked "Running"', keywords: ['infrastructure', 'cost', 'eight', 'rows', '8234', 'EC2', 'r6i', '2340', 'Running'] },
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

const FORM_NAMES = ['John Smith','Alice Chen','Bob Kumar','Maria Garcia','Yuki Tanaka','Hans Mueller','Fatima Al-Said','Pierre Dubois','Olga Petrova','Carlos Silva','Priya Sharma','Liam O\'Brien','Aiko Yamamoto','Mohammed Al-Rashid','Sofia Andersson','Wei Zhang','Amara Osei','Ravi Kapoor','Isabella Rossi','Dmitri Volkov','Nguyen Van An','Zainab Hassan','Lucas Ferreira','Elena Kowalski','Tariq Nasser','Mei-Ling Wu','Bjorn Larsen','Ayaan Khan','Valentina Cruz','Kenji Nakamura','Fatou Diallo','Nikola Petrov','Sung-Min Park','Aisyah Rahman','Tomás Herrera'];
const FORM_EMAILS = ['john@example.com','alice@test.org','bob@demo.io','maria@mail.com','yuki@sample.jp','hans@test.de','fatima@example.sa','pierre@demo.fr','olga@test.ru','carlos@mail.br','priya@demo.in','liam@test.ie','aiko@sample.co.jp','mohammed@example.ae','sofia@test.se','wei@demo.cn','amara@test.gh','ravi@sample.in','isabella@demo.it','dmitri@test.ru','fatou@demo.sn','nikola@test.bg','sungmin@sample.kr','aisyah@demo.my','tomas@test.es'];
const FORM_COUNTRIES = ['USA','Japan','Germany','Brazil','Australia','France','India','Canada','UK','South Korea','Sweden','UAE','Ireland','Mexico','Singapore','China','Ghana','Italy','Russia','Netherlands','Nigeria','Argentina','Turkey','Poland','Vietnam'];
const FORM_PHONES = ['+1-555-0123','+81-90-1234-5678','+49-170-1234567','+55-11-91234-5678','+61-400-123-456','+33-6-12-34-56-78','+91-98765-43210','+44-7700-900123','+46-70-123-4567','+65-9123-4567','+52-55-1234-5678','+353-87-123-4567'];
const FORM_DATES = ['1990-06-15','1985-03-22','1992-11-08','1988-01-30','1995-07-14','1983-09-25','1991-12-01','1987-04-17','1993-08-09','1986-02-14','1994-10-31','1989-05-20'];
const FORM_MESSAGES = ['Hello World','Please process my order','Testing the form','Quick inquiry','Need assistance','Feedback submission','Schedule a demo','Request for quote','Update my subscription','Cancel and refund','Report a billing issue','Upgrade account plan','Technical support needed','Request API access','Partnership inquiry','Download invoice','Reset 2FA device','Submit compliance form','Activate trial extension','Transfer account ownership'];

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
    // ── Daily pool update: added 2026-06-13 ──
    { title: 'Rotate Image 90°', description: 'Write `solve(matrix)` — rotate an n×n 2D matrix 90 degrees clockwise in-place and return it.',
      testCases: [{ input: '[[1,2,3],[4,5,6],[7,8,9]]', expected: '[[7,4,1],[8,5,2],[9,6,3]]' },{ input: '[[5,1],[2,4]]', expected: '[[2,5],[4,1]]' },{ input: '[[1]]', expected: '[[1]]' }] },
    { title: 'Longest Common Subsequence', description: 'Write `solve(s1, s2)` — return the length of the longest common subsequence of the two strings (characters need not be contiguous).',
      testCases: [{ input: '"abcde", "ace"', expected: '3' },{ input: '"abc", "abc"', expected: '3' },{ input: '"abc", "def"', expected: '0' },{ input: '"", "abc"', expected: '0' }] },
    { title: 'Trapping Rain Water', description: 'Write `solve(height)` — given an array of non-negative integers representing an elevation map where each bar has width 1, return how much water can be trapped.',
      testCases: [{ input: '[0,1,0,2,1,0,1,3,2,1,2,1]', expected: '6' },{ input: '[4,2,0,3,2,5]', expected: '9' },{ input: '[1,0,1]', expected: '1' },{ input: '[]', expected: '0' }] },
    { title: 'Edit Distance', description: 'Write `solve(word1, word2)` — return the minimum number of operations (insert, delete, or replace a single character) required to convert word1 into word2.',
      testCases: [{ input: '"horse", "ros"', expected: '3' },{ input: '"intention", "execution"', expected: '5' },{ input: '"", "abc"', expected: '3' },{ input: '"abc", "abc"', expected: '0' }] },
    { title: 'Merge K Sorted Arrays', description: 'Write `solve(arrays)` — given an array of k sorted arrays, merge all of them into one sorted array.',
      testCases: [{ input: '[[1,4,7],[2,5,8],[3,6,9]]', expected: '[1,2,3,4,5,6,7,8,9]' },{ input: '[[1,2],[3,4],[5,6]]', expected: '[1,2,3,4,5,6]' },{ input: '[[]]', expected: '[]' },{ input: '[[1]]', expected: '[1]' }] },
    { title: 'Valid Sudoku', description: 'Write `solve(board)` — given a 9×9 2D array (with "." for empty), return true if the board is valid: each row, column, and 3×3 box must contain digits 1-9 with no repeats.',
      testCases: [{ input: '[["5","3",".",".","7",".",".",".","."],["6",".",".","1","9","5",".",".","."],[".","9","8",".",".",".",".","6","."],["8",".",".",".","6",".",".",".","3"],["4",".",".","8",".","3",".",".","1"],["7",".",".",".","2",".",".",".","6"],[".","6",".",".",".",".","2","8","."],[".",".",".","4","1","9",".",".","5"],[".",".",".",".","8",".",".","7","9"]]', expected: 'true' },{ input: '[["8","3",".",".","7",".",".",".","."],["6",".",".","1","9","5",".",".","."],[".","9","8",".",".",".",".","6","."],["8",".",".",".","6",".",".",".","3"],["4",".",".","8",".","3",".",".","1"],["7",".",".",".","2",".",".",".","6"],[".","6",".",".",".",".","2","8","."],[".",".",".","4","1","9",".",".","5"],[".",".",".",".","8",".",".","7","9"]]', expected: 'false' }] },
    // ── Daily pool update: added 2026-06-14 ──
    { title: 'Jump Game', description: 'Write `solve(nums)` — given an array of non-negative integers where each element represents the maximum jump length from that position, return true if you can reach the last index starting from index 0.',
      testCases: [{ input: '[2,3,1,1,4]', expected: 'true' },{ input: '[3,2,1,0,4]', expected: 'false' },{ input: '[0]', expected: 'true' },{ input: '[1,0,1]', expected: 'false' }] },
    { title: 'Unique Paths', description: 'Write `solve(m, n)` — a robot is on the top-left of an m×n grid. It can only move right or down. Return the number of distinct paths to reach the bottom-right corner.',
      testCases: [{ input: '3, 3', expected: '6' },{ input: '3, 7', expected: '28' },{ input: '1, 1', expected: '1' },{ input: '2, 2', expected: '2' }] },
    { title: 'Best Time to Buy and Sell Stock', description: 'Write `solve(prices)` — given an array where prices[i] is the price of a stock on day i, return the maximum profit you can achieve from one buy and one sell. If no profit is possible, return 0.',
      testCases: [{ input: '[7,1,5,3,6,4]', expected: '5' },{ input: '[7,6,4,3,1]', expected: '0' },{ input: '[1,2]', expected: '1' },{ input: '[2,4,1]', expected: '2' }] },
    { title: 'Letter Combinations of Phone Number', description: 'Write `solve(digits)` — given a string of digits 2-9, return all possible letter combinations using the telephone keypad (2=abc, 3=def, 4=ghi, 5=jkl, 6=mno, 7=pqrs, 8=tuv, 9=wxyz). Return sorted alphabetically.',
      testCases: [{ input: '"2"', expected: '["a","b","c"]' },{ input: '"23"', expected: '["ad","ae","af","bd","be","bf","cd","ce","cf"]' },{ input: '""', expected: '[]' }] },
    { title: 'Find Duplicate Number', description: 'Write `solve(nums)` — given an array of n+1 integers where each integer is in the range [1, n] inclusive and exactly one number is duplicated, return that duplicate number without modifying the array.',
      testCases: [{ input: '[1,3,4,2,2]', expected: '2' },{ input: '[3,1,3,4,2]', expected: '3' },{ input: '[1,1]', expected: '1' },{ input: '[2,5,9,6,9,3,8,9,7,1]', expected: '9' }] },
    { title: 'Minimum Window Substring', description: 'Write `solve(s, t)` — return the shortest substring of s that contains every character in t (including duplicates). If no such substring exists, return an empty string "".',
      testCases: [{ input: '"ADOBECODEBANC", "ABC"', expected: '"BANC"' },{ input: '"a", "a"', expected: '"a"' },{ input: '"a", "aa"', expected: '""' },{ input: '"ab", "b"', expected: '"b"' }] },
    { title: 'Largest Rectangle in Histogram', description: 'Write `solve(heights)` — given an array of integers representing the height of bars in a histogram (each bar has width 1), return the area of the largest rectangle that can be formed.',
      testCases: [{ input: '[2,1,5,6,2,3]', expected: '10' },{ input: '[2,4]', expected: '4' },{ input: '[1,2]', expected: '2' },{ input: '[1]', expected: '1' },{ input: '[0,9]', expected: '9' }] },
    // ── Daily pool update: added 2026-06-15 ──
    { title: 'Generate Parentheses', description: 'Write `solve(n)` — given n pairs of parentheses, generate all combinations of well-formed parentheses and return them in sorted order.',
      testCases: [{ input: '1', expected: '["()"]' },{ input: '2', expected: '["(())","()()"]' },{ input: '3', expected: '["((()))","(()())","(())()","()(())","()()()"]' }] },
    { title: 'Course Schedule', description: 'Write `solve(numCourses, prerequisites)` — there are numCourses courses labeled 0 to numCourses-1. prerequisites[i] = [a, b] means course b must be taken before course a. Return true if it is possible to finish all courses (i.e., no circular dependency exists).',
      testCases: [{ input: '2, [[1,0]]', expected: 'true' },{ input: '2, [[1,0],[0,1]]', expected: 'false' },{ input: '3, [[1,0],[2,0]]', expected: 'true' },{ input: '1, []', expected: 'true' }] },
    { title: 'Balanced Binary Tree', description: 'Write `solve(nodes)` — given a binary tree as a level-order array (use null for missing nodes), return true if the tree is height-balanced (the heights of left and right subtrees of every node differ by at most 1).',
      testCases: [{ input: '[3,9,20,null,null,15,7]', expected: 'true' },{ input: '[1,2,2,3,3,null,null,4,4]', expected: 'false' },{ input: '[]', expected: 'true' },{ input: '[1]', expected: 'true' }] },
    // ── Daily pool update: added 2026-06-16 ──
    { title: 'Find Peak Element', description: 'Write `solve(nums)` — a peak element is strictly greater than its neighbors. Return any peak\'s index. (Assume nums[-1] = nums[n] = -Infinity)',
      testCases: [{ input: '[1,2,3,1]', expected: '2' },{ input: '[1,2,1,3,5,6,4]', expected: '5' },{ input: '[1]', expected: '0' },{ input: '[1,2]', expected: '1' }] },
    { title: 'Max Depth of Binary Tree', description: 'Write `solve(nodes)` — given a binary tree as a level-order array (null for missing nodes), return its maximum depth (number of nodes along the longest root-to-leaf path).',
      testCases: [{ input: '[3,9,20,null,null,15,7]', expected: '3' },{ input: '[1,null,2]', expected: '2' },{ input: '[]', expected: '0' },{ input: '[1,2,3,4,5]', expected: '3' }] },
    { title: 'House Robber', description: 'Write `solve(nums)` — you are a robber who cannot rob two adjacent houses. Given an array of non-negative integers representing the money at each house, return the maximum amount you can rob tonight.',
      testCases: [{ input: '[1,2,3,1]', expected: '4' },{ input: '[2,7,9,3,1]', expected: '12' },{ input: '[0]', expected: '0' },{ input: '[2,1]', expected: '2' },{ input: '[5,1,1,5]', expected: '10' }] },
    { title: 'Subsets', description: 'Write `solve(nums)` — given an array of distinct integers, return all possible subsets. Sort each subset, then sort all subsets lexicographically (empty set comes first).',
      testCases: [{ input: '[1,2,3]', expected: '[[],[1],[1,2],[1,2,3],[1,3],[2],[2,3],[3]]' },{ input: '[0]', expected: '[[],[0]]' },{ input: '[1,2]', expected: '[[],[1],[1,2],[2]]' }] },
    { title: 'Permutations', description: 'Write `solve(nums)` — given an array of distinct integers, return all permutations sorted lexicographically.',
      testCases: [{ input: '[1,2,3]', expected: '[[1,2,3],[1,3,2],[2,1,3],[2,3,1],[3,1,2],[3,2,1]]' },{ input: '[1]', expected: '[[1]]' },{ input: '[1,2]', expected: '[[1,2],[2,1]]' }] },
    { title: 'Regular Expression Matching', description: 'Write `solve(s, p)` — implement basic regex matching where "." matches any single character and "*" matches zero or more of the preceding element. Return true if the full string s matches pattern p.',
      testCases: [{ input: '"aa", "a"', expected: 'false' },{ input: '"aa", "a*"', expected: 'true' },{ input: '"ab", ".*"', expected: 'true' },{ input: '"aab", "c*a*b"', expected: 'true' },{ input: '"mississippi", "mis*is*p*."', expected: 'false' }] },
    // ── Daily pool update: added 2026-06-18 ──
    { title: 'Rotate Array', description: 'Write `solve(nums, k)` — rotate the array to the right by k steps (k may be larger than the array length). Return the resulting array.',
      testCases: [{ input: '[1,2,3,4,5], 2', expected: '[4,5,1,2,3]' },{ input: '[1,2,3], 4', expected: '[3,1,2]' },{ input: '[1], 100', expected: '[1]' },{ input: '[1,2,3,4,5,6,7], 3', expected: '[5,6,7,1,2,3,4]' }] },
    { title: 'Next Greater Element', description: 'Write `solve(nums)` — for each element in the array, return the first element to its right that is strictly greater, or -1 if no such element exists.',
      testCases: [{ input: '[4,1,2]', expected: '[-1,2,-1]' },{ input: '[1,2,3,4]', expected: '[2,3,4,-1]' },{ input: '[4,3,2,1]', expected: '[-1,-1,-1,-1]' },{ input: '[2,1,2,4,3,5]', expected: '[4,2,4,5,5,-1]' }] },
    { title: 'Sliding Window Maximum', description: 'Write `solve(nums, k)` — given an integer array and a sliding window of size k, return an array of the maximum value in each window position.',
      testCases: [{ input: '[1,3,-1,-3,5,3,6,7], 3', expected: '[3,3,5,5,6,7]' },{ input: '[1], 1', expected: '[1]' },{ input: '[1,2], 2', expected: '[2]' },{ input: '[2,3,4,1,5], 3', expected: '[4,4,5]' }] },
    { title: 'Longest Increasing Subsequence', description: 'Write `solve(nums)` — return the length of the longest strictly increasing subsequence (elements do not need to be contiguous).',
      testCases: [{ input: '[10,9,2,5,3,7,101,18]', expected: '4' },{ input: '[0,1,0,3,2,3]', expected: '4' },{ input: '[7,7,7,7,7]', expected: '1' },{ input: '[]', expected: '0' }] },
    // ── Daily pool update: added 2026-06-19 ──
    { title: 'Top K Frequent Elements', description: 'Write `solve(nums, k)` — return the k most frequent elements sorted in ascending order. Break frequency ties by choosing elements with smaller values.',
      testCases: [{ input: '[1,1,1,2,2,3], 2', expected: '[1,2]' },{ input: '[3,3,2,1,1], 2', expected: '[1,3]' },{ input: '[5,5,4,4,3], 2', expected: '[4,5]' },{ input: '[1], 1', expected: '[1]' }] },
    { title: 'Container With Most Water', description: 'Write `solve(height)` — given an array of non-negative integers where height[i] is the height of a vertical bar at index i, find two bars that form a container holding the most water. Return the maximum water volume (area = min height × distance between bars).',
      testCases: [{ input: '[1,8,6,2,5,4,8,3,7]', expected: '49' },{ input: '[1,1]', expected: '1' },{ input: '[4,3,2,1,4]', expected: '16' },{ input: '[1,2,4,3]', expected: '4' }] },
    { title: 'Search a 2D Matrix', description: 'Write `solve(matrix, target)` — search for a target in an m×n integer matrix where (1) each row is sorted left-to-right and (2) the first element of each row is strictly greater than the last element of the previous row. Return true if the target exists.',
      testCases: [{ input: '[[1,3,5,7],[10,11,16,20],[23,30,34,60]], 3', expected: 'true' },{ input: '[[1,3,5,7],[10,11,16,20],[23,30,34,60]], 13', expected: 'false' },{ input: '[[1]], 1', expected: 'true' },{ input: '[[1,3],[5,7]], 6', expected: 'false' }] },
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
    // ── Daily pool update: added 2026-06-13 ──
    { question: 'What is the least common multiple (LCM) of 12 and 18?', expectedKeywords: ['36'] },
    { question: 'You invest $1000 at 10% annual interest compounded annually. What is the value of the investment after 2 years?', expectedKeywords: ['1210', '1,210'] },
    { question: 'You draw 2 cards from a standard 52-card deck without replacement. What is the probability that both cards are aces? Express as a simplified fraction.', expectedKeywords: ['1/221'] },
    { question: 'A man looks at a photograph and says: "Brothers and sisters I have none, but this man\'s father is my father\'s son." Whose photograph is he looking at?', expectedKeywords: ['son', 'his son'] },
    { question: 'A cistern can be filled by pipe A in 12 hours and drained by pipe B in 18 hours. If both pipes are open simultaneously and the cistern starts empty, how many hours until it is full?', expectedKeywords: ['36'] },
    { question: 'What is the value of 7! (7 factorial)?', expectedKeywords: ['5040'] },
    { question: 'A train 150 m long passes a stationary observer in 10 seconds. What is the speed of the train in km/h?', expectedKeywords: ['54'] },
    // ── Daily pool update: added 2026-06-14 ──
    { question: 'Worker A can complete a job in 8 days; worker B can complete the same job in 12 days. Working together, how many days will it take them to complete the job?', expectedKeywords: ['4.8', '24/5'] },
    { question: 'What is the 15th term of the arithmetic sequence 3, 7, 11, 15, ...?', expectedKeywords: ['59'] },
    { question: 'A bag contains 5 red balls and 3 blue balls. You draw 2 balls without replacement. What is the probability that both balls are red? Express as a simplified fraction.', expectedKeywords: ['5/14', '10/28'] },
    { question: 'You have 12 identical-looking coins, but one is counterfeit and slightly heavier than the rest. What is the minimum number of weighings on a balance scale needed to guarantee finding the counterfeit coin?', expectedKeywords: ['3', 'three'] },
    { question: 'What is the greatest common divisor (GCD) of 84 and 126?', expectedKeywords: ['42'] },
    { question: 'In how many distinct ways can the letters of the word MISSISSIPPI be arranged?', expectedKeywords: ['34650'] },
    { question: 'A circle has a circumference of 12π cm. What is the area of the circle in square centimetres?', expectedKeywords: ['36π', '36pi', '113'] },
    // ── Daily pool update: added 2026-06-15 ──
    { question: 'What is the next term in the sequence: 1, 4, 9, 16, 25, ...?', expectedKeywords: ['36'] },
    { question: 'A cube has a side length of 3 cm. What is its total surface area in square centimetres?', expectedKeywords: ['54'] },
    { question: 'A shop buys a jacket and sells it for $120, making a 20% profit on the cost price. What was the original cost price of the jacket?', expectedKeywords: ['100'] },
    { question: 'A bag contains 4 white, 3 black, and 2 red balls. One ball is drawn at random. What is the probability of NOT drawing a red ball? Express as a simplified fraction.', expectedKeywords: ['7/9'] },
    { question: 'A car travels from city A to city B at 60 km/h and returns along the same route at 40 km/h. What is the average speed for the entire round trip in km/h?', expectedKeywords: ['48'] },
    { question: 'In a row of five differently-coloured houses, the red house is always immediately to the left of the white house. How many possible positions can the red house occupy?', expectedKeywords: ['4', 'four'] },
    { question: 'What is the value of 10 to the power of 0?', expectedKeywords: ['1', 'one'] },
    // ── Daily pool update: added 2026-06-16 ──
    // Easy tier
    { question: 'How many days are in a leap year?', expectedKeywords: ['366'] },
    { question: 'What is the square root of 169?', expectedKeywords: ['13'] },
    // Medium tier
    { question: 'Two trains start from opposite ends of a 600 km track at the same time, heading toward each other. Train A travels at 80 km/h and Train B at 70 km/h. After how many hours do they meet?', expectedKeywords: ['4', 'four'] },
    { question: 'A shirt\'s price is reduced by 20% and it now costs $48. What was its original price?', expectedKeywords: ['60', '$60'] },
    { question: 'How many diagonals does a regular octagon have?', expectedKeywords: ['20', 'twenty'] },
    // Hard tier
    { question: 'A pool has two inlet pipes (A fills in 10 h, B fills in 15 h) and one outlet pipe (drains in 30 h). If all three run simultaneously from empty, how many hours does it take to fill the pool?', expectedKeywords: ['7.5', '15/2'] },
    { question: 'A staircase has 7 steps. You can climb 1, 2, or 3 steps at a time. How many distinct ways can you climb to the top?', expectedKeywords: ['44'] },
    // ── Daily pool update: added 2026-06-18 ──
    // Easy tier
    { question: 'What is 9 squared?', expectedKeywords: ['81'] },
    { question: 'How many minutes are in 3 hours and 45 minutes?', expectedKeywords: ['225'] },
    // Medium tier
    { question: 'Two dice are rolled. What is the probability that their sum is greater than 9? Express as a simplified fraction.', expectedKeywords: ['1/6'] },
    { question: 'A car travels 300 km on 25 liters of fuel. What is the car\'s fuel efficiency in km per liter?', expectedKeywords: ['12'] },
    { question: 'A 5-meter ladder leans against a wall. The base of the ladder is 3 meters from the wall. How high up the wall does the ladder reach in meters?', expectedKeywords: ['4'] },
    { question: 'A shopkeeper bought an item for $150 and sold it at a 30% profit. What was the selling price?', expectedKeywords: ['195', '$195'] },
    // Hard tier
    { question: 'A cube is painted on all six faces and then cut into 27 smaller equal cubes (3×3×3). How many of the small cubes have exactly two faces painted?', expectedKeywords: ['12', 'twelve'] },
    { question: 'How many three-digit positive integers are divisible by both 4 and 6?', expectedKeywords: ['75'] },
    { question: 'A gear with 12 teeth meshes with a gear with 36 teeth. If the smaller gear rotates at 120 RPM, at what RPM does the larger gear rotate?', expectedKeywords: ['40'] },
    // ── Daily pool update: added 2026-06-19 ──
    // Medium tier
    { question: 'A shopkeeper marks a product 40% above its cost price and then offers a 20% discount on the marked price. What is the percentage profit on the original cost price?', expectedKeywords: ['12', '12%'] },
    { question: 'A 20-liter mixture of milk and water is in the ratio 3:1. How many liters of water must be added to make the ratio 3:2?', expectedKeywords: ['5'] },
    { question: 'In a group of 60 people, 30 speak English, 20 speak French, and 10 speak both languages. How many people speak neither English nor French?', expectedKeywords: ['20', 'twenty'] },
    // Hard tier
    { question: 'A rectangular swimming pool is 25 m long, 10 m wide, and filled to a depth of 1.5 m. How many kiloliters of water does it hold?', expectedKeywords: ['375'] },
    { question: 'A sum of money doubles itself in 5 years under simple interest. What is the annual interest rate as a percentage?', expectedKeywords: ['20', '20%'] },
    { question: 'You roll two fair six-sided dice. What is the probability that the product of the two numbers shown is even? Express as a simplified fraction.', expectedKeywords: ['3/4'] },
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
    // ── Daily pool update: added 2026-06-13 ──
    { text: 'The meeting has been rescheduled from Wednesday the 5th at 10 AM to Friday the 14th at 3:30 PM — conference room Delta on floor 8', keywords: ['rescheduled', 'wednesday', 'friday', '14', 'delta', 'floor', '8'] },
    { text: 'Order confirmation: SKU-79043-B quantity 24 shipped to 1425 Elm Street warehouse zone 7 expected delivery Tuesday the seventeenth', keywords: ['SKU', '79043', 'quantity', '24', 'Elm', 'zone', 'tuesday'] },
    { text: 'Euler prime number e approximately equals 2.71828 and serves as the base of the natural logarithm written as ln of x', keywords: ['euler', '2.71828', 'natural', 'logarithm', 'base'] },
    { text: 'IBAN GB29 NWBK 6016 1331 9268 19 — please verify the account number before initiating the SEPA transfer of two thousand four hundred euros', keywords: ['IBAN', 'GB29', 'SEPA', 'transfer', 'euros', 'verify'] },
    { text: 'The Reynolds number determines whether fluid flow is laminar or turbulent and equals density times velocity times characteristic length divided by dynamic viscosity', keywords: ['reynolds', 'laminar', 'turbulent', 'density', 'velocity', 'viscosity'] },
    // ── Daily pool update: added 2026-06-14 ──
    { text: 'The patient hemoglobin A1c is 7.2 percent, LDL cholesterol is 142 milligrams per deciliter, and blood pressure is 128 over 82 millimeters of mercury', keywords: ['hemoglobin', '7.2', 'cholesterol', '142', 'blood', 'pressure', '128'] },
    { text: 'The conference call dial-in number is 1-800-555-0173 passcode 4729 pound recorded for compliance — your reference number is REF-2024-8841', keywords: ['conference', '555', '4729', 'compliance', 'REF', '2024', '8841'] },
    { text: 'PostgreSQL version 15.4 introduced MERGE statements improved logical replication slot management and row-level security policy inheritance', keywords: ['PostgreSQL', '15.4', 'MERGE', 'replication', 'row-level', 'security'] },
    { text: 'Avogadro number is approximately 6.022 times ten to the power of 23 which represents the number of atoms or molecules in one mole of a substance', keywords: ['avogadro', '6.022', 'twenty-three', 'mole', 'atoms', 'molecules'] },
    { text: 'Your parcel tracking number is 1Z 999 AA1 01 2345 6784 expected to arrive Thursday the 19th between 9 AM and 1 PM at 42 Maple Drive', keywords: ['parcel', '1Z', '999', 'thursday', '19', 'maple', '42'] },
    // ── Daily pool update: added 2026-06-15 ──
    { text: 'Please update the Project Alpha meeting invite from 2:00 PM to 4:30 PM and add Sarah from the UX team as an optional attendee', keywords: ['Project Alpha', '2:00', '4:30', 'Sarah', 'optional'] },
    { text: 'The regulation requires form W-9 to be submitted within 30 business days of receiving a payment exceeding the de minimis threshold of six hundred US dollars', keywords: ['W-9', 'thirty', 'business', 'de minimis', 'six hundred', 'payment'] },
    { text: 'Container vessel MSC Splendida ETA zero-six-hundred Zulu on the fourteenth carrying two thousand eight hundred forty-seven TEUs bound for Eurogate terminal berth seven', keywords: ['MSC', 'Splendida', 'zero-six-hundred', '2847', 'TEUs', 'Eurogate', 'seven'] },
    { text: 'Software release 3.14.2-beta.4 patches CVE-2024-1337 and improves rendering pipeline throughput by 18 percent', keywords: ['3.14.2', 'beta', 'CVE', '2024', '1337', 'rendering', '18'] },
    { text: 'The derivative of x cubed is 3x squared, and the integral of 2x with respect to x equals x squared plus C where C is the constant of integration', keywords: ['derivative', 'cubed', '3x', 'squared', 'integral', 'constant', 'integration'] },
    // ── Daily pool update: added 2026-06-16 ──
    // Easy tier
    { text: 'The train will arrive at platform three in approximately five minutes', keywords: ['train', 'platform', 'three', 'five', 'minutes'] },
    { text: 'Please turn off the lights when leaving the room', keywords: ['turn', 'off', 'lights', 'leaving', 'room'] },
    // Medium tier
    { text: 'Route 66 spans two thousand four hundred forty-eight miles from Chicago Illinois to Santa Monica California', keywords: ['Route', '66', '2448', 'Chicago', 'Illinois', 'Santa Monica', 'California'] },
    { text: 'Your appointment with Dr Kim is confirmed for Thursday June nineteenth at 10 AM in Clinic B suite two-oh-four', keywords: ['appointment', 'Kim', 'thursday', 'june', 'nineteenth', '10', 'clinic', '204'] },
    // Hard tier
    { text: 'The S&P 500 closed at five thousand two hundred seventy-eight point five one — three hundred twenty-six issues advanced and one hundred sixty-seven declined giving a breadth ratio of 1.95 to 1', keywords: ['S&P', '5278', '326', 'advanced', '167', 'declined', 'breadth', '1.95'] },
    { text: 'SWIFT code DEUTDEDB for Deutsche Bank Frankfurt sort code 20030000 account number 1234567890 for incoming SEPA credit transfers only', keywords: ['SWIFT', 'DEUTDEDB', 'Deutsche', 'Frankfurt', '20030000', '1234567890', 'SEPA'] },
    // ── Daily pool update: added 2026-06-18 ──
    // Easy tier
    { text: 'Please confirm your booking by clicking the link sent to your email address', keywords: ['confirm', 'booking', 'clicking', 'link', 'email'] },
    { text: 'The office will be closed on Monday for the public holiday', keywords: ['office', 'closed', 'monday', 'public', 'holiday'] },
    // Medium tier
    { text: 'Gate B twenty-two for flight QR five-seventeen to Doha is now boarding zones three and four — please have your boarding pass and passport ready', keywords: ['gate', 'B22', 'QR517', 'Doha', 'boarding', 'zones', 'three', 'four'] },
    { text: 'The data center maintains ninety-six rack units across eight server cabinets each equipped with a redundant power supply unit rated at two-point-four kilowatts', keywords: ['data', 'center', '96', 'eight', 'cabinets', 'redundant', 'power', '2.4', 'kilowatts'] },
    { text: 'Your wire transfer of fourteen thousand three hundred fifty-two dollars and seventy-five cents to account ending 8831 has been initiated and will settle in two business days', keywords: ['wire', 'transfer', '14352', 'seventy-five', '8831', 'two', 'business'] },
    // Hard tier
    { text: 'CUSIP five nine four nine one eight one zero four represents Microsoft Corporation listed on NASDAQ under ticker MSFT with approximately seven point four billion shares outstanding', keywords: ['CUSIP', '594918104', 'Microsoft', 'NASDAQ', 'MSFT', 'seven', 'billion', 'shares'] },
    { text: 'The integral from zero to pi of sine x d x equals negative cosine of pi minus negative cosine of zero which simplifies to one plus one equals two', keywords: ['integral', 'zero', 'pi', 'sine', 'cosine', 'simplifies', 'two'] },
    { text: 'The multivariate normal distribution N of mu and sigma squared describes a family of Gaussian distributions parameterized by mean mu and variance sigma squared — in one dimension the PDF is one over sigma root two pi times e to the power of negative one half x minus mu over sigma squared', keywords: ['multivariate', 'normal', 'gaussian', 'sigma', 'variance', 'PDF', 'e', 'power'] },
    // ── Daily pool update: added 2026-06-19 ──
    // Medium tier
    { text: 'Support ticket SRQ-2024-48821 has been escalated to severity 1 and the on-call engineer was paged at 03:47 UTC — expected resolution time is four hours', keywords: ['support', 'SRQ', '2024', '48821', 'severity', '1', '03:47', 'UTC', 'four'] },
    { text: 'Please be advised that your appointment with Dr Patel has been moved from Thursday at 9:30 AM to Friday the 20th at 2:15 PM in the outpatient clinic on floor 4 wing B', keywords: ['Patel', 'thursday', '9:30', 'friday', '20', '2:15', 'outpatient', 'floor', '4', 'wing'] },
    // Hard tier
    { text: 'Kubernetes cluster status: 3 of 3 control plane nodes ready, 47 worker nodes scheduled, 231 pods running, 0 pods in CrashLoopBackOff — CPU utilization 62 percent, memory utilization 71 percent', keywords: ['kubernetes', 'three', 'control', 'plane', '47', 'workers', '231', 'pods', 'CPU', '62', 'memory', '71'] },
    { text: 'XGBoost hyperparameter grid search evaluated 1296 combinations across max depth 3 to 6, learning rate 0.01 to 0.3, n estimators 100 to 500, and subsample 0.6 to 0.9 — best validation AUC of 0.9417 achieved at max depth 5 and learning rate 0.1', keywords: ['XGBoost', '1296', 'learning', 'rate', 'AUC', '0.9417', 'depth', '5'] },
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

/**
 * Build the entity.identity patch that records a verified Arena
 * interview result on the bot's namecard (card_ad404375 — Arena/Feature/P1).
 *
 * Pure function — no I/O. Caller merges the returned object into
 * `entity.identity` and persists via db.saveDeviceData.
 *
 * Latest-wins: callers should overwrite any prior interviewCapabilities
 * block with this patch (latest interview defines the verified score).
 *
 * @param {object} exam — { id, model, total_score, max_score, completed_at }
 * @param {object} mapped — output of mapArenaResultToCapabilities()
 * @param {number} [nowMs] — clock injection for tests
 * @returns {{interviewCapabilities:object,lastInterviewAt:number}|null}
 */
function buildInterviewIdentityPatch(exam, mapped, nowMs) {
    if (!exam || !mapped || typeof mapped !== 'object') return null;

    const totalScore = Number(exam.total_score);
    const maxScore = Number(exam.max_score);
    if (!Number.isFinite(totalScore) || !Number.isFinite(maxScore) || maxScore <= 0) {
        return null;
    }
    // Clamp + guard against out-of-range / negative server-side rows
    const score = Math.max(0, Math.min(maxScore, Math.round(totalScore)));
    const max = Math.max(1, Math.round(maxScore));
    const normalized = Math.round((score / max) * 100);
    const passed = !!mapped.passed;
    const completedAtMs = exam.completed_at
        ? new Date(exam.completed_at).getTime()
        : (typeof nowMs === 'number' ? nowMs : Date.now());

    return {
        interviewCapabilities: {
            score,
            maxScore: max,
            normalized,
            passed,
            model: exam.model || null,
            examId: exam.id || null,
            completedAt: completedAtMs,
            source: 'arena',
        },
        lastInterviewAt: typeof nowMs === 'number' ? nowMs : Date.now(),
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

module.exports = function arenaFactory({ serverLog, io, devices, saveDeviceData } = {}) {
    const router = express.Router();
    const audit = serverLog || (() => {});
    const deviceRegistry = devices || {};
    // Used to verify entity botSecret on the /leaderboard binding path.
    const safeEqual = require('./safe-equal');

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
    //
    // Anonymous path (back-compat): { examId, name } only — writes a
    // leaderboard row tagged with the typed display name.
    //
    // Entity-bound path (card_ad404375 — namecard score binding):
    // { examId, name, deviceId, entityId, botSecret } — if the credentials
    // verify, the verified score is also written back to
    // entity.identity.interviewCapabilities so the bot's namecard + plaza
    // tile show the verified score. Anonymous path keeps working when no
    // botSecret is supplied or credentials fail.
    router.post('/leaderboard', async (req, res) => {
        try {
            const { examId, name, deviceId, entityId, botSecret } = req.body || {};
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

            // Optional entity binding — write the verified score back to the
            // bot's identity if botSecret authenticates. Failures here MUST
            // NOT fail the public LB submit (back-compat with anonymous flow).
            let entityBinding = null;
            try {
                if (deviceId && botSecret) {
                    const eId = parseInt(entityId, 10);
                    const device = deviceRegistry[deviceId];
                    const entity = (device && Number.isInteger(eId)) ? device.entities?.[eId] : null;
                    const credsOk = !!(entity && entity.isBound && entity.botSecret && safeEqual(entity.botSecret, botSecret));
                    if (credsOk) {
                        const mapped = mapArenaResultToCapabilities(report);
                        const patch = buildInterviewIdentityPatch(exam, mapped);
                        if (patch) {
                            if (!entity.identity) entity.identity = {};
                            // Latest-wins: overwrite any prior interviewCapabilities block.
                            entity.identity.interviewCapabilities = patch.interviewCapabilities;
                            entity.identity.lastInterviewAt = patch.lastInterviewAt;
                            entity.lastUpdated = Date.now();
                            if (saveDeviceData) {
                                // Fire-and-forget persistence — log failures but
                                // don't fail the LB submit. Same pattern as
                                // identity PATCH (index.js:13598).
                                Promise.resolve(saveDeviceData(deviceId, device))
                                    .catch(err => audit('warn', 'arena', `entity binding save failed: ${err.message}`));
                            }
                            entityBinding = {
                                entityId: eId,
                                score: patch.interviewCapabilities.score,
                                maxScore: patch.interviewCapabilities.maxScore,
                                normalized: patch.interviewCapabilities.normalized,
                                passed: patch.interviewCapabilities.passed,
                            };
                            audit('info', 'arena', `entity ${deviceId}:${eId} bound to exam ${exam.id} score=${entityBinding.normalized}%`);
                        }
                    } else if (entityId !== undefined) {
                        audit('warn', 'arena', `entity binding rejected for device=${deviceId} entity=${entityId}: invalid credentials`);
                    }
                }
            } catch (bindErr) {
                console.warn('[Arena] entity binding error (non-blocking):', bindErr.message);
            }

            res.json({ success: true, leaderboardId, entityBinding });
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
    // (safeEqual already required at the top of arenaFactory for the
    // /leaderboard entity binding path; reuse the same import.)

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
module.exports.buildInterviewIdentityPatch = buildInterviewIdentityPatch;
module.exports.ARENA_PASS_THRESHOLD = ARENA_PASS_THRESHOLD;
module.exports.ARENA_TO_CAPABILITY_MAP = ARENA_TO_CAPABILITY_MAP;
module.exports.SCORING_ENGINES = SCORING_ENGINES;
module.exports.CHALLENGE_GENERATORS = CHALLENGE_GENERATORS;
module.exports.stripSecretsForBot = stripSecretsForBot;
// Pool management (used by arena-pool-updater.js and daily cron)
module.exports.reloadPools    = reloadPools;
module.exports.getCurrentPools = getCurrentPools;
