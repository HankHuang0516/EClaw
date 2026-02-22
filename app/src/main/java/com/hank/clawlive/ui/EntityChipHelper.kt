package com.hank.clawlive.ui

import android.content.Context
import com.google.android.material.chip.Chip
import com.google.android.material.chip.ChipGroup
import com.hank.clawlive.BuildConfig
import com.hank.clawlive.R
import com.hank.clawlive.data.local.LayoutPreferences

/**
 * Dynamically populates ChipGroups with entity chips based on the current entity limit.
 * In debug builds the limit can be toggled between 4 and 8 via Settings.
 */
object EntityChipHelper {

    /**
     * Returns the effective entity limit for the current build.
     * Debug: reads from user preference (4 or 8). Release: always 4.
     */
    fun getEntityLimit(context: Context): Int {
        return if (BuildConfig.DEBUG) {
            LayoutPreferences.getInstance(context).debugEntityLimit
        } else {
            4
        }
    }

    /**
     * Populate a ChipGroup with entity filter chips.
     *
     * @param context Activity context
     * @param chipGroup The ChipGroup to populate
     * @param checkedByDefault Entity ID to check by default (-1 for none)
     * @param labelFormat Lambda to generate chip label from entity ID
     * @return Map of entityId -> Chip
     */
    fun populate(
        context: Context,
        chipGroup: ChipGroup,
        checkedByDefault: Int = 0,
        labelFormat: (Int) -> String = { "#$it" }
    ): Map<Int, Chip> {
        val limit = getEntityLimit(context)
        val chips = mutableMapOf<Int, Chip>()

        for (i in 0 until limit) {
            val chip = Chip(context, null, com.google.android.material.R.attr.chipStandaloneStyle).apply {
                setChipStyleFromResource(context)
                text = labelFormat(i)
                isCheckable = true
                isChecked = (i == checkedByDefault)
                tag = i
            }
            chipGroup.addView(chip)
            chips[i] = chip
        }

        return chips
    }

    /**
     * Insert entity chips into a ChipGroup at a specific position.
     * Useful when the ChipGroup already has non-entity chips (e.g. "All", "My Messages").
     *
     * @param insertAt Index in the ChipGroup to start inserting
     * @return Map of entityId -> Chip
     */
    fun insertAt(
        context: Context,
        chipGroup: ChipGroup,
        insertAt: Int,
        checkedByDefault: Int = -1,
        labelFormat: (Int) -> String = { "Entity $it" }
    ): Map<Int, Chip> {
        val limit = getEntityLimit(context)
        val chips = mutableMapOf<Int, Chip>()

        for (i in 0 until limit) {
            val chip = Chip(context, null, com.google.android.material.R.attr.chipStandaloneStyle).apply {
                setChipStyleFromResource(context)
                text = labelFormat(i)
                isCheckable = true
                isChecked = (i == checkedByDefault)
                tag = i
            }
            chipGroup.addView(chip, insertAt + i)
            chips[i] = chip
        }

        return chips
    }

    private fun Chip.setChipStyleFromResource(context: Context) {
        // Apply Material3 filter chip appearance
        setChipBackgroundColorResource(com.google.android.material.R.color.m3_chip_background_color)
        setTextAppearance(com.google.android.material.R.style.TextAppearance_Material3_LabelLarge)
        isCheckedIconVisible = true
    }
}
