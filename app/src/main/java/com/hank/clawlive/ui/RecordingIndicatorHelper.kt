package com.hank.clawlive.ui

import android.animation.ObjectAnimator
import android.app.Activity
import android.view.View
import android.widget.LinearLayout
import com.hank.clawlive.R
import com.hank.clawlive.data.local.FeedbackPreferences

/**
 * Adds a pulsing red recording indicator to any Activity's topBar
 * when FeedbackPreferences.isMarking is true.
 *
 * Usage:
 *   onResume  → RecordingIndicatorHelper.attach(this)
 *   onPause   → RecordingIndicatorHelper.detach()
 */
object RecordingIndicatorHelper {

    private const val INDICATOR_TAG = "recording_indicator"
    private var animator: ObjectAnimator? = null

    fun attach(activity: Activity) {
        val topBar = activity.findViewById<LinearLayout>(R.id.topBar) ?: return
        val prefs = FeedbackPreferences.getInstance(activity)

        if (prefs.isMarking) {
            var indicator = topBar.findViewWithTag<View>(INDICATOR_TAG)
            if (indicator == null) {
                indicator = View(activity).apply {
                    tag = INDICATOR_TAG
                    val size = (10 * activity.resources.displayMetrics.density).toInt()
                    val margin = (6 * activity.resources.displayMetrics.density).toInt()
                    layoutParams = LinearLayout.LayoutParams(size, size).apply {
                        marginStart = margin
                    }
                    setBackgroundResource(R.drawable.bg_recording_indicator)
                }
                topBar.addView(indicator)
            }
            indicator.visibility = View.VISIBLE
            animator?.cancel()
            animator = ObjectAnimator.ofFloat(indicator, "alpha", 1f, 0.3f).apply {
                duration = 800
                repeatCount = ObjectAnimator.INFINITE
                repeatMode = ObjectAnimator.REVERSE
                start()
            }
        } else {
            val indicator = topBar.findViewWithTag<View>(INDICATOR_TAG)
            animator?.cancel()
            animator = null
            indicator?.visibility = View.GONE
        }
    }

    fun detach() {
        animator?.cancel()
        animator = null
    }
}
