/**
 * Animation Sequence Test
 *
 * Tests claw wave animations with proper botSecret authentication.
 */

const BASE_URL = 'https://eclawbot.com';
const DELAY_MS = 2000;

let botSecret = null;
let entityId = 0;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function api(method, path, body = null) {
    const options = {
        method,
        headers: { 'Content-Type': 'application/json' }
    };
    if (body) options.body = JSON.stringify(body);
    const res = await fetch(`${BASE_URL}${path}`, options);
    return { status: res.status, data: await res.json() };
}

async function setupAuth() {
    console.log('?? Setting up authentication...');

    const deviceId = `anim-test-${Date.now()}`;
    const deviceSecret = `secret-${Date.now()}`;

    const registerRes = await api('POST', '/api/device/register', {
        entityId: entityId,
        deviceId: deviceId,
        deviceSecret: deviceSecret,
        isTestDevice: true
    });

    if (!registerRes.data.success) {
        console.log(`??Register failed: ${registerRes.data.message}`);
        return false;
    }

    const bindRes = await api('POST', '/api/bind', {
        code: registerRes.data.bindingCode
    });

    if (!bindRes.data.success) {
        console.log(`??Bind failed: ${bindRes.data.message}`);
        return false;
    }

    botSecret = bindRes.data.botSecret;
    console.log(`   ??Authenticated!\n`);
    return true;
}

async function sendTransform(body) {
    try {
        const res = await api('POST', '/api/transform', {
            entityId: entityId,
            botSecret: botSecret,
            ...body
        });
        if (res.data.success) {
            console.log(`   ??${res.data.currentState.state} - "${res.data.currentState.message}"`);
        } else {
            console.log(`   ??Failed: ${res.data.message}`);
        }
        return res.data.success;
    } catch (e) {
        console.error("Failed:", e.message);
        return false;
    }
}

async function runTest() {
    console.log(`?? Starting Animation Sequence on: ${BASE_URL}\n`);

    if (!await setupAuth()) {
        console.log('??Cannot run animations without authentication');
        return;
    }

    let passed = 0, failed = 0;

    // 1. Wave Left
    console.log("Action 1: Wave Left Claw ?? /");
    if (await sendTransform({
        character: "LOBSTER",
        state: "BUSY",
        message: "Hello! (Left)",
        parts: { "CLAW_LEFT": -45, "CLAW_RIGHT": 0 }
    })) passed++; else failed++;
    await sleep(DELAY_MS);

    // 2. Wave Right
    console.log("Action 2: Wave Right Claw ?? \\");
    if (await sendTransform({
        character: "LOBSTER",
        state: "BUSY",
        message: "Hi there! (Right)",
        parts: { "CLAW_LEFT": 0, "CLAW_RIGHT": 45 }
    })) passed++; else failed++;
    await sleep(DELAY_MS);

    // 3. BIG CLAWS (Both Open)
    console.log("Action 3: BIG CLAWS ?? \\_/");
    if (await sendTransform({
        character: "LOBSTER",
        state: "EXCITED",
        message: "I AM ALIVE!",
        parts: { "CLAW_LEFT": -60, "CLAW_RIGHT": 60 }
    })) passed++; else failed++;
    await sleep(DELAY_MS);

    // 4. Reset to Idle
    console.log("Action 4: Reset ?? | |");
    if (await sendTransform({
        character: "LOBSTER",
        state: "IDLE",
        message: "Waiting for command...",
        parts: { "CLAW_LEFT": 0, "CLAW_RIGHT": 0 }
    })) passed++; else failed++;

    // Summary
    console.log(`\n${'='.repeat(50)}`);
    console.log(`?? Result: ${passed}/${passed + failed} animations completed`);
    if (failed === 0) {
        console.log(`??Animation Sequence Complete!`);
    }
}

runTest().catch(console.error);
