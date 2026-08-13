import { InteractionContextType } from "discord.js";
import { Perms } from "../../../helpers/Permissions.ts";
import { GetRestriction, ResolveUser, UpdateRestriction } from "../../../helpers/Roblox.ts";
import { AuditTag, Command } from "../../Command.ts";

export const Unban = new Command({
	name: "unban",
	description: "Lift a Roblox game ban",
	permissions: Perms.Moderate,
	contexts: InteractionContextType.Guild,
	timeout: 15,
	options: {
		user: { string: { description: "Roblox username or user ID", required: true, maxLength: 40 } },
	},
	async execute(interaction) {
		await interaction.deferReply();
		const user = await ResolveUser(interaction.options.getString("user", true));
		const current = await GetRestriction(user.id);
		if (current?.gameJoinRestriction?.active !== true) {
			await interaction.editReply({
				content: `__${user.name}__ (${user.id}) is not currently banned`,
				allowedMentions: { parse: [] },
			});
			return;
		}
		// the unban would otherwise be attributed only to the shared API key
		await UpdateRestriction(user.id, {
			active: false,
			privateReason: `Unbanned by ${AuditTag(interaction)}`.slice(0, 1000),
		});
		await interaction.editReply({
			content: `Unbanned __${user.name}__ (${user.id}).`,
			allowedMentions: { parse: [] },
		});
	},
});
