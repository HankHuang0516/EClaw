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
import com.hank.clawlive.CardHolderActivity
import com.hank.clawlive.MainActivity
import com.hank.clawlive.MissionControlActivity
import com.hank.clawlive.R
import com.hank.clawlive.SettingsActivity
import timber.log.Timber

enum class NavItem {
    HOME, MISSION, CHAT, CARDS, SETTINGS
}

object BottomNavHelper {

    fun setup(activity: Activity, currentItem: NavItem) {
        Timber.d("BOTTOMNAV_DEBUG setup called for activity=${activity.javaClass.simpleName}, currentItem=$currentItem")
        val bottomNav = activity.findViewById<LinearLayout>(R.id.bottomNav)
        if (bottomNav == null) {
            Timber.w("BOTTOMNAV_DEBUG bottomNav NOT FOUND in ${activity.javaClass.simpleName}! Returning early.")
            return
        }
        Timber.d("BOTTOMNAV_DEBUG bottomNav found: parent=${bottomNav.parent?.javaClass?.simpleName}, lp=${bottomNav.layoutParams?.javaClass?.simpleName}")
        Timber.d("BOTTOMNAV_DEBUG bottomNav visibility=${bottomNav.visibility}, w=${bottomNav.width}, h=${bottomNav.height}")
        Timber.d("BOTTOMNAV_DEBUG bottomNav parent chain: parent=${bottomNav.parent?.javaClass?.simpleName} -> grandparent=${(bottomNav.parent as? android.view.View)?.parent?.javaClass?.simpleName}")

        // Edge-to-edge bottom insets with minimum padding to avoid HOME button conflict
        val minBottomPadding = (12 * activity.resources.displayMetrics.density).toInt()
        ViewCompat.setOnApplyWindowInsetsListener(bottomNav) { v, insets ->
            val sys = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
            )
            Timber.d("BOTTOMNAV_DEBUG insets applied: bottom=${sys.bottom}, minBottomPadding=$minBottomPadding, finalPadding=${maxOf(sys.bottom, minBottomPadding)}")
            v.updatePadding(bottom = maxOf(sys.bottom, minBottomPadding))
            insets
        }

        highlightItem(activity, currentItem)

        val navMap = mapOf(
            R.id.navHome to Pair(NavItem.HOME, MainActivity::class.java),
            R.id.navMission to Pair(NavItem.MISSION, MissionControlActivity::class.java),
            R.id.navChat to Pair(NavItem.CHAT, ChatActivity::class.java),
            R.id.navCards to Pair(NavItem.CARDS, CardHolderActivity::class.java),
            R.id.navSettings to Pair(NavItem.SETTINGS, SettingsActivity::class.java),
        )

        for ((viewId, pair) in navMap) {
            val (navItem, targetClass) = pair
            val navView = activity.findViewById<LinearLayout>(viewId)
            navView?.setOnClickListener {
                if (navItem != currentItem) {
                    val intent = Intent(activity, targetClass)
                    intent.flags = Intent.FLAG_ACTIVITY_REORDER_TO_FRONT
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
            Triple(R.id.navCardsIcon, R.id.navCardsText, NavItem.CARDS),
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
