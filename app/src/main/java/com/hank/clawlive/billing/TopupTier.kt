package com.hank.clawlive.billing

/**
 * Represents a top-up tier for e-coin purchase display.
 */
data class TopupTier(
    val productId: String,
    val formattedPrice: String,
    val baseEcoin: Int,
    val bonusPercent: Int
) {
    /** Total e-coins including bonus */
    val totalEcoin: Int
        get() = baseEcoin + (baseEcoin * bonusPercent / 100)

    /** Bonus e-coins */
    val bonusEcoin: Int
        get() = baseEcoin * bonusPercent / 100

    /** Display label for the tier */
    val label: String
        get() = when (productId) {
            "ec.topup.small" -> "Small"
            "ec.topup.starter" -> "Starter"
            "ec.topup.standard" -> "Standard"
            "ec.topup.advanced" -> "Advanced"
            "ec.topup.premium" -> "Premium"
            else -> productId
        }
}
