package com.hank.clawlive.data.local

import android.content.Context
import android.content.SharedPreferences
import android.provider.Settings

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
 * Screen corner used for the wallpaper usage overlay.
 */
enum class UsageOverlayPosition {
    TOP_LEFT,
    TOP_RIGHT,
    BOTTOM_LEFT,
    BOTTOM_RIGHT
}

/**
 * How kanban cards are materialized as wallpaper objects.
 */
enum class WallpaperKanbanObjectStyle {
    SMART_MIX,
    FOLDER,
    BOOK_NOTEBOOK,
    CLIPBOARD,
    STORAGE_BOX,
    STICKY_CARD
}

/**
 * Manages entity layout preferences
 */
class LayoutPreferences private constructor(
    private val prefs: SharedPreferences,
    private val appContext: Context?
) {

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
        val y = yPercent.coerceIn(0.05f, 0.95f)
        prefs.edit().putString("${KEY_CUSTOM_POS_PREFIX}$entityId", "$x,$y").apply()
    }

    /**
     * Clear custom position for an entity (also drops its pin so a cleared
     * position is never left "pinned" to a stale spot).
     */
    fun clearCustomPosition(entityId: Int) {
        prefs.edit()
            .remove("${KEY_CUSTOM_POS_PREFIX}$entityId")
            .remove("${KEY_PINNED_PREFIX}$entityId")
            .apply()
    }

    /**
     * Clear all custom positions (reset to defaults).
     *
     * Scans the actual stored keys instead of a hardcoded 0..7 slot range. The
     * old range silently skipped entity ids >= 8 (e.g. entity #10) so their
     * custom_pos / pin orphaned forever — the configured-vs-displayed desync for
     * high-id entities (card wallpaper-drag-pin, B3). Also clears the matching
     * pin so a reset truly returns the entity to free/default layout.
     */
    fun clearAllCustomPositions() {
        val editor = prefs.edit()
        prefs.all.keys
            .filter { it.startsWith(KEY_CUSTOM_POS_PREFIX) || it.startsWith(KEY_PINNED_PREFIX) }
            .forEach { editor.remove(it) }
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
     * Clear all custom scales (reset to defaults).
     *
     * Key-scan (not 0..7) so entity ids >= 8 (e.g. entity #10) are cleared too
     * — same #10-orphan fix as [clearAllCustomPositions] (card wallpaper-drag-pin, B3).
     */
    fun clearAllEntityScales() {
        val editor = prefs.edit()
        prefs.all.keys
            .filter { it.startsWith(KEY_ENTITY_SCALE_PREFIX) }
            .forEach { editor.remove(it) }
        editor.apply()
    }

    // ============================================================
    // PINNED POSITION (HARD PIN) — owner decision: a dragged/dropped
    // position becomes a LOCK. A pinned entity stops EXACTLY at its
    // custom_pos and does not wander/retarget/gather around it. The flag
    // is per-entity and read by the wander loop (WallpaperWanderController)
    // and the renderer.
    // ============================================================

    /** Whether [entityId] is pinned (held exactly at its custom position). */
    fun isPinned(entityId: Int): Boolean {
        return prefs.getBoolean("${KEY_PINNED_PREFIX}$entityId", false)
    }

    /** Set or clear the pin for [entityId]. */
    fun setPinned(entityId: Int, pinned: Boolean) {
        if (pinned) {
            prefs.edit().putBoolean("${KEY_PINNED_PREFIX}$entityId", true).apply()
        } else {
            prefs.edit().remove("${KEY_PINNED_PREFIX}$entityId").apply()
        }
    }

    /** All currently-pinned entity ids (scans actual keys; not slot-limited). */
    fun getPinnedEntityIds(): Set<Int> {
        return prefs.all.keys
            .filter { it.startsWith(KEY_PINNED_PREFIX) && prefs.getBoolean(it, false) }
            .mapNotNull { it.removePrefix(KEY_PINNED_PREFIX).toIntOrNull() }
            .toSet()
    }

    /** True if ANY entity has a saved custom position or pin. */
    fun hasAnyCustomOrPinnedPosition(): Boolean {
        return prefs.all.keys.any {
            (it.startsWith(KEY_CUSTOM_POS_PREFIX)) ||
                (it.startsWith(KEY_PINNED_PREFIX) && prefs.getBoolean(it, false))
        }
    }

    /**
     * Atomically pin [entityId] at (xPercent,yPercent): persist the custom
     * position, set the pin, and enable custom layout so the renderer honors it.
     * This is the single write the live-wallpaper drag commit performs.
     */
    fun pinAt(entityId: Int, xPercent: Float, yPercent: Float) {
        val x = xPercent.coerceIn(0.05f, 0.95f)
        val y = yPercent.coerceIn(0.05f, 0.95f)
        prefs.edit()
            .putString("${KEY_CUSTOM_POS_PREFIX}$entityId", "$x,$y")
            .putBoolean("${KEY_PINNED_PREFIX}$entityId", true)
            .putBoolean(KEY_USE_CUSTOM_LAYOUT, true)
            .apply()
    }

    /**
     * Migrate custom positions, scales, and registered entity IDs after a reorder.
     * @param permutation order[newSlot] = oldSlot (same semantics as the reorder API)
     */
    fun migrateEntityOrder(permutation: IntArray) {
        // 1. Snapshot old positions, scales, and pins
        val oldPositions = mutableMapOf<Int, String?>()
        val oldScales = mutableMapOf<Int, Float?>()
        val oldPinned = mutableMapOf<Int, Boolean>()
        for (oldSlot in permutation) {
            oldPositions[oldSlot] = prefs.getString("${KEY_CUSTOM_POS_PREFIX}$oldSlot", null)
            val scaleKey = "${KEY_ENTITY_SCALE_PREFIX}$oldSlot"
            oldScales[oldSlot] = if (prefs.contains(scaleKey)) prefs.getFloat(scaleKey, 1.0f) else null
            oldPinned[oldSlot] = prefs.getBoolean("${KEY_PINNED_PREFIX}$oldSlot", false)
        }

        // 2. Apply to new slots
        val editor = prefs.edit()
        for (newSlot in permutation.indices) {
            val oldSlot = permutation[newSlot]
            // Custom position
            val posStr = oldPositions[oldSlot]
            if (posStr != null) {
                editor.putString("${KEY_CUSTOM_POS_PREFIX}$newSlot", posStr)
            } else {
                editor.remove("${KEY_CUSTOM_POS_PREFIX}$newSlot")
            }
            // Entity scale
            val scale = oldScales[oldSlot]
            if (scale != null) {
                editor.putFloat("${KEY_ENTITY_SCALE_PREFIX}$newSlot", scale)
            } else {
                editor.remove("${KEY_ENTITY_SCALE_PREFIX}$newSlot")
            }
            // Pin (HARD PIN follows the entity through a reorder)
            if (oldPinned[oldSlot] == true) {
                editor.putBoolean("${KEY_PINNED_PREFIX}$newSlot", true)
            } else {
                editor.remove("${KEY_PINNED_PREFIX}$newSlot")
            }
        }

        // 3. Rebuild registered entity IDs through permutation
        val oldRegistered = getRegisteredEntityIds()
        val newRegistered = mutableSetOf<Int>()
        for (newSlot in permutation.indices) {
            val oldSlot = permutation[newSlot]
            if (oldRegistered.contains(oldSlot)) {
                newRegistered.add(newSlot)
            }
        }
        editor.putStringSet(KEY_REGISTERED_ENTITIES, newRegistered.map { it.toString() }.toSet())

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

    /**
     * Server-provided entity limit. Updated from /api/entities response.
     * Free users: 4, Premium users: 8.
     */
    var serverEntityLimit: Int
        get() = prefs.getInt(KEY_SERVER_ENTITY_LIMIT, 4)
        set(value) {
            prefs.edit().putInt(KEY_SERVER_ENTITY_LIMIT, value.coerceIn(4, 8)).apply()
        }

    /**
     * Device-level wallpaper walking toggle. This intentionally lives in the
     * wallpaper/layout preference file rather than per-entity state: one device
     * can choose whether its wallpaper entities wander without changing server
     * or entity settings for other devices.
     */
    var wallpaperWalkingEnabled: Boolean
        get() = prefs.getBoolean(KEY_WALLPAPER_WALKING_ENABLED, true) && !isAnimatorDurationDisabled()
        set(value) {
            prefs.edit().putBoolean(KEY_WALLPAPER_WALKING_ENABLED, value).apply()
        }

    var wallpaperPurposefulWalkingEnabled: Boolean
        get() = prefs.getBoolean(KEY_WALLPAPER_PURPOSEFUL_WALKING_ENABLED, true)
        set(value) {
            prefs.edit().putBoolean(KEY_WALLPAPER_PURPOSEFUL_WALKING_ENABLED, value).apply()
        }

    var wallpaperEntityInteractionsEnabled: Boolean
        get() = prefs.getBoolean(KEY_WALLPAPER_ENTITY_INTERACTIONS_ENABLED, true)
        set(value) {
            prefs.edit().putBoolean(KEY_WALLPAPER_ENTITY_INTERACTIONS_ENABLED, value).apply()
        }

    var wallpaperSpeechBubblesEnabled: Boolean
        get() = prefs.getBoolean(KEY_WALLPAPER_SPEECH_BUBBLES_ENABLED, true)
        set(value) {
            prefs.edit().putBoolean(KEY_WALLPAPER_SPEECH_BUBBLES_ENABLED, value).apply()
        }

    var wallpaperBubbleDurationSeconds: Int
        get() = prefs.getInt(
            KEY_WALLPAPER_BUBBLE_DURATION_SECONDS,
            WALLPAPER_BUBBLE_DURATION_DEFAULT_SECONDS
        ).coerceIn(
            WALLPAPER_BUBBLE_DURATION_MIN_SECONDS,
            WALLPAPER_BUBBLE_DURATION_MAX_SECONDS
        )
        set(value) {
            prefs.edit().putInt(
                KEY_WALLPAPER_BUBBLE_DURATION_SECONDS,
                value.coerceIn(
                    WALLPAPER_BUBBLE_DURATION_MIN_SECONDS,
                    WALLPAPER_BUBBLE_DURATION_MAX_SECONDS
                )
            ).apply()
        }

    val wallpaperBubbleDurationMs: Long
        get() = wallpaperBubbleDurationSeconds * 1_000L

    var wallpaperCollisionReactionDurationSeconds: Int
        get() = prefs.getInt(
            KEY_WALLPAPER_COLLISION_REACTION_DURATION_SECONDS,
            WALLPAPER_COLLISION_REACTION_DURATION_DEFAULT_SECONDS
        ).coerceIn(
            WALLPAPER_COLLISION_REACTION_DURATION_MIN_SECONDS,
            WALLPAPER_COLLISION_REACTION_DURATION_MAX_SECONDS
        )
        set(value) {
            prefs.edit().putInt(
                KEY_WALLPAPER_COLLISION_REACTION_DURATION_SECONDS,
                value.coerceIn(
                    WALLPAPER_COLLISION_REACTION_DURATION_MIN_SECONDS,
                    WALLPAPER_COLLISION_REACTION_DURATION_MAX_SECONDS
                )
            ).apply()
        }

    val wallpaperCollisionReactionDurationMs: Long
        get() = wallpaperCollisionReactionDurationSeconds * 1_000L

    var wallpaperBubblePulseEnabled: Boolean
        get() = prefs.getBoolean(KEY_WALLPAPER_BUBBLE_PULSE_ENABLED, true)
        set(value) {
            prefs.edit().putBoolean(KEY_WALLPAPER_BUBBLE_PULSE_ENABLED, value).apply()
        }

    var wallpaperBubbleOverlayAvoidanceEnabled: Boolean
        get() = prefs.getBoolean(KEY_WALLPAPER_BUBBLE_OVERLAY_AVOIDANCE_ENABLED, true)
        set(value) {
            prefs.edit().putBoolean(KEY_WALLPAPER_BUBBLE_OVERLAY_AVOIDANCE_ENABLED, value).apply()
        }

    var wallpaperStateAuraEnabled: Boolean
        get() = prefs.getBoolean(KEY_WALLPAPER_STATE_AURA_ENABLED, true)
        set(value) {
            prefs.edit().putBoolean(KEY_WALLPAPER_STATE_AURA_ENABLED, value).apply()
        }

    var wallpaperGroundShadowEnabled: Boolean
        get() = prefs.getBoolean(KEY_WALLPAPER_GROUND_SHADOW_ENABLED, true)
        set(value) {
            prefs.edit().putBoolean(KEY_WALLPAPER_GROUND_SHADOW_ENABLED, value).apply()
        }

    var wallpaperAdaptiveEffectsEnabled: Boolean
        get() = prefs.getBoolean(KEY_WALLPAPER_ADAPTIVE_EFFECTS_ENABLED, true)
        set(value) {
            prefs.edit().putBoolean(KEY_WALLPAPER_ADAPTIVE_EFFECTS_ENABLED, value).apply()
        }

    var wallpaperOfflineEntityCacheEnabled: Boolean
        get() = prefs.getBoolean(KEY_WALLPAPER_OFFLINE_ENTITY_CACHE_ENABLED, true)
        set(value) {
            prefs.edit().putBoolean(KEY_WALLPAPER_OFFLINE_ENTITY_CACHE_ENABLED, value).apply()
        }

    var wallpaperKanbanTasksEnabled: Boolean
        get() = prefs.getBoolean(KEY_WALLPAPER_KANBAN_TASKS_ENABLED, true)
        set(value) {
            prefs.edit().putBoolean(KEY_WALLPAPER_KANBAN_TASKS_ENABLED, value).apply()
        }

    var wallpaperKanbanAutomationBoardEnabled: Boolean
        get() = prefs.getBoolean(KEY_WALLPAPER_KANBAN_AUTOMATION_BOARD_ENABLED, true)
        set(value) {
            prefs.edit().putBoolean(KEY_WALLPAPER_KANBAN_AUTOMATION_BOARD_ENABLED, value).apply()
        }

    var wallpaperKanbanPrivacyModeEnabled: Boolean
        get() = prefs.getBoolean(KEY_WALLPAPER_KANBAN_PRIVACY_MODE_ENABLED, false)
        set(value) {
            prefs.edit().putBoolean(KEY_WALLPAPER_KANBAN_PRIVACY_MODE_ENABLED, value).apply()
        }

    var wallpaperKanbanObjectStyle: WallpaperKanbanObjectStyle
        get() {
            val name = prefs.getString(KEY_WALLPAPER_KANBAN_OBJECT_STYLE, WallpaperKanbanObjectStyle.SMART_MIX.name)
            return try {
                WallpaperKanbanObjectStyle.valueOf(name ?: WallpaperKanbanObjectStyle.SMART_MIX.name)
            } catch (e: Exception) {
                WallpaperKanbanObjectStyle.SMART_MIX
            }
        }
        set(value) {
            prefs.edit().putString(KEY_WALLPAPER_KANBAN_OBJECT_STYLE, value.name).apply()
        }

    var wallpaperKanbanAssetWhiteboardEnabled: Boolean
        get() = prefs.getBoolean(KEY_WALLPAPER_KANBAN_ASSET_WHITEBOARD_ENABLED, true)
        set(value) {
            prefs.edit().putBoolean(KEY_WALLPAPER_KANBAN_ASSET_WHITEBOARD_ENABLED, value).apply()
        }

    var wallpaperKanbanHandwrittenBoardTextEnabled: Boolean
        get() = prefs.getBoolean(KEY_WALLPAPER_KANBAN_HANDWRITTEN_BOARD_TEXT_ENABLED, true)
        set(value) {
            prefs.edit().putBoolean(KEY_WALLPAPER_KANBAN_HANDWRITTEN_BOARD_TEXT_ENABLED, value).apply()
        }

    var usageOverlayEnabled: Boolean
        get() = prefs.getBoolean(KEY_USAGE_OVERLAY_ENABLED, true)
        set(value) {
            prefs.edit().putBoolean(KEY_USAGE_OVERLAY_ENABLED, value).apply()
        }

    var usageOverlayPosition: UsageOverlayPosition
        get() {
            val name = prefs.getString(KEY_USAGE_OVERLAY_POSITION, UsageOverlayPosition.TOP_RIGHT.name)
            return try {
                UsageOverlayPosition.valueOf(name ?: UsageOverlayPosition.TOP_RIGHT.name)
            } catch (e: Exception) {
                UsageOverlayPosition.TOP_RIGHT
            }
        }
        set(value) {
            prefs.edit().putString(KEY_USAGE_OVERLAY_POSITION, value.name).apply()
        }

    fun getUsageOverlayCenter(): Pair<Float, Float>? {
        val posStr = prefs.getString(KEY_USAGE_OVERLAY_CENTER, null)
        return posStr?.split(",")?.let {
            if (it.size == 2) {
                val x = it[0].toFloatOrNull() ?: return null
                val y = it[1].toFloatOrNull() ?: return null
                Pair(x, y)
            } else null
        }
    }

    fun setUsageOverlayCenter(xPercent: Float, yPercent: Float) {
        val x = xPercent.coerceIn(0.05f, 0.95f)
        val y = yPercent.coerceIn(0.05f, 0.95f)
        prefs.edit().putString(KEY_USAGE_OVERLAY_CENTER, "$x,$y").apply()
    }

    var usageOverlayScale: Float
        get() = prefs.getFloat(KEY_USAGE_OVERLAY_SCALE, 1.0f)
        set(value) {
            prefs.edit().putFloat(KEY_USAGE_OVERLAY_SCALE, value.coerceIn(0.75f, 1.8f)).apply()
        }

    fun clearUsageOverlayTransform() {
        prefs.edit()
            .remove(KEY_USAGE_OVERLAY_CENTER)
            .remove(KEY_USAGE_OVERLAY_SCALE)
            .apply()
    }

    var usageOverlayShowClaude: Boolean
        get() = prefs.getBoolean(KEY_USAGE_OVERLAY_SHOW_CLAUDE, true)
        set(value) {
            prefs.edit().putBoolean(KEY_USAGE_OVERLAY_SHOW_CLAUDE, value).apply()
        }

    var usageOverlayShowCodex: Boolean
        get() = prefs.getBoolean(KEY_USAGE_OVERLAY_SHOW_CODEX, true)
        set(value) {
            prefs.edit().putBoolean(KEY_USAGE_OVERLAY_SHOW_CODEX, value).apply()
        }

    var usageOverlayShowSession: Boolean
        get() = prefs.getBoolean(KEY_USAGE_OVERLAY_SHOW_SESSION, true)
        set(value) {
            prefs.edit().putBoolean(KEY_USAGE_OVERLAY_SHOW_SESSION, value).apply()
        }

    var usageOverlayShowWeekly: Boolean
        get() = prefs.getBoolean(KEY_USAGE_OVERLAY_SHOW_WEEKLY, true)
        set(value) {
            prefs.edit().putBoolean(KEY_USAGE_OVERLAY_SHOW_WEEKLY, value).apply()
        }

    var wallpaperResetShowFiveHour: Boolean
        get() {
            if (prefs.contains(KEY_WALLPAPER_RESET_SHOW_5H)) {
                return prefs.getBoolean(KEY_WALLPAPER_RESET_SHOW_5H, false)
            }
            if (prefs.contains(KEY_WALLPAPER_RESET_WINDOW)) {
                return legacyResetWindowValue() in listOf(RESET_WINDOW_5H, RESET_WINDOW_5H_WEEKLY)
            }
            // New user with no prefs ever set: default both 5h and Weekly to ON.
            // Why: a fresh user should see countdowns by default; the only way to
            // get both off is an explicit user toggle, not a silent first-launch state.
            return true
        }
        set(value) {
            writeResetWindowSelection(value, wallpaperResetShowWeekly)
        }

    var wallpaperResetShowWeekly: Boolean
        get() {
            if (prefs.contains(KEY_WALLPAPER_RESET_SHOW_WEEKLY)) {
                return prefs.getBoolean(KEY_WALLPAPER_RESET_SHOW_WEEKLY, false)
            }
            if (prefs.contains(KEY_WALLPAPER_RESET_WINDOW)) {
                return legacyResetWindowValue() in listOf(RESET_WINDOW_WEEKLY, RESET_WINDOW_5H_WEEKLY)
            }
            return true
        }
        set(value) {
            writeResetWindowSelection(wallpaperResetShowFiveHour, value)
        }

    var wallpaperResetWindow: String
        get() = resetWindowValue(wallpaperResetShowFiveHour, wallpaperResetShowWeekly)
        set(value) {
            val showFiveHour = value in listOf(RESET_WINDOW_5H, RESET_WINDOW_5H_WEEKLY)
            val showWeekly = value in listOf(RESET_WINDOW_WEEKLY, RESET_WINDOW_5H_WEEKLY)
            writeResetWindowSelection(showFiveHour, showWeekly)
        }

    private fun legacyResetWindowValue(): String {
        return prefs.getString(KEY_WALLPAPER_RESET_WINDOW, RESET_WINDOW_OFF) ?: RESET_WINDOW_OFF
    }

    private fun writeResetWindowSelection(showFiveHour: Boolean, showWeekly: Boolean) {
        prefs.edit()
            .putBoolean(KEY_WALLPAPER_RESET_SHOW_5H, showFiveHour)
            .putBoolean(KEY_WALLPAPER_RESET_SHOW_WEEKLY, showWeekly)
            .putString(KEY_WALLPAPER_RESET_WINDOW, resetWindowValue(showFiveHour, showWeekly))
            .apply()
    }

    private fun resetWindowValue(showFiveHour: Boolean, showWeekly: Boolean): String {
        return when {
            showFiveHour && showWeekly -> RESET_WINDOW_5H_WEEKLY
            showFiveHour -> RESET_WINDOW_5H
            showWeekly -> RESET_WINDOW_WEEKLY
            else -> RESET_WINDOW_OFF
        }
    }

    private fun isAnimatorDurationDisabled(): Boolean {
        val ctx = appContext ?: return false
        return try {
            Settings.Global.getFloat(
                ctx.contentResolver,
                Settings.Global.ANIMATOR_DURATION_SCALE,
                1f
            ) == 0f
        } catch (e: Exception) {
            false
        }
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
        private const val KEY_PINNED_PREFIX = "pinned_"
        private const val KEY_USE_BACKGROUND_IMAGE = "use_background_image"
        private const val KEY_BACKGROUND_URI = "background_image_uri"
        private const val KEY_DEBUG_ENTITY_LIMIT = "debug_entity_limit"
        private const val KEY_SERVER_ENTITY_LIMIT = "server_entity_limit"
        private const val KEY_WALLPAPER_WALKING_ENABLED = "wallpaper_walking_enabled"
        private const val KEY_WALLPAPER_PURPOSEFUL_WALKING_ENABLED = "wallpaper_purposeful_walking_enabled"
        private const val KEY_WALLPAPER_ENTITY_INTERACTIONS_ENABLED = "wallpaper_entity_interactions_enabled"
        private const val KEY_WALLPAPER_SPEECH_BUBBLES_ENABLED = "wallpaper_speech_bubbles_enabled"
        private const val KEY_WALLPAPER_BUBBLE_DURATION_SECONDS = "wallpaper_bubble_duration_seconds"
        private const val KEY_WALLPAPER_COLLISION_REACTION_DURATION_SECONDS = "wallpaper_collision_reaction_duration_seconds"
        private const val KEY_WALLPAPER_BUBBLE_PULSE_ENABLED = "wallpaper_bubble_pulse_enabled"
        private const val KEY_WALLPAPER_BUBBLE_OVERLAY_AVOIDANCE_ENABLED = "wallpaper_bubble_overlay_avoidance_enabled"
        private const val KEY_WALLPAPER_STATE_AURA_ENABLED = "wallpaper_state_aura_enabled"
        private const val KEY_WALLPAPER_GROUND_SHADOW_ENABLED = "wallpaper_ground_shadow_enabled"
        private const val KEY_WALLPAPER_ADAPTIVE_EFFECTS_ENABLED = "wallpaper_adaptive_effects_enabled"
        private const val KEY_WALLPAPER_OFFLINE_ENTITY_CACHE_ENABLED = "wallpaper_offline_entity_cache_enabled"
        private const val KEY_WALLPAPER_KANBAN_TASKS_ENABLED = "wallpaper_kanban_tasks_enabled"
        private const val KEY_WALLPAPER_KANBAN_AUTOMATION_BOARD_ENABLED = "wallpaper_kanban_automation_board_enabled"
        private const val KEY_WALLPAPER_KANBAN_PRIVACY_MODE_ENABLED = "wallpaper_kanban_privacy_mode_enabled"
        private const val KEY_WALLPAPER_KANBAN_OBJECT_STYLE = "wallpaper_kanban_object_style"
        private const val KEY_WALLPAPER_KANBAN_ASSET_WHITEBOARD_ENABLED = "wallpaper_kanban_asset_whiteboard_enabled"
        private const val KEY_WALLPAPER_KANBAN_HANDWRITTEN_BOARD_TEXT_ENABLED = "wallpaper_kanban_handwritten_board_text_enabled"
        private const val KEY_USAGE_OVERLAY_ENABLED = "usage_overlay_enabled"
        private const val KEY_USAGE_OVERLAY_POSITION = "usage_overlay_position"
        private const val KEY_USAGE_OVERLAY_CENTER = "usage_overlay_center"
        private const val KEY_USAGE_OVERLAY_SCALE = "usage_overlay_scale"
        private const val KEY_USAGE_OVERLAY_SHOW_CLAUDE = "usage_overlay_show_claude"
        private const val KEY_USAGE_OVERLAY_SHOW_CODEX = "usage_overlay_show_codex"
        private const val KEY_USAGE_OVERLAY_SHOW_SESSION = "usage_overlay_show_session"
        private const val KEY_USAGE_OVERLAY_SHOW_WEEKLY = "usage_overlay_show_weekly"
        private const val KEY_WALLPAPER_RESET_WINDOW = "wallpaper_reset_window"
        private const val KEY_WALLPAPER_RESET_SHOW_5H = "wallpaper_reset_show_5h"
        private const val KEY_WALLPAPER_RESET_SHOW_WEEKLY = "wallpaper_reset_show_weekly"

        const val RESET_WINDOW_OFF = "off"
        const val RESET_WINDOW_5H = "5h"
        const val RESET_WINDOW_WEEKLY = "weekly"
        const val RESET_WINDOW_5H_WEEKLY = "5h_weekly"

        const val WALLPAPER_BUBBLE_DURATION_MIN_SECONDS = 1
        // Max raised 20s → 600s (10 min) per Hank request (card_c421110c). This
        // single constant drives both the setter clamp (coerceIn below) and the
        // WallpaperMoreSettings slider's valueTo, so the slider now reaches 10 min;
        // secondsLabel() already renders ≥60s as "N 分鐘 / N 分 M 秒".
        const val WALLPAPER_BUBBLE_DURATION_MAX_SECONDS = 600
        const val WALLPAPER_BUBBLE_DURATION_DEFAULT_SECONDS = 5
        const val WALLPAPER_COLLISION_REACTION_DURATION_MIN_SECONDS = 1
        const val WALLPAPER_COLLISION_REACTION_DURATION_MAX_SECONDS = 20
        const val WALLPAPER_COLLISION_REACTION_DURATION_DEFAULT_SECONDS = 5

        // Display mode constants
        const val MODE_SINGLE = 1
        const val MODE_DUAL = 2
        const val MODE_QUAD = 4

        @Volatile
        private var instance: LayoutPreferences? = null

        fun getInstance(context: Context): LayoutPreferences {
            return instance ?: synchronized(this) {
                instance ?: LayoutPreferences(
                    context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE),
                    context.applicationContext
                ).also { instance = it }
            }
        }

        /**
         * Build a standalone instance backed by the supplied [SharedPreferences]
         * for unit tests (no Android Context / animator-scale probe). Does NOT
         * touch the process-wide singleton.
         */
        @JvmStatic
        fun forTesting(prefs: SharedPreferences): LayoutPreferences =
            LayoutPreferences(prefs, null)
    }
}
