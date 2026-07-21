import { InteractionContextType, PermissionFlagsBits } from "discord.js";
import { publishMessage } from "../helpers/Roblox.ts";
import { Command } from "./Command.ts";

export const announce = new Command({
	name: "announce",
	description: "Broadcast an announcement to everyone in the live game",
	userPermissions: PermissionFlagsBits.ManageGuild,
	contexts: InteractionContextType.Guild,
	ephemeral: true,
	// biome-ignore format: hand-aligned builder for readability
	options: (data) => data
		.addStringOption((o) => o
			.setName("text")
			.setDescription("The announcement (max 400 characters)")
			.setRequired(true).setMaxLength(400))
		.addStringOption((o) => o
			.setName("display")
			.setDescription("Where it shows in-game. Default: both")
			.addChoices({ name: "chat", value: "chat" }, { name: "popup", value: "popup" }, { name: "both", value: "both" })),
	async execute(interaction) {
		// The game clamps text to 400; clamp here too so the payload stays well under the 1 KiB limit.
		const text = interaction.options.getString("text", true).slice(0, 400);
		const display = interaction.options.getString("display") ?? "both";

		await publishMessage("announcement", { text, display });

		await interaction.editReply({
			content: `**Announcement published** (${display}) — delivering to live servers:\n> ${text}`,
			allowedMentions: { parse: [] },
		});
	},
});
