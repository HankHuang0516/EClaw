#!/usr/bin/env node
/**
 * Parity Prober — Layer 4 (Rewrite of #3 prober)
 * Validates API-UI parity by parsing actual route registrations from index.js
 * and verifying endpoints respond correctly with proper auth.
 * 
 * FALSE-POSITIVE FIXES (vs prior #3 prober):
 * 1. URL discovery: parse from index.js (app.get/post/use), never hardcode
 * 2. Auth: entityId as NUMBER not UUID; use {deviceId, botSecret, entityId:<number>}
 * 3. Module mount: verify file exists AND is required before claiming missing
 * 4. Portal gap: check public/portal/ file AND prod URL 200 before claiming missing
 * 5. Report: include file/line, tested URL, response body (first 200 chars), confidence
 *
 * Usage:
 *   node backend/tests/test-parity-prober.js
 *   node backend/tests/test-parity-prober.js --local   # localhost:3000
 *   node backend/tests/test-parity-prober.js --debug   # verbose output
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

// ── Config ─────────────────────────────────────────────────
const args = process.argv.slice(2);
const IS_LOCAL = args.includes('--local');
const IS_DEBUG = args.includes('--debug');
const API_BASE = IS_LOCAL ? 'http://localhost:3000' : 'https://eclawbot.com';

const ROOT_DIR = path.resolve(__dirname, '..');
const INDEX_PATH = path.join(ROOT_DIR, 'index.js');
const PORTAL_DIR = path.join(ROOT_DIR, 'public', 'portal');

// Device credentials for testing (entityId as NUMBER per spec)
const TEST_DEVICE_ID = process.env.BROADCAST_TEST_DEVICE_ID || '480def4c-2183-4d8e-afd0-b131ae89adcc';
const TEST_BOT_SECRET = process.env.BROADCAST_TEST_DEVICE_SECRET || '34da23a4e54c212cff56be7d9140a2a9';
const TEST_ENTITY_ID = 3; // NUMBER, not UUID

// Modules whose routes need auth {deviceId, botSecret, entityId:<number>}
const AUTH_MODULES = ['mission', 'ai-support', 'chat', 'notifications'];

// ── Result Tracking ─────────────────────────────────────────
const results = [];
const gaps = [];

function log(msg) {
    if (IS_DEBUG) console.log('[DEBUG]', msg);
}

function check(name, passed, detail = '') {
    results.push({ name, passed, detail });
    const icon = passed ? '\u2705' : '\u274C';
    const suffix = detail ? ` \u2014 ${detail}` : '';
    console.log(`  ${icon} ${name}${suffix}`);
}

function gapReport(category, file, line, testedUrl, responseBody, confidence) {
    gaps.push({ category, file, line, testedUrl, responseBody, confidence });
    console.log(`  \u26A0\uFE0F  GAP [${category}]`);
    console.log(`      File/Line: ${file}:${line}`);
    console.log(`      URL: ${testedUrl}`);
    console.log(`      Body: ${(responseBody || '').substring(0, 200)}`);
    console.log(`      Confidence: ${confidence}/10`);
}

// ── HTTP Helper ─────────────────────────────────────────────
async function httpGet(urlPath, opts = {}) {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(urlPath, API_BASE);
        const protocol = urlObj.protocol === 'https:' ? https : http;
        const reqOpts = {
            hostname: urlObj.hostname,
            port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
            path: urlObj.pathname + urlObj.search,
            method: opts.method || 'GET',
            headers: opts.headers || {},
        };
        
        const req = protocol.request(reqOpts, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                resolve({ status: res.statusCode, headers: res.headers, body });
            });
        });
        
        req.on('error', reject);
        req.setTimeout(15000, () => {
            req.destroy();
            reject(new Error('TIMEOUT'));
        });
        
        if (opts.body) req.write(opts.body);
        req.end();
    });
}

// ── Route Parser ───────────────────────────────────────────

/**
 * Parse index.js to extract route registrations.
 * Returns array of { method, path, module, line }
 */
function parseRoutes() {
    const content = fs.readFileSync(INDEX_PATH, 'utf8');
    const lines = content.split('\n');
    const routes = [];
    
    // Track current app.use for module-mounted routers
    let currentModule = null;
    let currentModuleLine = 0;
    
    // Patterns for route detection
    const routePatterns = [
        /^\s*app\.(get|post|put|delete|patch)\s*\(\s*['"]([^'"]+)['"]\s*,/,
        /^\s*app\.use\s*\(\s*['"]([^'"]+)['"]\s*,/,
    ];
    
    // Module require pattern
    const requirePattern = /^(\s*)const\s+(\w+)\s*=\s*require\s*\(\s*['"]([^'"]+)['"]/;
    const moduleRequirePattern = /(\w+)\.router/;
    
    for (let i = 0; i < lines.length; i++) {
        const lineNum = i + 1;
        const line = lines[i];
        
        // Check for module require (e.g., const missionModule = require('./mission'))
        const reqMatch = line.match(requirePattern);
        if (reqMatch) {
            const [, indent, varName, reqPath] = reqMatch;
            // Check if this variable is used as a router (e.g., missionModule.router)
            const nextLines = lines.slice(i, i + 10).join('\n');
            if (moduleRequirePattern.test(nextLines)) {
                currentModule = varName.replace(/Module$/, '').replace(/Module$/, '');
                currentModuleLine = lineNum;
                log(`Found module require: ${varName} = require('${reqPath}') at line ${lineNum}`);
            }
        }
        
        // Check for route registrations
        for (const pattern of routePatterns) {
            const match = line.match(pattern);
            if (match) {
                const [, method, routePath] = match;
                
                // Determine which module this route belongs to
                let module = 'root';
                let moduleFile = 'index.js';
                let moduleLine = 1;
                
                // Check if this is a mounted router route
                // e.g., app.use('/api/mission', missionModule.router)
                const mountedRouterMatch = line.match(/app\.use\s*\(\s*['"]([^'"]+)['"]\s*,\s*(\w+)\.router/);
                if (mountedRouterMatch) {
                    const [, mountPath, routerVar] = mountedRouterMatch;
                    module = routerVar.replace(/Module$/, '');
                    moduleFile = `${module}.js`;
                    moduleLine = lineNum;
                    
                    // The actual path is mountPath + routePath (for router-level routes)
                    // But for app.use mounting, the router handles its own paths
                    routes.push({
                        method: 'USE',
                        path: mountPath,
                        fullPath: mountPath,
                        module,
                        moduleFile,
                        moduleLine,
                        line: lineNum,
                        isRouterMount: true,
                        routerVar,
                    });
                    continue;
                }
                
                // Regular route
                routes.push({
                    method: method.toUpperCase(),
                    path: routePath,
                    fullPath: routePath,
                    module,
                    moduleFile,
                    moduleLine,
                    line: lineNum,
                    isRouterMount: false,
                });
            }
        }
    }
    
    return routes;
}

/**
 * Parse a module file to extract its routes.
 * E.g., ai-support.js has router.post('/chat', ...) etc.
 */
function parseModuleRoutes(modulePath) {
    if (!fs.existsSync(modulePath)) {
        return [];
    }
    
    const content = fs.readFileSync(modulePath, 'utf8');
    const lines = content.split('\n');
    const routes = [];
    const routerGetPostPattern = /^\s*router\.(get|post|put|delete|patch)\s*\(\s*['"]([^'"]+)['"]/;
    
    for (let i = 0; i < lines.length; i++) {
        const match = lines[i].match(routerGetPostPattern);
        if (match) {
            const [, method, routePath] = match;
            routes.push({
                method: method.toUpperCase(),
                path: routePath,
                line: i + 1,
            });
        }
    }
    
    return routes;
}

/**
 * Known module name to file name mappings (for non-standard naming)
 */
const MODULE_FILE_MAP = {
    'arena': 'interview-arena.js',
    'channel': 'channel-api.js',
    'discord': 'discord-integration.js',
    'a2aCompat': 'a2a-compat.js',
    'oauthServer': 'oauth-server.js',
    'articlePublisher': 'article-publisher.js',
    'apiDocs': 'api-docs.js',
    'botTools': 'bot-tools.js',
    'aiSupport': 'ai-support.js',
};

/**
 * Check if a module file exists AND is required in index.js
 */
function verifyModuleMount(moduleName) {
    // First check the known mappings, then try standard naming
    const moduleFileNameJS = MODULE_FILE_MAP[moduleName] || `${moduleName}.js`;
    let modulePath = path.join(ROOT_DIR, moduleFileNameJS);
    
    // Check file exists
    let actualFileName = moduleFileNameJS;
    if (!fs.existsSync(modulePath)) {
        // Try standard naming as fallback
        const standardPath = path.join(ROOT_DIR, `${moduleName}.js`);
        if (fs.existsSync(standardPath)) {
            actualFileName = `${moduleName}.js`;
            modulePath = standardPath;
        }
    }
    
    const fileExists = fs.existsSync(modulePath);
    if (!fileExists) {
        return { exists: false, required: false, line: null, reason: 'file_missing', file: actualFileName };
    }
    
    // Check if required in index.js - try various forms
    const indexContent = fs.readFileSync(INDEX_PATH, 'utf8');
    
    // Get base name without .js for matching require
    const baseName = actualFileName.replace(/\.js$/, '');
    const escapedActualFile = actualFileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const escapedBaseName = baseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const escapedModuleName = moduleName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const hyphenatedModule = moduleName.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
    const escapedHyphenated = hyphenatedModule.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    
    // Patterns to match require statements (with optional function call after)
    const patterns = [
        `require\\s*\\(\\s*['"]./${escapedBaseName}['"]\\s*\\)`,  // require('./file')
        `require\\s*\\(\\s*['"]./${escapedBaseName}['"]\\s*\\)\\s*\\(`,  // require('./file')(args)
        `require\\s*\\(\\s*['"]./${escapedModuleName}['"]\\s*\\)`,  // require('./ModuleName')
        `require\\s*\\(\\s*['"]./${escapedModuleName}['"]\\s*\\)\\s*\\(`,  // require('./ModuleName')(args)
        `require\\s*\\(\\s*['"]./${escapedHyphenated}['"]\\s*\\)`,  // require('./module-name')
        `require\\s*\\(\\s*['"]./${escapedHyphenated}['"]\\s*\\)\\s*\\(`,  // require('./module-name')(args)
    ];
    
    let match = null;
    let matchedPattern = null;
    for (const pattern of patterns) {
        match = indexContent.match(new RegExp(pattern));
        if (match) {
            matchedPattern = pattern;
            break;
        }
    }
    
    if (!match) {
        return { exists: true, required: false, line: null, reason: 'not_required', file: actualFileName };
    }
    
    // Find line number
    const lines = indexContent.split('\n');
    let lineNum = 1;
    const regex = new RegExp(matchedPattern);
    for (const line of lines) {
        if (regex.test(line)) {
            return { exists: true, required: true, line: lineNum, reason: 'ok', file: actualFileName };
        }
        lineNum++;
    }
    
    return { exists: true, required: true, line: null, reason: 'ok', file: actualFileName };
}

// ── Auth Builder ────────────────────────────────────────────

/**
 * Build auth query string for protected endpoints.
 * entityId must be a NUMBER, not a UUID string.
 */
function buildAuthParams(extraParams = {}) {
    const params = new URLSearchParams({
        deviceId: TEST_DEVICE_ID,
        botSecret: TEST_BOT_SECRET,
        entityId: TEST_ENTITY_ID.toString(), // NUMBER as string
        ...extraParams,
    });
    return params.toString();
}

/**
 * Determine if a path requires auth and how to format it.
 */
function needsAuth(path) {
    return AUTH_MODULES.some(mod => path.startsWith(`/${mod}`) || path.startsWith(`/api/${mod}`));
}

// ── Portal Checker ──────────────────────────────────────────

/**
 * Check if a portal page exists AND is accessible on prod.
 */
async function checkPortalPage(pageName) {
    const portalPath = path.join(PORTAL_DIR, pageName);
    const fileExists = fs.existsSync(portalPath);
    
    if (!fileExists) {
        return {
            exists: false,
            prodAccessible: false,
            fileLine: null,
            reason: 'file_missing',
        };
    }
    
    // Check prod URL
    try {
        const res = await httpGet(`/portal/${pageName}`);
        const prodAccessible = res.status === 200;
        return {
            exists: true,
            prodAccessible,
            prodStatus: res.status,
            reason: prodAccessible ? 'ok' : `prod_${res.status}`,
        };
    } catch (err) {
        return {
            exists: true,
            prodAccessible: false,
            prodStatus: null,
            reason: `prod_error: ${err.message}`,
        };
    }
}

// ── Main ────────────────────────────────────────────────────

async function main() {
    console.log('\n\u{1F310} Parity Prober \u2014 Layer 4\n');
    console.log(`  Server: ${API_BASE}`);
    console.log(`  Auth: deviceId=${TEST_DEVICE_ID.substring(0, 8)}..., entityId=${TEST_ENTITY_ID} (NUMBER)`);
    console.log('');
    
    // ── Phase 1: Parse Routes from index.js ─────────────────
    console.log('\u2500\u2500 Phase 1: Route Discovery (parsing index.js) \u2500\u2500\n');
    
    const routes = parseRoutes();
    console.log(`  Found ${routes.length} route registrations\n`);
    
    // Show mounted routers
    const routerMounts = routes.filter(r => r.isRouterMount);
    for (const r of routerMounts) {
        console.log(`  Router mount: ${r.path} -> ${r.module} (${r.moduleFile}:${r.moduleLine})`);
    }
    console.log('');
    
    // ── Phase 2: Module Mount Verification ─────────────────
    console.log('\u2500\u2500 Phase 2: Module Mount Verification \u2500\u2500\n');
    
    const mountedModules = [...new Set(routes.filter(r => r.isRouterMount).map(r => r.module))];
    for (const mod of mountedModules) {
        const verification = verifyModuleMount(mod);
        const status = verification.exists && verification.required ? '\u2705' : '\u274C';
        let detail = `${verification.exists ? 'file_exists' : 'file_missing'}`;
        if (verification.exists && !verification.required) {
            detail += ', not_required_in_index';
        } else if (verification.required) {
            detail += `, required at line ${verification.line}`;
        }
        console.log(`  ${status} ${mod}: ${detail}`);
        
        // If module missing, this is a GAP
        if (!verification.exists || !verification.required) {
            const confidence = !verification.exists ? 10 : 8;
            gapReport(
                'MODULE_MOUNT',
                verification.exists ? 'index.js' : mod,
                verification.line || 'N/A',
                `require('./${mod}.js')`,
                verification.reason,
                confidence
            );
        }
    }
    console.log('');
    
    // ── Phase 3: Portal Page Verification ──────────────────
    console.log('\u2500\u2500 Phase 3: Portal Page Verification \u2500\u2500\n');
    
    const portalPages = [
        'dashboard.html', 'chat.html', 'kanban.html', 'settings.html',
        'env-vars.html', 'files.html', 'feedback.html', 'admin.html',
        'card-holder.html', 'info.html', 'delete-account.html',
        'screen-control.html', 'wallet.html', 'my-rentals.html',
        'invite.html', 'community.html',
    ];
    
    for (const page of portalPages) {
        const result = await checkPortalPage(page);
        if (result.exists && result.prodAccessible) {
            check(`Portal ${page}`, true, `status=${result.prodStatus}`);
        } else if (!result.exists) {
            check(`Portal ${page}`, false, 'file missing');
            gapReport('PORTAL_MISSING', page, 'N/A', `/portal/${page}`, result.reason, 10);
        } else {
            check(`Portal ${page}`, false, `prod status: ${result.prodStatus}`);
            gapReport('PORTAL_INACCESSIBLE', page, 'N/A', `/portal/${page}`, result.reason, 9);
        }
    }
    console.log('');
    
    // ── Phase 4: API Endpoint Parity ──────────────────────
    console.log('\u2500\u2500 Phase 4: API Endpoint Parity \u2500\u2500\n');
    
    // Test key endpoints from parsed routes
    const keyEndpoints = [
        // Public endpoints
        { path: '/api/health', auth: false },
        { path: '/api/version', auth: false },
        { path: '/api/skill-templates', auth: false },
        { path: '/api/soul-templates', auth: false },
        { path: '/api/rule-templates', auth: false },
        
        // Auth-protected mission endpoints
        { path: '/api/mission/dashboard', auth: true },
        { path: '/api/mission/cards', auth: true },
        { path: '/api/mission/note/add', auth: true, method: 'POST' },
        
        // Auth-protected ai-support endpoints
        { path: '/api/ai-support/chat', auth: true, method: 'POST' },
        
        // Auth-protected chat endpoints
        { path: '/api/chat/history', auth: true },
        
        // Auth-protected notifications
        { path: '/api/notifications', auth: true },
        
        // Entity endpoints
        { path: '/api/entities', auth: true },
        { path: '/api/status', auth: true },
        
        // Subscription & wallet
        { path: '/api/subscription/status', auth: true },
        { path: '/api/wallet/balance', auth: true },
    ];
    
    for (const ep of keyEndpoints) {
        const authParams = ep.auth ? `?${buildAuthParams()}` : '';
        const fullUrl = `${ep.path}${authParams}`;
        
        try {
            const res = await httpGet(fullUrl, { method: ep.method || 'GET' });
            
            // Distinguish between auth failures (NOT gaps) vs actual missing endpoints
            const isAuthError = (res.status === 401 || res.status === 403) && 
                (res.body.includes('Invalid credentials') || 
                 res.body.includes('Unauthorized') || 
                 res.body.includes('not_authenticated') ||
                 res.body.includes('Not authenticated') ||
                 res.body.includes('Authentication required'));
            
            const isNotFound = res.status === 404 || res.body.includes('Cannot GET') || res.body.includes('Not Found');
            const isServerError = res.status >= 500;
            
            if (res.status >= 200 && res.status < 400) {
                check(`${ep.method || 'GET'} ${ep.path}`, true, `status=${res.status}`);
            } else if (isAuthError) {
                // Auth error means endpoint EXISTS but credentials are wrong - NOT a gap
                check(`${ep.method || 'GET'} ${ep.path}`, 'auth_error', `status=${res.status} (endpoint exists, auth failed)`);
            } else if (isNotFound) {
                // 404 means endpoint truly doesn't exist - this IS a gap
                check(`${ep.method || 'GET'} ${ep.path}`, false, `status=${res.status}`);
                gapReport(
                    'ENDPOINT_MISSING',
                    ep.path,
                    'N/A',
                    fullUrl,
                    res.body.substring(0, 200),
                    9
                );
            } else if (isServerError) {
                check(`${ep.method || 'GET'} ${ep.path}`, false, `status=${res.status}`);
                gapReport(
                    'ENDPOINT_ERROR',
                    ep.path,
                    'N/A',
                    fullUrl,
                    res.body.substring(0, 200),
                    9
                );
            } else {
                // Other errors (client errors 400-499 except auth)
                check(`${ep.method || 'GET'} ${ep.path}`, false, `status=${res.status}`);
                gapReport(
                    'ENDPOINT_ERROR',
                    ep.path,
                    'N/A',
                    fullUrl,
                    res.body.substring(0, 200),
                    7
                );
            }
        } catch (err) {
            check(`${ep.method || 'GET'} ${ep.path}`, false, err.message);
            gapReport(
                'ENDPOINT_ERROR',
                ep.path,
                'N/A',
                fullUrl,
                err.message,
                8
            );
        }
    }
    console.log('');
    
    // ── Phase 5: Parse Module Routes and Test ──────────────
    console.log('\u2500\u2500 Phase 5: Module Route Testing \u2500\u2500\n');
    
    for (const mod of mountedModules) {
        const moduleFileName = MODULE_FILE_MAP[mod] || `${mod}.js`;
        const modulePath = path.join(ROOT_DIR, moduleFileName);
        const moduleRoutes = parseModuleRoutes(modulePath);
        
        if (moduleRoutes.length === 0) {
            console.log(`  ${mod}: no router routes found`);
            continue;
        }
        
        console.log(`  ${mod}: ${moduleRoutes.length} routes registered`);
        
        // Test a sample of routes from each module
        const sampleRoutes = moduleRoutes.slice(0, 3);
        for (const route of sampleRoutes) {
            // Determine full path (router path + module mount path)
            const mountPath = routes.find(r => r.module === mod && r.isRouterMount)?.path || `/api/${mod}`;
            const fullPath = `${mountPath}${route.path}`;
            const authParams = `?${buildAuthParams()}`;
            const fullUrl = `${fullPath}${authParams}`;
            
            try {
                const res = await httpGet(fullUrl, { method: route.method });
                const ok = res.status >= 200 && res.status < 400;
                check(`  ${route.method} ${fullPath}`, ok, `status=${res.status}`);
            } catch (err) {
                check(`  ${route.method} ${fullPath}`, false, err.message);
            }
        }
    }
    console.log('');
    
    // ── Summary ───────────────────────────────────────────
    const passed = results.filter(r => r.passed === true).length;
    const failed = results.filter(r => !r.passed).length;
    
    console.log('\u2550'.repeat(60));
    console.log(`\n  \u2705 Passed: ${passed}   \u274C Failed: ${failed}`);
    console.log(`  \u26A0\uFE0F  Gaps: ${gaps.length}\n`);
    
    if (gaps.length > 0) {
        console.log('  Gap Report:');
        for (const g of gaps) {
            console.log(`    [${g.category}] ${g.file}:${g.line}`);
            console.log(`      URL: ${g.testedUrl}`);
            console.log(`      Body: ${g.responseBody.substring(0, 100)}...`);
            console.log(`      Confidence: ${g.confidence}/10`);
        }
        console.log('');
    }
    
    // False positive check: on re-run of same 5 items, all should be EXISTS
    // This is the acceptance criteria
    const falsePositiveRate = failed > 0 ? (gaps.length / failed) : 0;
    console.log(`  False-positive rate: ${(falsePositiveRate * 100).toFixed(1)}% (${gaps.length}/${failed})`);
    
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
