/**
 * Local regex validation for the Android-side entity echo filter.
 *
 * This mirrors the Kotlin regex in ChatRepository.processEntityMessage():
 *   if (entity.message.matches(Regex("^entity:\\d+:[A-Z]+:.*"))) { return }
 *
 * Run: node backend/tests/test_echo_regex_validation.js
 */

const pattern = /^entity:\d+:[A-Z]+:.*/;

let passed = 0;
let failed = 0;

function assert(label, condition) {
    if (condition) {
        console.log(`  OK ${label}`);
        passed++;
    } else {
        console.log(`  FAIL ${label}`);
        failed++;
    }
}

console.log('='.repeat(60));
console.log('Entity Echo Filter — Regex Validation');
console.log('='.repeat(60));

// ===== Messages that MUST be filtered (echo suppression) =====
console.log('\n--- Must be FILTERED (return early, skip saving to DB) ---\n');

assert('Broadcast echo: entity:1:LOBSTER: [廣播] 大家好',
    pattern.test('entity:1:LOBSTER: [廣播] 大家好，有人在嗎？'));

assert('Speak-to echo: entity:0:PIG: 你好',
    pattern.test('entity:0:PIG: 你好，我想問一個問題'));

assert('Broadcast with photo: entity:2:CHICKEN: [廣播] [Photo]',
    pattern.test('entity:2:CHICKEN: [廣播] [Photo] Check this out'));

assert('Speak-to trailing space: entity:3:LOBSTER: ',
    pattern.test('entity:3:LOBSTER: '));

assert('Minimal pattern: entity:0:PIG:',
    pattern.test('entity:0:PIG:'));

assert('Entity 0: entity:0:LOBSTER: test',
    pattern.test('entity:0:LOBSTER: test'));

assert('Entity 1: entity:1:LOBSTER: test',
    pattern.test('entity:1:LOBSTER: test'));

assert('Entity 2: entity:2:LOBSTER: test',
    pattern.test('entity:2:LOBSTER: test'));

assert('Entity 3: entity:3:LOBSTER: test',
    pattern.test('entity:3:LOBSTER: test'));

for (const char of ['LOBSTER', 'PIG', 'CHICKEN', 'CAT', 'DOG', 'BEAR']) {
    assert(`Character ${char}: entity:1:${char}: hello`,
        pattern.test(`entity:1:${char}: hello`));
}

// ===== Messages that must NOT be filtered =====
console.log('\n--- Must NOT be filtered (legitimate entity responses) ---\n');

assert('Regular response: 正在處理您的請求...',
    !pattern.test('正在處理您的請求...'));

assert('Contains "entity" word but wrong format',
    !pattern.test('The entity system is working correctly'));

assert('System message: [SYSTEM:WEBHOOK_ERROR]',
    !pattern.test('[SYSTEM:WEBHOOK_ERROR] Push failed (HTTP 500)'));

assert('Received echo: Received: "hello"',
    !pattern.test('Received: "hello"'));

assert('Passive: Waiting...',
    !pattern.test('Waiting...'));

assert('Passive: Zzz...',
    !pattern.test('Zzz...'));

assert('Passive: Loading...',
    !pattern.test('Loading...'));

assert('Passive: Idle',
    !pattern.test('Idle'));

assert('Lowercase character: entity:1:lobster: hello',
    !pattern.test('entity:1:lobster: hello'));

assert('Missing ID: entity:LOBSTER: hello',
    !pattern.test('entity:LOBSTER: hello'));

assert('Missing colon after ID: entity:1LOBSTER: hello',
    !pattern.test('entity:1LOBSTER: hello'));

assert('Extra char before colon: entityX:1:LOBSTER: hello',
    !pattern.test('entityX:1:LOBSTER: hello'));

assert('Old "From Entity" format: From Entity 1: "hello"',
    !pattern.test('From Entity 1: "hello"'));

assert('Empty string',
    !pattern.test(''));

assert('Bot status: 我正在觀察星空',
    !pattern.test('我正在觀察星空'));

assert('Mixed case character: entity:1:Lobster: hello',
    !pattern.test('entity:1:Lobster: hello'));

// Summary
console.log(`\n${'='.repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('='.repeat(60));

if (failed > 0) {
    console.log(`\n${failed} assertion(s) FAILED — regex pattern needs adjustment`);
    process.exit(1);
} else {
    console.log('\nAll regex validation tests passed');
    process.exit(0);
}
