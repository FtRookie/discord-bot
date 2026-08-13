import { InteractionContextType, MessageFlags } from "discord.js";
import { Perms } from "../../helpers/Permissions.ts";
import { AddReply, RemoveReply, Replies } from "../../helpers/Replies.ts";
import { Command } from "../Command.ts";

export const Reply = new Command({
	name: "reply",
	description: "Manage keyword text replies",
	permissions: Perms.Configure,
	contexts: InteractionContextType.Guild,
	subcommands: {
		add: {
			description: "Reply with a sentence when a keyword appears in a message",
			options: {
				match: { string: { description: "Substring to match, case-insensitive", required: true } },
				text: { string: { description: "Sentence to reply with", required: true, maxLength: 2000 } },
			},
		},
		remove: {
			description: "Remove a keyword reply",
			options: { match: { string: { description: "Keyword to remove", required: true } } },
		},
		list: { description: "List keyword replies" },
	},
	async execute(interaction) {
		let response: string;
		const sub = interaction.options.getSubcommand();
		if (sub === "add") {
			const match = interaction.options.getString("match", true);
			const text = interaction.options.getString("text", true);
			AddReply(match, text);
			response = `Replying with "${text}" to "${match.toLowerCase()}"`;
		} else if (sub === "remove") {
			const match = interaction.options.getString("match", true);
			response = RemoveReply(match)
				? `Removed "${match.toLowerCase()}"`
				: `No reply bound to "${match.toLowerCase()}"`;
		} else {
			response = Replies.map((r) => `"${r.match}" → ${r.text}`).join("\n") || "No replies bound.";
		}
		await interaction.reply({ content: response, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
	},
});
