package com.hank.clawlive.data.remote

import android.annotation.SuppressLint
import com.hank.clawlive.BuildConfig
import okhttp3.OkHttpClient
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.Retrofit
import retrofit2.converter.gson.GsonConverterFactory
import java.security.SecureRandom
import java.security.cert.X509Certificate
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager

/**
 * Creates a trust-all OkHttpClient for debug builds.
 * This bypasses SSL cert validation, which is needed on emulators with outdated CA stores.
 * ONLY active when BuildConfig.DEBUG == true; release builds use the normal client.
 */
@SuppressLint("TrustAllX509TrustManager", "CustomX509TrustManager")
internal fun buildDebugOkHttpClient(
    connectTimeoutSec: Long = 15,
    readTimeoutSec: Long = 60,
    writeTimeoutSec: Long = 15
): OkHttpClient {
    val trustAll = object : X509TrustManager {
        override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) {}
        override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {}
        override fun getAcceptedIssuers(): Array<X509Certificate> = arrayOf()
    }
    val sslContext = SSLContext.getInstance("TLS").apply {
        init(null, arrayOf(trustAll), SecureRandom())
    }
    return OkHttpClient.Builder()
        .sslSocketFactory(sslContext.socketFactory, trustAll)
        .hostnameVerifier { _, _ -> true }
        .connectTimeout(connectTimeoutSec, TimeUnit.SECONDS)
        .readTimeout(readTimeoutSec, TimeUnit.SECONDS)
        .writeTimeout(writeTimeoutSec, TimeUnit.SECONDS)
        .build()
}

object NetworkModule {

    private const val BASE_URL = "https://eclawbot.com/"

    init {
    }

    private val loggingInterceptor = HttpLoggingInterceptor().apply {
        level = HttpLoggingInterceptor.Level.BODY
    }

    private val telemetryInterceptor = TelemetryInterceptor()

    private val okHttpClient: OkHttpClient = if (BuildConfig.DEBUG) {
        // Emulator may have outdated CA store; trust-all in debug only
        buildDebugOkHttpClient(readTimeoutSec = 60).newBuilder()
            .addInterceptor(telemetryInterceptor)
            .addInterceptor(loggingInterceptor)
            .build()
    } else {
        OkHttpClient.Builder()
            .addInterceptor(telemetryInterceptor)
            .addInterceptor(loggingInterceptor)
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(60, TimeUnit.SECONDS)
            .writeTimeout(15, TimeUnit.SECONDS)
            .build()
    }

    private val retrofit = Retrofit.Builder()
        .baseUrl(BASE_URL)
        .client(okHttpClient)
        .addConverterFactory(GsonConverterFactory.create())
        .build()

    val api: ClawApiService = retrofit.create(ClawApiService::class.java)
}
