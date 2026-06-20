package com.hank.clawlive

import com.google.gson.JsonParser
import com.hank.clawlive.data.model.CompanionDetail
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class CompanionDescriptorAnimationTest {
    @Test
    fun walkingStateUsesPetdxRunningRightAnimation() {
        val descriptor = JsonParser.parseString(
            """
            {
              "asset": {
                "url": "https://example.test/sprite.webp",
                "frameWidth": 192,
                "frameHeight": 208,
                "animations": {
                  "idle": { "row": 0, "frames": [280, 110] },
                  "running-right": { "row": 1, "count": 8, "dur": 120, "last": 220 }
                }
              },
              "stateAssets": {
                "IDLE": { "animation": "idle", "loop": true },
                "WALKING": { "animation": "running-right", "loop": true }
              }
            }
            """.trimIndent()
        ).asJsonObject

        val companion = CompanionDetail(
            id = "petdex-test",
            name = "Petdex Test",
            assetType = "spritesheet",
            assetUrl = "https://fallback.test/sprite.webp",
            supportedStates = listOf("IDLE", "WALKING"),
            descriptor = descriptor
        )

        val animation = companion.spritesheetAnimation("WALKING")

        assertEquals("https://example.test/sprite.webp", companion.spritesheetUrl())
        assertEquals(1, animation?.row)
        assertEquals(8, animation?.frameDurationsMs?.size)
        assertEquals(120, animation?.frameDurationsMs?.first())
        assertEquals(220, animation?.frameDurationsMs?.last())
        assertTrue(companion.stateAsset("WALKING")?.loop == true)
    }

    @Test
    fun legacySpritesheetStateWithoutNamedAnimationKeepsSupportedStateRowFallback() {
        val descriptor = JsonParser.parseString(
            """
            {
              "stateAssets": {
                "IDLE": { "frames": 2, "fps": 4 },
                "BUSY": { "frames": 3, "fps": 6 }
              }
            }
            """.trimIndent()
        ).asJsonObject

        val companion = CompanionDetail(
            id = "legacy-sheet",
            name = "Legacy Sheet",
            assetType = "spritesheet",
            supportedStates = listOf("IDLE", "BUSY"),
            descriptor = descriptor
        )

        val animation = companion.spritesheetAnimation("BUSY")

        assertEquals(1, animation?.row)
        assertEquals(3, animation?.frameDurationsMs?.size)
        assertEquals(166, animation?.frameDurationsMs?.first())
    }
}
