package com.hank.clawlive.data.model

import com.google.gson.annotations.SerializedName

data class ScheduleItem(
    val id: Int,
    @SerializedName("deviceId") val deviceId: String,
    @SerializedName("entityId") val entityId: Int,
    val message: String,
    @SerializedName("scheduledAt") val scheduledAt: String?,
    @SerializedName("repeatType") val repeatType: String = "once",
    @SerializedName("cronExpr") val cronExpr: String? = null,
    val status: String = "pending",
    @SerializedName("createdAt") val createdAt: String? = null,
    @SerializedName("executedAt") val executedAt: String? = null,
    val result: String? = null,
    @SerializedName("resultStatus") val resultStatus: String? = null,
    val label: String? = null
)

data class ScheduleListResponse(
    val success: Boolean,
    val schedules: List<ScheduleItem> = emptyList(),
    val error: String? = null
)

data class ScheduleCreateResponse(
    val success: Boolean,
    val schedule: ScheduleItem? = null,
    val error: String? = null
)

data class ScheduleDeleteResponse(
    val success: Boolean,
    val error: String? = null
)
