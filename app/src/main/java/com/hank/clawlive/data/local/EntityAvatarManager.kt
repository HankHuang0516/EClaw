package com.hank.clawlive.data.local

import android.content.Context
import android.content.SharedPreferences

/**
 * Manages entity avatar icons.
 * Each entity (identified by entityId) has a customizable avatar emoji.
 */
class EntityAvatarManager private constructor(context: Context) {

    // Keep same SharedPreferences name for backward compatibility
    private val prefs: SharedPreferences =
        context.applicationContext.getSharedPreferences("entity_emojis", Context.MODE_PRIVATE)

    companion object {
        @Volatile
        private var INSTANCE: EntityAvatarManager? = null

        fun getInstance(context: Context): EntityAvatarManager {
            return INSTANCE ?: synchronized(this) {
                INSTANCE ?: EntityAvatarManager(context).also { INSTANCE = it }
            }
        }

        /** Default avatar for each entity slot */
        val DEFAULT_AVATARS = mapOf(
            0 to "\uD83E\uDD9E",  // 🦞
            1 to "\uD83D\uDC37",  // 🐷
            2 to "\uD83E\uDD9E",  // 🦞
            3 to "\uD83D\uDC37",  // 🐷
            4 to "\uD83E\uDD8A",  // 🦊
            5 to "\uD83D\uDC3B",  // 🐻
            6 to "\uD83D\uDC3C",  // 🐼
            7 to "\uD83D\uDC28"   // 🐨
        )

        /** 30 avatar options organized by category (6 columns x 5 rows) */
        val AVATAR_OPTIONS = listOf(
            // Row 1: Sea creatures
            "🦞", "🦀", "🐙", "🦑", "🐠", "🐟",
            // Row 2: Animals
            "🐷", "🐶", "🐱", "🐰", "🦊", "🐻",
            // Row 3: More animals
            "🐼", "🐨", "🦁", "🐯", "🐸", "🐵",
            // Row 4: Robots & fantasy
            "🤖", "👾", "🎃", "👻", "🦄", "🐲",
            // Row 5: People & misc
            "😎", "🥷", "🧙", "🦸", "🐧", "🦅"
        )
    }

    fun getAvatar(entityId: Int): String {
        // Keep same key format for backward compatibility
        return prefs.getString("emoji_$entityId", DEFAULT_AVATARS[entityId] ?: "🦞") ?: "🦞"
    }

    fun setAvatar(entityId: Int, avatar: String) {
        prefs.edit().putString("emoji_$entityId", avatar).apply()
    }

    /** Check if an avatar value is an image URL (not an emoji). */
    fun isImageUrl(avatar: String): Boolean = avatar.startsWith("https://")
}
