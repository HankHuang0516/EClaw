package com.hank.clawlive.data.model

import com.google.gson.annotations.SerializedName

/**
 * Response from GET /api/entities containing all active entities.
 */
data class MultiEntityResponse(
    val entities: List<EntityStatus> = emptyList(),
    val activeCount: Int = 0,
    @SerializedName("maxEntitiesPerDevice")
    val maxEntities: Int = 4,
    val serverReady: Boolean = true
)
