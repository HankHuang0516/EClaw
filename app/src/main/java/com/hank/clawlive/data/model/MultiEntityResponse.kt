package com.hank.clawlive.data.model

/**
 * Response from GET /api/entities containing all active entities.
 */
data class MultiEntityResponse(
    val entities: List<EntityStatus> = emptyList(),
    val activeCount: Int = 0,
    val maxEntities: Int = 4,
    val serverReady: Boolean = true
)
