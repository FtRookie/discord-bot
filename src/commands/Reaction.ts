import { InteractionContextType, MessageFlags } from "discord.js";
import { Perms } from "../helpers/Permissions.ts";
import { AddReaction, Reactions, RemoveReaction } from "../helpers/Reactions.ts";
import { Command } from "./Command.ts";

export const Reaction = new Command({
	name: "reaction",
	description: "Manage keyword emoji reactions",
	permissions: Perms.Configure,
	contexts: InteractionContextType.Guild,
	// biome-ignore format:  readability
	options: (data) => data
		.addSubcommand((s) => s
			.setName("add")
			.setDescription("React with an emoji when a keyword appears in a message")
			.addStringOption((o) => o
				.setName("match")
				.setDescription("Substring to match, case-insensitive")
				.setRequired(true))
			.addStringOption((o) => o
				.setName("emoji")
				.setDescription("Emoji to react with")
				.setRequired(true)))
		.addSubcommand((s) => s
			.setName("remove")
			.setDescription("Remove a keyword reaction")
			.addStringOption((o) => o
				.setName("match")
				.setDescription("Keyword to remove")
				.setRequired(true)))
		.addSubcommand((s) => s
			.setName("list")
			.setDescription("List keyword reactions")),
	async execute(interaction) {
		let reply: string;
		const sub = interaction.options.getSubcommand();
		switch (sub) {
			case "add": {
				const match = interaction.options.getString("match", true);
				const emoji = interaction.options.getString("emoji", true);
				AddReaction(match, emoji);
				reply = `Reacting with ${emoji} to "${match.toLowerCase()}"`;
				break;
			}
			case "remove": {
				const match = interaction.options.getString("match", true);
				reply = RemoveReaction(match)
					? `Removed "${match.toLowerCase()}"`
					: `No reaction bound to "${match.toLowerCase()}"`;
				break;
			}
			default: // list
				reply = Reactions.map((r) => `${r.emoji} ← "${r.match}"`).join("\n") || "No reactions bound.";
		}
		await interaction.reply({ content: reply, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
	},
});
