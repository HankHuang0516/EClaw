package com.hank.clawlive

import com.google.gson.Gson
import com.hank.clawlive.data.model.UsageSnapshotResponse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class UsageSnapshotModelTest {

    @Test
    fun parsesClaudeAndCodexUsageSnapshotPercentages() {
        val json = """
            {
              "success": true,
              "latest": {
                "id": 123,
                "deviceId": "dev_1",
                "received_at": "2026-05-25T10:00:00.000Z",
                "claude": {
                  "live": {
                    "rate_limits": {
                      "five_hour": { "used_percentage": 42.4, "resets_at": 1780000000 },
                      "seven_day": { "used_percentage": 63.9, "resets_at": 1780500000 }
                    }
                  },
                  "sessions": []
                },
                "codex": {
                  "rate_limits": {
                    "five_hour_pct": 6.0,
                    "five_hour_resets_at": 1780000000,
                    "seven_day_pct": 28.0,
                    "seven_day_resets_at": 1780500000,
                    "plan_type": "Max"
                  },
                  "sessions": []
                }
              }
            }
        """.trimIndent()

        val parsed = Gson().fromJson(json, UsageSnapshotResponse::class.java)

        assertTrue(parsed.success)
        assertNotNull(parsed.latest)
        assertEquals(42.4, parsed.latest!!.claude!!.live!!.rateLimits!!.fiveHour!!.usedPercentage!!, 0.001)
        assertEquals(63.9, parsed.latest!!.claude!!.live!!.rateLimits!!.sevenDay!!.usedPercentage!!, 0.001)
        assertEquals(6.0, parsed.latest!!.codex!!.rateLimits!!.fiveHourPct!!, 0.001)
        assertEquals(28.0, parsed.latest!!.codex!!.rateLimits!!.sevenDayPct!!, 0.001)
    }
}
