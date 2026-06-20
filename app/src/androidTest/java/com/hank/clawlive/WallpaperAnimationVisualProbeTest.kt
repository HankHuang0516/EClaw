package com.hank.clawlive

import android.content.ContentValues
import android.graphics.Bitmap
import android.graphics.Canvas
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.view.MotionEvent
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.hank.clawlive.data.local.LayoutPreferences
import com.hank.clawlive.data.model.CharacterState
import com.hank.clawlive.data.model.EntityStatus
import com.hank.clawlive.engine.ClawRenderer
import com.hank.clawlive.ui.WallpaperPreviewView
import java.io.File
import java.io.FileOutputStream
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class WallpaperAnimationVisualProbeTest {
    @Test
    fun captureRendererBubbleAuraShadowProbe() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val prefs = LayoutPreferences.getInstance(context)
        prefs.clearAllCustomPositions()
        prefs.clearAllEntityScales()
        prefs.useCustomLayout = true
        prefs.wallpaperWalkingEnabled = true
        prefs.wallpaperSpeechBubblesEnabled = true
        prefs.wallpaperBubblePulseEnabled = true
        prefs.wallpaperBubbleOverlayAvoidanceEnabled = true
        prefs.wallpaperStateAuraEnabled = true
        prefs.wallpaperGroundShadowEnabled = true
        prefs.wallpaperAdaptiveEffectsEnabled = true
        prefs.wallpaperOfflineEntityCacheEnabled = true
        prefs.usageOverlayEnabled = true
        prefs.clearUsageOverlayTransform()
        prefs.setEntityScale(0, 0.72f)
        prefs.setEntityScale(1, 0.72f)
        prefs.setCustomPosition(0, 0.28f, 0.05f)
        prefs.setCustomPosition(1, 0.52f, 0.68f)

        val bitmap = Bitmap.createBitmap(1080, 1920, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        val renderer = ClawRenderer(context)
        renderer.drawMultiEntity(
            canvas,
            listOf(
                EntityStatus(
                    entityId = 0,
                    name = "Top flip",
                    state = CharacterState.EXCITED,
                    message = "Near top: bubble flips below",
                    isBound = true
                ),
                EntityStatus(
                    entityId = 1,
                    name = "Busy walk",
                    state = CharacterState.BUSY,
                    message = "Walking anchor + aura",
                    isBound = true
                )
            ),
            loading = false
        )

        val file = saveBitmap("renderer-bubble-aura-shadow.png", bitmap)
        assertTrue(file.length() > 0)
    }

    @Test
    fun capturePreviewRenderedHitTargetProbe() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val targetContext = instrumentation.targetContext
        val prefs = LayoutPreferences.getInstance(targetContext)
        prefs.clearAllCustomPositions()
        prefs.clearAllEntityScales()
        prefs.useCustomLayout = true
        prefs.wallpaperWalkingEnabled = true
        prefs.wallpaperSpeechBubblesEnabled = true
        prefs.wallpaperBubblePulseEnabled = true
        prefs.wallpaperBubbleOverlayAvoidanceEnabled = true
        prefs.wallpaperStateAuraEnabled = true
        prefs.wallpaperGroundShadowEnabled = true
        prefs.wallpaperAdaptiveEffectsEnabled = true
        prefs.wallpaperOfflineEntityCacheEnabled = true
        prefs.setCustomPosition(0, 0.72f, 0.46f)

        ActivityScenario.launch(WallpaperPreviewActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                val preview = activity.findViewById<WallpaperPreviewView>(R.id.wallpaperPreviewView)
                preview.setEntities(
                    listOf(
                        EntityStatus(entityId = 0, name = "Walker", isBound = true)
                    )
                )
                preview.dispatchTouchEvent(
                    MotionEvent.obtain(
                        0L,
                        32L,
                        MotionEvent.ACTION_DOWN,
                        preview.width * 0.72f,
                        preview.height * 0.46f,
                        0
                    )
                )
                preview.dispatchTouchEvent(
                    MotionEvent.obtain(
                        0L,
                        64L,
                        MotionEvent.ACTION_UP,
                        preview.width * 0.72f,
                        preview.height * 0.46f,
                        0
                    )
                )
                val bitmap = Bitmap.createBitmap(preview.width, preview.height, Bitmap.Config.ARGB_8888)
                preview.draw(Canvas(bitmap))
                val file = saveBitmap("preview-rendered-hit-target.png", bitmap)
                assertTrue(file.length() > 0)
            }
            instrumentation.waitForIdleSync()
        }
    }

    private fun saveBitmap(name: String, bitmap: Bitmap): File {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val dir = File(context.getExternalFilesDir(null), "wallpaper-animation-visual-probes")
        dir.mkdirs()
        val file = File(dir, name)
        FileOutputStream(file).use { out ->
            bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)
        }
        savePublicDownloadBitmap(name, bitmap)
        return file
    }

    private fun savePublicDownloadBitmap(name: String, bitmap: Bitmap) {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val values = ContentValues().apply {
                put(MediaStore.Downloads.DISPLAY_NAME, name)
                put(MediaStore.Downloads.MIME_TYPE, "image/png")
                put(MediaStore.Downloads.RELATIVE_PATH, "Download/eclaw-wallpaper-visual-probes")
                put(MediaStore.Downloads.IS_PENDING, 1)
            }
            val uri = context.contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                ?: error("Unable to create visual probe download: $name")
            context.contentResolver.openOutputStream(uri)?.use { out ->
                bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)
            } ?: error("Unable to open visual probe download: $name")
            values.clear()
            values.put(MediaStore.Downloads.IS_PENDING, 0)
            context.contentResolver.update(uri, values, null, null)
        } else {
            val dir = File(
                Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS),
                "eclaw-wallpaper-visual-probes"
            )
            dir.mkdirs()
            FileOutputStream(File(dir, name)).use { out ->
                bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)
            }
        }
    }
}
