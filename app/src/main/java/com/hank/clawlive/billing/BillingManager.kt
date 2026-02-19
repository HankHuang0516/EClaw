package com.hank.clawlive.billing

import android.app.Activity
import android.content.Context
import com.android.billingclient.api.*
import com.hank.clawlive.data.local.DeviceManager
import com.hank.clawlive.data.local.UsageManager
import com.hank.clawlive.data.remote.NetworkModule
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
 * Manages Google Play Billing for subscription purchases.
 * Handles connection, purchase, acknowledgment, and restoration.
 */
class BillingManager(private val context: Context) : PurchasesUpdatedListener {

    companion object {
        const val SUBSCRIPTION_ID = "e_claw_premium"
        const val BORROW_SUBSCRIPTION_ID = "e_claw_borrow_personal"
        private const val TAG = "BillingManager"

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
        .enablePendingPurchases()
        .build()

    private var productDetails: ProductDetails? = null
    private var borrowProductDetails: ProductDetails? = null

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
                } else {
                    Timber.tag(TAG).e("Billing setup failed: ${billingResult.debugMessage}")
                }
            }

            override fun onBillingServiceDisconnected() {
                Timber.tag(TAG).w("Billing service disconnected")
                // Reconnect on next operation
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
                    val premiumPurchase = purchases.firstOrNull { purchase ->
                        purchase.purchaseState == Purchase.PurchaseState.PURCHASED &&
                        purchase.products.contains(SUBSCRIPTION_ID)
                    }
                    val hasActiveSubscription = premiumPurchase != null

                    val hasBorrowSub = purchases.any { purchase ->
                        purchase.purchaseState == Purchase.PurchaseState.PURCHASED &&
                        purchase.products.contains(BORROW_SUBSCRIPTION_ID)
                    }

                    usageManager.isPremium = hasActiveSubscription
                    _subscriptionState.value = _subscriptionState.value.copy(
                        hasBorrowSubscription = hasBorrowSub
                    )
                    updateState()

                    // Sync premium status with server (ensures server-side limit is lifted)
                    if (hasActiveSubscription) {
                        syncPremiumWithServer(premiumPurchase?.purchaseToken, SUBSCRIPTION_ID)
                    }

                    // Acknowledge any unacknowledged purchases
                    purchases.filter { !it.isAcknowledged }.forEach { purchase ->
                        acknowledgePurchase(purchase)
                    }

                    Timber.tag(TAG).d("Subscription status: premium=$hasActiveSubscription, borrow=$hasBorrowSub")
                }
            }
        }
    }

    /**
     * Query product details for display
     */
    private fun queryProductDetails() {
        scope.launch {
            val productList = listOf(
                QueryProductDetailsParams.Product.newBuilder()
                    .setProductId(SUBSCRIPTION_ID)
                    .setProductType(BillingClient.ProductType.SUBS)
                    .build(),
                QueryProductDetailsParams.Product.newBuilder()
                    .setProductId(BORROW_SUBSCRIPTION_ID)
                    .setProductType(BillingClient.ProductType.SUBS)
                    .build()
            )

            val params = QueryProductDetailsParams.newBuilder()
                .setProductList(productList)
                .build()

            billingClient.queryProductDetailsAsync(params) { billingResult, productDetailsList ->
                if (billingResult.responseCode == BillingClient.BillingResponseCode.OK) {
                    productDetails = productDetailsList.firstOrNull { it.productId == SUBSCRIPTION_ID }
                    borrowProductDetails = productDetailsList.firstOrNull { it.productId == BORROW_SUBSCRIPTION_ID }

                    val price = productDetails?.subscriptionOfferDetails
                        ?.firstOrNull()
                        ?.pricingPhases
                        ?.pricingPhaseList
                        ?.firstOrNull()
                        ?.formattedPrice ?: ""

                    val borrowPrice = borrowProductDetails?.subscriptionOfferDetails
                        ?.firstOrNull()
                        ?.pricingPhases
                        ?.pricingPhaseList
                        ?.firstOrNull()
                        ?.formattedPrice ?: ""

                    _subscriptionState.value = _subscriptionState.value.copy(
                        subscriptionPrice = price,
                        borrowSubscriptionPrice = borrowPrice
                    )
                    Timber.tag(TAG).d("Product details loaded: premium=$price, borrow=$borrowPrice")
                }
            }
        }
    }

    /**
     * Launch subscription purchase flow
     */
    fun launchPurchaseFlow(activity: Activity) {
        val details = productDetails
        if (details == null) {
            Timber.tag(TAG).e("Product details not available")
            android.widget.Toast.makeText(activity, "Google Play 商品載入中，請稍後再試", android.widget.Toast.LENGTH_SHORT).show()
            connectToBillingService()
            return
        }

        val offerToken = details.subscriptionOfferDetails?.firstOrNull()?.offerToken
        if (offerToken == null) {
            Timber.tag(TAG).e("Offer token not available")
            android.widget.Toast.makeText(activity, "無法取得訂閱方案，請稍後再試", android.widget.Toast.LENGTH_SHORT).show()
            return
        }

        val productDetailsParams = BillingFlowParams.ProductDetailsParams.newBuilder()
            .setProductDetails(details)
            .setOfferToken(offerToken)
            .build()

        val billingFlowParams = BillingFlowParams.newBuilder()
            .setProductDetailsParamsList(listOf(productDetailsParams))
            .build()

        val result = billingClient.launchBillingFlow(activity, billingFlowParams)
        Timber.tag(TAG).d("Launch purchase flow result: ${result.responseCode}")
    }

    /**
     * Handle purchase updates from Google Play
     */
    override fun onPurchasesUpdated(billingResult: BillingResult, purchases: List<Purchase>?) {
        when (billingResult.responseCode) {
            BillingClient.BillingResponseCode.OK -> {
                purchases?.forEach { purchase ->
                    if (purchase.purchaseState == Purchase.PurchaseState.PURCHASED) {
                        if (!purchase.isAcknowledged) {
                            acknowledgePurchase(purchase)
                        }
                        if (purchase.products.contains(SUBSCRIPTION_ID)) {
                            usageManager.isPremium = true
                            syncPremiumWithServer(purchase.purchaseToken, SUBSCRIPTION_ID)
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

    /**
     * Launch borrow subscription purchase flow
     */
    fun launchBorrowPurchaseFlow(activity: Activity) {
        val details = borrowProductDetails
        if (details == null) {
            Timber.tag(TAG).e("Borrow product details not available")
            android.widget.Toast.makeText(activity, "Google Play 商品載入中，請稍後再試", android.widget.Toast.LENGTH_SHORT).show()
            connectToBillingService()
            return
        }

        val offerToken = details.subscriptionOfferDetails?.firstOrNull()?.offerToken
        if (offerToken == null) {
            Timber.tag(TAG).e("Borrow offer token not available")
            android.widget.Toast.makeText(activity, "無法取得訂閱方案，請稍後再試", android.widget.Toast.LENGTH_SHORT).show()
            return
        }

        val productDetailsParams = BillingFlowParams.ProductDetailsParams.newBuilder()
            .setProductDetails(details)
            .setOfferToken(offerToken)
            .build()

        val billingFlowParams = BillingFlowParams.newBuilder()
            .setProductDetailsParamsList(listOf(productDetailsParams))
            .build()

        val result = billingClient.launchBillingFlow(activity, billingFlowParams)
        Timber.tag(TAG).d("Launch borrow purchase flow result: ${result.responseCode}")
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
     * This ensures the client displays the correct usage even after app updates or reinstalls.
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
