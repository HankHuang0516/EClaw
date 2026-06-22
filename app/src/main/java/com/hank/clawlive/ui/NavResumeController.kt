package com.hank.clawlive.ui

/**
 * NavResumeController — saves the last-active nav tab across app sessions and
 * determines where to restore on process-death restart (card_489a8836).
 *
 * ### Two-layer resume strategy
 * - **Brief app-switch** (process alive): `singleTop` launchMode keeps the
 *   back stack intact, so Android naturally re-shows whichever Activity was on
 *   top. No re-routing needed.
 * - **Process-death restart**: Android re-creates from scratch, always starting
 *   `MainActivity`. This controller reads the persisted `lastNavItem` and
 *   signals MainActivity to re-launch the correct tab Activity so the user sees
 *   the same screen they left.
 *
 * The class is purposely decoupled from Android SDK types so it is pure-JVM
 * testable; callers bridge the SharedPreferences read/write via [Store].
 */
class NavResumeController(private val store: Store) {

    /** Minimal persistence contract — implemented by SharedPreferences in prod. */
    interface Store {
        fun readLastNav(): String?
        fun writeLastNav(name: String)
        fun clearLastNav()
    }

    /**
     * Record that the user has navigated to [item]. Call this whenever a tab
     * Activity comes to the foreground (onResume) so the latest tab is always
     * persisted.
     *
     * HOME is intentionally skipped: if the process dies while the user is on
     * HOME the restart naturally lands on HOME (MainActivity shows dashboard),
     * which is correct — no re-routing required.
     */
    fun onNavigatedTo(item: NavItem) {
        if (item == NavItem.HOME) {
            store.clearLastNav()
        } else {
            store.writeLastNav(item.name)
        }
    }

    /**
     * Returns the [NavItem] to restore, or `null` if no non-home tab was saved
     * (either no prior session or the user was on HOME last time).
     *
     * Call from `MainActivity.onCreate()` **only when there is no deep-link
     * intent** — a deep link should always win over the saved tab.
     */
    fun restoredNavItem(): NavItem? {
        val saved = store.readLastNav() ?: return null
        return try {
            val item = NavItem.valueOf(saved)
            if (item == NavItem.HOME) null else item
        } catch (_: IllegalArgumentException) {
            // Stale or unknown value — discard.
            store.clearLastNav()
            null
        }
    }
}
