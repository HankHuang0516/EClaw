package com.hank.clawlive.integrity

import android.content.Context
import com.google.android.play.core.integrity.IntegrityManagerFactory
import com.google.android.play.core.integrity.IntegrityTokenRequest
import com.google.android.play.core.integrity.IntegrityTokenResponse
import com.google.android.play.core.integrity.StandardIntegrityManager
import com.google.android.play.core.integrity.StandardIntegrityManager.PrepareIntegrityTokenRequest
import com.google.android.play.core.integrity.StandardIntegrityManager.StandardIntegrityToken
import com.google.android.play.core.integrity.StandardIntegrityManager.StandardIntegrityTokenProvider
import com.google.android.play.core.integrity.StandardIntegrityManager.StandardIntegrityTokenRequest
import com.google.android.play.core.integrity.StandardIntegrityException
import com.google.android.play.core.integrity.model.StandardIntegrityErrorCode
import com.hank.clawlive.data.local.DeviceManager
import com.hank.clawlive.data.model.PlayIntegrityNonceResponse
import com.hank.clawlive.data.remote.NetworkModule
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.suspendCancellableCoroutine
import timber.log.Timber

/**
 * Best-effort Google Play Integrity bridge.
 *
 * The client requests a server-scoped nonce, asks Google Play for an integrity
 * token, then submits the token to the backend. The backend decides whether
 * full Google server-side decode is configured; this class never logs tokens.
 */
class PlayIntegrityReporter private constructor(context: Context) {

    private val appContext = context.applicationContext
    private val deviceManager = DeviceManager.getInstance(appContext)
    private val classicIntegrityManager = IntegrityManagerFactory.create(appContext)
    private val standardIntegrityManager: StandardIntegrityManager =
        IntegrityManagerFactory.createStandard(appContext)

    @Volatile
    private var standardTokenProvider: StandardIntegrityTokenProvider? = null

    @Volatile
    private var preparedCloudProjectNumber: Long? = null

    suspend fun reportStartup() {
        reportAction(ACTION_STARTUP)
    }

    suspend fun reportAction(action: String) {
        val deviceId = deviceManager.deviceId
        val deviceSecret = deviceManager.deviceSecret
        if (deviceId.isBlank() || deviceSecret.isBlank()) return

        try {
            val nonceResponse = NetworkModule.api.createPlayIntegrityNonce(
                mapOf(
                    "deviceId" to deviceId,
                    "deviceSecret" to deviceSecret,
                    "action" to action,
                    "appVersion" to deviceManager.appVersion
                )
            )
            val nonce = nonceResponse.nonce
            if (!nonceResponse.success || nonce.isNullOrBlank()) {
                Timber.tag(TAG).w("Nonce request failed for action=%s error=%s", action, nonceResponse.error)
                return
            }

            val tokenResult = requestBestIntegrityToken(nonceResponse)
            val verdict = NetworkModule.api.submitPlayIntegrityVerdict(
                mutableMapOf(
                    "deviceId" to deviceId,
                    "deviceSecret" to deviceSecret,
                    "action" to action,
                    "nonce" to nonce,
                    "requestMode" to tokenResult.requestMode,
                    "integrityToken" to tokenResult.token,
                    "appVersion" to deviceManager.appVersion
                ).apply {
                    if (tokenResult.requestHash.isNotBlank()) put("requestHash", tokenResult.requestHash)
                }
            )
            Timber.tag(TAG).i(
                "Integrity report action=%s mode=%s status=%s verificationConfigured=%s",
                action,
                tokenResult.requestMode,
                verdict.status,
                verdict.verificationConfigured
            )
        } catch (e: Exception) {
            Timber.tag(TAG).w(e, "Integrity report failed for action=%s", action)
        }
    }

    private suspend fun requestBestIntegrityToken(nonceResponse: PlayIntegrityNonceResponse): IntegrityTokenResult {
        val nonce = nonceResponse.nonce.orEmpty()
        val requestHash = nonceResponse.requestHash.orEmpty()
        val cloudProjectNumber = nonceResponse.cloudProjectNumber?.toLongOrNull()
        val shouldUseStandard =
            nonceResponse.requestMode == MODE_STANDARD &&
                nonceResponse.standardRequestConfigured &&
                cloudProjectNumber != null &&
                requestHash.isNotBlank()

        if (shouldUseStandard) {
            try {
                val token = requestStandardIntegrityToken(cloudProjectNumber, requestHash).token()
                return IntegrityTokenResult(
                    token = token,
                    requestMode = MODE_STANDARD,
                    requestHash = requestHash
                )
            } catch (e: Exception) {
                if (isProviderInvalid(e)) {
                    standardTokenProvider = null
                    preparedCloudProjectNumber = null
                    try {
                        val token = requestStandardIntegrityToken(cloudProjectNumber, requestHash).token()
                        return IntegrityTokenResult(
                            token = token,
                            requestMode = MODE_STANDARD,
                            requestHash = requestHash
                        )
                    } catch (retryError: Exception) {
                        Timber.tag(TAG).w(retryError, "Standard integrity provider refresh failed; falling back to classic")
                    }
                }
                Timber.tag(TAG).w(e, "Standard integrity request failed; falling back to classic")
            }
        }

        return IntegrityTokenResult(
            token = requestClassicIntegrityToken(nonce).token(),
            requestMode = MODE_CLASSIC,
            requestHash = ""
        )
    }

    private suspend fun requestStandardIntegrityToken(
        cloudProjectNumber: Long,
        requestHash: String
    ): StandardIntegrityToken {
        val provider = getStandardTokenProvider(cloudProjectNumber)
        return suspendCancellableCoroutine { cont ->
            val task = provider.request(
                StandardIntegrityTokenRequest.builder()
                    .setRequestHash(requestHash)
                    .build()
            )
            task.addOnSuccessListener { response ->
                if (cont.isActive) cont.resume(response)
            }
            task.addOnFailureListener { error ->
                if (cont.isActive) cont.resumeWithException(error)
            }
        }
    }

    private suspend fun getStandardTokenProvider(cloudProjectNumber: Long): StandardIntegrityTokenProvider {
        val current = standardTokenProvider
        if (current != null && preparedCloudProjectNumber == cloudProjectNumber) return current

        return suspendCancellableCoroutine { cont ->
            val task = standardIntegrityManager.prepareIntegrityToken(
                PrepareIntegrityTokenRequest.builder()
                    .setCloudProjectNumber(cloudProjectNumber)
                    .build()
            )
            task.addOnSuccessListener { provider ->
                preparedCloudProjectNumber = cloudProjectNumber
                standardTokenProvider = provider
                if (cont.isActive) cont.resume(provider)
            }
            task.addOnFailureListener { error ->
                if (cont.isActive) cont.resumeWithException(error)
            }
        }
    }

    private suspend fun requestClassicIntegrityToken(nonce: String): IntegrityTokenResponse =
        suspendCancellableCoroutine { cont ->
            val task = classicIntegrityManager.requestIntegrityToken(
                IntegrityTokenRequest.builder()
                    .setNonce(nonce)
                    .build()
            )
            task.addOnSuccessListener { response ->
                if (cont.isActive) cont.resume(response)
            }
            task.addOnFailureListener { error ->
                if (cont.isActive) cont.resumeWithException(error)
            }
        }

    private fun isProviderInvalid(error: Exception): Boolean =
        error is StandardIntegrityException &&
            error.errorCode == StandardIntegrityErrorCode.INTEGRITY_TOKEN_PROVIDER_INVALID

    companion object {
        private const val TAG = "PlayIntegrity"
        private const val ACTION_STARTUP = "startup"
        private const val MODE_CLASSIC = "classic"
        private const val MODE_STANDARD = "standard"

        @Volatile
        private var instance: PlayIntegrityReporter? = null

        fun getInstance(context: Context): PlayIntegrityReporter =
            instance ?: synchronized(this) {
                instance ?: PlayIntegrityReporter(context.applicationContext).also { instance = it }
            }
    }

    private data class IntegrityTokenResult(
        val token: String,
        val requestMode: String,
        val requestHash: String
    )
}
