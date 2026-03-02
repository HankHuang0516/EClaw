package com.hank.clawlive.data.local

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * Local Variables Vault — stores user-defined KEY=VALUE pairs on device only.
 * Uses EncryptedSharedPreferences; values are never sent to the cloud database.
 * Synced to the server's in-memory cache (TTL 30 min) via POST /api/device-vars
 * so bots can read them via GET /api/device-vars.
 */
class LocalVarsManager private constructor(context: Context) {

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
            context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).edit().clear().apply()
            EncryptedSharedPreferences.create(
                context,
                PREFS_NAME,
                masterKey,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
            )
        }
    }

    /** Return all stored variables as a Map<KEY, VALUE>. */
    fun getAll(): Map<String, String> {
        return prefs.all.mapNotNull { (k, v) ->
            if (v is String) k to v else null
        }.toMap()
    }

    /** Insert or update a variable. Key is auto-uppercased and trimmed. */
    fun set(key: String, value: String) {
        val sanitizedKey = key.trim().uppercase()
        if (sanitizedKey.isNotEmpty()) {
            prefs.edit().putString(sanitizedKey, value).apply()
        }
    }

    /** Remove a single variable by key. */
    fun delete(key: String) {
        prefs.edit().remove(key).apply()
    }

    /** Remove all stored variables. */
    fun clear() {
        prefs.edit().clear().apply()
    }

    companion object {
        private const val PREFS_NAME = "realbot_local_vars"

        @Volatile
        private var instance: LocalVarsManager? = null

        fun getInstance(context: Context): LocalVarsManager {
            return instance ?: synchronized(this) {
                instance ?: LocalVarsManager(context.applicationContext).also { instance = it }
            }
        }
    }
}
