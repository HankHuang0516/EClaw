package com.hank.clawlive.ui.mission

import android.content.Context
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.hank.clawlive.R
import com.hank.clawlive.data.remote.SkillTemplate

/**
 * A simple dialog that lists rule templates (from server) and lets the user pick one.
 * On selection, the callback receives the template name (title), label (used as description),
 * and ruleType (defaults to "WORKFLOW" when not specified by the template).
 */
class RuleGalleryDialog(
    private val context: Context,
    private val templates: List<SkillTemplate>,
    private val onTemplateSelected: (name: String, description: String, ruleType: String) -> Unit
) {
    fun show() {
        val builder = MaterialAlertDialogBuilder(context)
            .setTitle(context.getString(R.string.mission_rule_gallery_title))

        if (templates.isEmpty()) {
            builder.setMessage(context.getString(R.string.mission_template_empty))
                .setPositiveButton(android.R.string.ok, null)
                .show()
            return
        }

        val labels = templates.map { t ->
            val icon = t.icon ?: "📋"
            val label = t.label
            val ruleTypeDisplay = t.ruleType ?: "WORKFLOW"
            "$icon $label  [$ruleTypeDisplay]"
        }.toTypedArray()

        builder.setItems(labels) { _, which ->
            val tpl = templates[which]
            val name = tpl.name ?: tpl.title
            val desc = tpl.description ?: tpl.label
            val ruleType = tpl.ruleType ?: "WORKFLOW"
            onTemplateSelected(name, desc, ruleType)
        }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }
}
