import { InteractionContextType, MessageFlags, PermissionFlagsBits } from "discord.js";
import { addReaction, reactions, removeReaction } from "../helpers/Reactions.ts";
import { Command } from "./Command.ts";

export const reaction = new Command({
    name: "reaction",
    description: "Manage keyword emoji reactions",
    userPermissions: PermissionFlagsBits.ManageGuild,
    contexts: InteractionContextType.Guild,
    options: (data) =>
        data
            .addSubcommand((s) => s
                .setName("add")
                .setDescription("React with an emoji when a keyword appears in a message")
                .addStringOption((o) =>
                    o.setName("match").setDescription("Substring to match, case-insensitive").setRequired(true),
                )
                .addStringOption((o) => o.setName("emoji").setDescription("Emoji to react with").setRequired(true)),
            )
            .addSubcommand((s) => s
                .setName("remove")
                .setDescription("Remove a keyword reaction")
                .addStringOption((o) => o.setName("match").setDescription("Keyword to remove").setRequired(true)),
            )
            .addSubcommand((s) => s.setName("list").setDescription("List keyword reactions")),
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
});
