import { InteractionContextType } from "discord.js";
import { GrantBlock, GrantFailure } from "../helpers/Grants.ts";
import { Perms } from "../helpers/Permissions.ts";
import { ResolveUser, UserError } from "../helpers/Roblox.ts";
import { Command } from "./Command.ts";

export const Blocks = new Command({
	name: "blocks",
	description: "Manage a Roblox user's per-player block limits",
	permissions: Perms.Owner,
	contexts: InteractionContextType.Guild,
	ephemeral: true,
	// biome-ignore format:  readability
	options: (data) => data
		.addSubcommand((s) => s
			.setName("grant")
			.setDescription("Give a user a per-player limit for a block")
			.addStringOption((o) => o
				.setName("user")
				.setDescription("Username or UserID")
				.setRequired(true).setMaxLength(40))
			.addStringOption((o) => o
				.setName("blockid")
				.setDescription("Block id, e.g. luacircuit")
				.setRequired(true).setMaxLength(64))
			.addIntegerOption((o) => o
				.setName("limit")
				.setDescription("How many they may place")
				.setRequired(true).setMinValue(0).setMaxValue(5000)))
		.addSubcommand((s) => s
			.setName("remove")
			.setDescription("Drop a user's override, returning the block to its global limit")
			.addStringOption((o) => o
				.setName("user")
				.setDescription("Username or UserID")
				.setRequired(true).setMaxLength(40))
			.addStringOption((o) => o
				.setName("blockid")
				.setDescription("Block id, e.g. luacircuit")
				.setRequired(true).setMaxLength(64))),
	// fixme: a `list` subcommand needs a server to answer with the row, and `response` is one free-text field
	// sized for a status line, not a payload. Reinstate once Bot → Backend exists (GAME_INTEGRATION.md §1).
	// .addSubcommand((s) => s
	// 	.setName("list")
	// 	.setDescription("Show every per-player limit a user holds")
	// 	.addStringOption((o) => o
	// 		.setName("user")
	// 		.setDescription("Username or UserID")
	// 		.setRequired(true).setMaxLength(40)))
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
