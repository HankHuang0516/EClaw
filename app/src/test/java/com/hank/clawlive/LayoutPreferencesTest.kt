package com.hank.clawlive

import android.content.SharedPreferences
import com.hank.clawlive.data.local.LayoutPreferences
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Unit tests for LayoutPreferences pin model + the entity-#10 (id >= 8) orphan
 * fix (card wallpaper-drag-pin, B3). Backed by an in-memory SharedPreferences
 * fake so the test stays pure-JVM (no Robolectric / emulator), matching the
 * project's existing unit-test style.
 */
class LayoutPreferencesTest {

    private fun prefs(): LayoutPreferences =
        LayoutPreferences.forTesting(FakeSharedPreferences())

    @Test
    fun clearAllCustomPositionsClearsHighIdEntities() {
        // B3 regression: the old `for (i in 0..7)` loop silently skipped entity
        // ids >= 8 → entity #10's custom_pos was orphaned forever. FAILS on old
        // code (id 10 survives the clear); PASSES with the key-scan clear.
        val p = prefs()
        p.setCustomPosition(3, 0.2f, 0.3f)
        p.setCustomPosition(10, 0.4f, 0.5f)
        assertNotNull(p.getCustomPosition(3))
        assertNotNull(p.getCustomPosition(10))

        p.clearAllCustomPositions()

        assertNull("entity 3 custom_pos must clear", p.getCustomPosition(3))
        assertNull("entity 10 custom_pos must clear (fails on old 0..7 loop)", p.getCustomPosition(10))
    }

    @Test
    fun clearAllEntityScalesClearsHighIdEntities() {
        // B3 regression for the scale keys (same 0..7 bug).
        val p = prefs()
        p.setEntityScale(3, 1.8f)
        p.setEntityScale(10, 2.2f)
        assertEquals(1.8f, p.getEntityScale(3), 0.0001f)
        assertEquals(2.2f, p.getEntityScale(10), 0.0001f)

        p.clearAllEntityScales()

        assertEquals("entity 3 scale resets", 1.0f, p.getEntityScale(3), 0.0001f)
        assertEquals("entity 10 scale resets (fails on old 0..7 loop)", 1.0f, p.getEntityScale(10), 0.0001f)
    }

    @Test
    fun pinAtPersistsPinCustomPosAndCustomLayoutForHighId() {
        val p = prefs()
        assertFalse(p.isPinned(10))
        p.pinAt(10, 0.6f, 0.7f)

        assertTrue("pin must be set", p.isPinned(10))
        assertTrue("useCustomLayout must be enabled by a pin", p.useCustomLayout)
        val pos = p.getCustomPosition(10)
        assertNotNull(pos)
        assertEquals(0.6f, pos!!.first, 0.0001f)
        assertEquals(0.7f, pos.second, 0.0001f)
        assertEquals(setOf(10), p.getPinnedEntityIds())
        assertTrue(p.hasAnyCustomOrPinnedPosition())
    }

    @Test
    fun clearAllCustomPositionsAlsoClearsPins() {
        val p = prefs()
        p.pinAt(10, 0.6f, 0.7f)

        p.clearAllCustomPositions()

        assertFalse(p.isPinned(10))
        assertNull(p.getCustomPosition(10))
        assertTrue(p.getPinnedEntityIds().isEmpty())
    }

    @Test
    fun migrateEntityOrderMovesPinWithEntity() {
        // A HARD PIN must follow its entity through a reorder.
        val p = prefs()
        p.pinAt(1, 0.3f, 0.4f)

        // newSlot[0] = oldSlot 1, newSlot[1] = oldSlot 0
        p.migrateEntityOrder(intArrayOf(1, 0))

        assertTrue("pin follows entity to new slot 0", p.isPinned(0))
        assertFalse("old slot 1 no longer pinned", p.isPinned(1))
        assertEquals(0.3f, p.getCustomPosition(0)!!.first, 0.0001f)
    }

    /** In-memory SharedPreferences for pure-JVM tests (interface impl only). */
    private class FakeSharedPreferences : SharedPreferences {
        private val map = HashMap<String, Any?>()

        override fun getAll(): MutableMap<String, *> = HashMap(map)
        override fun getString(key: String?, defValue: String?): String? =
            (map[key] as? String) ?: defValue

        @Suppress("UNCHECKED_CAST")
        override fun getStringSet(key: String?, defValues: MutableSet<String>?): MutableSet<String>? =
            (map[key] as? MutableSet<String>) ?: defValues

        override fun getInt(key: String?, defValue: Int): Int = (map[key] as? Int) ?: defValue
        override fun getLong(key: String?, defValue: Long): Long = (map[key] as? Long) ?: defValue
        override fun getFloat(key: String?, defValue: Float): Float = (map[key] as? Float) ?: defValue
        override fun getBoolean(key: String?, defValue: Boolean): Boolean = (map[key] as? Boolean) ?: defValue
        override fun contains(key: String?): Boolean = map.containsKey(key)
        override fun edit(): SharedPreferences.Editor = FakeEditor(map)
        override fun registerOnSharedPreferenceChangeListener(
            listener: SharedPreferences.OnSharedPreferenceChangeListener?
        ) {}
        override fun unregisterOnSharedPreferenceChangeListener(
            listener: SharedPreferences.OnSharedPreferenceChangeListener?
        ) {}
    }

    private class FakeEditor(private val backing: HashMap<String, Any?>) : SharedPreferences.Editor {
        private val puts = HashMap<String, Any?>()
        private val removes = HashSet<String>()
        private var clearAll = false

        override fun putString(key: String?, value: String?): SharedPreferences.Editor {
            puts[key!!] = value; removes.remove(key); return this
        }
        override fun putStringSet(key: String?, values: MutableSet<String>?): SharedPreferences.Editor {
            puts[key!!] = values; removes.remove(key); return this
        }
        override fun putInt(key: String?, value: Int): SharedPreferences.Editor {
            puts[key!!] = value; removes.remove(key); return this
        }
        override fun putLong(key: String?, value: Long): SharedPreferences.Editor {
            puts[key!!] = value; removes.remove(key); return this
        }
        override fun putFloat(key: String?, value: Float): SharedPreferences.Editor {
            puts[key!!] = value; removes.remove(key); return this
        }
        override fun putBoolean(key: String?, value: Boolean): SharedPreferences.Editor {
            puts[key!!] = value; removes.remove(key); return this
        }
        override fun remove(key: String?): SharedPreferences.Editor {
            removes.add(key!!); puts.remove(key); return this
        }
        override fun clear(): SharedPreferences.Editor { clearAll = true; return this }
        override fun commit(): Boolean { flush(); return true }
        override fun apply() { flush() }

        private fun flush() {
            if (clearAll) backing.clear()
            removes.forEach { backing.remove(it) }
            for ((k, v) in puts) {
                if (v == null) backing.remove(k) else backing[k] = v
            }
            puts.clear(); removes.clear(); clearAll = false
        }
    }
}
