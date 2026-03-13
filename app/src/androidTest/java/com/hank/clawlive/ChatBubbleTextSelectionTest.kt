package com.hank.clawlive

import android.widget.TextView
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Regression test for GitHub Issue #168:
 * Chat bubble messages must support partial text selection (textIsSelectable=true).
 *
 * Previously: only full-copy via long-press itemView listener was available.
 * Fix: added textIsSelectable="true" to tvMessage in both sent/received layouts,
 *      removed conflicting itemView.setOnLongClickListener.
 */
@RunWith(AndroidJUnit4::class)
class ChatBubbleTextSelectionTest {

    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext

    @Test
    fun testReceivedMessageBubbleIsTextSelectable() {
        val inflater = android.view.LayoutInflater.from(context)
        val root = inflater.inflate(R.layout.item_message_received, null, false)
        val tvMessage = root.findViewById<TextView>(R.id.tvMessage)

        assertNotNull("tvMessage should exist in item_message_received", tvMessage)
        assertTrue(
            "Received message bubble must have textIsSelectable=true (#168)",
            tvMessage.isTextSelectable
        )
    }

    @Test
    fun testSentMessageBubbleIsTextSelectable() {
        val inflater = android.view.LayoutInflater.from(context)
        val root = inflater.inflate(R.layout.item_message_sent, null, false)
        val tvMessage = root.findViewById<TextView>(R.id.tvMessage)

        assertNotNull("tvMessage should exist in item_message_sent", tvMessage)
        assertTrue(
            "Sent message bubble must have textIsSelectable=true (#168)",
            tvMessage.isTextSelectable
        )
    }
}
