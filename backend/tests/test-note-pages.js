#!/usr/bin/env node
/**
 * Note Pages (Webview static pages) regression test
 *
 * Tests: PUT/GET/DELETE /api/mission/note/page, GET /note/pages, PUT /note/page/drawing
 * Credentials: BROADCAST_TEST_DEVICE_ID + BROADCAST_TEST_DEVICE_SECRET from .env
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const BASE = process.env.TEST_BASE_URL || 'https://eclawbot.com';
const DEVICE_ID = process.env.BROADCAST_TEST_DEVICE_ID;
const DEVICE_SECRET = process.env.BROADCAST_TEST_DEVICE_SECRET;

if (!DEVICE_ID || !DEVICE_SECRET) {
    console.error('Missing BROADCAST_TEST_DEVICE_ID or BROADCAST_TEST_DEVICE_SECRET in .env');
    process.exit(1);
}

let passed = 0;
let failed = 0;

function assert(condition, msg) {
    if (condition) {
        passed++;
        console.log(`  ✓ ${msg}`);
    } else {
        failed++;
        console.error(`  ✗ ${msg}`);
    }
}

async function api(method, path, body) {
    const url = `${BASE}${path}`;
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(url, opts);
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
}

async function run() {
    console.log('Note Pages (Webview) regression test');
    console.log(`Base: ${BASE}, Device: ${DEVICE_ID}\n`);

    // First, create a test note via the existing note/add API
    console.log('0. Setup — create test note');
    const noteTitle = `_test_page_${Date.now()}`;
    const addRes = await api('POST', '/api/mission/note/add', {
        deviceId: DEVICE_ID,
        deviceSecret: DEVICE_SECRET,
        title: noteTitle,
        content: 'Test note for webview page'
    });
    assert(addRes.status === 200, `Note created: ${addRes.data.message || addRes.status}`);
    const noteId = addRes.data.item?.id;
    assert(!!noteId, `Got noteId: ${noteId}`);

    if (!noteId) {
        console.log('\nCannot continue without noteId. Aborting.');
        process.exit(1);
    }

    // 1. PUT /api/mission/note/page — create page
    console.log('\n1. Create note page');
    const htmlContent = '<html><body><h1>Test Page</h1><p>Hello from bot!</p></body></html>';
    const createRes = await api('PUT', '/api/mission/note/page', {
        deviceId: DEVICE_ID,
        deviceSecret: DEVICE_SECRET,
        noteId,
        htmlContent
    });
    assert(createRes.status === 200, `PUT /note/page → ${createRes.status}`);
    assert(createRes.data.success === true, 'success: true');

    // 2. GET /api/mission/note/page — read page
    console.log('\n2. Read note page');
    const readRes = await api('GET', `/api/mission/note/page?deviceId=${DEVICE_ID}&deviceSecret=${DEVICE_SECRET}&noteId=${noteId}`);
    assert(readRes.status === 200, `GET /note/page → ${readRes.status}`);
    assert(readRes.data.htmlContent === htmlContent, 'htmlContent matches');
    assert(readRes.data.drawingData === null, 'drawingData is null initially');

    // 3. GET /api/mission/note/pages — list pages
    console.log('\n3. List note pages');
    const listRes = await api('GET', `/api/mission/note/pages?deviceId=${DEVICE_ID}&deviceSecret=${DEVICE_SECRET}`);
    assert(listRes.status === 200, `GET /note/pages → ${listRes.status}`);
    assert(Array.isArray(listRes.data.pages), 'pages is array');
    const found = listRes.data.pages.find(p => p.noteId === noteId);
    assert(!!found, `Found noteId ${noteId} in pages list`);

    // 4. PUT /api/mission/note/page — update page
    console.log('\n4. Update note page');
    const updatedHtml = '<html><body><h1>Updated</h1></body></html>';
    const updateRes = await api('PUT', '/api/mission/note/page', {
        deviceId: DEVICE_ID,
        deviceSecret: DEVICE_SECRET,
        noteId,
        htmlContent: updatedHtml
    });
    assert(updateRes.status === 200, `PUT /note/page (update) → ${updateRes.status}`);

    // 5. PUT /api/mission/note/page/drawing — save drawing
    console.log('\n5. Save drawing');
    const drawingData = [{ color: '#ff0000', size: 3, eraser: false, points: [{ x: 10, y: 20 }, { x: 30, y: 40 }] }];
    const drawRes = await api('PUT', '/api/mission/note/page/drawing', {
        deviceId: DEVICE_ID,
        deviceSecret: DEVICE_SECRET,
        noteId,
        drawingData
    });
    assert(drawRes.status === 200, `PUT /note/page/drawing → ${drawRes.status}`);
    assert(drawRes.data.success === true, 'Drawing saved');

    // 6. Verify drawing persisted
    console.log('\n6. Verify drawing persisted');
    const readRes2 = await api('GET', `/api/mission/note/page?deviceId=${DEVICE_ID}&deviceSecret=${DEVICE_SECRET}&noteId=${noteId}`);
    assert(readRes2.status === 200, `GET /note/page → ${readRes2.status}`);
    assert(readRes2.data.drawingData != null, 'drawingData is not null');

    // 7. PUT by title
    console.log('\n7. Create page by title');
    const byTitleRes = await api('PUT', '/api/mission/note/page', {
        deviceId: DEVICE_ID,
        deviceSecret: DEVICE_SECRET,
        title: noteTitle,
        htmlContent: '<p>By title</p>'
    });
    assert(byTitleRes.status === 200, `PUT /note/page by title → ${byTitleRes.status}`);

    // 8. Validation — missing noteId/title
    console.log('\n8. Validation');
    const noIdRes = await api('PUT', '/api/mission/note/page', {
        deviceId: DEVICE_ID,
        deviceSecret: DEVICE_SECRET,
        htmlContent: 'test'
    });
    assert(noIdRes.status === 400, `Missing noteId → 400: ${noIdRes.status}`);

    // 9. Drawing on nonexistent page
    console.log('\n9. Drawing on nonexistent page');
    const drawNoPageRes = await api('PUT', '/api/mission/note/page/drawing', {
        deviceId: DEVICE_ID,
        deviceSecret: DEVICE_SECRET,
        noteId: 'nonexistent-id',
        drawingData: []
    });
    assert(drawNoPageRes.status === 404, `Drawing on missing page → 404: ${drawNoPageRes.status}`);

    // 10. DELETE /api/mission/note/page
    console.log('\n10. Delete note page');
    const delRes = await api('DELETE', '/api/mission/note/page', {
        deviceId: DEVICE_ID,
        deviceSecret: DEVICE_SECRET,
        noteId
    });
    assert(delRes.status === 200, `DELETE /note/page → ${delRes.status}`);

    // 11. Verify deletion
    console.log('\n11. Verify page deleted');
    const readDel = await api('GET', `/api/mission/note/page?deviceId=${DEVICE_ID}&deviceSecret=${DEVICE_SECRET}&noteId=${noteId}`);
    assert(readDel.status === 404, `GET after delete → 404: ${readDel.status}`);

    // Cleanup — delete test note
    console.log('\n12. Cleanup — delete test note');
    await api('POST', '/api/mission/note/delete', {
        deviceId: DEVICE_ID,
        deviceSecret: DEVICE_SECRET,
        title: noteTitle
    });

    // Summary
    console.log(`\n${'='.repeat(40)}`);
    console.log(`Passed: ${passed}, Failed: ${failed}`);
    process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
    console.error('Test error:', err);
    process.exit(1);
});
