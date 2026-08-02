import { InteractionContextType } from "discord.js";
import { Perms } from "../helpers/Permissions.ts";
import { AddReminder } from "../helpers/Reminders.ts";
import { ParseDurationSeconds } from "../helpers/Roblox.ts";
import { Command } from "./Command.ts";

export const Reminder = new Command({
	name: "reminder",
	description: "Set a reminder — the bot pings you in this channel after the delay",
	permissions: Perms.None,
	contexts: InteractionContextType.Guild,
	ephemeral: true,
	// biome-ignore format:  readability
	options: (data) => data
		.addStringOption((o) => o
			.setName("in")
			.setDescription("How long from now, e.g. 30m, 2h, 1d, 1w2d")
			.setRequired(true).setMaxLength(40))
		.addStringOption((o) => o
			.setName("message")
			.setDescription("What to remind you about")
			.setRequired(true).setMaxLength(1500)),
	async execute(interaction) {
		const seconds = ParseDurationSeconds(interaction.options.getString("in", true));
		const message = interaction.options.getString("message", true);
		const fireAt = Date.now() + seconds * 1000;

		AddReminder({ userId: interaction.user.id, channelId: interaction.channelId, message, fireAt });

		await interaction.editReply({
			content: `⏰ Reminder set for <t:${Math.floor(fireAt / 1000)}:R> — I'll ping you here with:\n> ${message}`,
			allowedMentions: { parse: [] },
		});
	},
});
