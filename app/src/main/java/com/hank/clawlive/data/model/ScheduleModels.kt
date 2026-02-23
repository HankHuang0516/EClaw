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

data class ExecutionContextResponse(
    val success: Boolean,
    val execution: ExecutionDetail? = null,
    val scheduledMessage: ExecutionChatMessage? = null,
    val botReplies: List<ExecutionChatMessage> = emptyList(),
    val error: String? = null
)

data class ExecutionDetail(
    val id: Int,
    @SerializedName("schedule_id") val scheduleId: Int?,
    @SerializedName("device_id") val deviceId: String,
    @SerializedName("entity_id") val entityId: Int,
    val message: String,
    @SerializedName("executed_at") val executedAt: String?,
    val result: String? = null,
    @SerializedName("result_status") val resultStatus: String? = null,
    val label: String? = null
)

data class ExecutionChatMessage(
    val id: String,
    @SerializedName("entity_id") val entityId: Int?,
    val text: String,
    val source: String? = null,
    @SerializedName("created_at") val createdAt: String?,
    @SerializedName("is_from_bot") val isFromBot: Boolean = false,
    @SerializedName("schedule_label") val scheduleLabel: String? = null
)
