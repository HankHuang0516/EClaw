package com.hank.clawlive.billing

import android.content.Context
import com.hank.clawlive.R

/**
 * Represents a top-up tier for e-coin purchase display.
 */
data class TopupTier(
    val productId: String,
    val formattedPrice: String,
    val baseEcoin: Int,
    val bonusPercent: Int
) {
    val totalEcoin: Int
        get() = baseEcoin + (baseEcoin * bonusPercent / 100)

    val bonusEcoin: Int
        get() = baseEcoin * bonusPercent / 100

    /** Localized label resource ID for the tier */
    val labelResId: Int
        get() = when (productId) {
            "ec.topup.small" -> R.string.topup_tier_small
            "ec.topup.starter" -> R.string.topup_tier_starter
            "ec.topup.standard" -> R.string.topup_tier_standard
            "ec.topup.advanced" -> R.string.topup_tier_advanced
            "ec.topup.premium" -> R.string.topup_tier_premium
            else -> R.string.topup_tier_standard
        }

    fun getLabel(context: Context): String = context.getString(labelResId)
}
