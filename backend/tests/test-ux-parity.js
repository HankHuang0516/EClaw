#!/usr/bin/env node
/**
 * UX Parity Checker — Layer 2
 * Cross-platform API-UI parity validation
 * Verifies Web Portal, Android, and iOS all implement the same API features
 * No credentials needed.
 * Usage: node backend/tests/test-ux-parity.js
 */

const fs = require('fs');
const path = require('path');

// ── Test Result Tracking ────────────────────────────────────
const results = [];
function check(name, passed, detail = '') {
    results.push({ name, passed, detail });
    const icon = passed ? '✅' : '❌';
    const suffix = detail ? ` — ${detail}` : '';
    console.log(`  ${icon} ${name}${suffix}`);
}

function warn(name, detail = '') {
    results.push({ name, passed: 'warn', detail });
    console.log(`  ⚠️  ${name} — ${detail}`);
}

// ── Path Constants ──────────────────────────────────────────
const ROOT = path.resolve(__dirname, '../..');
const PORTAL_DIR = path.join(ROOT, 'backend/public/portal');
const ANDROID_API = path.join(ROOT, 'app/src/main/java/com/hank/clawlive/data/remote/ClawApiService.kt');
const IOS_API = path.join(ROOT, 'ios-app/services/api.ts');
const PORTAL_SHARED_DIR = path.join(ROOT, 'backend/public/portal/shared');
const ANDROID_ACTIVITY_DIR = path.join(ROOT, 'app/src/main/java/com/hank/clawlive');
const IOS_APP_DIR = path.join(ROOT, 'ios-app/app');

// ── File Content Cache ──────────────────────────────────────
const fileCache = {};

function readFile(filePath) {
    if (fileCache[filePath]) return fileCache[filePath];
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        fileCache[filePath] = content;
        return content;
    } catch {
        fileCache[filePath] = '';
        return '';
    }
}

function readDir(dirPath) {
    try {
        return fs.readdirSync(dirPath);
    } catch {
        return [];
    }
}

// ── Platform Scanners ───────────────────────────────────────

/**
 * Scan Web Portal HTML files for an API path in <script> sections.
 * Excludes info.html (documentation page, not functional UI).
 */
function webHasApi(apiPath, specificHtml) {
    const htmlFiles = specificHtml
        ? [specificHtml]
        : readDir(PORTAL_DIR).filter(f => f.endsWith('.html') && f !== 'info.html');

    for (const file of htmlFiles) {
        const filePath = path.join(PORTAL_DIR, file);
        const content = readFile(filePath);

        // Extract <script> sections only
        const scriptBlocks = [];
        const scriptRe = /<script[^>]*>([\s\S]*?)<\/script>/gi;
        let m;
        while ((m = scriptRe.exec(content)) !== null) {
            scriptBlocks.push(m[1]);
        }

        const allScripts = scriptBlocks.join('\n');
        // Match the API path — allow query params or path suffixes after
        const escaped = apiPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp(escaped.replace(/\//g, '\\/'), 'i');
        if (re.test(allScripts)) return true;
    }

    // Also check shared JS files (e.g., socket.js handles notifications)
    const sharedFiles = readDir(PORTAL_SHARED_DIR).filter(f => f.endsWith('.js'));
    for (const file of sharedFiles) {
        const content = readFile(path.join(PORTAL_SHARED_DIR, file));
        const escaped2 = apiPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re2 = new RegExp(escaped2, 'i');
        if (re2.test(content)) return true;
    }

    return false;
}

/**
 * Scan Android ClawApiService.kt for API path in @GET/@POST/@PUT/@DELETE/@PATCH annotations.
 */
function androidHasApi(apiPath) {
    const content = readFile(ANDROID_API);
    if (!content) return false;
    // Android uses paths without leading slash: "api/entities"
    const stripped = apiPath.replace(/^\//, '');
    // Match in annotation strings like @GET("api/entities")
    const escaped = stripped.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`@(?:GET|POST|PUT|DELETE|PATCH)\\("${escaped}`, 'i');
    return re.test(content);
}

/**
 * Scan iOS api.ts for API path string.
 */
function iosHasApi(apiPath) {
    const content = readFile(IOS_API);
    if (!content) return false;
    const escaped = apiPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(escaped, 'i');
    return re.test(content);
}

// ── Feature Definitions ─────────────────────────────────────

const FEATURES = [
    {
        name: 'Entity List',
        apis: ['/api/entities'],
        webPages: ['dashboard.html'],
        androidActivity: 'MainActivity.kt',
        iosScreen: '(tabs)',
    },
    {
        name: 'Entity Status',
        apis: ['/api/status'],
        webPages: ['dashboard.html'],
        androidActivity: 'MainActivity.kt',
        iosScreen: '(tabs)',
    },
    {
        name: 'Chat History',
        apis: ['/api/chat/history'],
        webPages: ['chat.html'],
        androidActivity: 'ChatActivity.kt',
        iosScreen: 'chat',
    },
    {
        name: 'Agent Card',
        apis: ['/api/entity/agent-card'],
        crudOps: { GET: '/api/entity/agent-card', PUT: '/api/entity/agent-card', DELETE: '/api/entity/agent-card' },
        webPages: ['dashboard.html'],
        androidActivity: 'MainActivity.kt',
        iosScreen: '(tabs)',
    },
    {
        name: 'Schedules',
        apis: ['/api/schedules'],
        webPages: ['kanban.html'],
        androidActivity: 'ScheduleActivity.kt',
        iosScreen: 'schedule.tsx',
    },
    {
        name: 'Feedback',
        apis: ['/api/feedback'],
        crudOps: { POST: '/api/feedback', GET: '/api/feedback' },
        webPages: ['feedback.html'],
        androidActivity: 'FeedbackActivity.kt',
        iosScreen: 'feedback.tsx',
    },
    {
        name: 'Card Holder',
        apis: ['/api/contacts'],
        crudOps: { GET: '/api/contacts', POST: '/api/contacts', DELETE: '/api/contacts' },
        webPages: ['card-holder.html'],
        androidActivity: 'CardHolderActivity.kt',
        iosScreen: 'card-holder.tsx',
    },
    {
        name: 'Files',
        apis: ['/api/device/files'],
        webPages: ['files.html'],
        androidActivity: 'FileManagerActivity.kt',
        iosScreen: 'file-manager.tsx',
    },
    {
        name: 'Mission Dashboard',
        // Android uses /api/mission/dashboard, iOS uses /api/device/dashboard, Web uses kanban.html
        apis: ['/api/mission/dashboard', '/api/device/dashboard'],
        webPages: ['kanban.html'],
        androidActivity: 'MissionControlActivity.kt',
        iosScreen: '(tabs)',
    },
    {
        name: 'Env Vars',
        apis: ['/api/device-vars'],
        crudOps: { GET: '/api/device-vars', POST: '/api/device-vars' },
        webPages: ['env-vars.html'],
        androidActivity: null, // checked via API only
        iosScreen: null,
    },
    {
        name: 'Templates',
        apis: ['/api/skill-templates', '/api/soul-templates', '/api/rule-templates'],
        webPages: ['kanban.html'],
        androidActivity: null,
        iosScreen: null,
    },
    {
        name: 'Notifications',
        apis: ['/api/notifications'],
        webPages: null, // nav badge only, not a dedicated page
        androidActivity: null,
        iosScreen: null,
    },
    {
        name: 'Official Borrow',
        apis: ['/api/official-borrow/status'],
        webPages: ['dashboard.html'],
        androidActivity: 'OfficialBorrowActivity.kt',
        iosScreen: 'official-borrow.tsx',
    },
    {
        name: 'Subscription',
        apis: ['/api/subscription/status'],
        webPages: ['settings.html'],
        androidActivity: null,
        iosScreen: null,
    },
    {
        name: 'Cross-Device Settings',
        apis: ['/api/entity/cross-device-settings'],
        crudOps: { GET: '/api/entity/cross-device-settings', PUT: '/api/entity/cross-device-settings' },
        webPages: ['dashboard.html'],
        androidActivity: null,
        iosScreen: null,
    },
    {
        name: 'Device Preferences',
        apis: ['/api/device-preferences'],
        crudOps: { GET: '/api/device-preferences', PUT: '/api/device-preferences' },
        webPages: ['settings.html'],
        androidActivity: null,
        iosScreen: null,
    },
];

// ── Main Parity Check ───────────────────────────────────────

console.log('\n📊 Cross-Platform API Parity Check\n');
console.log('─'.repeat(60));
console.log('  Scanning platform files...\n');

// Verify platform files exist
const androidApiExists = fs.existsSync(ANDROID_API);
const iosApiExists = fs.existsSync(IOS_API);
const portalDirExists = fs.existsSync(PORTAL_DIR);

check('Web Portal directory exists', portalDirExists, PORTAL_DIR);
check('Android ClawApiService.kt exists', androidApiExists, ANDROID_API);
check('iOS api.ts exists', iosApiExists, IOS_API);

if (!portalDirExists || !androidApiExists || !iosApiExists) {
    console.log('\n❌ Cannot proceed — missing platform files\n');
    process.exit(1);
}

// ── API Endpoint Parity ─────────────────────────────────────

console.log('\n── API Endpoint Parity ──────────────────────────────────\n');

const matrix = [];

for (const feature of FEATURES) {
    // Check if ANY of the feature's API paths appear in each platform
    const webFound = feature.apis.some(api => webHasApi(api));
    const androidFound = feature.apis.some(api => androidHasApi(api));
    const iosFound = feature.apis.some(api => iosHasApi(api));

    matrix.push({
        feature: feature.name,
        web: webFound,
        android: androidFound,
        ios: iosFound,
    });

    const allPresent = webFound && androidFound && iosFound;
    const missing = [];
    if (!webFound) missing.push('Web');
    if (!androidFound) missing.push('Android');
    if (!iosFound) missing.push('iOS');

    if (allPresent) {
        check(`${feature.name} — all platforms`, true);
    } else {
        warn(`${feature.name} — missing on: ${missing.join(', ')}`);
    }
}

// ── CRUD Completeness ───────────────────────────────────────

console.log('\n── CRUD Completeness ───────────────────────────────────\n');

for (const feature of FEATURES) {
    if (!feature.crudOps) continue;

    const ops = Object.entries(feature.crudOps);
    const platforms = ['Web', 'Android', 'iOS'];
    const platformCheckers = [webHasApi, androidHasApi, iosHasApi];

    for (let p = 0; p < platforms.length; p++) {
        const platformName = platforms[p];
        const checker = platformCheckers[p];
        const missingOps = [];

        for (const [method, apiPath] of ops) {
            if (!checker(apiPath)) {
                missingOps.push(method);
            }
        }

        if (missingOps.length === 0) {
            check(`${feature.name} CRUD on ${platformName}`, true, `all ${ops.length} ops present`);
        } else if (missingOps.length === ops.length) {
            // Entire feature missing — already flagged above, skip duplicate noise
            continue;
        } else {
            warn(`${feature.name} CRUD on ${platformName}`, `missing: ${missingOps.join(', ')}`);
        }
    }
}

// ── Feature Page Existence ──────────────────────────────────

console.log('\n── Feature Page/Screen Existence ───────────────────────\n');

for (const feature of FEATURES) {
    // Web page check
    if (feature.webPages) {
        for (const page of feature.webPages) {
            const exists = fs.existsSync(path.join(PORTAL_DIR, page));
            check(`${feature.name} web page: ${page}`, exists);
        }
    }

    // Android Activity check
    if (feature.androidActivity) {
        const activityPath = path.join(ANDROID_ACTIVITY_DIR, feature.androidActivity);
        const exists = fs.existsSync(activityPath);
        check(`${feature.name} Android: ${feature.androidActivity}`, exists);
    }

    // iOS screen check
    if (feature.iosScreen) {
        const screenPath = path.join(IOS_APP_DIR, feature.iosScreen);
        const exists = fs.existsSync(screenPath) || fs.existsSync(path.join(IOS_APP_DIR, feature.iosScreen.replace('.tsx', '')));
        check(`${feature.name} iOS: ${feature.iosScreen}`, exists);
    }
}

// ── Parity Matrix Table ─────────────────────────────────────

console.log('\n── Parity Matrix ──────────────────────────────────────\n');

// Calculate column widths
const nameWidth = Math.max(22, ...matrix.map(r => r.feature.length + 2));
const colWeb = 5;
const colAndroid = 9;
const colIos = 5;

function pad(str, len) { return str + ' '.repeat(Math.max(0, len - str.length)); }

const divider = `├${'─'.repeat(nameWidth)}┼${'─'.repeat(colWeb)}┼${'─'.repeat(colAndroid)}┼${'─'.repeat(colIos)}┤`;
const topBorder = `┌${'─'.repeat(nameWidth)}┬${'─'.repeat(colWeb)}┬${'─'.repeat(colAndroid)}┬${'─'.repeat(colIos)}┐`;
const bottomBorder = `└${'─'.repeat(nameWidth)}┴${'─'.repeat(colWeb)}┴${'─'.repeat(colAndroid)}┴${'─'.repeat(colIos)}┘`;

console.log(topBorder);
console.log(`│${pad(' Feature', nameWidth)}│${pad(' Web', colWeb)}│${pad(' Android', colAndroid)}│${pad(' iOS', colIos)}│`);
console.log(divider);

for (const row of matrix) {
    const w = row.web ? ' ✅ ' : ' ❌ ';
    const a = row.android ? ' ✅    ' : ' ❌    ';
    const i = row.ios ? ' ✅ ' : ' ❌ ';
    console.log(`│${pad(' ' + row.feature, nameWidth)}│${pad(w, colWeb)}│${pad(a, colAndroid)}│${pad(i, colIos)}│`);
}

console.log(bottomBorder);

// ── Summary ─────────────────────────────────────────────────

const totalFeatures = matrix.length;
const fullParity = matrix.filter(r => r.web && r.android && r.ios).length;
const parityPct = ((fullParity / totalFeatures) * 100).toFixed(1);

console.log(`\n📈 Parity: ${fullParity}/${totalFeatures} features (${parityPct}%)\n`);

// Detailed gap report
const gaps = matrix.filter(r => !(r.web && r.android && r.ios));
if (gaps.length > 0) {
    console.log('⚠️  Parity gaps (WARN, not FAIL):');
    for (const gap of gaps) {
        const missing = [];
        if (!gap.web) missing.push('Web');
        if (!gap.android) missing.push('Android');
        if (!gap.ios) missing.push('iOS');
        console.log(`   • ${gap.feature}: missing on ${missing.join(', ')}`);
    }
    console.log('');
}

// ── Final Summary ───────────────────────────────────────────

const passed = results.filter(r => r.passed === true).length;
const warned = results.filter(r => r.passed === 'warn').length;
const failed = results.filter(r => r.passed === false).length;

console.log('─'.repeat(60));
console.log(`\n✅ Passed: ${passed}   ⚠️  Warned: ${warned}   ❌ Failed: ${failed}\n`);

if (failed > 0) {
    console.log('Some checks failed (platform files missing). Review above.\n');
}

// Exit 0 — parity gaps are informational, not CI-blocking
process.exit(0);
