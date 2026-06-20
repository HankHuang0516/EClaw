package com.hank.clawlive

import android.graphics.Bitmap
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.hank.clawlive.data.local.WallpaperEntitySnapshotCache
import com.hank.clawlive.data.local.WallpaperSpritesheetDiskCache
import com.hank.clawlive.data.model.CharacterState
import com.hank.clawlive.data.model.EntityStatus
import com.hank.clawlive.data.model.MessageQueueItem
import java.io.ByteArrayOutputStream
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class WallpaperOfflineEntityCacheTest {
    @Test
    fun cacheKeepsAppearanceButStripsSecretsAndMessages() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val cache = WallpaperEntitySnapshotCache.getInstance(context)
        cache.clearForTest()

        cache.saveEntities(
            listOf(
                EntityStatus(
                    entityId = 6,
                    name = "Admin companion",
                    character = "LOBSTER",
                    state = CharacterState.EXCITED,
                    message = "private message should not persist",
                    parts = mapOf("EYE_LID" to 0.25),
                    isBound = true,
                    messageQueue = listOf(
                        MessageQueueItem(
                            text = "private queue",
                            from = "entity",
                            fromEntityId = 2,
                            fromCharacter = "LOBSTER",
                            timestamp = 1L
                        )
                    ),
                    botSecret = "secret",
                    publicCode = "pub_code",
                    avatar = "🦞"
                )
            ),
            totalSlots = 8,
            nowMs = 1234L
        )

        val snapshot = cache.loadEntities()
        requireNotNull(snapshot)
        assertEquals(8, snapshot.totalSlots)
        assertEquals(1234L, snapshot.cachedAt)
        assertEquals(1, snapshot.entities.size)
        val entity = snapshot.entities.single()
        assertEquals(6, entity.entityId)
        assertEquals("Admin companion", entity.name)
        assertEquals(CharacterState.EXCITED, entity.state)
        assertEquals("LOBSTER", entity.character)
        assertEquals("🦞", entity.avatar)
        assertTrue(entity.isBound)
        assertEquals("", entity.message)
        assertNull(entity.messageQueue)
        assertNull(entity.botSecret)
        assertNull(entity.publicCode)
    }

    @Test
    fun spritesheetDiskCacheSurvivesMemoryLoss() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val diskCache = WallpaperSpritesheetDiskCache.getInstance(context)
        diskCache.clearForTest()

        val bitmap = Bitmap.createBitmap(2, 2, Bitmap.Config.ARGB_8888)
        val out = ByteArrayOutputStream()
        assertTrue(bitmap.compress(Bitmap.CompressFormat.PNG, 100, out))

        val url = "https://assets.example.test/eclaw/wallpaper/sheet.png"
        diskCache.save(url, out.toByteArray())

        val loaded = diskCache.load(url)
        assertNotNull(loaded)
        assertEquals(2, loaded?.width)
        assertEquals(2, loaded?.height)
    }
}
