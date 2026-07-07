package com.hank.clawlive.data.local

import android.content.Context
import kotlin.math.max

class NeedYouIndicatorPrefs private constructor(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    var pendingCount: Int
        get() = prefs.getInt(KEY_PENDING_COUNT, 0)
        set(value) {
            prefs.edit()
                .putInt(KEY_PENDING_COUNT, max(0, value))
                .putLong(KEY_UPDATED_AT, System.currentTimeMillis())
                .apply()
        }

    val updatedAt: Long
        get() = prefs.getLong(KEY_UPDATED_AT, 0L)

    companion object {
        private const val PREFS_NAME = "needyou_indicator_prefs"
        private const val KEY_PENDING_COUNT = "pending_count"
        private const val KEY_UPDATED_AT = "updated_at"

        @Volatile
        private var instance: NeedYouIndicatorPrefs? = null

        fun getInstance(context: Context): NeedYouIndicatorPrefs {
            return instance ?: synchronized(this) {
                instance ?: NeedYouIndicatorPrefs(context.applicationContext).also { instance = it }
            }
        }
    }
}
