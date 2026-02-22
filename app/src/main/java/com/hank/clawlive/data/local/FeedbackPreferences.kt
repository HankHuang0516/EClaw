package com.hank.clawlive.data.local

import android.content.Context
import android.content.SharedPreferences

class FeedbackPreferences private constructor(context: Context) {

    private val prefs: SharedPreferences = context.getSharedPreferences(
        PREFS_NAME, Context.MODE_PRIVATE
    )

    var isMarking: Boolean
        get() = prefs.getBoolean(KEY_IS_MARKING, false)
        set(value) { prefs.edit().putBoolean(KEY_IS_MARKING, value).apply() }

    var markTimestamp: Long
        get() = prefs.getLong(KEY_MARK_TIMESTAMP, 0L)
        set(value) { prefs.edit().putLong(KEY_MARK_TIMESTAMP, value).apply() }

    fun startMarking(timestamp: Long) {
        prefs.edit()
            .putBoolean(KEY_IS_MARKING, true)
            .putLong(KEY_MARK_TIMESTAMP, timestamp)
            .apply()
    }

    fun clearMarking() {
        prefs.edit()
            .putBoolean(KEY_IS_MARKING, false)
            .remove(KEY_MARK_TIMESTAMP)
            .apply()
    }

    companion object {
        private const val PREFS_NAME = "feedback_prefs"
        private const val KEY_IS_MARKING = "is_marking"
        private const val KEY_MARK_TIMESTAMP = "mark_timestamp"

        @Volatile
        private var instance: FeedbackPreferences? = null

        fun getInstance(context: Context): FeedbackPreferences {
            return instance ?: synchronized(this) {
                instance ?: FeedbackPreferences(context.applicationContext).also { instance = it }
            }
        }
    }
}
