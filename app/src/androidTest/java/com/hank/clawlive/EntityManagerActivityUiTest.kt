package com.hank.clawlive

import android.view.View
import android.widget.TextView
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

/**
 * UI/UX tests for EntityManagerActivity
 * Validates edge-to-edge display and safe insets for system bars
 */
@RunWith(AndroidJUnit4::class)
class EntityManagerActivityUiTest {

    @Test
    fun testTopBarHasSafeInsetFromStatusBar() {
        ActivityScenario.launch(EntityManagerActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                val topBar = activity.findViewById<View>(R.id.topBar)
                val rootView = activity.findViewById<View>(android.R.id.content)

                assertNotNull("Top bar should exist", topBar)

                val windowInsets = ViewCompat.getRootWindowInsets(rootView)
                assertNotNull("Window insets should be available", windowInsets)

                val statusBarHeight = windowInsets!!.getInsets(
                    WindowInsetsCompat.Type.statusBars()
                ).top

                val topPadding = topBar.paddingTop
                assertTrue(
                    "Top bar padding ($topPadding) should be >= status bar height ($statusBarHeight)",
                    topPadding >= statusBarHeight
                )
            }
        }
    }

    @Test
    fun testBottomBarHasSafeInsetFromNavigationBar() {
        ActivityScenario.launch(EntityManagerActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                val bottomBar = activity.findViewById<View>(R.id.bottomBar)
                val rootView = activity.findViewById<View>(android.R.id.content)

                assertNotNull("Bottom bar should exist", bottomBar)

                val windowInsets = ViewCompat.getRootWindowInsets(rootView)
                assertNotNull("Window insets should be available", windowInsets)

                val navBarHeight = windowInsets!!.getInsets(
                    WindowInsetsCompat.Type.navigationBars()
                ).bottom

                val bottomPadding = bottomBar.paddingBottom
                assertTrue(
                    "Bottom padding ($bottomPadding) should be >= nav bar height ($navBarHeight)",
                    bottomPadding >= navBarHeight
                )
            }
        }
    }

    @Test
    fun testBackButtonIsAccessible() {
        ActivityScenario.launch(EntityManagerActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                val btnBack = activity.findViewById<View>(R.id.btnBack)
                val rootView = activity.findViewById<View>(android.R.id.content)

                assertNotNull("Back button should exist", btnBack)
                assertTrue("Back button should be clickable", btnBack.isClickable)

                val location = IntArray(2)
                btnBack.getLocationOnScreen(location)

                val windowInsets = ViewCompat.getRootWindowInsets(rootView)
                val statusBarHeight = windowInsets?.getInsets(
                    WindowInsetsCompat.Type.statusBars()
                )?.top ?: 0

                assertTrue(
                    "Back button top (${location[1]}) should be below status bar ($statusBarHeight)",
                    location[1] >= statusBarHeight
                )
            }
        }
    }

    @Test
    fun testRefreshButtonIsAccessible() {
        ActivityScenario.launch(EntityManagerActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                val btnRefresh = activity.findViewById<View>(R.id.btnRefresh)
                val rootView = activity.findViewById<View>(android.R.id.content)

                assertNotNull("Refresh button should exist", btnRefresh)
                assertTrue("Refresh button should be clickable", btnRefresh.isClickable)

                val screenHeight = activity.resources.displayMetrics.heightPixels
                val location = IntArray(2)
                btnRefresh.getLocationOnScreen(location)
                val buttonBottom = location[1] + btnRefresh.height

                val windowInsets = ViewCompat.getRootWindowInsets(rootView)
                val navBarHeight = windowInsets?.getInsets(
                    WindowInsetsCompat.Type.navigationBars()
                )?.bottom ?: 0

                val maxBottomY = screenHeight - navBarHeight + 50
                assertTrue(
                    "Refresh button bottom ($buttonBottom) should be above nav bar area",
                    buttonBottom <= maxBottomY || navBarHeight == 0
                )
            }
        }
    }

    // -------------------------------------------------------------------------
    // Regression: GitHub Issue #167 — Entity public code display
    // Root cause: R.string.entity_public_code and R.string.code_copied were
    // missing from strings.xml, causing compilation failure and no display.
    // -------------------------------------------------------------------------

    @Test
    fun testEntityPublicCodeStringResourcesExist() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext

        val formatted = context.getString(R.string.entity_public_code, "ABCD1234")
        assertTrue(
            "entity_public_code string must contain the public code value (#167)",
            formatted.contains("ABCD1234")
        )

        val copiedMsg = context.getString(R.string.code_copied)
        assertTrue("code_copied string must not be empty (#167)", copiedMsg.isNotBlank())
    }

    @Test
    fun testEntityAgentCardHasPublicCodeView() {
        val inflater = android.view.LayoutInflater.from(
            InstrumentationRegistry.getInstrumentation().targetContext
        )
        val root = inflater.inflate(R.layout.item_agent_card, null, false)
        val tvPublicCode = root.findViewById<TextView>(R.id.tvPublicCode)

        assertNotNull("tvPublicCode must exist in item_agent_card layout (#167)", tvPublicCode)
        assertEquals(
            "tvPublicCode should be GONE by default (shown only when code is set)",
            View.GONE,
            tvPublicCode.visibility
        )
    }

    @Test
    fun testSafeInsetsAppliedCorrectly() {
        ActivityScenario.launch(EntityManagerActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                val topBar = activity.findViewById<View>(R.id.topBar)
                val bottomBar = activity.findViewById<View>(R.id.bottomBar)
                val rootView = activity.findViewById<View>(android.R.id.content)

                val windowInsets = ViewCompat.getRootWindowInsets(rootView)
                assertNotNull("Window insets should be available", windowInsets)

                val systemBarsInsets = windowInsets!!.getInsets(
                    WindowInsetsCompat.Type.systemBars()
                )

                println("=== EntityManagerActivity Safe Insets Test ===")
                println("Status bar height: ${systemBarsInsets.top}")
                println("Navigation bar height: ${systemBarsInsets.bottom}")
                println("Top bar padding: top=${topBar.paddingTop}")
                println("Bottom bar padding: bottom=${bottomBar.paddingBottom}")

                assertTrue(
                    "Top bar should have top padding >= status bar",
                    topBar.paddingTop >= systemBarsInsets.top
                )

                assertTrue(
                    "Bottom bar should have bottom padding >= nav bar",
                    bottomBar.paddingBottom >= systemBarsInsets.bottom
                )
            }
        }
    }
}
