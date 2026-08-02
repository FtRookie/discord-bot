import { InteractionContextType, MessageFlags } from "discord.js";
import { Perms } from "../helpers/Permissions.ts";
import { AddReply, RemoveReply, Replies } from "../helpers/Replies.ts";
import { Command } from "./Command.ts";

export const Reply = new Command({
	name: "reply",
	description: "Manage keyword text replies",
	permissions: Perms.Configure,
	contexts: InteractionContextType.Guild,
	// biome-ignore format:  readability
	options: (data) => data
		.addSubcommand((s) => s
			.setName("add")
			.setDescription("Reply with a sentence when a keyword appears in a message")
			.addStringOption((o) => o
				.setName("match")
				.setDescription("Substring to match, case-insensitive")
				.setRequired(true))
			.addStringOption((o) => o
				.setName("text")
				.setDescription("Sentence to reply with")
				.setRequired(true).setMaxLength(2000)))
		.addSubcommand((s) => s
			.setName("remove")
			.setDescription("Remove a keyword reply")
			.addStringOption((o) => o
				.setName("match")
				.setDescription("Keyword to remove")
				.setRequired(true)))
		.addSubcommand((s) => s
			.setName("list")
			.setDescription("List keyword replies")),
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
