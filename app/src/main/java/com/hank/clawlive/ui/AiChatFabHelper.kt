package com.hank.clawlive.ui

import android.annotation.SuppressLint
import android.content.Context
import android.view.Gravity
import android.view.MotionEvent
import android.view.ViewGroup
import android.view.animation.OvershootInterpolator
import android.widget.FrameLayout
import android.widget.ImageButton
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import com.hank.clawlive.R

object AiChatFabHelper {

    private const val PREFS_NAME = "ai_chat_fab"
    private const val KEY_X = "fab_x"
    private const val KEY_Y = "fab_y"
    private const val DRAG_THRESHOLD = 12f  // px — movement beyond this = drag, not click

    @SuppressLint("ClickableViewAccessibility")
    fun setup(activity: AppCompatActivity, pageName: String) {
        val density = activity.resources.displayMetrics.density
        val fabSize = (56 * density).toInt()
        val defaultMargin = (16 * density).toInt()
        val bottomNavHeight = (60 * density).toInt()

        val prefs = activity.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val savedX = prefs.getFloat(KEY_X, -1f)
        val savedY = prefs.getFloat(KEY_Y, -1f)

        val fab = ImageButton(activity).apply {
            setImageResource(R.drawable.ic_ai_chat)
            setBackgroundResource(R.drawable.bg_fab_ai_chat)
            setColorFilter(0xFFFFFFFF.toInt())
            scaleType = android.widget.ImageView.ScaleType.CENTER
            elevation = 6 * density
            contentDescription = activity.getString(R.string.ai_chat_title)
        }

        // Use absolute positioning (no gravity) so we can freely move the FAB
        val params = FrameLayout.LayoutParams(fabSize, fabSize).apply {
            gravity = Gravity.NO_GRAVITY
        }

        val wrapper = FrameLayout(activity).apply {
            addView(fab, params)
        }

        activity.addContentView(wrapper, ViewGroup.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT
        ))

        // Position after layout pass so we know parent dimensions
        wrapper.post {
            val parentW = wrapper.width
            val parentH = wrapper.height

            // Compute system bar insets
            val insets = ViewCompat.getRootWindowInsets(wrapper)
            val sysInsets = insets?.getInsets(WindowInsetsCompat.Type.systemBars())
            val topSafe = (sysInsets?.top ?: 0) + defaultMargin
            val bottomSafe = bottomNavHeight + (sysInsets?.bottom ?: 0) + defaultMargin

            if (savedX >= 0 && savedY >= 0) {
                // Restore saved position, clamped to safe area
                val x = savedX.coerceIn(defaultMargin.toFloat(), (parentW - fabSize - defaultMargin).toFloat())
                val y = savedY.coerceIn(topSafe.toFloat(), (parentH - fabSize - bottomSafe).toFloat())
                fab.x = x
                fab.y = y
            } else {
                // Default: bottom-right, above bottom nav
                fab.x = (parentW - fabSize - defaultMargin).toFloat()
                fab.y = (parentH - fabSize - bottomSafe).toFloat()
            }

            // ── Touch: drag + click ──
            var downX = 0f
            var downY = 0f
            var downRawX = 0f
            var downRawY = 0f
            var isDragging = false

            fab.setOnTouchListener { v, event ->
                when (event.actionMasked) {
                    MotionEvent.ACTION_DOWN -> {
                        downX = v.x - event.rawX
                        downY = v.y - event.rawY
                        downRawX = event.rawX
                        downRawY = event.rawY
                        isDragging = false
                        true
                    }
                    MotionEvent.ACTION_MOVE -> {
                        val dx = event.rawX - downRawX
                        val dy = event.rawY - downRawY
                        if (!isDragging && (dx * dx + dy * dy) > DRAG_THRESHOLD * DRAG_THRESHOLD * density * density) {
                            isDragging = true
                        }
                        if (isDragging) {
                            val newX = (event.rawX + downX).coerceIn(
                                defaultMargin.toFloat(),
                                (parentW - fabSize - defaultMargin).toFloat()
                            )
                            val newY = (event.rawY + downY).coerceIn(
                                topSafe.toFloat(),
                                (parentH - fabSize - bottomSafe).toFloat()
                            )
                            v.x = newX
                            v.y = newY
                        }
                        true
                    }
                    MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                        if (isDragging) {
                            // Snap to nearest horizontal edge
                            val midX = parentW / 2f
                            val targetX = if (v.x + fabSize / 2f < midX)
                                defaultMargin.toFloat()
                            else
                                (parentW - fabSize - defaultMargin).toFloat()

                            v.animate()
                                .x(targetX)
                                .setDuration(250)
                                .setInterpolator(OvershootInterpolator(1.2f))
                                .start()

                            // Save position (use targetX for snapped X)
                            prefs.edit()
                                .putFloat(KEY_X, targetX)
                                .putFloat(KEY_Y, v.y)
                                .apply()
                        } else {
                            // It's a tap → open AI chat
                            v.performClick()
                        }
                        true
                    }
                    else -> false
                }
            }

            fab.setOnClickListener {
                val existing = activity.supportFragmentManager.findFragmentByTag(AiChatBottomSheet.TAG)
                if (existing == null) {
                    AiChatBottomSheet.newInstance(pageName)
                        .show(activity.supportFragmentManager, AiChatBottomSheet.TAG)
                }
            }
        }

        // Re-clamp on insets change (e.g. keyboard appears)
        ViewCompat.setOnApplyWindowInsetsListener(wrapper) { _, insets ->
            insets
        }
    }
}
