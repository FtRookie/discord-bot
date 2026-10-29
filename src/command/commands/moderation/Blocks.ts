import { InteractionContextType } from "discord.js";
import { GetBlockGrants, GrantBlock, RefreshPlayer } from "../../../helpers/Grants.ts";
import { Perms } from "../../../helpers/Permissions.ts";
import { ResolveUser } from "../../../helpers/Roblox.ts";
import { Command, UserOption } from "../../Command.ts";

export const Blocks = new Command({
	name: "blocks",
	description: "Manage a Roblox user's per-player block limits",
	permissions: Perms.Owner,
	contexts: InteractionContextType.Guild,
	ephemeral: true,
	subcommands: {
		grant: {
			description: "Give a user a per-player limit for a block",
			options: {
				user: UserOption(),
				blockid: {
					string: {
						description: "Block id, e.g. luacircuit",
						required: true,
						maxLength: 64,
					},
				},
				limit: {
					integer: {
						description: "How many they may place",
						required: true,
						min: 0,
						max: 5000,
					},
				},
			},
		},
		remove: {
			description: "Drop a user's override, returning the block to its global limit",
			options: {
				user: UserOption(),
				blockid: {
					string: {
						description: "Block id, e.g. luacircuit",
						required: true,
						maxLength: 64,
					},
				},
			},
		},
		list: {
			description: "Show every per-player limit a user holds",
			options: { user: UserOption() },
		},
	},
	async execute(interaction) {
		const sub = interaction.options.getSubcommand();
		const user = await ResolveUser(interaction.options.getString("user", true));
		const who = `__${user.name}__ (${user.id})`;

		if (sub === "list") {
			const grants = Object.entries(await GetBlockGrants(user.id));
			const content = grants.length
				? `${who} holds:\n${grants.map(([id, limit]) => `- \`${id}\` ×${limit}`).join("\n")}`
				: `${who} holds no per-player limits.`;
			await interaction.editReply({ content, allowedMentions: { parse: [] } });
			return;
		}

		const blockId = interaction.options.getString("blockid", true).trim();
		// no limit reads as "drop the key" rather than "set it to zero" — a zero would linger and still look
		// like an explicit grant to anything checking for the id
		const limit = sub === "remove" ? undefined : interaction.options.getInteger("limit", true);

		await GrantBlock(user.id, blockId, limit);
		await RefreshPlayer(user.id);

		const content =
			limit === undefined
				? `**Removed** \`${blockId}\` from ${who}. It returns to its global limit.`
				: `**Granted** ${who} \`${blockId}\` ×${limit}. Applies in game within seconds, or when they next join.`;

		await interaction.editReply({ content, allowedMentions: { parse: [] } });
	},
});
