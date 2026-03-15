package com.hank.clawlive

import android.content.Context
import android.widget.TextView
import android.view.View
import android.view.ViewGroup
import androidx.appcompat.app.AppCompatDelegate
import androidx.core.os.LocaleListCompat
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.Locale

/**
 * Bilingual Verification Test (雙語驗證測試)
 * 
 * This test verifies that all app pages properly adapt to bilingual settings.
 * It checks both English and Traditional Chinese (zh-TW) locales.
 * 
 * Test Scope:
 * - MainActivity
 * - SettingsActivity
 *
 *
 * - WallpaperPreviewActivity (if applicable)
 */
@RunWith(AndroidJUnit4::class)
class BilingualVerificationTest {

    companion object {
        // Known English-only strings that should NOT appear in Chinese locale
        private val ENGLISH_ONLY_PATTERNS = listOf(
            "Claw Live",          // Should be app_name or main_title
            "No agents connected",
            "Add Entity",
            "Generate",
            "Broadcast",
            "Settings",
            "Send Message",
            "Cancel"
        )

        // Known Chinese strings that should appear in zh-TW locale
        private val CHINESE_PATTERNS = listOf(
            "新增實體",      // add_entity
            "產生",          // generate
            "廣播",          // broadcast
            "設定",          // settings
            "發送訊息",      // send_message
            "取消"           // cancel
        )
    }

    // ========================================
    // LOCALE SWITCHING TESTS
    // ========================================

    @Test
    fun testMainActivityInEnglish() {
        setLocale(Locale.ENGLISH)
        
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                val allTextViews = getAllTextViews(activity.window.decorView)
                
                println("=== MainActivity in ENGLISH ===")
                allTextViews.forEach { tv ->
                    val text = tv.text?.toString() ?: ""
                    if (text.isNotBlank()) {
                        println("  TextView: $text")
                    }
                }

                // Verify at least one English string is present
                val hasEnglishContent = allTextViews.any { tv ->
                    val text = tv.text?.toString() ?: ""
                    text.contains("Entity") || text.contains("Live") || text.contains("Wallpaper")
                }
                assertTrue("Should have English content in English locale", hasEnglishContent)
            }
        }
    }

    @Test
    fun testMainActivityInChinese() {
        setLocale(Locale.TRADITIONAL_CHINESE)
        
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                val allTextViews = getAllTextViews(activity.window.decorView)
                
                println("=== MainActivity in CHINESE ===")
                allTextViews.forEach { tv ->
                    val text = tv.text?.toString() ?: ""
                    if (text.isNotBlank()) {
                        println("  TextView: $text")
                    }
                }

                // Check that at least some Chinese text is present
                val hasChineseContent = allTextViews.any { tv ->
                    val text = tv.text?.toString() ?: ""
                    CHINESE_PATTERNS.any { pattern -> text.contains(pattern) } ||
                    text.any { char -> char.code in 0x4E00..0x9FFF } // CJK Unicode range
                }
                
                assertTrue(
                    "Should have Chinese content in Chinese locale. Check if strings are properly localized.",
                    hasChineseContent
                )
            }
        }
    }

    @Test
    fun testSettingsActivityInEnglish() {
        setLocale(Locale.ENGLISH)
        
        ActivityScenario.launch(SettingsActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                val allTextViews = getAllTextViews(activity.window.decorView)
                
                println("=== SettingsActivity in ENGLISH ===")
                allTextViews.forEach { tv ->
                    val text = tv.text?.toString() ?: ""
                    if (text.isNotBlank()) {
                        println("  TextView: $text")
                    }
                }

                assertTrue("SettingsActivity should load in English", allTextViews.isNotEmpty())
            }
        }
    }

    @Test
    fun testSettingsActivityInChinese() {
        setLocale(Locale.TRADITIONAL_CHINESE)
        
        ActivityScenario.launch(SettingsActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                val allTextViews = getAllTextViews(activity.window.decorView)
                
                println("=== SettingsActivity in CHINESE ===")
                allTextViews.forEach { tv ->
                    val text = tv.text?.toString() ?: ""
                    if (text.isNotBlank()) {
                        println("  TextView: $text")
                    }
                }

                // Check for Chinese content
                val hasChineseContent = allTextViews.any { tv ->
                    val text = tv.text?.toString() ?: ""
                    text.contains("設定") || text.contains("用量") || text.contains("佈局") ||
                    text.any { char -> char.code in 0x4E00..0x9FFF }
                }
                
                assertTrue(
                    "SettingsActivity should show Chinese text in Chinese locale",
                    hasChineseContent
                )
            }
        }
    }

    // ========================================
    // HARDCODED STRING DETECTION
    // ========================================

    @Test
    fun testNoHardcodedEnglishInChineseLocale() {
        setLocale(Locale.TRADITIONAL_CHINESE)
        
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                val allTextViews = getAllTextViews(activity.window.decorView)
                val hardcodedStrings = mutableListOf<String>()

                allTextViews.forEach { tv ->
                    val text = tv.text?.toString() ?: ""
                    ENGLISH_ONLY_PATTERNS.forEach { pattern ->
                        if (text.contains(pattern, ignoreCase = true)) {
                            hardcodedStrings.add("'$pattern' found in: '$text'")
                        }
                    }
                }

                if (hardcodedStrings.isNotEmpty()) {
                    println("=== HARDCODED ENGLISH STRINGS DETECTED ===")
                    hardcodedStrings.forEach { println("  ⚠️ $it") }
                }

                assertTrue(
                    "Should not have hardcoded English strings in Chinese locale: ${hardcodedStrings.joinToString()}",
                    hardcodedStrings.isEmpty()
                )
            }
        }
    }

    // ========================================
    // STRING RESOURCE COMPLETENESS
    // ========================================

    @Test
    fun testAllStringResourcesHaveChineseTranslation() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val englishConfig = context.resources.configuration.apply {
            setLocale(Locale.ENGLISH)
        }
        val chineseConfig = context.resources.configuration.apply {
            setLocale(Locale.TRADITIONAL_CHINESE)
        }

        // Key string resources that must be translated
        val criticalStrings = listOf(
            R.string.main_title,
            R.string.no_agents_connected,
            R.string.add_entity,
            R.string.generate,
            R.string.broadcast_to_all,
            R.string.set_live_wallpaper,
            R.string.settings_title,
            R.string.send_message,
            R.string.cancel
        )

        println("=== STRING RESOURCE TRANSLATION CHECK ===")
        criticalStrings.forEach { resId ->
            val englishContext = context.createConfigurationContext(englishConfig)
            val chineseContext = context.createConfigurationContext(chineseConfig)
            
            val englishValue = englishContext.getString(resId)
            val chineseValue = chineseContext.getString(resId)
            
            println("  ${context.resources.getResourceEntryName(resId)}: EN='$englishValue' | ZH='$chineseValue'")
            
            // Chinese should be different from English (unless it's intentionally same, like brand names)
            // Skip check for intentionally same strings
            if (!englishValue.contains("E-Claw") && !englishValue.contains("#")) {
                assertNotEquals(
                    "String ${context.resources.getResourceEntryName(resId)} should have Chinese translation",
                    englishValue,
                    chineseValue
                )
            }
        }
    }

    // ========================================
    // HELPER METHODS
    // ========================================

    private fun setLocale(locale: Locale) {
        val localeList = LocaleListCompat.forLanguageTags(locale.toLanguageTag())
        AppCompatDelegate.setApplicationLocales(localeList)
    }

    private fun getAllTextViews(view: View): List<TextView> {
        val textViews = mutableListOf<TextView>()
        
        if (view is TextView) {
            textViews.add(view)
        }
        
        if (view is ViewGroup) {
            for (i in 0 until view.childCount) {
                textViews.addAll(getAllTextViews(view.getChildAt(i)))
            }
        }
        
        return textViews
    }
}
