package com.hank.clawlive.ui.mission

import android.content.Context
import android.graphics.*
import android.util.AttributeSet
import android.view.MotionEvent
import android.view.View
import org.json.JSONArray
import org.json.JSONObject

/**
 * Canvas overlay for drawing on note pages.
 * Stores strokes as JSON-serializable data for server persistence.
 */
class DrawingCanvasView @JvmOverloads constructor(
    context: Context, attrs: AttributeSet? = null, defStyleAttr: Int = 0
) : View(context, attrs, defStyleAttr) {

    data class Stroke(
        val color: Int,
        val size: Float,
        val isEraser: Boolean,
        val points: MutableList<PointF> = mutableListOf()
    )

    private val strokes = mutableListOf<Stroke>()
    private var currentStroke: Stroke? = null

    var drawColor: Int = Color.RED
    var drawSize: Float = 6f
    var isEraser: Boolean = false

    private val paint = Paint().apply {
        isAntiAlias = true
        style = Paint.Style.STROKE
        strokeCap = Paint.Cap.ROUND
        strokeJoin = Paint.Join.ROUND
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        for (stroke in strokes) {
            drawStroke(canvas, stroke)
        }
        currentStroke?.let { drawStroke(canvas, it) }
    }

    private fun drawStroke(canvas: Canvas, stroke: Stroke) {
        if (stroke.points.size < 2) return
        paint.color = stroke.color
        paint.strokeWidth = stroke.size
        paint.xfermode = if (stroke.isEraser) PorterDuffXfermode(PorterDuff.Mode.CLEAR) else null
        val path = Path()
        path.moveTo(stroke.points[0].x, stroke.points[0].y)
        for (i in 1 until stroke.points.size) {
            path.lineTo(stroke.points[i].x, stroke.points[i].y)
        }
        canvas.drawPath(path, paint)
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        when (event.action) {
            MotionEvent.ACTION_DOWN -> {
                currentStroke = Stroke(
                    color = drawColor,
                    size = drawSize,
                    isEraser = isEraser,
                    points = mutableListOf(PointF(event.x, event.y))
                )
                invalidate()
                return true
            }
            MotionEvent.ACTION_MOVE -> {
                currentStroke?.points?.add(PointF(event.x, event.y))
                invalidate()
                return true
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                currentStroke?.let {
                    if (it.points.size > 1) strokes.add(it)
                }
                currentStroke = null
                invalidate()
                return true
            }
        }
        return super.onTouchEvent(event)
    }

    fun clearAll() {
        strokes.clear()
        currentStroke = null
        invalidate()
    }

    fun toJson(): String {
        val arr = JSONArray()
        for (s in strokes) {
            val obj = JSONObject()
            obj.put("color", String.format("#%06X", 0xFFFFFF and s.color))
            obj.put("size", s.size.toInt())
            obj.put("eraser", s.isEraser)
            val pts = JSONArray()
            for (p in s.points) {
                val pt = JSONObject()
                pt.put("x", p.x.toInt())
                pt.put("y", p.y.toInt())
                pts.put(pt)
            }
            obj.put("points", pts)
            arr.put(obj)
        }
        return arr.toString()
    }

    fun loadFromJson(json: String?) {
        strokes.clear()
        if (json.isNullOrBlank()) { invalidate(); return }
        try {
            val arr = JSONArray(json)
            for (i in 0 until arr.length()) {
                val obj = arr.getJSONObject(i)
                val color = try { Color.parseColor(obj.getString("color")) } catch (_: Exception) { Color.RED }
                val size = obj.optDouble("size", 6.0).toFloat()
                val eraser = obj.optBoolean("eraser", false)
                val pts = obj.getJSONArray("points")
                val points = mutableListOf<PointF>()
                for (j in 0 until pts.length()) {
                    val pt = pts.getJSONObject(j)
                    points.add(PointF(pt.optDouble("x").toFloat(), pt.optDouble("y").toFloat()))
                }
                strokes.add(Stroke(color, size, eraser, points))
            }
        } catch (_: Exception) { /* ignore parse errors */ }
        invalidate()
    }
}
