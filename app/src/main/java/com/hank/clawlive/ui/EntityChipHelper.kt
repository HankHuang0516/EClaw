package com.hank.clawlive.ui

import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Color
import com.google.android.material.chip.Chip
import com.google.android.material.chip.ChipGroup
import com.hank.clawlive.BuildConfig
import com.hank.clawlive.data.local.EntityAvatarManager
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
     * @param labelFormat Lambda to generate chip label from entity ID (null = use avatar + #N)
     * @return Map of entityId -> Chip
     */
    fun populate(
        context: Context,
        chipGroup: ChipGroup,
        checkedByDefault: Int = 0,
        labelFormat: ((Int) -> String)? = null
    ): Map<Int, Chip> {
        val limit = getEntityLimit(context)
        val avatarManager = EntityAvatarManager.getInstance(context)
        val chips = mutableMapOf<Int, Chip>()
        val format = labelFormat ?: { id -> "${avatarManager.getAvatar(id)} #$id" }

        for (i in 0 until limit) {
            val chip = createChip(context, format(i), i, i == checkedByDefault)
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
        labelFormat: ((Int) -> String)? = null
    ): Map<Int, Chip> {
        val limit = getEntityLimit(context)
        val avatarManager = EntityAvatarManager.getInstance(context)
        val chips = mutableMapOf<Int, Chip>()
        val format = labelFormat ?: { id -> "${avatarManager.getAvatar(id)} #$id" }

        for (i in 0 until limit) {
            val chip = createChip(context, format(i), i, i == checkedByDefault)
            chipGroup.addView(chip, insertAt + i)
            chips[i] = chip
        }

        return chips
    }

    private fun createChip(context: Context, label: String, entityId: Int, checked: Boolean): Chip {
        return Chip(context).apply {
            text = label
            isCheckable = true
            isChecked = checked
            tag = entityId

            // Hide close icon (not deletable)
            isCloseIconVisible = false

            // Checked icon
            isCheckedIconVisible = true

            // Colors for dark theme
            chipBackgroundColor = ColorStateList(
                arrayOf(
                    intArrayOf(android.R.attr.state_checked),
                    intArrayOf()
                ),
                intArrayOf(
                    Color.parseColor("#3D2B7C"),  // checked: deep purple
                    Color.parseColor("#1E1E2E")   // unchecked: dark surface
                )
            )
            chipStrokeColor = ColorStateList(
                arrayOf(
                    intArrayOf(android.R.attr.state_checked),
                    intArrayOf()
                ),
                intArrayOf(
                    Color.parseColor("#7C4DFF"),  // checked: purple accent
                    Color.parseColor("#3A3A4E")   // unchecked: subtle border
                )
            )
            chipStrokeWidth = 1.5f * context.resources.displayMetrics.density
            setTextColor(ColorStateList(
                arrayOf(
                    intArrayOf(android.R.attr.state_checked),
                    intArrayOf()
                ),
                intArrayOf(
                    Color.WHITE,
                    Color.parseColor("#AAAAAA")
                )
            ))
            checkedIconTint = ColorStateList.valueOf(Color.parseColor("#B388FF"))
            textSize = 13f
        }
    }
}
