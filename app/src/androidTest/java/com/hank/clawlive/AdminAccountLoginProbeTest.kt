package com.hank.clawlive

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.hank.clawlive.data.local.DeviceManager
import com.hank.clawlive.data.remote.NetworkModule
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class AdminAccountLoginProbeTest {
    @Test
    fun loginAdminAccountRestoresDeviceCredentials() = runBlocking {
        val args = InstrumentationRegistry.getArguments()
        val email = args.getString("adminEmail")?.trim().orEmpty()
        val password = args.getString("adminPassword").orEmpty()
        assumeTrue("adminEmail/adminPassword instrumentation args required for live admin login probe", email.isNotBlank() && password.isNotBlank())

        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val response = NetworkModule.api.appLogin(mapOf("email" to email, "password" to password))
        assertTrue(response.error ?: "admin login failed", response.success)
        val deviceId = requireNotNull(response.deviceId)
        val deviceSecret = requireNotNull(response.deviceSecret)

        val deviceManager = DeviceManager.getInstance(context)
        deviceManager.setCredentials(deviceId, deviceSecret)
        assertEquals(deviceId, deviceManager.deviceId)
        assertEquals(deviceSecret, deviceManager.deviceSecret)

        val status = NetworkModule.api.getBindEmailStatus(deviceId, deviceSecret)
        assertTrue(status.error ?: "bind email status failed", status.success)
        assertTrue("admin account should report admin/developer roles", status.roles.orEmpty().any { it == "admin" || it == "developer" })
    }
}
