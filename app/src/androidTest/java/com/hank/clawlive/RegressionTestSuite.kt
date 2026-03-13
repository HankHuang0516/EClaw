package com.hank.clawlive

import org.junit.runner.RunWith
import org.junit.runners.Suite

/**
 * Regression Test Suite (回歸測試套件)
 * 
 * This suite runs all critical UI and functionality tests to ensure
 * no regressions are introduced during development.
 * 
 * Run with:
 * ./gradlew connectedDebugAndroidTest --tests "*.RegressionTestSuite"
 */
@RunWith(Suite::class)
@Suite.SuiteClasses(
    // Core UI Tests
    MainActivityUiTest::class,
    SettingsActivityUiTest::class,
    EntityManagerActivityUiTest::class,
    DebugRenderActivityUiTest::class,
    WallpaperPreviewUiTest::class,

    // Chat UI Tests
    ChatBubbleTextSelectionTest::class,  // #168: chat bubble partial text selection

    // Localization Tests
    BilingualVerificationTest::class
)
class RegressionTestSuite
