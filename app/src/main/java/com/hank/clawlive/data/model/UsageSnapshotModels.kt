package com.hank.clawlive.data.model

import com.google.gson.annotations.SerializedName

data class UsageSnapshotResponse(
    val success: Boolean = false,
    val latest: UsageSnapshotLatest? = null,
    val aggregates: UsageSnapshotAggregates? = null,
    val error: String? = null
)

data class UsageSnapshotLatest(
    val id: Long? = null,
    val deviceId: String? = null,
    val entityId: Int? = null,
    @SerializedName("captured_at") val capturedAt: String? = null,
    @SerializedName("received_at") val receivedAt: String? = null,
    @SerializedName("daemon_version") val daemonVersion: String? = null,
    @SerializedName("pricing_source") val pricingSource: String? = null,
    val claude: UsageSnapshotEngine? = null,
    val codex: UsageSnapshotEngine? = null
)

data class UsageSnapshotEngine(
    val live: UsageLiveStatus? = null,
    @SerializedName("rate_limits") val rateLimits: CodexRateLimits? = null,
    val sessions: List<UsageSessionSummary> = emptyList()
)

data class UsageLiveStatus(
    @SerializedName("five_hour_pct") val fiveHourPct: Double? = null,
    @SerializedName("seven_day_pct") val sevenDayPct: Double? = null,
    @SerializedName("rate_limits") val rateLimits: ClaudeRateLimitWindows? = null
)

data class ClaudeRateLimitWindows(
    @SerializedName("five_hour") val fiveHour: UsageRateLimitWindow? = null,
    @SerializedName("seven_day") val sevenDay: UsageRateLimitWindow? = null
)

data class UsageRateLimitWindow(
    @SerializedName("used_percentage") val usedPercentage: Double? = null,
    @SerializedName("resets_at") val resetsAt: Double? = null
)

data class CodexRateLimits(
    @SerializedName("five_hour_pct") val fiveHourPct: Double? = null,
    @SerializedName("five_hour_resets_at") val fiveHourResetsAt: Double? = null,
    @SerializedName("seven_day_pct") val sevenDayPct: Double? = null,
    @SerializedName("seven_day_resets_at") val sevenDayResetsAt: Double? = null,
    @SerializedName("plan_type") val planType: String? = null,
    @SerializedName("updated_at") val updatedAt: String? = null
)

data class UsageSessionSummary(
    @SerializedName("session_id") val sessionId: String? = null,
    val cwd: String? = null,
    @SerializedName("input_tokens") val inputTokens: Long? = null,
    @SerializedName("output_tokens") val outputTokens: Long? = null,
    @SerializedName("first_seen") val firstSeen: String? = null,
    @SerializedName("last_seen") val lastSeen: String? = null
)

data class UsageSnapshotAggregates(
    val today: UsageAggregateRange? = null,
    val week: UsageAggregateRange? = null,
    val month: UsageAggregateRange? = null
)

data class UsageAggregateRange(
    val claude: UsageAggregateEngine? = null,
    val codex: UsageAggregateEngine? = null,
    @SerializedName("snapshot_count") val snapshotCount: Int = 0
)

data class UsageAggregateEngine(
    @SerializedName("session_count") val sessionCount: Int = 0,
    @SerializedName("sum_input_tokens") val sumInputTokens: Long = 0,
    @SerializedName("sum_output_tokens") val sumOutputTokens: Long = 0,
    @SerializedName("sum_cost_usd") val sumCostUsd: Double = 0.0
)
