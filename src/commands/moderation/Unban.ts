import { InteractionContextType, PermissionFlagsBits } from "discord.js";
import { getRestriction, resolveUser, updateRestriction } from "../../helpers/Roblox.ts";
import { auditTag, Command } from "../Command.ts";

export const unban = new Command({
	name: "unban",
	description: "Lift a Roblox game ban",
	userPermissions: PermissionFlagsBits.BanMembers,
	contexts: InteractionContextType.Guild,
	timeout: 15,
	options: (data) =>
		data.addStringOption((o) =>
			o.setName("user").setDescription("Roblox username or user ID").setRequired(true).setMaxLength(40),
		),
	async execute(interaction) {
		await interaction.deferReply();
		const user = await resolveUser(interaction.options.getString("user", true));
		const current = await getRestriction(user.id);
		if (current?.gameJoinRestriction?.active !== true) {
			await interaction.editReply({
				content: `__${user.name}__ (${user.id}) is not currently banned`,
				allowedMentions: { parse: [] },
			});
			return;
		}
		// The unban would otherwise be attributed only to the shared API key.
		await updateRestriction(user.id, {
			active: false,
			privateReason: `Unbanned by ${auditTag(interaction)}`.slice(0, 1000),
		});
		await interaction.editReply({
			content: `Unbanned __${user.name}__ (${user.id}).`,
			allowedMentions: { parse: [] },
		});
	},
});
