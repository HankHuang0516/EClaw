package com.hank.clawlive.ui.chat

import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import androidx.recyclerview.widget.RecyclerView
import com.hank.clawlive.R

class SlashCommandAdapter(
    private val onCommandClick: (SlashCommand) -> Unit
) : RecyclerView.Adapter<SlashCommandAdapter.ViewHolder>() {

    private val items = mutableListOf<SlashCommand>()

    fun updateList(commands: List<SlashCommand>) {
        items.clear()
        items.addAll(commands)
        notifyDataSetChanged()
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): ViewHolder {
        val view = LayoutInflater.from(parent.context)
            .inflate(R.layout.item_slash_command, parent, false)
        return ViewHolder(view)
    }

    override fun onBindViewHolder(holder: ViewHolder, position: Int) {
        val cmd = items[position]
        holder.tvCommand.text = cmd.command
        holder.tvDescription.text = cmd.description
        holder.itemView.setOnClickListener { onCommandClick(cmd) }
    }

    override fun getItemCount() = items.size

    class ViewHolder(view: View) : RecyclerView.ViewHolder(view) {
        val tvCommand: TextView = view.findViewById(R.id.tvCommand)
        val tvDescription: TextView = view.findViewById(R.id.tvDescription)
    }
}
