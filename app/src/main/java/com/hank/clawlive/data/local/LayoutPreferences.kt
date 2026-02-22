package com.hank.clawlive.data.local

import android.content.Context
import android.content.SharedPreferences

/**
 * Entity Layout Types for wallpaper positioning
 */
enum class EntityLayout {
    GRID_2X2,      // Default: 2x2 grid
    HORIZONTAL,    // All in a row
    VERTICAL,      // All in a column
    DIAMOND,       // Diamond pattern
    CORNERS        // Four corners
}

/**
 * Manages entity layout preferences
 */
class LayoutPreferences private constructor(context: Context) {

    private val prefs: SharedPreferences = context.getSharedPreferences(
        PREFS_NAME, Context.MODE_PRIVATE
    )

    var entityLayout: EntityLayout
        get() {
            val name = prefs.getString(KEY_LAYOUT, EntityLayout.GRID_2X2.name)
            return try {
                EntityLayout.valueOf(name ?: EntityLayout.GRID_2X2.name)
            } catch (e: Exception) {
                EntityLayout.GRID_2X2
            }
        }
        set(value) {
            prefs.edit().putString(KEY_LAYOUT, value.name).apply()
        }

    /**
     * Get entity scale multiplier (user adjustable)
     */
    var entityScale: Float
        get() = prefs.getFloat(KEY_SCALE, 1.0f)
        set(value) {
            prefs.edit().putFloat(KEY_SCALE, value.coerceIn(0.5f, 2.0f)).apply()
        }

    /**
     * Get vertical offset for entities (0.0 = top, 0.5 = center, 1.0 = bottom)
     */
    var verticalPosition: Float
        get() = prefs.getFloat(KEY_VERTICAL_POS, 0.5f)
        set(value) {
            prefs.edit().putFloat(KEY_VERTICAL_POS, value.coerceIn(0.1f, 0.9f)).apply()
        }

    /**
     * Get the set of entity IDs that THIS device has registered.
     * Only entities in this set should be displayed on the wallpaper.
     */
    fun getRegisteredEntityIds(): Set<Int> {
        val stored = prefs.getStringSet(KEY_REGISTERED_ENTITIES, emptySet()) ?: emptySet()
        return stored.mapNotNull { it.toIntOrNull() }.toSet()
    }

    /**
     * Add an entity ID to the registered set (called after successful registration)
     */
    fun addRegisteredEntity(entityId: Int) {
        val current = getRegisteredEntityIds().toMutableSet()
        current.add(entityId)
        prefs.edit().putStringSet(KEY_REGISTERED_ENTITIES, current.map { it.toString() }.toSet()).apply()
    }

    /**
     * Remove an entity ID from the registered set (called after entity removal)
     */
    fun removeRegisteredEntity(entityId: Int) {
        val current = getRegisteredEntityIds().toMutableSet()
        current.remove(entityId)
        prefs.edit().putStringSet(KEY_REGISTERED_ENTITIES, current.map { it.toString() }.toSet()).apply()
    }

    /**
     * Check if this device has registered a specific entity
     */
    fun isEntityRegistered(entityId: Int): Boolean {
        return getRegisteredEntityIds().contains(entityId)
    }

    /**
     * Clear all registered entities (for testing/reset)
     */
    fun clearRegisteredEntities() {
        prefs.edit().remove(KEY_REGISTERED_ENTITIES).apply()
    }

    /**
     * Display mode: how many entities to show (1, 2, or 4)
     */
    var displayMode: Int
        get() = prefs.getInt(KEY_DISPLAY_MODE, MODE_SINGLE)
        set(value) {
            prefs.edit().putInt(KEY_DISPLAY_MODE, value).apply()
        }

    /**
     * Whether to use custom positions instead of preset layouts
     */
    var useCustomLayout: Boolean
        get() = prefs.getBoolean(KEY_USE_CUSTOM_LAYOUT, false)
        set(value) {
            prefs.edit().putBoolean(KEY_USE_CUSTOM_LAYOUT, value).apply()
        }

    /**
     * Whether to use a custom background image
     */
    var useBackgroundImage: Boolean
        get() = prefs.getBoolean(KEY_USE_BACKGROUND_IMAGE, false)
        set(value) {
            prefs.edit().putBoolean(KEY_USE_BACKGROUND_IMAGE, value).apply()
        }

    /**
     * Background image URI (stored as string)
     */
    var backgroundImageUri: String?
        get() = prefs.getString(KEY_BACKGROUND_URI, null)
        set(value) {
            prefs.edit().putString(KEY_BACKGROUND_URI, value).apply()
        }

    /**
     * Clear background image settings
     */
    fun clearBackgroundImage() {
        prefs.edit()
            .remove(KEY_BACKGROUND_URI)
            .putBoolean(KEY_USE_BACKGROUND_IMAGE, false)
            .apply()
    }

    /**
     * Get custom position for an entity (percentage-based 0.0-1.0)
     * Returns null if no custom position is set
     */
    fun getCustomPosition(entityId: Int): Pair<Float, Float>? {
        val posStr = prefs.getString("${KEY_CUSTOM_POS_PREFIX}$entityId", null)
        return posStr?.split(",")?.let {
            if (it.size == 2) {
                val x = it[0].toFloatOrNull() ?: return null
                val y = it[1].toFloatOrNull() ?: return null
                Pair(x, y)
            } else null
        }
    }

    /**
     * Set custom position for an entity (percentage-based 0.0-1.0)
     */
    fun setCustomPosition(entityId: Int, xPercent: Float, yPercent: Float) {
        val x = xPercent.coerceIn(0.05f, 0.95f)
        val y = yPercent.coerceIn(0.1f, 0.9f)
        prefs.edit().putString("${KEY_CUSTOM_POS_PREFIX}$entityId", "$x,$y").apply()
    }

    /**
     * Clear custom position for an entity
     */
    fun clearCustomPosition(entityId: Int) {
        prefs.edit().remove("${KEY_CUSTOM_POS_PREFIX}$entityId").apply()
    }

    /**
     * Clear all custom positions (reset to defaults)
     */
    fun clearAllCustomPositions() {
        val editor = prefs.edit()
        for (i in 0..3) {
            editor.remove("${KEY_CUSTOM_POS_PREFIX}$i")
        }
        editor.apply()
    }

    /**
     * Get custom scale for an entity (default 1.0)
     */
    fun getEntityScale(entityId: Int): Float {
        return prefs.getFloat("${KEY_ENTITY_SCALE_PREFIX}$entityId", 1.0f)
    }

    /**
     * Set custom scale for an entity (clamped to 0.3-2.5)
     */
    fun setEntityScale(entityId: Int, scale: Float) {
        val clampedScale = scale.coerceIn(0.3f, 2.5f)
        prefs.edit().putFloat("${KEY_ENTITY_SCALE_PREFIX}$entityId", clampedScale).apply()
    }

    /**
     * Clear all custom scales (reset to defaults)
     */
    fun clearAllEntityScales() {
        val editor = prefs.edit()
        for (i in 0..3) {
            editor.remove("${KEY_ENTITY_SCALE_PREFIX}$i")
        }
        editor.apply()
    }

    /**
     * Debug entity limit (4 or 8). Only used when BuildConfig.DEBUG is true.
     */
    var debugEntityLimit: Int
        get() = prefs.getInt(KEY_DEBUG_ENTITY_LIMIT, 8)
        set(value) {
            prefs.edit().putInt(KEY_DEBUG_ENTITY_LIMIT, value.coerceIn(4, 8)).apply()
        }

    companion object {
        private const val PREFS_NAME = "entity_layout_prefs"
        private const val KEY_LAYOUT = "layout_type"
        private const val KEY_SCALE = "entity_scale"
        private const val KEY_VERTICAL_POS = "vertical_position"
        private const val KEY_REGISTERED_ENTITIES = "registered_entity_ids"
        private const val KEY_DISPLAY_MODE = "display_mode"
        private const val KEY_USE_CUSTOM_LAYOUT = "use_custom_layout"
        private const val KEY_CUSTOM_POS_PREFIX = "custom_pos_"
        private const val KEY_ENTITY_SCALE_PREFIX = "entity_scale_"
        private const val KEY_USE_BACKGROUND_IMAGE = "use_background_image"
        private const val KEY_BACKGROUND_URI = "background_image_uri"
        private const val KEY_DEBUG_ENTITY_LIMIT = "debug_entity_limit"

        // Display mode constants
        const val MODE_SINGLE = 1
        const val MODE_DUAL = 2
        const val MODE_QUAD = 4

        @Volatile
        private var instance: LayoutPreferences? = null

        fun getInstance(context: Context): LayoutPreferences {
            return instance ?: synchronized(this) {
                instance ?: LayoutPreferences(context.applicationContext).also { instance = it }
            }
        }
    }
}
