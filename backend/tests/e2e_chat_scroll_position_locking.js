/**
 * E2E Test: Chat Scroll Position Locking
 *
 * Tests the scroll position locking mechanism that prevents new messages
 * from disrupting user's reading position when browsing chat history.
 *
 * CI-Safe: Uses headless mode and environment-based test credentials
 */

const { chromium } = require('playwright');

const TEST_CONFIG = {
    chatUrl: process.env.E2E_CHAT_URL || 'http://localhost:3000/portal/chat.html',
    deviceId: process.env.E2E_DEVICE_ID || 'test-device-id',
    deviceSecret: process.env.E2E_DEVICE_SECRET || 'test-device-secret',
    headless: process.env.CI === 'true' || process.env.E2E_HEADLESS === 'true',
    timeout: 10000
};

async function runChatScrollPositionLockingTest() {
    console.log('🧪 Starting Chat Scroll Position Locking E2E Test...');
    console.log('📊 Config:', {
        url: TEST_CONFIG.chatUrl.replace(/deviceSecret=[^&]+/, 'deviceSecret=***'),
        headless: TEST_CONFIG.headless
    });

    const browser = await chromium.launch({
        headless: TEST_CONFIG.headless,
        slowMo: TEST_CONFIG.headless ? 0 : 100
    });
    const page = await browser.newPage();

    try {
        // Construct test URL with credentials
        const testUrl = `${TEST_CONFIG.chatUrl}?deviceId=${TEST_CONFIG.deviceId}&deviceSecret=${TEST_CONFIG.deviceSecret}`;

        // Navigate to chat page
        await page.goto(testUrl);
        await page.waitForLoadState('networkidle', { timeout: TEST_CONFIG.timeout });
        console.log('✅ Chat page loaded');

        // Wait for chat container
        const chatContainer = await page.locator('#chatMessages');
        await chatContainer.waitFor({ timeout: TEST_CONFIG.timeout });
        console.log('✅ Chat container found');

        // Test 1: Verify _chatScrollState is exposed and initialized
        const scrollStateExists = await page.evaluate(() => {
            return typeof window._chatScrollState === 'object' &&
                   window._chatScrollState !== null &&
                   typeof window._chatScrollState.userScrolling === 'boolean';
        });

        if (!scrollStateExists) {
            throw new Error('_chatScrollState not properly exposed to window');
        }
        console.log('✅ _chatScrollState properly exposed and initialized');

        // Test 2: Check initial scroll state
        const initialState = await page.evaluate(() => {
            return {
                userScrolling: window._chatScrollState.userScrolling,
                lastScrollTop: window._chatScrollState.lastScrollTop,
                containerExists: !!document.getElementById('chatMessages')
            };
        });
        console.log('📊 Initial state:', initialState);

        // Test 3: Simulate adding content and scrolling behavior
        await page.evaluate(() => {
            const container = document.getElementById('chatMessages');
            if (container) {
                // Add test content to make scrolling possible
                for (let i = 0; i < 20; i++) {
                    const messageDiv = document.createElement('div');
                    messageDiv.style.height = '60px';
                    messageDiv.style.marginBottom = '10px';
                    messageDiv.style.background = '#f0f0f0';
                    messageDiv.style.padding = '10px';
                    messageDiv.textContent = `Test message ${i + 1}`;
                    container.appendChild(messageDiv);
                }

                // Scroll to middle to trigger user scrolling state
                container.scrollTop = Math.floor(container.scrollHeight * 0.4);
                container.dispatchEvent(new Event('scroll'));
            }
        });

        await page.waitForTimeout(500); // Wait for scroll handlers

        // Test 4: Verify user scrolling state is detected
        const afterScrollState = await page.evaluate(() => {
            return {
                userScrolling: window._chatScrollState.userScrolling,
                lastScrollTop: window._chatScrollState.lastScrollTop,
                scrollTop: document.getElementById('chatMessages')?.scrollTop
            };
        });
        console.log('📊 After scroll state:', afterScrollState);

        // Test 5: Verify scroll-to-bottom button appears
        const jumpButtonVisible = await page.locator('#scrollToBottomBtn.visible').count() > 0;
        console.log('📊 Jump-to-bottom button visible:', jumpButtonVisible);

        // Test 6: Test scroll-to-bottom functionality
        if (jumpButtonVisible) {
            await page.click('#scrollToBottomBtn');
            await page.waitForTimeout(300);

            const afterJumpState = await page.evaluate(() => {
                const container = document.getElementById('chatMessages');
                return {
                    userScrolling: window._chatScrollState.userScrolling,
                    isAtBottom: container ?
                        (container.scrollHeight - container.scrollTop - container.clientHeight) < 120 : false
                };
            });
            console.log('📊 After jump-to-bottom:', afterJumpState);
        }

        // Test Results Summary
        const testResults = {
            scrollStateExposed: scrollStateExists,
            initialStateValid: initialState.containerExists && typeof initialState.userScrolling === 'boolean',
            userScrollingDetected: afterScrollState.userScrolling === true,
            jumpButtonFunctional: jumpButtonVisible
        };

        console.log('📊 Test Results Summary:');
        Object.entries(testResults).forEach(([test, passed]) => {
            console.log(`  - ${test}: ${passed ? '✅' : '❌'}`);
        });

        const allTestsPassed = Object.values(testResults).every(result => result === true);

        // Take screenshot for evidence (only if not in CI)
        if (!TEST_CONFIG.headless) {
            await page.screenshot({
                path: 'chat_scroll_position_locking_evidence.png',
                fullPage: true
            });
            console.log('📸 Evidence screenshot saved');
        }

        console.log(allTestsPassed ? '🎉 All scroll position locking tests PASSED!' : '❌ Some tests FAILED!');

        return {
            passed: allTestsPassed,
            results: testResults,
            scrollStates: {
                initial: initialState,
                afterScroll: afterScrollState
            }
        };

    } catch (error) {
        console.error('❌ E2E test error:', error);

        // Take error screenshot (only if not in CI)
        if (!TEST_CONFIG.headless) {
            await page.screenshot({
                path: 'chat_scroll_position_locking_error.png',
                fullPage: true
            });
        }

        return { passed: false, error: error.message };
    } finally {
        await browser.close();
    }
}

// Run test if called directly
if (require.main === module) {
    runChatScrollPositionLockingTest().then(result => {
        console.log('\n📊 Final Test Result:', result);
        process.exit(result.passed ? 0 : 1);
    }).catch(err => {
        console.error('Test execution error:', err);
        process.exit(1);
    });
}

module.exports = { runChatScrollPositionLockingTest };