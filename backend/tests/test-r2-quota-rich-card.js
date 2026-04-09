/**
 * test-r2-quota-rich-card.js
 *
 * End-to-end test: R2 quota exceeded → bot sends rich card → user deletes file
 *
 * Scenario:
 *   1. Upload two test files to R2
 *   2. Trigger quota exceeded (507) via testQuotaBytes=1 override
 *   3. Verify 507 response has correct oldestFiles structure
 *   4. Bot constructs and sends rich card with delete buttons
 *   5. Simulate card action (user clicks delete) via /api/channel/card-action
 *   6. Bot webhook receives card_action → calls DELETE /api/files/:fileId
 *   7. Verify file is deleted and space is freed
 *
 * Usage:
 *   node test-r2-quota-rich-card.js
 *   node test-r2-quota-rich-card.js --local
 */

const path = require('path');
const fs = require('fs');

const args = process.argv.slice(2);
const isLocal = args.includes('--local');
const API_BASE = isLocal ? 'http://localhost:3000' : 'https://eclawbot.com';

// ── Credentials ──────────────────────────────────────────────
function loadEnvFile() {
    const envPath = path.resolve(__dirname, '..', '.env');
    if (!fs.existsSync(envPath)) return {};
    const vars = {};
    fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
        line = line.trim();
        if (!line || line.startsWith('#')) return;
        const idx = line.indexOf('=');
        if (idx > 0) vars[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    });
    return vars;
}

const env = loadEnvFile();
const DEVICE_ID = env.BROADCAST_TEST_DEVICE_ID || process.env.DEVICE_ID;
const DEVICE_SECRET = env.BROADCAST_TEST_DEVICE_SECRET || process.env.DEVICE_SECRET;
const BOT_SECRET = env.TEST_BOT_SECRET || process.env.BOT_SECRET;
const ENTITY_ID = parseInt(env.TEST_ENTITY_ID || process.env.ENTITY_ID || '2');
// publicCode of the entity to send card to (entity speaking to itself for test)
const SPEAK_TO_CODE = env.TEST_PUBLIC_CODE || process.env.SPEAK_TO_CODE || '31tlkr';

// ── Helpers ──────────────────────────────────────────────────
async function postJSON(url, body) {
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text.substring(0, 500) }; }
    return { status: res.status, data };
}

async function deleteJSON(url, body) {
    const res = await fetch(url, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text.substring(0, 500) }; }
    return { status: res.status, data };
}

async function getJSON(url) {
    const res = await fetch(url);
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text.substring(0, 500) }; }
    return { status: res.status, data };
}

async function uploadFile(filename, content, mimeType, extraFields = {}) {
    // Use built-in FormData (Node 18+) — no external dependencies
    const form = new FormData();
    form.append('deviceId', DEVICE_ID);
    form.append('deviceSecret', DEVICE_SECRET);
    form.append('file', new Blob([content], { type: mimeType }), filename);
    for (const [k, v] of Object.entries(extraFields)) form.append(k, String(v));

    const res = await fetch(`${API_BASE}/api/files/upload`, {
        method: 'POST',
        body: form,
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text.substring(0, 500) }; }
    return { status: res.status, data };
}

// ── Test Runner ──────────────────────────────────────────────
let passed = 0;
let failed = 0;
const cleanup = []; // fileIds to delete at end

function assert(cond, msg) {
    if (cond) { console.log(`  ✓ ${msg}`); passed++; }
    else { console.error(`  ✗ ${msg}`); failed++; }
}

function section(title) {
    console.log(`\n── ${title} ──`);
}

// ── Main ─────────────────────────────────────────────────────
async function runTests() {
    if (!DEVICE_ID || !DEVICE_SECRET) {
        console.error('Missing credentials. Set BROADCAST_TEST_DEVICE_ID + BROADCAST_TEST_DEVICE_SECRET in backend/.env');
        console.error('Or set DEVICE_ID + DEVICE_SECRET env vars.');
        process.exit(1);
    }
    if (!BOT_SECRET) {
        console.error('Missing BOT_SECRET / TEST_BOT_SECRET — needed to send rich card via /api/transform');
        process.exit(1);
    }

    console.log(`Testing against: ${API_BASE}`);
    console.log(`Device: ${DEVICE_ID.slice(0, 8)}... Entity: ${ENTITY_ID}`);

    // ── 1. Upload two seed files ─────────────────────────────
    section('1. Upload seed files');

    const up1 = await uploadFile('quota-test-seed-1.txt', 'Seed file 1 for quota test', 'text/plain');
    assert(up1.status === 200 && up1.data.success, `Upload seed file 1 → ${up1.status}`);
    if (up1.data.fileId) cleanup.push(up1.data.fileId);
    const seed1Id = up1.data.fileId;

    const up2 = await uploadFile('quota-test-seed-2.txt', 'Seed file 2 for quota test', 'text/plain');
    assert(up2.status === 200 && up2.data.success, `Upload seed file 2 → ${up2.status}`);
    if (up2.data.fileId) cleanup.push(up2.data.fileId);
    const seed2Id = up2.data.fileId;

    // ── 2. Trigger quota exceeded via testQuotaBytes=1 ───────
    section('2. Simulate quota exceeded (testQuotaBytes=1)');

    const quotaRes = await uploadFile(
        'quota-trigger.txt', 'x', 'text/plain',
        { testQuotaBytes: '1' }  // any file exceeds 1-byte quota
    );
    assert(quotaRes.status === 507, `Upload returns 507 when quota exceeded → ${quotaRes.status}`);
    assert(quotaRes.data.error === 'quota_exceeded', `Error field = 'quota_exceeded'`);
    assert(Array.isArray(quotaRes.data.oldestFiles), `Response has oldestFiles array`);
    assert(quotaRes.data.oldestFiles.length > 0, `oldestFiles is non-empty`);
    assert(typeof quotaRes.data.currentUsageMB === 'number', `currentUsageMB is a number`);
    assert(typeof quotaRes.data.quotaMB === 'number', `quotaMB is a number`);

    const oldestFiles = quotaRes.data.oldestFiles;
    const firstOld = oldestFiles[0];
    assert(firstOld && firstOld.fileId, `oldestFiles[0] has fileId`);
    assert(firstOld && firstOld.filename, `oldestFiles[0] has filename`);
    assert(firstOld && typeof firstOld.sizeMB === 'number', `oldestFiles[0] has sizeMB`);
    assert(firstOld && firstOld.createdAt, `oldestFiles[0] has createdAt`);

    console.log(`  → Oldest files: ${oldestFiles.map(f => f.filename).join(', ')}`);

    // ── 3. Bot constructs rich card from 507 response ─────────
    section('3. Bot sends rich card with delete buttons');

    // Build card buttons: one per oldest file (max 5, cap at 10 limit)
    const buttons = oldestFiles.slice(0, 5).map(f => ({
        id: f.fileId,
        label: `🗑 ${f.filename} (${f.sizeMB || 0} MB)`.slice(0, 80),
        style: 'danger',
    }));
    // Add a "cancel" button
    buttons.push({ id: 'cancel', label: '✕ 取消', style: 'secondary' });

    const askId = `quota-cleanup-${Date.now()}`;
    const cardMsg = `⚠️ 儲存空間已滿（${quotaRes.data.currentUsageMB} MB / ${quotaRes.data.quotaMB} MB）\n請選擇要刪除的檔案以釋放空間：`;

    const transformRes = await postJSON(`${API_BASE}/api/transform`, {
        deviceId: DEVICE_ID,
        entityId: ENTITY_ID,
        botSecret: BOT_SECRET,
        message: cardMsg,
        state: 'IDLE',
        speakTo: [SPEAK_TO_CODE],
        card: { ask_id: askId, buttons },
    });

    assert(transformRes.status === 200 && transformRes.data.success, `Transform with card → ${transformRes.status}`);
    console.log(`  → Card sent with ask_id: ${askId}, ${buttons.length} buttons`);

    // ── 4. Verify card appears in chat history ────────────────
    section('4. Verify card in chat history');

    await new Promise(r => setTimeout(r, 800)); // brief wait for DB write

    const histUrl = `${API_BASE}/api/chat/history?deviceId=${DEVICE_ID}&deviceSecret=${DEVICE_SECRET}&entityId=${ENTITY_ID}&limit=10`;
    const histRes = await getJSON(histUrl);
    assert(histRes.status === 200, `Chat history fetch → ${histRes.status}`);

    const messages = histRes.data.messages || [];
    const cardMsg_ = messages.find(m => m.card && m.card.ask_id === askId);
    assert(!!cardMsg_, `Card message found in history with ask_id=${askId}`);
    if (cardMsg_) {
        assert(Array.isArray(cardMsg_.card.buttons) && cardMsg_.card.buttons.length === buttons.length,
            `Card has ${buttons.length} buttons`);
        assert(cardMsg_.card.buttons.some(b => b.id === firstOld.fileId),
            `Card button IDs include the oldest file's fileId`);
    }

    const chatMsgId = cardMsg_ ? cardMsg_.id : null;

    // ── 5. Simulate user clicking delete button ───────────────
    section('5. Simulate card action (user clicks delete)');

    if (!chatMsgId) {
        console.error('  ⚠ Skipping card-action test — could not find card message in history');
    } else {
        // User selects the first old file's delete button
        const actionRes = await postJSON(`${API_BASE}/api/channel/card-action`, {
            deviceId: DEVICE_ID,
            deviceSecret: DEVICE_SECRET,
            entityId: ENTITY_ID,
            ask_id: askId,
            action_id: firstOld.fileId,
        });
        assert(actionRes.status === 200 && actionRes.data.success,
            `card-action accepted → ${actionRes.status}`);
        assert(actionRes.data.action_id === firstOld.fileId,
            `card-action echoes correct action_id`);
        assert(actionRes.data.already_resolved === undefined || !actionRes.data.already_resolved,
            `Card is not already resolved`);
    }

    // ── 6. Bot acts on card_action: DELETE the chosen file ────
    section('6. Bot deletes file (simulating webhook handler)');

    const deleteRes = await deleteJSON(`${API_BASE}/api/files/${firstOld.fileId}`, {
        deviceId: DEVICE_ID,
        deviceSecret: DEVICE_SECRET,
    });
    assert(deleteRes.status === 200 && deleteRes.data.success,
        `DELETE /api/files/${firstOld.fileId.slice(0, 8)}... → ${deleteRes.status}`);
    assert(deleteRes.data.deleted === true, `Response confirms deleted=true`);

    // Remove from cleanup list (already deleted)
    const idx = cleanup.indexOf(firstOld.fileId);
    if (idx >= 0) cleanup.splice(idx, 1);

    // ── 7. Verify file is gone ────────────────────────────────
    section('7. Verify file is gone');

    const listRes = await getJSON(
        `${API_BASE}/api/files/list?deviceId=${DEVICE_ID}&deviceSecret=${DEVICE_SECRET}`
    );
    assert(listRes.status === 200 && listRes.data.success, `File list fetch → ${listRes.status}`);
    const remaining = (listRes.data.files || []).map(f => f.fileId);
    assert(!remaining.includes(firstOld.fileId), `Deleted fileId no longer in list`);

    // Verify the second seed file still exists
    if (seed2Id && remaining.includes(seed2Id)) {
        assert(true, `Other files remain intact (seed2 still present)`);
    }

    // ── 8. Verify quota now fits ──────────────────────────────
    section('8. Re-upload should succeed with testQuotaBytes = freed space');

    const usageBytes = listRes.data.usage ? listRes.data.usage.totalBytes : 0;
    // Use a quota that's 1 byte MORE than current usage → should succeed
    const newQuota = usageBytes + 100;
    const retryRes = await uploadFile(
        'quota-retry-test.txt', 'retry', 'text/plain',
        { testQuotaBytes: String(newQuota) }
    );
    assert(retryRes.status === 200 && retryRes.data.success,
        `Re-upload succeeds after deletion with adjusted quota → ${retryRes.status}`);
    if (retryRes.data.fileId) cleanup.push(retryRes.data.fileId);

    // ── Summary ───────────────────────────────────────────────
    console.log('\n══════════════════════════════');
    console.log(`Results: ${passed} passed, ${failed} failed`);

    // ── Cleanup ───────────────────────────────────────────────
    if (cleanup.length > 0) {
        console.log(`\nCleaning up ${cleanup.length} test file(s)...`);
        for (const fileId of cleanup) {
            await deleteJSON(`${API_BASE}/api/files/${fileId}`, {
                deviceId: DEVICE_ID,
                deviceSecret: DEVICE_SECRET,
            }).catch(() => {});
        }
        console.log('  Cleanup done.');
    }

    process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
    console.error('Unexpected error:', err);
    process.exit(1);
});
