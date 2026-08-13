import { InteractionContextType } from "discord.js";
import { GrantBlock, GrantFailure } from "../../../helpers/Grants.ts";
import { Perms } from "../../../helpers/Permissions.ts";
import { ResolveUser, UserError } from "../../../helpers/Roblox.ts";
import { Command } from "../../Command.ts";

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
				user: {
					string: {
						description: "Username or UserID",
						required: true,
						maxLength: 40,
					},
				},
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
				user: {
					string: {
						description: "Username or UserID",
						required: true,
						maxLength: 40,
					},
				},
				blockid: {
					string: {
						description: "Block id, e.g. luacircuit",
						required: true,
						maxLength: 64,
					},
				},
			},
		},
		// fixme: a `list` subcommand needs a server to answer with the row, and `response` is one free-text
		// field sized for a status line, not a payload. Reinstate once Bot → Backend exists
		// (GAME_INTEGRATION.md §1).
		// list: {
		// 	description: "Show every per-player limit a user holds",
		// 	options: { user: { string: { description: "Username or UserID", required: true, maxLength: 40 } } },
		// },
	},
	async execute(interaction) {
		const sub = interaction.options.getSubcommand();
		const user = await ResolveUser(interaction.options.getString("user", true));
		const blockId = interaction.options.getString("blockid", true).trim();
		// no limit reads as "drop the key" rather than "set it to zero" — a zero would linger and still look
		// like an explicit grant to anything checking for the id
		const limit = sub === "remove" ? undefined : interaction.options.getInteger("limit", true);

		const outcome = await GrantBlock(user.id, blockId, limit);
		const failure = GrantFailure(outcome);
		const who = `__${user.name}__ (${user.id})`;

		if (failure) throw new UserError(failure);

		const content =
			limit === undefined
				? `**Removed** \`${blockId}\` from ${who}. It returns to its global limit.`
				: `**Granted** ${who} \`${blockId}\` ×${limit}. Applies next time they join.`;

		await interaction.editReply({ content, allowedMentions: { parse: [] } });
	},
});
