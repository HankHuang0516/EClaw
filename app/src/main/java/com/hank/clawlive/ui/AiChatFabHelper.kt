package com.hank.clawlive.ui

import android.view.Gravity
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.ImageButton
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import com.hank.clawlive.R

object AiChatFabHelper {

    fun setup(activity: AppCompatActivity, pageName: String) {
        val density = activity.resources.displayMetrics.density
        val fabSize = (56 * density).toInt()
        val margin = (16 * density).toInt()
        val bottomNavHeight = (60 * density).toInt()

        val fab = ImageButton(activity).apply {
            setImageResource(R.drawable.ic_ai_chat)
            setBackgroundResource(R.drawable.bg_fab_ai_chat)
            setColorFilter(0xFFFFFFFF.toInt())
            scaleType = android.widget.ImageView.ScaleType.CENTER
            elevation = 6 * density
            contentDescription = activity.getString(R.string.ai_chat_title)

            setOnClickListener {
                val existing = activity.supportFragmentManager.findFragmentByTag(AiChatBottomSheet.TAG)
                if (existing == null) {
                    AiChatBottomSheet.newInstance(pageName).show(activity.supportFragmentManager, AiChatBottomSheet.TAG)
                }
            }
        }

        val params = FrameLayout.LayoutParams(fabSize, fabSize).apply {
            gravity = Gravity.BOTTOM or Gravity.END
            rightMargin = margin
            bottomMargin = bottomNavHeight + margin
        }

        val wrapper = FrameLayout(activity).apply {
            addView(fab, params)
        }

        activity.addContentView(wrapper, ViewGroup.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT
        ))

        // Adjust for system navigation bar insets
        ViewCompat.setOnApplyWindowInsetsListener(wrapper) { _, insets ->
            val navBar = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            val lp = fab.layoutParams as FrameLayout.LayoutParams
            lp.bottomMargin = bottomNavHeight + margin + navBar.bottom
            fab.layoutParams = lp
            insets
        }
    }
}
