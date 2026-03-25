package com.hank.clawlive.billing

/**
 * Represents the current subscription state for UI display
 */
data class SubscriptionState(
    val isPremium: Boolean = false,
    val usageToday: Int = 0,
    val usageLimit: Int = 25,
    val canSendMessage: Boolean = true,
    val subscriptionPrice: String = "",
    val hasBorrowSubscription: Boolean = false,
    val borrowSubscriptionPrice: String = ""
) {
    /**
     * Usage display string (e.g., "5" or "∞")
     */
    val usageDisplay: String
        get() = if (isPremium) "∞" else "$usageToday"

    /**
     * Usage progress for progress bar (0.0 to 1.0)
     */
    val usageProgress: Float
        get() = if (isPremium) 0f else (usageToday.toFloat() / usageLimit).coerceIn(0f, 1f)

    /**
     * Whether limit is reached
     */
    val isLimitReached: Boolean
        get() = !isPremium && usageToday >= usageLimit
}
