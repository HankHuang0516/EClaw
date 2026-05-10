package com.hank.clawlive.engine

import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import com.hank.clawlive.data.model.CompanionDetail
import com.hank.clawlive.data.model.EntityStatus
import kotlin.math.sin

/**
 * Procedural drawers keyed by `descriptor.asset.renderer` (spec §4.3).
 * All drawers operate inside a 120x120 logical viewport so the existing
 * lobster-style canvas transform in ClawRenderer can wrap them unchanged.
 *
 * Adding a new creature: register a new key + body Path in [draw].
 */
object ProceduralCreatureDrawer {

    fun supports(rendererKey: String?): Boolean = when (rendererKey) {
        "cat-procedural", "dog-procedural", "fish-procedural" -> true
        else -> false
    }

    /**
     * Draws creature inside the already-transformed canvas (120x120 viewport).
     * Returns true if a creature was drawn, false to fall back to default lobster.
     */
    fun draw(
        canvas: Canvas,
        rendererKey: String?,
        entity: EntityStatus,
        companion: CompanionDetail?,
        bodyColor: Int,
        darkColor: Int,
        timeMs: Long
    ): Boolean = when (rendererKey) {
        "cat-procedural" -> { drawCat(canvas, entity, bodyColor, darkColor, timeMs); true }
        "dog-procedural" -> { drawDog(canvas, entity, bodyColor, darkColor, timeMs); true }
        "fish-procedural" -> { drawFish(canvas, entity, bodyColor, darkColor, timeMs); true }
        else -> false
    }

    private fun fillPaint(c: Int) = Paint().apply {
        style = Paint.Style.FILL; color = c; isAntiAlias = true
    }
    private fun strokePaint(c: Int, w: Float = 2f) = Paint().apply {
        style = Paint.Style.STROKE; color = c; strokeWidth = w
        strokeCap = Paint.Cap.ROUND; isAntiAlias = true
    }

    // ---------------------------------------------------------------- Cat
    private fun drawCat(canvas: Canvas, e: EntityStatus, body: Int, dark: Int, t: Long) {
        val tailWag = sin(t * 0.005).toFloat() * 8f
        val ear = fillPaint(body)
        val bodyP = fillPaint(body)
        val belly = fillPaint(lighten(body, 0.25f))
        val outline = strokePaint(dark, 1.5f)

        // Tail (behind body, animated wag)
        val tail = Path().apply {
            moveTo(95f, 80f)
            quadTo(115f + tailWag, 60f, 110f + tailWag, 35f)
            quadTo(108f + tailWag, 30f, 105f + tailWag, 32f)
            quadTo(108f + tailWag, 50f, 90f, 78f)
            close()
        }
        canvas.drawPath(tail, bodyP); canvas.drawPath(tail, outline)

        // Body (rounded oval)
        val bodyPath = Path().apply {
            moveTo(60f, 30f)
            cubicTo(25f, 30f, 18f, 70f, 25f, 95f)
            cubicTo(30f, 110f, 90f, 110f, 95f, 95f)
            cubicTo(102f, 70f, 95f, 30f, 60f, 30f)
            close()
        }
        canvas.drawPath(bodyPath, bodyP); canvas.drawPath(bodyPath, outline)

        // Belly highlight
        val bellyPath = Path().apply {
            moveTo(45f, 65f); cubicTo(42f, 90f, 78f, 90f, 75f, 65f)
            cubicTo(70f, 60f, 50f, 60f, 45f, 65f); close()
        }
        canvas.drawPath(bellyPath, belly)

        // Ears (triangles)
        val earL = Path().apply {
            moveTo(35f, 30f); lineTo(28f, 8f); lineTo(50f, 22f); close()
        }
        val earR = Path().apply {
            moveTo(85f, 30f); lineTo(92f, 8f); lineTo(70f, 22f); close()
        }
        canvas.drawPath(earL, ear); canvas.drawPath(earL, outline)
        canvas.drawPath(earR, ear); canvas.drawPath(earR, outline)
        // Inner ears
        val pink = fillPaint(Color.argb(255, 255, 180, 200))
        canvas.drawPath(Path().apply {
            moveTo(36f, 28f); lineTo(33f, 14f); lineTo(43f, 22f); close()
        }, pink)
        canvas.drawPath(Path().apply {
            moveTo(84f, 28f); lineTo(87f, 14f); lineTo(77f, 22f); close()
        }, pink)

        // Face features
        drawCatFace(canvas, e, dark)

        // Front paws
        canvas.drawCircle(40f, 105f, 8f, bodyP)
        canvas.drawCircle(80f, 105f, 8f, bodyP)
    }

    private fun drawCatFace(canvas: Canvas, e: EntityStatus, dark: Int) {
        val eye = fillPaint(Color.parseColor("#1a1a2e"))
        val glow = fillPaint(Color.parseColor("#80ffd9"))
        val sleeping = e.state.toString() == "SLEEPING"

        if (sleeping) {
            // Closed eyes (curve)
            val p = strokePaint(Color.parseColor("#1a1a2e"), 2f)
            canvas.drawArc(46f, 50f, 56f, 60f, 0f, 180f, false, p)
            canvas.drawArc(64f, 50f, 74f, 60f, 0f, 180f, false, p)
        } else {
            canvas.drawCircle(51f, 55f, 4f, eye)
            canvas.drawCircle(69f, 55f, 4f, eye)
            // Cyan slit pupil
            val slit = Paint().apply {
                color = Color.parseColor("#80ffd9"); style = Paint.Style.FILL; isAntiAlias = true
            }
            canvas.drawOval(50f, 53f, 52f, 57f, slit)
            canvas.drawOval(68f, 53f, 70f, 57f, slit)
        }

        // Pink nose
        val nose = fillPaint(Color.parseColor("#ff8fa3"))
        val noseP = Path().apply {
            moveTo(57f, 65f); lineTo(63f, 65f); lineTo(60f, 70f); close()
        }
        canvas.drawPath(noseP, nose)

        // Mouth
        val mouth = strokePaint(dark, 1.5f)
        canvas.drawLine(60f, 70f, 60f, 74f, mouth)
        canvas.drawArc(54f, 70f, 60f, 78f, 0f, 90f, false, mouth)
        canvas.drawArc(60f, 70f, 66f, 78f, 90f, 90f, false, mouth)

        // Whiskers
        val w = strokePaint(dark, 1f)
        canvas.drawLine(28f, 65f, 48f, 64f, w)
        canvas.drawLine(28f, 70f, 48f, 70f, w)
        canvas.drawLine(72f, 64f, 92f, 65f, w)
        canvas.drawLine(72f, 70f, 92f, 70f, w)
    }

    // ---------------------------------------------------------------- Dog
    private fun drawDog(canvas: Canvas, e: EntityStatus, body: Int, dark: Int, t: Long) {
        val tailWag = sin(t * 0.012).toFloat() * 12f
        val tongue = e.state.toString() == "EXCITED" || e.state.toString() == "EATING"

        val bodyP = fillPaint(body)
        val outline = strokePaint(dark, 2f)
        val belly = fillPaint(lighten(body, 0.3f))
        val earC = fillPaint(darken(body, 0.7f))

        // Wagging tail
        val tail = Path().apply {
            moveTo(98f, 70f)
            quadTo(115f + tailWag, 55f, 112f + tailWag, 35f)
            quadTo(110f + tailWag, 30f, 107f + tailWag, 33f)
            quadTo(106f + tailWag, 50f, 95f, 70f)
            close()
        }
        canvas.drawPath(tail, bodyP); canvas.drawPath(tail, outline)

        // Body
        val bodyPath = Path().apply {
            moveTo(60f, 35f)
            cubicTo(28f, 35f, 20f, 75f, 28f, 100f)
            cubicTo(35f, 112f, 85f, 112f, 92f, 100f)
            cubicTo(100f, 75f, 92f, 35f, 60f, 35f)
            close()
        }
        canvas.drawPath(bodyPath, bodyP); canvas.drawPath(bodyPath, outline)

        // Belly
        canvas.drawPath(Path().apply {
            moveTo(45f, 75f); cubicTo(42f, 100f, 78f, 100f, 75f, 75f)
            cubicTo(70f, 70f, 50f, 70f, 45f, 75f); close()
        }, belly)

        // Floppy ears
        val earL = Path().apply {
            moveTo(32f, 35f); cubicTo(20f, 40f, 18f, 65f, 32f, 65f)
            cubicTo(38f, 60f, 38f, 38f, 32f, 35f); close()
        }
        val earR = Path().apply {
            moveTo(88f, 35f); cubicTo(100f, 40f, 102f, 65f, 88f, 65f)
            cubicTo(82f, 60f, 82f, 38f, 88f, 35f); close()
        }
        canvas.drawPath(earL, earC); canvas.drawPath(earL, outline)
        canvas.drawPath(earR, earC); canvas.drawPath(earR, outline)

        // Face
        drawDogFace(canvas, e, dark, tongue)

        // Front paws
        canvas.drawCircle(40f, 108f, 9f, bodyP)
        canvas.drawCircle(80f, 108f, 9f, bodyP)
        canvas.drawCircle(40f, 108f, 9f, outline)
        canvas.drawCircle(80f, 108f, 9f, outline)
    }

    private fun drawDogFace(canvas: Canvas, e: EntityStatus, dark: Int, tongue: Boolean) {
        val eye = fillPaint(Color.parseColor("#1a1a2e"))
        val sleeping = e.state.toString() == "SLEEPING"

        if (sleeping) {
            val p = strokePaint(Color.parseColor("#1a1a2e"), 2f)
            canvas.drawArc(46f, 52f, 56f, 62f, 0f, 180f, false, p)
            canvas.drawArc(64f, 52f, 74f, 62f, 0f, 180f, false, p)
        } else {
            canvas.drawCircle(51f, 57f, 4.5f, eye)
            canvas.drawCircle(69f, 57f, 4.5f, eye)
            val white = fillPaint(Color.WHITE)
            canvas.drawCircle(52f, 56f, 1.5f, white)
            canvas.drawCircle(70f, 56f, 1.5f, white)
        }

        // Snout
        val snout = fillPaint(lighten(dark, 0.6f))
        val snoutPath = Path().apply {
            moveTo(50f, 68f); cubicTo(50f, 80f, 70f, 80f, 70f, 68f)
            cubicTo(70f, 65f, 50f, 65f, 50f, 68f); close()
        }
        canvas.drawPath(snoutPath, snout)

        // Black nose
        val nose = fillPaint(Color.parseColor("#1a1a2e"))
        val noseP = Path().apply {
            moveTo(56f, 70f); cubicTo(56f, 76f, 64f, 76f, 64f, 70f)
            cubicTo(64f, 67f, 56f, 67f, 56f, 70f); close()
        }
        canvas.drawPath(noseP, nose)

        if (tongue) {
            val pink = fillPaint(Color.parseColor("#ff6b8a"))
            canvas.drawPath(Path().apply {
                moveTo(57f, 76f); cubicTo(56f, 88f, 64f, 88f, 63f, 76f); close()
            }, pink)
        }
    }

    // ---------------------------------------------------------------- Fish
    private fun drawFish(canvas: Canvas, e: EntityStatus, body: Int, dark: Int, t: Long) {
        val finFlap = sin(t * 0.008).toFloat() * 6f
        val tailWave = sin(t * 0.006).toFloat() * 5f

        val bodyP = fillPaint(body)
        val outline = strokePaint(dark, 1.5f)
        val belly = fillPaint(lighten(body, 0.4f))
        val finC = fillPaint(darken(body, 0.75f))

        // Tail fin (back)
        val tail = Path().apply {
            moveTo(20f, 60f)
            lineTo(5f, 35f + tailWave)
            lineTo(8f, 60f)
            lineTo(5f, 85f - tailWave)
            close()
        }
        canvas.drawPath(tail, finC); canvas.drawPath(tail, outline)

        // Body (almond)
        val bodyPath = Path().apply {
            moveTo(20f, 60f)
            cubicTo(25f, 30f, 90f, 30f, 105f, 60f)
            cubicTo(90f, 90f, 25f, 90f, 20f, 60f)
            close()
        }
        canvas.drawPath(bodyPath, bodyP); canvas.drawPath(bodyPath, outline)

        // Belly stripe
        canvas.drawPath(Path().apply {
            moveTo(30f, 65f); cubicTo(40f, 82f, 80f, 82f, 95f, 65f)
            cubicTo(85f, 75f, 35f, 75f, 30f, 65f); close()
        }, belly)

        // Top dorsal fin (animated)
        val dorsal = Path().apply {
            moveTo(45f, 35f)
            lineTo(55f, 18f + finFlap)
            lineTo(65f, 20f + finFlap)
            lineTo(75f, 35f)
            close()
        }
        canvas.drawPath(dorsal, finC); canvas.drawPath(dorsal, outline)

        // Side fin
        val sideFin = Path().apply {
            moveTo(60f, 70f)
            quadTo(50f, 88f + finFlap, 65f, 80f)
            close()
        }
        canvas.drawPath(sideFin, finC); canvas.drawPath(sideFin, outline)

        // Scales (decorative dots)
        val scale = fillPaint(darken(body, 0.85f))
        for (sx in intArrayOf(45, 60, 75, 90)) {
            for (sy in intArrayOf(50, 65)) {
                canvas.drawCircle(sx.toFloat(), sy.toFloat(), 3f, scale)
            }
        }

        // Eye
        drawFishFace(canvas, e)
    }

    private fun drawFishFace(canvas: Canvas, e: EntityStatus) {
        val sleeping = e.state.toString() == "SLEEPING"
        val white = fillPaint(Color.WHITE)
        val pupil = fillPaint(Color.parseColor("#1a1a2e"))
        val outline = strokePaint(Color.parseColor("#1a1a2e"), 1f)

        canvas.drawCircle(85f, 55f, 6f, white)
        canvas.drawCircle(85f, 55f, 6f, outline)
        if (sleeping) {
            val p = strokePaint(Color.parseColor("#1a1a2e"), 1.5f)
            canvas.drawLine(80f, 55f, 90f, 55f, p)
        } else {
            canvas.drawCircle(86f, 55f, 3f, pupil)
            canvas.drawCircle(87f, 54f, 1f, white)
        }

        // Mouth (pucker)
        val m = strokePaint(Color.parseColor("#1a1a2e"), 1.5f)
        canvas.drawArc(95f, 60f, 105f, 70f, 90f, 180f, false, m)
    }

    // ---------------------------------------------------------------- color utils
    private fun lighten(c: Int, factor: Float): Int {
        val r = Color.red(c); val g = Color.green(c); val b = Color.blue(c)
        return Color.rgb(
            (r + (255 - r) * factor).toInt().coerceIn(0, 255),
            (g + (255 - g) * factor).toInt().coerceIn(0, 255),
            (b + (255 - b) * factor).toInt().coerceIn(0, 255),
        )
    }

    private fun darken(c: Int, factor: Float): Int {
        val r = Color.red(c); val g = Color.green(c); val b = Color.blue(c)
        return Color.rgb(
            (r * factor).toInt().coerceIn(0, 255),
            (g * factor).toInt().coerceIn(0, 255),
            (b * factor).toInt().coerceIn(0, 255),
        )
    }
}
