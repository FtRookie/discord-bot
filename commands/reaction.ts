import {
    InteractionContextType,
    MessageFlags,
    PermissionFlagsBits,
    SlashCommandBuilder,
} from "discord.js";
import { addReaction, reactions, removeReaction } from "../reactions.ts";
import type { Command } from "./command.ts";

export const reaction: Command = {
    data: new SlashCommandBuilder()
        .setName("reaction")
        .setDescription("Manage keyword emoji reactions")
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .setContexts(InteractionContextType.Guild)
        .addSubcommand((s) => s
            .setName("add")
            .setDescription("React with an emoji when a keyword appears in a message")
            .addStringOption((o) => o.setName("match").setDescription("Substring to match, case-insensitive").setRequired(true))
            .addStringOption((o) => o.setName("emoji").setDescription("Emoji to react with").setRequired(true)))
        .addSubcommand((s) => s
            .setName("remove")
            .setDescription("Remove a keyword reaction")
            .addStringOption((o) => o.setName("match").setDescription("Keyword to remove").setRequired(true)))
        .addSubcommand((s) => s
            .setName("list")
            .setDescription("List keyword reactions")),
    async execute(interaction) {
        let reply: string;
        const sub = interaction.options.getSubcommand();
        if (sub === "add") {
            const match = interaction.options.getString("match", true);
            const emoji = interaction.options.getString("emoji", true);
            addReaction(match, emoji);
            reply = `Reacting with ${emoji} to "${match.toLowerCase()}"`;
        } else if (sub === "remove") {
            const match = interaction.options.getString("match", true);
            reply = removeReaction(match)
                ? `Removed "${match.toLowerCase()}"`
                : `No reaction bound to "${match.toLowerCase()}"`;
        } else {
            reply = reactions.map((r) => `${r.emoji} ← "${r.match}"`).join("\n") || "No reactions bound.";
        }
        await interaction.reply({ content: reply, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    },
};
