package com.hank.clawlive.data.model

data class WallpaperKanbanCardsResponse(
    val success: Boolean = false,
    val cards: List<WallpaperKanbanCard> = emptyList()
)

data class WallpaperKanbanCard(
    val id: String = "",
    val title: String = "",
    val priority: String = "P2",
    val status: String = "todo",
    val assignedBots: List<Int> = emptyList(),
    val archived: Boolean = false,
    val updatedAt: Long? = null,
    val statusChangedAt: Long? = null,
    val isAutomation: Boolean = false,
    val schedule: WallpaperKanbanSchedule? = null
)

data class WallpaperKanbanSchedule(
    val enabled: Boolean = false,
    val type: String? = null,
    val nextRunAt: Long? = null,
    val timezone: String? = null
)
