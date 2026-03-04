package com.hank.clawlive.service

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Canvas
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.SweepGradient
import android.os.Build
import android.util.TypedValue
import android.view.RoundedCorner
import android.view.View
import android.view.WindowManager
import android.view.animation.LinearInterpolator

/**
 * Full-screen transparent overlay that draws an animated rainbow border.
 * Used by ScreenControlService to signal bot remote control is active.
 *
 * Rendering: rotating SweepGradient stroke along all 4 screen edges, with
 * a wider softer glow layer underneath for depth.
 * Corner radius matches the device's physical screen corner radius (API 31+).
 */
class RemoteControlBorderView(context: Context) : View(context) {

    private val borderWidthPx = dp(6f)
    private val glowWidthPx   = dp(11f)

    // Rainbow palette (cyan → green → yellow → pink → purple → blue → cyan)
    private val colors = intArrayOf(
        0xFF00FFFF.toInt(),
        0xFF00FF88.toInt(),
        0xFFAAFF00.toInt(),
        0xFFFFFF00.toInt(),
        0xFFFF0099.toInt(),
        0xFF9900FF.toInt(),
        0xFF0088FF.toInt(),
        0xFF00FFFF.toInt(),
    )

    private val borderPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = borderWidthPx
        strokeJoin = Paint.Join.ROUND
        strokeCap  = Paint.Cap.ROUND
    }

    private val glowPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = glowWidthPx
        strokeJoin = Paint.Join.ROUND
        strokeCap  = Paint.Cap.ROUND
        alpha = 70
    }

    private val borderPath = Path()
    private val gradientMatrix = Matrix()
    private var rotationDeg = 0f

    private val animator = ValueAnimator.ofFloat(0f, 360f).apply {
        duration = 2000L
        repeatCount = ValueAnimator.INFINITE
        repeatMode  = ValueAnimator.RESTART
        interpolator = LinearInterpolator()
        addUpdateListener { va ->
            rotationDeg = va.animatedValue as Float
            invalidate()
        }
    }

    /** Read the device's physical screen corner radius (API 31+), fallback 0. */
    private fun screenCornerRadiusPx(): Float {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val wm = context.getSystemService(Context.WINDOW_SERVICE) as WindowManager
            val corner = wm.currentWindowMetrics.windowInsets
                .getRoundedCorner(RoundedCorner.POSITION_TOP_LEFT)
            if (corner != null) return corner.radius.toFloat()
        }
        return 0f
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        val inset = borderWidthPx / 2f
        // Path corner radius = screen corner radius minus the path inset,
        // so the outer edge of the stroke aligns with the physical screen curve.
        val cornerRadius = maxOf(screenCornerRadiusPx() - inset, 0f)
        borderPath.reset()
        borderPath.addRoundRect(
            RectF(inset, inset, w - inset, h - inset),
            cornerRadius, cornerRadius,
            Path.Direction.CW
        )
    }

    override fun onDraw(canvas: Canvas) {
        if (width == 0 || height == 0) return

        val cx = width  / 2f
        val cy = height / 2f

        val shader = SweepGradient(cx, cy, colors, null)
        gradientMatrix.setRotate(rotationDeg, cx, cy)
        shader.setLocalMatrix(gradientMatrix)

        glowPaint.shader   = shader
        borderPaint.shader = shader

        canvas.drawPath(borderPath, glowPaint)
        canvas.drawPath(borderPath, borderPaint)
    }

    fun startAnimation() {
        if (!animator.isRunning) animator.start()
    }

    fun stopAnimation() {
        animator.cancel()
    }

    override fun onDetachedFromWindow() {
        super.onDetachedFromWindow()
        animator.cancel()
    }

    private fun dp(value: Float) = TypedValue.applyDimension(
        TypedValue.COMPLEX_UNIT_DIP, value, resources.displayMetrics
    )
}
