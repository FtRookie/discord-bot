import { InteractionContextType, MessageFlags } from "discord.js";
import { Perms } from "../../helpers/Permissions.ts";
import { AddReaction, Reactions, RemoveReaction } from "../../helpers/Reactions.ts";
import { Command } from "../Command.ts";

export const Reaction = new Command({
	name: "reaction",
	description: "Manage keyword emoji reactions",
	permissions: Perms.Configure,
	contexts: InteractionContextType.Guild,
	subcommands: {
		add: {
			description: "React with an emoji when a keyword appears in a message",
			options: {
				match: { string: { description: "Substring to match, case-insensitive", required: true } },
				emoji: { string: { description: "Emoji to react with", required: true } },
			},
		},
		remove: {
			description: "Remove a keyword reaction",
			options: { match: { string: { description: "Keyword to remove", required: true } } },
		},
		list: { description: "List keyword reactions" },
	},
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
