package com.hank.clawlive

import com.hank.clawlive.fcm.FcmChannelCreationTest
import com.hank.clawlive.settings.NotificationPreferenceCatalogTest
import com.hank.clawlive.settings.SettingsManifestResolverTest
import com.hank.clawlive.settings.SettingsManifestSyncTest
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
    ChatEchoSuppressionTest::class,
    WallpaperWanderControllerTest::class,
    EngineLifecycleControllerTest::class,
    CompanionDescriptorAnimationTest::class,
    NotificationPreferenceCatalogTest::class,
    SettingsManifestResolverTest::class,
    SettingsManifestSyncTest::class,
    FcmChannelCreationTest::class
)
class UnitTestSuite
