package com.hank.clawlive.data.local

import android.content.Context
import android.content.SharedPreferences
import android.content.pm.PackageManager
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import java.util.UUID

/**
 * Manages device credentials securely using EncryptedSharedPreferences
 */
class DeviceManager private constructor(context: Context) {

    private val appContext = context.applicationContext

    private val masterKey = MasterKey.Builder(context)
        .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
        .build()

    private val prefs: SharedPreferences = createEncryptedPrefs(context, masterKey)
    
    private fun createEncryptedPrefs(context: Context, masterKey: MasterKey): SharedPreferences {
        return try {
            EncryptedSharedPreferences.create(
                context,
                PREFS_NAME,
                masterKey,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
            )
        } catch (e: Exception) {
            // If keys are corrupted (e.g. key invalidated or content bad), delete file and recreate
            context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).edit().clear().apply()
            // Some devices need file deletion too
            // context.deleteSharedPreferences(PREFS_NAME) // API 24+
            
            // Re-try creation
            EncryptedSharedPreferences.create(
                context,
                PREFS_NAME,
                masterKey,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
            )
        }
    }

    /**
     * Get or generate device ID
     */
    val deviceId: String
        get() {
            var id = prefs.getString(KEY_DEVICE_ID, null)
            if (id == null) {
                id = UUID.randomUUID().toString()
                prefs.edit().putString(KEY_DEVICE_ID, id).apply()
            }
            return id
        }

    /**
     * Get or generate device secret
     */
    val deviceSecret: String
        get() {
            var secret = prefs.getString(KEY_DEVICE_SECRET, null)
            if (secret == null) {
                secret = UUID.randomUUID().toString() + "-" + UUID.randomUUID().toString()
                prefs.edit().putString(KEY_DEVICE_SECRET, secret).apply()
            }
            return secret
        }

    /**
     * Get app version name (e.g., "1.0.3")
     * Sent to backend so bot can detect outdated app versions
     */
    val appVersion: String
        get() = try {
            appContext.packageManager.getPackageInfo(appContext.packageName, 0).versionName ?: "unknown"
        } catch (e: PackageManager.NameNotFoundException) {
            "unknown"
        }

    /**
     * Check if device is bound to OpenClaw
     */
    var isBound: Boolean
        get() = prefs.getBoolean(KEY_IS_BOUND, false)
        set(value) = prefs.edit().putBoolean(KEY_IS_BOUND, value).apply()

    /**
     * Store the current binding code (for display)
     */
    var currentBindingCode: String?
        get() = prefs.getString(KEY_BINDING_CODE, null)
        set(value) = prefs.edit().putString(KEY_BINDING_CODE, value).apply()

    /**
     * Store binding code expiry time
     */
    var bindingCodeExpiry: Long
        get() = prefs.getLong(KEY_BINDING_EXPIRY, 0)
        set(value) = prefs.edit().putLong(KEY_BINDING_EXPIRY, value).apply()

    /**
     * Overwrite device credentials with values recovered from account login.
     * Used when user logs in with email/password to restore their old device.
     */
    fun setCredentials(newDeviceId: String, newDeviceSecret: String) {
        prefs.edit()
            .putString(KEY_DEVICE_ID, newDeviceId)
            .putString(KEY_DEVICE_SECRET, newDeviceSecret)
            .remove(KEY_IS_BOUND)
            .remove(KEY_BINDING_CODE)
            .remove(KEY_BINDING_EXPIRY)
            .apply()
    }

    /**
     * Reset device credentials (for re-binding)
     */
    fun reset() {
        prefs.edit()
            .remove(KEY_DEVICE_ID)
            .remove(KEY_DEVICE_SECRET)
            .remove(KEY_IS_BOUND)
            .remove(KEY_BINDING_CODE)
            .remove(KEY_BINDING_EXPIRY)
            .apply()
    }

    companion object {
        private const val PREFS_NAME = "realbot_device_prefs"
        private const val KEY_DEVICE_ID = "device_id"
        private const val KEY_DEVICE_SECRET = "device_secret"
        private const val KEY_IS_BOUND = "is_bound"
        private const val KEY_BINDING_CODE = "binding_code"
        private const val KEY_BINDING_EXPIRY = "binding_expiry"

        @Volatile
        private var instance: DeviceManager? = null

        fun getInstance(context: Context): DeviceManager {
            return instance ?: synchronized(this) {
                instance ?: DeviceManager(context.applicationContext).also { instance = it }
            }
        }
    }
}
