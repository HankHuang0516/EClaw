package com.hank.clawlive.ui.chat

data class SlashCommand(
    val command: String,
    val label: String,
    val description: String
)

object SlashCommandRegistry {
    val commands = listOf(
        SlashCommand("/status", "Status", "Check bot connection status"),
        SlashCommand("/help", "Help", "Show available commands"),
        SlashCommand("/activation", "Activation", "Manage bot activation"),
        SlashCommand("/pair", "Pair", "Pair with a new device"),
        SlashCommand("/reasoning", "Reasoning", "Toggle reasoning mode"),
        SlashCommand("/config", "Config", "Configure bot settings"),
        SlashCommand("/broadcast", "Broadcast", "Broadcast to all entities"),
    )

    fun filter(query: String): List<SlashCommand> {
        if (!query.startsWith("/")) return emptyList()
        val search = query.lowercase()
        return commands.filter { it.command.startsWith(search) }
    }
}
