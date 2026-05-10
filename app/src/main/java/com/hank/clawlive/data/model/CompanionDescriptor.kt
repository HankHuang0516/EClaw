package com.hank.clawlive.data.model

import com.google.gson.JsonElement
import com.google.gson.JsonObject

/**
 * Petdx Companion descriptor — Android-side mirror of the JSON returned by
 * GET /api/companion/current and /api/companion/:id. Spec:
 * docs/specs/petdx-uiux-spec.md §2.1 + petdx-backend-api-spec.md §3.5.
 *
 * Field shape mirrors backend `rowToCompanionDetail()`:
 * { id, name, assetType, descriptor:{asset, stateAssets, ...}, assetUrl, ... }
 */
data class CompanionCurrentResponse(
    val success: Boolean = false,
    val selection: CompanionSelection? = null,
    val favorites: List<CompanionFavorite> = emptyList(),
    val error: String? = null
)

data class CompanionSelection(
    val selectedAt: Long = 0,
    val source: String? = null,
    val companion: CompanionDetail? = null
)

data class CompanionFavorite(
    val companionId: String,
    val favoritedAt: Long = 0
)

/**
 * Companion catalog row — flat fields stored in `companions` table plus the
 * `descriptor` JSONB blob with extended creator-supplied params.
 */
data class CompanionDetail(
    val id: String,
    val name: String,
    val version: String? = null,
    val avatarUrl: String? = null,
    val thumbnailUrl: String? = null,
    val assetType: String = "procedural", // procedural | spritesheet | vector
    val assetUrl: String? = null,
    val supportedStates: List<String> = listOf("IDLE"),
    val mood: String? = null,
    val color: String? = null,
    val category: String? = null,
    val tags: List<String> = emptyList(),
    val scope: String? = null,
    val status: String? = null,
    /**
     * Full descriptor JSON — `asset.params`, `stateAssets`, `i18n` etc. live here.
     * Kept as JsonObject so we can read creator-extended fields without exhaustively
     * modeling every key (spec §2.3 allows arbitrary state names).
     */
    val descriptor: JsonObject? = null
) {
    /** Extract `descriptor.asset.params` as a plain map for procedural drawers. */
    fun proceduralParams(): Map<String, JsonElement> {
        val asset = descriptor?.getAsJsonObject("asset") ?: return emptyMap()
        val params = asset.getAsJsonObject("params") ?: return emptyMap()
        return params.entrySet().associate { it.key to it.value }
    }

    /**
     * State asset hint (loop/fps/row/frames) for a given state, or IDLE fallback,
     * or null if not declared.
     */
    fun stateAsset(state: String): StateAssetHint? {
        val sa = descriptor?.getAsJsonObject("stateAssets") ?: return null
        val key = if (sa.has(state)) state else "IDLE"
        val obj = sa.getAsJsonObject(key) ?: return null
        return StateAssetHint(
            loop = obj.get("loop")?.asBoolean ?: true,
            fps = obj.get("fps")?.asInt ?: 4,
            row = obj.get("row")?.asInt ?: 0,
            frames = obj.get("frames")?.asInt ?: 1
        )
    }

    /** Dimensions of one frame in the spritesheet. Defaults to 128×128 if unspecified. */
    fun spritesheetFrameSize(): Pair<Int, Int> {
        val asset = descriptor?.getAsJsonObject("asset") ?: return 128 to 128
        val w = asset.get("frameWidth")?.asInt ?: 128
        val h = asset.get("frameHeight")?.asInt ?: 128
        return w to h
    }

    /** Direct URL of the spritesheet image (overrides top-level assetUrl). */
    fun spritesheetUrl(): String? {
        val asset = descriptor?.getAsJsonObject("asset") ?: return assetUrl
        return asset.get("sheetUrl")?.asString ?: assetUrl
    }

    /**
     * Procedural renderer key (e.g. "lobster-procedural", "cat-procedural").
     * Spec §4.3 — drives ProceduralCreatureDrawer dispatch.
     */
    fun proceduralRenderer(): String? {
        val asset = descriptor?.getAsJsonObject("asset") ?: return null
        return asset.get("renderer")?.asString
    }
}

data class StateAssetHint(
    val loop: Boolean = true,
    val fps: Int = 4,
    val row: Int = 0,
    val frames: Int = 1
)
