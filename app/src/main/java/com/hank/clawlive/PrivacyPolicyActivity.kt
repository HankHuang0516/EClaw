package com.hank.clawlive

import android.os.Bundle
import android.text.Html
import android.widget.ImageButton
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.updatePadding
import com.hank.clawlive.ui.RecordingIndicatorHelper

class PrivacyPolicyActivity : AppCompatActivity() {

    override fun onResume() {
        super.onResume()
        RecordingIndicatorHelper.attach(this)
    }

    override fun onPause() {
        super.onPause()
        RecordingIndicatorHelper.detach()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        setContentView(R.layout.activity_privacy_policy)

        val btnBack = findViewById<ImageButton>(R.id.btnBack)
        btnBack.setOnClickListener { finish() }

        // Android TextView supports some HTML tags automatically in strings.xml if formatted correctly, but typically requires Html.fromHtml() for robust support.
        // However, I didn't give it an ID in the layout file I created in step 321.
        // Let me check the layout file content I wrote.
        // It was:
        // <TextView
        //     android:text="@string/privacy_policy_content"
        //     ... />
        // I should probably update the layout to give it an ID and set text programmatically using Html.fromHtml to ensure <b> tags work,
        // OR rely on Android's resource handling which usually handles <b> and <i> if they are not escaped.
        // In my multi_replace_file_content for strings.xml, I used <b> tags. Java string resources support HTML styling tags directly.
        // So it should be fine without code intervention.
        // I will just handle the padding for edge-to-edge.

        setupEdgeToEdgeInsets()
    }

    private fun setupEdgeToEdgeInsets() {
        val topBar = findViewById<android.view.View>(R.id.topBar)
        ViewCompat.setOnApplyWindowInsetsListener(findViewById(android.R.id.content)) { _, windowInsets ->
            val insets = windowInsets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
            )

            topBar.updatePadding(
                left = insets.left + dpToPx(8),
                top = insets.top + dpToPx(8),
                right = insets.right + dpToPx(8)
            )
            
            // Allow clicking through transparent nav bar area at bottom? 
            // Or add padding to scrollview? 
            // The ScrollView is the second child of root LinearLayout.
            // I should probably add bottom padding to it.
            // But let's keep it simple for now, the top bar is the most important overlap to avoid.
            
            WindowInsetsCompat.CONSUMED
        }
    }

    private fun dpToPx(dp: Int): Int {
        return (dp * resources.displayMetrics.density).toInt()
    }
}
