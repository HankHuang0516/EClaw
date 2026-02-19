package com.hank.clawlive.data.local

import android.content.Context
import android.content.SharedPreferences
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Manages daily message usage tracking for subscription limits.
 * Free tier: 15 sends per day
 * Premium: Unlimited
 * 
 * Only counts:
 * - POST /api/client/speak (user sends message to bot)
 * - POST /api/entity/speak-to (entity to entity messaging)
 */
class UsageManager private constructor(context: Context) {

    private val prefs: SharedPreferences = context.getSharedPreferences(
        PREFS_NAME, Context.MODE_PRIVATE
    )

    companion object {
        private const val PREFS_NAME = "usage_prefs"
        private const val KEY_DAILY_COUNT = "daily_message_count"
        private const val KEY_LAST_RESET_DATE = "last_reset_date"
        private const val KEY_IS_PREMIUM = "is_premium"
        
        const val FREE_TIER_LIMIT = 15

        @Volatile
        private var instance: UsageManager? = null

        fun getInstance(context: Context): UsageManager {
            return instance ?: synchronized(this) {
                instance ?: UsageManager(context.applicationContext).also { instance = it }
            }
        }
    }

    /**
     * Current day's message count
     */
    var dailyMessageCount: Int
        get() {
            checkAndResetIfNewDay()
            return prefs.getInt(KEY_DAILY_COUNT, 0)
        }
        private set(value) {
            prefs.edit().putInt(KEY_DAILY_COUNT, value).apply()
        }

    /**
     * Premium subscription status (cached from BillingManager)
     */
    var isPremium: Boolean
        get() = prefs.getBoolean(KEY_IS_PREMIUM, false)
        set(value) {
            prefs.edit().putBoolean(KEY_IS_PREMIUM, value).apply()
        }

    /**
     * Get today's date as string for comparison
     */
    private fun getTodayString(): String {
        val dateFormat = SimpleDateFormat("yyyy-MM-dd", Locale.US)
        return dateFormat.format(Date())
    }

    /**
     * Check if it's a new day and reset counter if needed
     */
    private fun checkAndResetIfNewDay() {
        val today = getTodayString()
        val lastReset = prefs.getString(KEY_LAST_RESET_DATE, null)
        
        if (lastReset != today) {
            prefs.edit()
                .putInt(KEY_DAILY_COUNT, 0)
                .putString(KEY_LAST_RESET_DATE, today)
                .apply()
        }
    }

    /**
     * Check if user can send/receive a message
     */
    /**
     * Check if user can send/receive a message
     */
    fun canUseMessage(): Boolean {
        if (com.hank.clawlive.BuildConfig.DEBUG) return true
        if (isPremium) return true
        return dailyMessageCount < FREE_TIER_LIMIT
    }

    /**
     * Increment usage counter. Call this after successful message send/receive.
     * @return true if message was allowed, false if limit exceeded
     */
    fun incrementUsage(): Boolean {
        if (!canUseMessage()) return false
        
        checkAndResetIfNewDay()
        val current = prefs.getInt(KEY_DAILY_COUNT, 0)
        prefs.edit().putInt(KEY_DAILY_COUNT, current + 1).apply()
        return true
    }

    /**
     * Get remaining messages for today
     */
    fun getRemainingMessages(): Int {
        if (com.hank.clawlive.BuildConfig.DEBUG) return Int.MAX_VALUE
        if (isPremium) return Int.MAX_VALUE
        return (FREE_TIER_LIMIT - dailyMessageCount).coerceAtLeast(0)
    }

    /**
     * Get usage display string for UI (e.g., "5/25" or "∞" for premium)
     */
    fun getUsageDisplay(): String {
        return if (com.hank.clawlive.BuildConfig.DEBUG) {
            "DEBUG"
        } else if (isPremium) {
            "∞"
        } else {
            "$dailyMessageCount/$FREE_TIER_LIMIT"
        }
    }

    /**
     * Get usage as percentage (0.0 to 1.0) for progress bar
     */
    fun getUsageProgress(): Float {
        if (com.hank.clawlive.BuildConfig.DEBUG) return 0f
        if (isPremium) return 0f
        return (dailyMessageCount.toFloat() / FREE_TIER_LIMIT).coerceIn(0f, 1f)
    }

    /**
     * Sync local usage count with server-reported value.
     * Ensures client display matches actual server-side tracking.
     */
    fun syncFromServer(serverUsageCount: Int) {
        prefs.edit()
            .putInt(KEY_DAILY_COUNT, serverUsageCount)
            .putString(KEY_LAST_RESET_DATE, getTodayString())
            .apply()
    }

    /**
     * Reset usage (for testing only)
     */
    fun resetUsage() {
        prefs.edit()
            .putInt(KEY_DAILY_COUNT, 0)
            .putString(KEY_LAST_RESET_DATE, getTodayString())
            .apply()
    }
}
