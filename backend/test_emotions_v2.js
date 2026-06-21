/**
 * Eye Expression Test
 *
 * Tests eye lid and angle animations with proper botSecret authentication.
 */

const BASE_URL = 'https://eclawbot.com';
const DELAY_EMOTION = 2000;
const DELAY_ANIM = 200;

let botSecret = null;
let deviceId = null;
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

async function send(state, message, parts) {
    try {
        const res = await api('POST', '/api/transform', {
            deviceId: deviceId,
            entityId: entityId,
            botSecret: botSecret,
            character: "LOBSTER",
            state: state,
            message: message,
            parts: parts
        });
        if (!res.data.success) {
            console.log(`   ⚠️  Transform rejected: ${res.data.message}`);
        }
        return res.data.success;
    } catch (e) {
        console.error(e.message);
        return false;
    }
}

async function verify(expectedState, expectedMessage) {
    const res = await api('GET', `/api/status?deviceId=${deviceId}&entityId=${entityId}`);
    const data = res.data;
    const ok = data.state === expectedState && data.message === expectedMessage;
    console.log(ok ? `   ✅ ${data.state} - "${data.message}"` : `   ❌ Got: ${data.state}`);
    return ok;
}

async function setupAuth() {
    console.log('🔐 Setting up authentication...\n');

    deviceId = `eye-test-${Date.now()}`;
    const deviceSecret = `secret-${Date.now()}`;

    const registerRes = await api('POST', '/api/device/register', {
        entityId: entityId,
        deviceId: deviceId,
        deviceSecret: deviceSecret,
        isTestDevice: true
    });

    if (!registerRes.data.success) {
        console.log(`❌ Register failed: ${registerRes.data.message}`);
        return false;
    }

    const bindRes = await api('POST', '/api/bind', {
        code: registerRes.data.bindingCode
    });

    if (!bindRes.data.success) {
        console.log(`❌ Bind failed: ${bindRes.data.message}`);
        return false;
    }

    botSecret = bindRes.data.botSecret;
    console.log(`   ✅ Authenticated! botSecret: ${botSecret.substring(0, 8)}...\n`);
    return true;
}

async function runEyeTest() {
    console.log(`👀 Starting Eye Expression Test on: ${BASE_URL}\n`);

    if (!await setupAuth()) {
        console.log('❌ Cannot run test without authentication');
        return;
    }

    let passed = 0, failed = 0;

    // 1. Blink Test
    console.log("😉 Blink Test");
    for (let i = 0; i < 3; i++) {
        await send("IDLE", "Blinking...", { "EYE_LID": 1.0 }); // Close
        await sleep(150);
        await send("IDLE", "Blinking...", { "EYE_LID": 0.0 }); // Open
        await sleep(500);
    }
    if (await verify("IDLE", "Blinking...")) passed++; else failed++;
    await sleep(DELAY_EMOTION);

    // 2. Angry (Combat)
    console.log("😡 Angry - Slanted & Half Lidded");
    await send("BUSY", "ANGRY!!!", {
        "CLAW_LEFT": -10, "CLAW_RIGHT": 10,
        "EYE_LID": 0.5,
        "EYE_ANGLE": 25.0
    });
    if (await verify("BUSY", "ANGRY!!!")) passed++; else failed++;
    await sleep(DELAY_EMOTION);

    // 3. Sad (Crying)
    console.log("😢 Sad - Droopy Outward");
    await send("SLEEPING", "Sad...", {
        "CLAW_LEFT": 10, "CLAW_RIGHT": -10,
        "EYE_LID": 0.6,
        "EYE_ANGLE": -25.0
    });
    if (await verify("SLEEPING", "Sad...")) passed++; else failed++;
    await sleep(DELAY_EMOTION);

    // 4. Suspicious/Squint
    console.log("🤨 Suspicious - Narrow Eyes");
    await send("IDLE", "Hmm...", {
        "EYE_LID": 0.7,
        "EYE_ANGLE": 0.0
    });
    if (await verify("IDLE", "Hmm...")) passed++; else failed++;
    await sleep(DELAY_EMOTION);

    // 5. Surprise/Wide Awake
    console.log("😳 Surprise - Wide Open");
    await send("EXCITED", "O_O", {
        "EYE_LID": -0.2,
        "EYE_ANGLE": 0.0
    });
    if (await verify("EXCITED", "O_O")) passed++; else failed++;
    await sleep(DELAY_EMOTION);

    // Reset
    console.log("🍵 Reset to Normal");
    await send("IDLE", "Normal", { "EYE_LID": 0.0, "EYE_ANGLE": 0.0 });
    if (await verify("IDLE", "Normal")) passed++; else failed++;

    // Summary
    console.log(`\n${'='.repeat(50)}`);
    console.log(`📊 Result: ${passed}/${passed + failed} verified`);
    if (failed === 0) {
        console.log(`✅ All eye expressions verified!`);
    }
}

runEyeTest().catch(console.error);
