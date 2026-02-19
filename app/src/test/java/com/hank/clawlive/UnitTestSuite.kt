package com.hank.clawlive

import org.junit.runner.RunWith
import org.junit.runners.Suite

/**
 * Unit Test Suite (單元測試套件)
 *
 * Runs all pure-Kotlin unit tests (no Android dependencies).
 *
 * Run with:
 *   ./gradlew test --tests "*.UnitTestSuite"
 */
@RunWith(Suite::class)
@Suite.SuiteClasses(
    MessageRequestFormatTest::class,
    ChatEchoSuppressionTest::class
)
class UnitTestSuite
