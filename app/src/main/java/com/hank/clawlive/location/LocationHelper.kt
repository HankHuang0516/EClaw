package com.hank.clawlive.location

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Looper
import androidx.core.content.ContextCompat
import com.google.android.gms.location.*
import com.hank.clawlive.data.local.DeviceManager
import com.hank.clawlive.data.remote.NetworkModule
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import timber.log.Timber
import kotlin.coroutines.resume

/**
 * Helper to fetch GPS location and report it to the EClaw backend.
 *
 * Flow:
 *   1. Server sends Socket.IO "location_request" or FCM push
 *   2. App calls LocationHelper.fetchAndReport(context, requestId)
 *   3. Helper gets GPS via FusedLocationProvider
 *   4. POSTs coordinates to /api/device/location
 */
object LocationHelper {

    private const val TIMEOUT_MS = 15_000L

    /**
     * Check if location permission is granted.
     */
    fun hasLocationPermission(context: Context): Boolean {
        return ContextCompat.checkSelfPermission(
            context, Manifest.permission.ACCESS_FINE_LOCATION
        ) == PackageManager.PERMISSION_GRANTED ||
        ContextCompat.checkSelfPermission(
            context, Manifest.permission.ACCESS_COARSE_LOCATION
        ) == PackageManager.PERMISSION_GRANTED
    }

    /**
     * Fetch current GPS location and POST to backend.
     * Call from coroutine scope (e.g. Dispatchers.IO).
     * Returns true if successfully reported.
     */
    suspend fun fetchAndReport(context: Context, requestId: String? = null): Boolean {
        if (!hasLocationPermission(context)) {
            Timber.w("[Location] No location permission")
            return false
        }

        val location = getCurrentLocation(context)
        if (location == null) {
            Timber.w("[Location] Failed to get location within timeout")
            return false
        }

        return reportLocation(context, location, requestId)
    }

    /**
     * Get current location using FusedLocationProviderClient.
     * Tries last known location first, falls back to fresh request.
     */
    @Suppress("MissingPermission")
    private suspend fun getCurrentLocation(context: Context): android.location.Location? {
        val client = LocationServices.getFusedLocationProviderClient(context)

        // Try last known location first (fast)
        val lastKnown = try {
            suspendCancellableCoroutine<android.location.Location?> { cont ->
                client.lastLocation
                    .addOnSuccessListener { loc -> cont.resume(loc) }
                    .addOnFailureListener { cont.resume(null) }
            }
        } catch (e: Exception) {
            null
        }

        // If last known is recent enough (< 2 minutes), use it
        if (lastKnown != null) {
            val ageMs = System.currentTimeMillis() - lastKnown.time
            if (ageMs < 120_000) {
                Timber.d("[Location] Using last known: ${lastKnown.latitude}, ${lastKnown.longitude} (age: ${ageMs/1000}s)")
                return lastKnown
            }
        }

        // Request fresh location
        return withTimeoutOrNull(TIMEOUT_MS) {
            suspendCancellableCoroutine<android.location.Location?> { cont ->
                val request = LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, 1000)
                    .setWaitForAccurateLocation(false)
                    .setMaxUpdates(1)
                    .setMaxUpdateDelayMillis(5000)
                    .build()

                val callback = object : LocationCallback() {
                    override fun onLocationResult(result: LocationResult) {
                        client.removeLocationUpdates(this)
                        val loc = result.lastLocation
                        Timber.d("[Location] Fresh location: ${loc?.latitude}, ${loc?.longitude}")
                        if (cont.isActive) cont.resume(loc)
                    }
                }

                client.requestLocationUpdates(request, callback, Looper.getMainLooper())
                cont.invokeOnCancellation {
                    client.removeLocationUpdates(callback)
                }
            }
        }
    }

    /**
     * POST location to /api/device/location
     */
    private suspend fun reportLocation(
        context: Context,
        location: android.location.Location,
        requestId: String?
    ): Boolean {
        val dm = DeviceManager.getInstance(context)
        val body = mutableMapOf<String, Any>(
            "deviceId" to dm.deviceId,
            "deviceSecret" to dm.deviceSecret,
            "latitude" to location.latitude,
            "longitude" to location.longitude
        )
        if (location.hasAccuracy()) body["accuracy"] = location.accuracy.toDouble()
        if (location.hasAltitude()) body["altitude"] = location.altitude
        if (location.hasSpeed()) body["speed"] = location.speed.toDouble()
        if (location.hasBearing()) body["bearing"] = location.bearing.toDouble()
        body["provider"] = location.provider ?: "fused"
        if (requestId != null) body["requestId"] = requestId

        return try {
            val response = NetworkModule.api.reportDeviceLocation(body)
            Timber.d("[Location] Reported: ${location.latitude}, ${location.longitude} → ${response.success}")
            response.success
        } catch (e: Exception) {
            Timber.e(e, "[Location] Failed to report location")
            false
        }
    }

    /**
     * Fire-and-forget: fetch and report in background.
     */
    fun fetchAndReportAsync(context: Context, requestId: String? = null) {
        CoroutineScope(Dispatchers.IO).launch {
            fetchAndReport(context, requestId)
        }
    }
}
