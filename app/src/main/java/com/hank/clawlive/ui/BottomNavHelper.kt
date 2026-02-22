package com.hank.clawlive.ui

import android.app.Activity
import android.content.Intent
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.updatePadding
import com.hank.clawlive.ChatActivity
import com.hank.clawlive.FileManagerActivity
import com.hank.clawlive.MainActivity
import com.hank.clawlive.MissionControlActivity
import com.hank.clawlive.R
import com.hank.clawlive.SettingsActivity

enum class NavItem {
    HOME, MISSION, CHAT, FILES, SETTINGS
}

object BottomNavHelper {

    fun setup(activity: Activity, currentItem: NavItem) {
        val bottomNav = activity.findViewById<LinearLayout>(R.id.bottomNav) ?: return

        // Edge-to-edge bottom insets
        ViewCompat.setOnApplyWindowInsetsListener(bottomNav) { v, insets ->
            val sys = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
            )
            v.updatePadding(bottom = sys.bottom)
            insets
        }

        highlightItem(activity, currentItem)

        val navMap = mapOf(
            R.id.navHome to Pair(NavItem.HOME, MainActivity::class.java),
            R.id.navMission to Pair(NavItem.MISSION, MissionControlActivity::class.java),
            R.id.navChat to Pair(NavItem.CHAT, ChatActivity::class.java),
            R.id.navFiles to Pair(NavItem.FILES, FileManagerActivity::class.java),
            R.id.navSettings to Pair(NavItem.SETTINGS, SettingsActivity::class.java),
        )

        for ((viewId, pair) in navMap) {
            val (navItem, targetClass) = pair
            activity.findViewById<LinearLayout>(viewId)?.setOnClickListener {
                if (navItem != currentItem) {
                    val intent = Intent(activity, targetClass)
                    intent.flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or
                            Intent.FLAG_ACTIVITY_SINGLE_TOP
                    activity.startActivity(intent)
                    @Suppress("DEPRECATION")
                    activity.overridePendingTransition(0, 0)
                }
            }
        }
    }

    private fun highlightItem(activity: Activity, item: NavItem) {
        val allItems = listOf(
            Triple(R.id.navHomeIcon, R.id.navHomeText, NavItem.HOME),
            Triple(R.id.navMissionIcon, R.id.navMissionText, NavItem.MISSION),
            Triple(R.id.navChatIcon, R.id.navChatText, NavItem.CHAT),
            Triple(R.id.navFilesIcon, R.id.navFilesText, NavItem.FILES),
            Triple(R.id.navSettingsIcon, R.id.navSettingsText, NavItem.SETTINGS),
        )

        val activeIconColor = 0xFFFFFFFF.toInt()
        val inactiveIconColor = 0xFFCCCCCC.toInt()
        val activeTextColor = 0xFFFFFFFF.toInt()
        val inactiveTextColor = 0xFFAAAAAA.toInt()

        for ((iconId, textId, navItem) in allItems) {
            val isActive = navItem == item
            activity.findViewById<ImageView>(iconId)?.setColorFilter(
                if (isActive) activeIconColor else inactiveIconColor
            )
            activity.findViewById<TextView>(textId)?.setTextColor(
                if (isActive) activeTextColor else inactiveTextColor
            )
        }
    }
}
