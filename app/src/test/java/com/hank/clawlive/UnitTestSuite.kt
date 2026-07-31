package com.hank.clawlive

import com.hank.clawlive.fcm.FcmChannelCreationTest
import com.hank.clawlive.fcm.KanbanDoneDeepLinkTest
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
    WallpaperLayoutDefaultsTest::class,
    WallpaperDragControllerTest::class,
    ActivityStatePolicyTest::class,
    LayoutPreferencesTest::class,
    EngineLifecycleControllerTest::class,
    SpritesheetLoadingGraceTest::class,
    CompanionDescriptorAnimationTest::class,
    CompanionAssetUrlTest::class,
    AndroidSdkPolicyTest::class,
    CompanionCacheInvalidationStaticTest::class,
    NavResumeControllerTest::class,
    NotificationPreferenceCatalogTest::class,
    SettingsManifestResolverTest::class,
    SettingsManifestSyncTest::class,
    NeedYouIndicatorStaticTest::class,
    FcmChannelCreationTest::class,
    KanbanDoneDeepLinkTest::class
)
class UnitTestSuite
