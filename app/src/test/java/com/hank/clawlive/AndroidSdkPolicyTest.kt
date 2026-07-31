package com.hank.clawlive

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class AndroidSdkPolicyTest {
    @Test
    fun androidAppTargetsGooglePlay2026ApiRequirement() {
        val gradle = locateBuildGradle().readText()
        val compileSdk = extractSdkValue(gradle, "compileSdk")
        val targetSdk = extractSdkValue(gradle, "targetSdk")

        assertTrue(
            "Google Play requires Android 16 / API 36+ for app updates starting 2026-08-31; compileSdk=$compileSdk",
            compileSdk >= GOOGLE_PLAY_2026_REQUIRED_API
        )
        assertTrue(
            "Google Play requires Android 16 / API 36+ for app updates starting 2026-08-31; targetSdk=$targetSdk",
            targetSdk >= GOOGLE_PLAY_2026_REQUIRED_API
        )
        assertTrue(
            "compileSdk must stay at least targetSdk so release builds can compile all targeted APIs",
            compileSdk >= targetSdk
        )
    }

    private fun extractSdkValue(source: String, propertyName: String): Int {
        val match = Regex("""\b$propertyName\s*=\s*(\d+)""").find(source)
            ?: error("Could not find $propertyName in app/build.gradle.kts")
        return match.groupValues[1].toInt()
    }

    private fun locateBuildGradle(): File {
        val candidates = listOf(
            File("build.gradle.kts"),
            File("app/build.gradle.kts")
        )

        return candidates.firstOrNull { it.isFile }
            ?: error("Could not locate app/build.gradle.kts from ${File(".").absolutePath}")
    }

    private companion object {
        private const val GOOGLE_PLAY_2026_REQUIRED_API = 36
    }
}
