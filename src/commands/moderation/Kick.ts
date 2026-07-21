import { InteractionContextType, PermissionFlagsBits } from "discord.js";
import { publishMessage, resolveUser } from "../../helpers/Roblox.ts";
import { Command } from "../Command.ts";

export const kick = new Command({
	name: "kick",
	description: "Kick a Roblox user from any live game server they're in",
	userPermissions: PermissionFlagsBits.KickMembers,
	contexts: InteractionContextType.Guild,
	ephemeral: true,
	// biome-ignore format: hand-aligned builder for readability
	options: (data) => data
		.addStringOption((o) => o
			.setName("user")
			.setDescription("Username or UserID")
			.setRequired(true).setMaxLength(40))
		.addStringOption((o) => o
			.setName("reason")
			.setDescription("Shown to the kicked player (defaults to a generic message)")
			.setMaxLength(400)),
	async execute(interaction) {
		const user = await resolveUser(interaction.options.getString("user", true));
		const reason = interaction.options.getString("reason")?.trim();

		// A kick only ends an active session — it's broadcast to every live server and the one
		// hosting this player (if any) removes them. It's a no-op when they're offline; use /ban to keep them out.
		await publishMessage("kick", { userId: user.id, ...(reason ? { reason } : {}) });

		await interaction.editReply({
			content:
				`**Kick sent** for __${user.name}__ (${user.id}). They'll be removed from any live server ` +
				"they're in — a no-op if they're offline. To keep them out, use /ban.",
			allowedMentions: { parse: [] },
		});
	},
});
