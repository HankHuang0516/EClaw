package com.hank.clawlive.ui.mission

import android.content.Context
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.hank.clawlive.R
import com.hank.clawlive.data.remote.SkillTemplate

/**
 * Gallery dialog listing both built-in and community soul templates.
 * Callback receives (name, description, templateId) where templateId is non-null
 * for built-in templates and null for community templates.
 */
class SoulGalleryDialog(
    private val context: Context,
    private val builtinTemplates: List<BuiltinTemplate>,
    private val communityTemplates: List<SkillTemplate>,
    private val onSelected: (name: String, description: String, templateId: String?) -> Unit
) {
    data class BuiltinTemplate(
        val id: String,
        val icon: String,
        val name: String,
        val description: String
    )

    fun show() {
        val total = builtinTemplates.size + communityTemplates.size
        val title = "${context.getString(R.string.mission_soul_gallery_title)} ($total)"

        // Build flat item list: built-in first, then community
        data class Item(val label: String, val name: String, val description: String, val templateId: String?)

        val items = mutableListOf<Item>()
        builtinTemplates.forEach { t ->
            items.add(Item("${t.icon} ${t.name}", t.name, t.description, t.id))
        }
        communityTemplates.forEach { t ->
            val icon = t.icon ?: "🧠"
            val label = t.label ?: t.name ?: ""
            val author = t.author ?: ""
            val displayLabel = if (author.isNotEmpty()) "$icon $label  (by $author)" else "$icon $label"
            val name = t.name ?: t.title ?: label
            val desc = t.description ?: label
            items.add(Item(displayLabel, name, desc, null))
        }

        if (items.isEmpty()) {
            MaterialAlertDialogBuilder(context)
                .setTitle(title)
                .setMessage(context.getString(R.string.mission_template_empty))
                .setPositiveButton(android.R.string.ok, null)
                .show()
            return
        }

        val labels = items.map { it.label }.toTypedArray()
        MaterialAlertDialogBuilder(context)
            .setTitle(title)
            .setItems(labels) { _, which ->
                val item = items[which]
                onSelected(item.name, item.description, item.templateId)
            }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }
}
