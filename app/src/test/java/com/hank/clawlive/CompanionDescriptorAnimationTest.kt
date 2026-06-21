package com.hank.clawlive

import com.google.gson.GsonBuilder
import com.google.gson.JsonParser
import com.hank.clawlive.data.model.CharacterState
import com.hank.clawlive.data.model.CharacterStateJsonAdapter
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

    @Test
    fun nativePetdexActionKeysUseNativeAnimationRowsWithoutStateAssets() {
        val descriptor = JsonParser.parseString(
            """
            {
              "asset": {
                "url": "https://example.test/petdex.webp",
                "frameWidth": 192,
                "frameHeight": 208,
                "animations": {
                  "idle": { "row": 0, "frames": [280, 110, 110, 140, 140, 320] },
                  "running-right": { "row": 1, "count": 8, "dur": 120, "last": 220 },
                  "running-left": { "row": 2, "count": 8, "dur": 120, "last": 220 },
                  "waving": { "row": 3, "count": 4, "dur": 140, "last": 280 },
                  "jumping": { "row": 4, "count": 5, "dur": 140, "last": 280 },
                  "failed": { "row": 5, "count": 8, "dur": 140, "last": 240 },
                  "waiting": { "row": 6, "count": 6, "dur": 150, "last": 260 },
                  "running": { "row": 7, "count": 6, "dur": 120, "last": 220 },
                  "review": { "row": 8, "count": 6, "dur": 150, "last": 280 }
                }
              },
              "stateAssets": {
                "IDLE": { "animation": "idle", "loop": true }
              }
            }
            """.trimIndent()
        ).asJsonObject

        val companion = CompanionDetail(
            id = "petdex-native-actions",
            name = "Petdex Native Actions",
            assetType = "spritesheet",
            supportedStates = listOf("IDLE"),
            descriptor = descriptor
        )

        val expectedRows = mapOf(
            "idle" to 0,
            "running-right" to 1,
            "running-left" to 2,
            "waving" to 3,
            "jumping" to 4,
            "failed" to 5,
            "waiting" to 6,
            "running" to 7,
            "review" to 8
        )

        expectedRows.forEach { (action, row) ->
            assertEquals(action, row, companion.spritesheetAnimation(action)?.row)
        }
        assertEquals(2, companion.spritesheetAnimation("RUNNING_LEFT")?.row)
    }

    @Test
    fun characterStateJsonAdapterAcceptsPetdexActionKeys() {
        val gson = GsonBuilder()
            .registerTypeAdapter(CharacterState::class.java, CharacterStateJsonAdapter())
            .create()

        assertEquals(CharacterState.RUNNING_LEFT, gson.fromJson("\"running-left\"", CharacterState::class.java))
        assertEquals(CharacterState.RUNNING_LEFT, gson.fromJson("\"RUNNING_LEFT\"", CharacterState::class.java))
        assertEquals(CharacterState.WAVING, gson.fromJson("\"wave\"", CharacterState::class.java))
        assertEquals(CharacterState.REVIEW, gson.fromJson("\"review\"", CharacterState::class.java))
        assertEquals(CharacterState.IDLE, gson.fromJson("\"not-real\"", CharacterState::class.java))
        assertEquals("\"running-left\"", gson.toJson(CharacterState.RUNNING_LEFT, CharacterState::class.java))
        assertTrue(CharacterState.WAVING.pausesAmbientWander)
        assertEquals("review", CharacterState.REVIEW.wallpaperActionKey)
    }
}
