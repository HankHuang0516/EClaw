package com.hank.clawlive.billing

import android.app.Activity
import android.content.Context
import com.android.billingclient.api.*
import com.hank.clawlive.BuildConfig
import com.hank.clawlive.R
import com.hank.clawlive.data.local.DeviceManager
import com.hank.clawlive.data.local.LayoutPreferences
import com.hank.clawlive.data.local.UsageManager
import com.hank.clawlive.data.remote.NetworkModule
import com.hank.clawlive.integrity.PlayIntegrityReporter
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import timber.log.Timber
import kotlin.coroutines.resume

/**
 * Manages Google Play Billing for subscriptions and e-coin top-up purchases.
 * Handles connection, purchase, acknowledgment, consumption, and restoration.
 */
class BillingManager(private val context: Context) : PurchasesUpdatedListener {

    companion object {
        // Legacy subscription IDs (kept for migration / existing subscribers)
        const val SUBSCRIPTION_ID = "e_claw_premium"
        const val BORROW_SUBSCRIPTION_ID = "e_claw_borrow_personal"

        // New subscription plan IDs (only starter is live on Google Play for now)
        const val SUB_STARTER_ID = "ec.sub.starter"
        const val SUB_PRO_ID = "" // TODO: create on Google Play when needed
        const val SUB_BUSINESS_ID = "" // TODO: create on Google Play when needed

        // Top-up consumable product IDs (5 tiers with increasing bonuses)
        val TOPUP_PRODUCT_IDS = listOf(
            "ec.topup.small",      // $0.99 → 3,000 e幣 (0%)
            "ec.topup.starter",    // $2.99 → 9,450 e幣 (+5%)
            "ec.topup.standard",   // $4.99 → 16,200 e幣 (+8%)
            "ec.topup.advanced",   // $9.99 → 33,600 e幣 (+12%)
            "ec.topup.premium"     // $19.99 → 69,000 e幣 (+15%)
        )

        val ALL_SUB_IDS = listOfNotNull(SUBSCRIPTION_ID, BORROW_SUBSCRIPTION_ID, SUB_STARTER_ID)
            .filter { it.isNotEmpty() }

        private const val TAG = "BillingManager"
        private const val ACTION_BILLING_TOPUP = "billing_topup"
        private const val ACTION_SUBSCRIPTION_PURCHASE = "subscription_purchase"
        private const val ACTION_BORROW_SUBSCRIPTION = "borrow_subscription"

        @Volatile
        private var instance: BillingManager? = null

        fun getInstance(context: Context): BillingManager {
            return instance ?: synchronized(this) {
                instance ?: BillingManager(context.applicationContext).also { instance = it }
            }
        }
    }

    private val scope = CoroutineScope(Dispatchers.Main)
    private val usageManager = UsageManager.getInstance(context)
    private val deviceManager = DeviceManager.getInstance(context)
    private val api = NetworkModule.api

    private val _subscriptionState = MutableStateFlow(SubscriptionState())
    val subscriptionState: StateFlow<SubscriptionState> = _subscriptionState.asStateFlow()

    private var billingClient: BillingClient = BillingClient.newBuilder(context)
        .setListener(this)
        .enablePendingPurchases(
            PendingPurchasesParams.newBuilder()
                .enableOneTimeProducts()
                .build()
        )
        .enableAutoServiceReconnection()
        .build()

    private var productDetails: ProductDetails? = null
    private var borrowProductDetails: ProductDetails? = null

    // New subscription plan details
    private var subStarterDetails: ProductDetails? = null
    private var subProDetails: ProductDetails? = null
    private var subBusinessDetails: ProductDetails? = null

    // Top-up consumable product details (keyed by product ID)
    private val topupDetailsMap = mutableMapOf<String, ProductDetails>()

    /** Callback for top-up purchase completion */
    var onTopupComplete: ((productId: String, success: Boolean) -> Unit)? = null

    init {
        connectToBillingService()
    }

    /**
     * Connect to Google Play Billing service
     */
    fun connectToBillingService() {
        if (billingClient.isReady) {
            querySubscriptionStatus()
            return
        }

        billingClient.startConnection(object : BillingClientStateListener {
            override fun onBillingSetupFinished(billingResult: BillingResult) {
                if (billingResult.responseCode == BillingClient.BillingResponseCode.OK) {
                    Timber.tag(TAG).d("Billing service connected")
                    querySubscriptionStatus()
                    queryProductDetails()
                    queryTopupProductDetails()
                    queryStuckTopupPurchases()
                } else {
                    Timber.tag(TAG).e("Billing setup failed: ${billingResult.debugMessage}")
                }
            }

            override fun onBillingServiceDisconnected() {
                Timber.tag(TAG).w("Billing service disconnected")
            }
        })
    }

    /**
     * Query current subscription status
     */
    private fun querySubscriptionStatus() {
        scope.launch {
            val params = QueryPurchasesParams.newBuilder()
                .setProductType(BillingClient.ProductType.SUBS)
                .build()

            billingClient.queryPurchasesAsync(params) { billingResult, purchases ->
                if (billingResult.responseCode == BillingClient.BillingResponseCode.OK) {
                    // Detect any active subscription (legacy or new plans)
                    val activeSub = purchases.firstOrNull { purchase ->
                        purchase.purchaseState == Purchase.PurchaseState.PURCHASED &&
                        purchase.products.any { it in ALL_SUB_IDS }
                    }
                    val hasActiveSubscription = activeSub != null

                    // Determine current plan tier
                    val currentPlan = when {
                        activeSub?.products?.contains(SUB_BUSINESS_ID) == true -> "business"
                        activeSub?.products?.contains(SUB_PRO_ID) == true -> "pro"
                        activeSub?.products?.contains(SUB_STARTER_ID) == true -> "starter"
                        activeSub?.products?.contains(SUBSCRIPTION_ID) == true -> "starter"
                        else -> "free"
                    }

                    val hasBorrowSub = purchases.any { purchase ->
                        purchase.purchaseState == Purchase.PurchaseState.PURCHASED &&
                        purchase.products.contains(BORROW_SUBSCRIPTION_ID)
                    }

                    usageManager.isPremium = hasActiveSubscription
                    _subscriptionState.value = _subscriptionState.value.copy(
                        hasBorrowSubscription = hasBorrowSub,
                        currentPlan = currentPlan
                    )
                    updateState()

                    if (hasActiveSubscription) {
                        val activeProductId = activeSub?.products?.firstOrNull { it in ALL_SUB_IDS }
                        syncPremiumWithServer(activeSub?.purchaseToken, activeProductId)
                    }

                    purchases.filter { !it.isAcknowledged }.forEach { purchase ->
                        acknowledgePurchase(purchase)
                    }

                    Timber.tag(TAG).d("Subscription status: premium=$hasActiveSubscription, plan=$currentPlan, borrow=$hasBorrowSub")
                }
            }
        }
    }

    /**
     * Query subscription product details for display
     */
    private fun queryProductDetails() {
        scope.launch {
            val productList = ALL_SUB_IDS.map { id ->
                QueryProductDetailsParams.Product.newBuilder()
                    .setProductId(id)
                    .setProductType(BillingClient.ProductType.SUBS)
                    .build()
            }

            val params = QueryProductDetailsParams.newBuilder()
                .setProductList(productList)
                .build()

            billingClient.queryProductDetailsAsync(params) { billingResult, queryProductDetailsResult ->
                if (billingResult.responseCode == BillingClient.BillingResponseCode.OK) {
                    val productDetailsList = queryProductDetailsResult.productDetailsList
                    productDetails = productDetailsList.firstOrNull { it.productId == SUBSCRIPTION_ID }
                    borrowProductDetails = productDetailsList.firstOrNull { it.productId == BORROW_SUBSCRIPTION_ID }
                    subStarterDetails = productDetailsList.firstOrNull { it.productId == SUB_STARTER_ID }
                    subProDetails = productDetailsList.firstOrNull { it.productId == SUB_PRO_ID }
                    subBusinessDetails = productDetailsList.firstOrNull { it.productId == SUB_BUSINESS_ID }

                    fun getSubPrice(details: ProductDetails?): String =
                        details?.subscriptionOfferDetails
                            ?.firstOrNull()
                            ?.pricingPhases
                            ?.pricingPhaseList
                            ?.firstOrNull()
                            ?.formattedPrice ?: ""

                    _subscriptionState.value = _subscriptionState.value.copy(
                        subscriptionPrice = getSubPrice(productDetails),
                        borrowSubscriptionPrice = getSubPrice(borrowProductDetails),
                        starterPrice = getSubPrice(subStarterDetails),
                        proPrice = getSubPrice(subProDetails),
                        businessPrice = getSubPrice(subBusinessDetails)
                    )
                    Timber.tag(TAG).d("Subscription details loaded")
                }
            }
        }
    }

    /**
     * Retry any INAPP top-up purchases that were never consumed — typically because
     * a prior verify-google call failed and the fail-safe left the token alive on
     * Google Play. Without this sweep, the user hits itemAlreadyOwned on next buy
     * until Google auto-refunds after ~3 days.
     */
    private fun queryStuckTopupPurchases() {
        scope.launch {
            val params = QueryPurchasesParams.newBuilder()
                .setProductType(BillingClient.ProductType.INAPP)
                .build()

            billingClient.queryPurchasesAsync(params) { billingResult, purchases ->
                if (billingResult.responseCode != BillingClient.BillingResponseCode.OK) {
                    Timber.tag(TAG).w("Stuck top-up query failed: ${billingResult.debugMessage}")
                    return@queryPurchasesAsync
                }
                val stuck = purchases.filter { purchase ->
                    purchase.purchaseState == Purchase.PurchaseState.PURCHASED &&
                        purchase.products.any { it in TOPUP_PRODUCT_IDS }
                }
                if (stuck.isEmpty()) return@queryPurchasesAsync
                Timber.tag(TAG).d("Found ${stuck.size} stuck top-up purchase(s) — retrying verify+consume")
                stuck.forEach { purchase ->
                    val productId = purchase.products.firstOrNull { it in TOPUP_PRODUCT_IDS }
                        ?: return@forEach
                    consumeAndVerifyTopup(purchase, productId)
                }
            }
        }
    }

    /**
     * Query top-up consumable product details
     */
    private fun queryTopupProductDetails() {
        scope.launch {
            val productList = TOPUP_PRODUCT_IDS.map { id ->
                QueryProductDetailsParams.Product.newBuilder()
                    .setProductId(id)
                    .setProductType(BillingClient.ProductType.INAPP)
                    .build()
            }

            val params = QueryProductDetailsParams.newBuilder()
                .setProductList(productList)
                .build()

            billingClient.queryProductDetailsAsync(params) { billingResult, queryProductDetailsResult ->
                if (billingResult.responseCode == BillingClient.BillingResponseCode.OK) {
                    topupDetailsMap.clear()
                    queryProductDetailsResult.productDetailsList.forEach { details ->
                        topupDetailsMap[details.productId] = details
                    }
                    Timber.tag(TAG).d("Top-up product details loaded: ${topupDetailsMap.keys}")
                }
            }
        }
    }

    /**
     * Launch subscription purchase flow (legacy)
     */
    fun launchPurchaseFlow(activity: Activity) {
        val details = productDetails
        if (details == null) {
            Timber.tag(TAG).e("Product details not available")
            android.widget.Toast.makeText(activity, context.getString(R.string.billing_google_play_loading), android.widget.Toast.LENGTH_SHORT).show()
            connectToBillingService()
            return
        }

        val offerToken = details.subscriptionOfferDetails?.firstOrNull()?.offerToken
        if (offerToken == null) {
            Timber.tag(TAG).e("Offer token not available")
            android.widget.Toast.makeText(activity, context.getString(R.string.billing_subscription_unavailable), android.widget.Toast.LENGTH_SHORT).show()
            return
        }

        val billingFlowParams = BillingFlowParams.newBuilder()
            .setProductDetailsParamsList(listOf(
                BillingFlowParams.ProductDetailsParams.newBuilder()
                    .setProductDetails(details)
                    .setOfferToken(offerToken)
                    .build()
            ))
            .build()

        val result = billingClient.launchBillingFlow(activity, billingFlowParams)
        Timber.tag(TAG).d("Launch purchase flow result: ${result.responseCode}")
    }

    /**
     * Launch top-up consumable purchase flow.
     */
    fun launchTopupPurchaseFlow(activity: Activity, productId: String) {
        val details = topupDetailsMap[productId]
        if (details == null) {
            Timber.tag(TAG).e("Top-up product details not available for $productId")
            android.widget.Toast.makeText(activity, context.getString(R.string.billing_google_play_loading), android.widget.Toast.LENGTH_SHORT).show()
            connectToBillingService()
            return
        }

        val billingFlowParams = BillingFlowParams.newBuilder()
            .setProductDetailsParamsList(listOf(
                BillingFlowParams.ProductDetailsParams.newBuilder()
                    .setProductDetails(details)
                    .build()
            ))
            .build()

        val result = billingClient.launchBillingFlow(activity, billingFlowParams)
        Timber.tag(TAG).d("Launch top-up purchase flow ($productId) result: ${result.responseCode}")
    }

    /**
     * Launch a new subscription plan purchase flow.
     */
    fun launchPlanPurchaseFlow(activity: Activity, planId: String) {
        val details = when (planId) {
            SUB_STARTER_ID -> subStarterDetails
            SUB_PRO_ID -> subProDetails
            SUB_BUSINESS_ID -> subBusinessDetails
            else -> null
        }
        if (details == null) {
            Timber.tag(TAG).e("Plan product details not available for $planId")
            android.widget.Toast.makeText(activity, context.getString(R.string.billing_google_play_loading), android.widget.Toast.LENGTH_SHORT).show()
            connectToBillingService()
            return
        }

        val offerToken = details.subscriptionOfferDetails?.firstOrNull()?.offerToken
        if (offerToken == null) {
            Timber.tag(TAG).e("Offer token not available for $planId")
            android.widget.Toast.makeText(activity, context.getString(R.string.billing_subscription_unavailable), android.widget.Toast.LENGTH_SHORT).show()
            return
        }

        val billingFlowParams = BillingFlowParams.newBuilder()
            .setProductDetailsParamsList(listOf(
                BillingFlowParams.ProductDetailsParams.newBuilder()
                    .setProductDetails(details)
                    .setOfferToken(offerToken)
                    .build()
            ))
            .build()

        val result = billingClient.launchBillingFlow(activity, billingFlowParams)
        Timber.tag(TAG).d("Launch plan purchase flow ($planId) result: ${result.responseCode}")
    }

    /**
     * Handle purchase updates from Google Play
     */
    override fun onPurchasesUpdated(billingResult: BillingResult, purchases: List<Purchase>?) {
        when (billingResult.responseCode) {
            BillingClient.BillingResponseCode.OK -> {
                purchases?.forEach { purchase ->
                    if (purchase.purchaseState == Purchase.PurchaseState.PURCHASED) {
                        val productId = purchase.products.firstOrNull() ?: return@forEach

                        // Top-up consumable: consume + verify with server
                        if (productId in TOPUP_PRODUCT_IDS) {
                            reportPlayIntegrityAction(ACTION_BILLING_TOPUP)
                            consumeAndVerifyTopup(purchase, productId)
                            return@forEach
                        }

                        // Subscription: acknowledge + sync
                        if (!purchase.isAcknowledged) {
                            acknowledgePurchase(purchase)
                        }

                        val activeSubId = purchase.products.firstOrNull { it in ALL_SUB_IDS }
                        if (activeSubId != null) {
                            reportPlayIntegrityAction(
                                if (activeSubId == BORROW_SUBSCRIPTION_ID) {
                                    ACTION_BORROW_SUBSCRIPTION
                                } else {
                                    ACTION_SUBSCRIPTION_PURCHASE
                                }
                            )
                            usageManager.isPremium = true
                            syncPremiumWithServer(purchase.purchaseToken, activeSubId)
                            refreshEntityLimitFromServer()

                            val plan = when (activeSubId) {
                                SUB_BUSINESS_ID -> "business"
                                SUB_PRO_ID -> "pro"
                                SUB_STARTER_ID -> "starter"
                                else -> "starter"
                            }
                            _subscriptionState.value = _subscriptionState.value.copy(currentPlan = plan)
                        }

                        if (purchase.products.contains(BORROW_SUBSCRIPTION_ID)) {
                            _subscriptionState.value = _subscriptionState.value.copy(
                                hasBorrowSubscription = true
                            )
                        }
                        updateState()
                    }
                }
            }
            BillingClient.BillingResponseCode.USER_CANCELED -> {
                Timber.tag(TAG).d("Purchase cancelled by user")
            }
            else -> {
                Timber.tag(TAG).e("Purchase failed: ${billingResult.debugMessage}")
            }
        }
    }

    private fun reportPlayIntegrityAction(action: String) {
        if (BuildConfig.DEBUG) return
        scope.launch(Dispatchers.IO) {
            PlayIntegrityReporter.getInstance(context).reportAction(action)
        }
    }

    /**
     * Launch borrow subscription purchase flow
     */
    fun launchBorrowPurchaseFlow(activity: Activity) {
        val details = borrowProductDetails
        if (details == null) {
            Timber.tag(TAG).e("Borrow product details not available")
            android.widget.Toast.makeText(activity, context.getString(R.string.billing_google_play_loading), android.widget.Toast.LENGTH_SHORT).show()
            connectToBillingService()
            return
        }

        val offerToken = details.subscriptionOfferDetails?.firstOrNull()?.offerToken
        if (offerToken == null) {
            Timber.tag(TAG).e("Borrow offer token not available")
            android.widget.Toast.makeText(activity, context.getString(R.string.billing_subscription_unavailable), android.widget.Toast.LENGTH_SHORT).show()
            return
        }

        val billingFlowParams = BillingFlowParams.newBuilder()
            .setProductDetailsParamsList(listOf(
                BillingFlowParams.ProductDetailsParams.newBuilder()
                    .setProductDetails(details)
                    .setOfferToken(offerToken)
                    .build()
            ))
            .build()

        val result = billingClient.launchBillingFlow(activity, billingFlowParams)
        Timber.tag(TAG).d("Launch borrow purchase flow result: ${result.responseCode}")
    }

    /**
     * Verify top-up with backend first, then consume the purchase.
     * This ensures e-coins are credited before the purchase token is consumed,
     * preventing lost purchases on server verification failure.
     */
    private fun consumeAndVerifyTopup(purchase: Purchase, productId: String) {
        scope.launch(Dispatchers.IO) {
            try {
                val body = mapOf(
                    "deviceId" to deviceManager.deviceId,
                    "deviceSecret" to (deviceManager.deviceSecret ?: ""),
                    "purchaseToken" to purchase.purchaseToken,
                    "productId" to productId
                )
                api.verifyGoogleTopup(body)
                Timber.tag(TAG).d("Top-up verified with server: $productId")

                val consumeParams = ConsumeParams.newBuilder()
                    .setPurchaseToken(purchase.purchaseToken)
                    .build()

                billingClient.consumeAsync(consumeParams) { billingResult, _ ->
                    if (billingResult.responseCode == BillingClient.BillingResponseCode.OK) {
                        Timber.tag(TAG).d("Top-up consumed: $productId")
                    } else {
                        Timber.tag(TAG).w("Top-up consume failed (e-coins already credited): ${billingResult.debugMessage}")
                    }
                    // Success: e-coins credited regardless of consume result
                    scope.launch(Dispatchers.Main) {
                        onTopupComplete?.invoke(productId, true)
                    }
                }
            } catch (e: Exception) {
                Timber.tag(TAG).e(e, "Failed to verify top-up with server")
                // Don't consume — purchase remains on Google Play for retry
                scope.launch(Dispatchers.Main) {
                    onTopupComplete?.invoke(productId, false)
                }
            }
        }
    }

    /**
     * Get available top-up tiers with prices for UI display.
     */
    fun getTopupTiers(): List<TopupTier> {
        return TOPUP_PRODUCT_IDS.mapNotNull { id ->
            val details = topupDetailsMap[id] ?: return@mapNotNull null
            val price = details.oneTimePurchaseOfferDetails?.formattedPrice ?: return@mapNotNull null
            TopupTier(
                productId = id,
                formattedPrice = price,
                baseEcoin = when (id) {
                    "ec.topup.small" -> 3000
                    "ec.topup.starter" -> 9000
                    "ec.topup.standard" -> 15000
                    "ec.topup.advanced" -> 30000
                    "ec.topup.premium" -> 60000
                    else -> 0
                },
                bonusPercent = when (id) {
                    "ec.topup.small" -> 0
                    "ec.topup.starter" -> 5
                    "ec.topup.standard" -> 8
                    "ec.topup.advanced" -> 12
                    "ec.topup.premium" -> 15
                    else -> 0
                }
            )
        }
    }

    /**
     * Sync premium status with the backend server so usage limits are lifted server-side.
     */
    private fun syncPremiumWithServer(purchaseToken: String?, productId: String?) {
        scope.launch(Dispatchers.IO) {
            try {
                val body = mutableMapOf<String, Any>(
                    "deviceId" to deviceManager.deviceId,
                    "deviceSecret" to deviceManager.deviceSecret
                )
                if (purchaseToken != null) body["purchaseToken"] = purchaseToken
                if (productId != null) body["productId"] = productId
                api.verifyGoogleSubscription(body)
                Timber.tag(TAG).d("Premium status synced with server")
            } catch (e: Exception) {
                Timber.tag(TAG).e(e, "Failed to sync premium status with server")
            }
        }
    }

    /**
     * #69: Refresh entity limit from server after premium activation
     */
    private fun refreshEntityLimitFromServer() {
        scope.launch(Dispatchers.IO) {
            try {
                val response = api.getAllEntities(deviceId = deviceManager.deviceId, deviceSecret = deviceManager.deviceSecret ?: "")
                LayoutPreferences.getInstance(context).serverEntityLimit = response.totalSlots
                Timber.tag(TAG).d("Entity limit refreshed: ${response.totalSlots}")
            } catch (e: Exception) {
                Timber.tag(TAG).e(e, "Failed to refresh entity limit")
            }
        }
    }

    /**
     * Acknowledge purchase to prevent refund
     */
    private fun acknowledgePurchase(purchase: Purchase) {
        scope.launch {
            val params = AcknowledgePurchaseParams.newBuilder()
                .setPurchaseToken(purchase.purchaseToken)
                .build()

            billingClient.acknowledgePurchase(params) { result ->
                if (result.responseCode == BillingClient.BillingResponseCode.OK) {
                    Timber.tag(TAG).d("Purchase acknowledged")
                }
            }
        }
    }

    /**
     * Update subscription state for UI
     */
    private fun updateState() {
        _subscriptionState.value = _subscriptionState.value.copy(
            isPremium = usageManager.isPremium,
            usageToday = usageManager.dailyMessageCount,
            usageLimit = UsageManager.FREE_TIER_LIMIT,
            canSendMessage = usageManager.canUseMessage()
        )
    }

    /**
     * Refresh state (call when UI is shown)
     */
    fun refreshState() {
        querySubscriptionStatus()
        syncUsageFromServer()
        updateState()
    }

    /**
     * Fetch actual usage count from server and sync local state.
     */
    private fun syncUsageFromServer() {
        scope.launch(Dispatchers.IO) {
            try {
                val body = mapOf(
                    "deviceId" to deviceManager.deviceId,
                    "deviceSecret" to deviceManager.deviceSecret
                )
                val response = api.getSubscriptionUsage(body)
                if (response.success) {
                    usageManager.syncFromServer(response.usageToday)
                    if (response.isPremium) {
                        usageManager.isPremium = true
                    }
                    scope.launch(Dispatchers.Main) {
                        updateState()
                    }
                    Timber.tag(TAG).d("Usage synced from server: ${response.usageToday}, premium=${response.isPremium}")
                }
            } catch (e: Exception) {
                Timber.tag(TAG).e(e, "Failed to sync usage from server")
            }
        }
    }

    /**
     * Clean up resources
     */
    fun destroy() {
        if (billingClient.isReady) {
            billingClient.endConnection()
        }
    }
}
