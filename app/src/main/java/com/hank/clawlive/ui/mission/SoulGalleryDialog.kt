package com.hank.clawlive.ui.mission

import android.content.Context
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.hank.clawlive.R
import com.hank.clawlive.data.remote.SkillTemplate

/**
 * A simple dialog that lists soul templates (from server) and lets the user pick one.
 * On selection, the callback receives the template name (title) and label (used as description).
 */
class SoulGalleryDialog(
    private val context: Context,
    private val templates: List<SkillTemplate>,
    private val onTemplateSelected: (name: String, description: String) -> Unit
) {
    fun show() {
        val builder = MaterialAlertDialogBuilder(context)
            .setTitle(context.getString(R.string.mission_soul_gallery_title))

        if (templates.isEmpty()) {
            builder.setMessage(context.getString(R.string.mission_template_empty))
                .setPositiveButton(android.R.string.ok, null)
                .show()
            return
        }

        val labels = templates.map { t ->
            val icon = t.icon ?: "🧠"
            val label = t.label
            val author = t.author ?: ""
            if (author.isNotEmpty()) "$icon $label  (by $author)" else "$icon $label"
        }.toTypedArray()

        builder.setItems(labels) { _, which ->
            val tpl = templates[which]
            val name = tpl.title
            val description = tpl.label
            onTemplateSelected(name, description)
        }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }
}
