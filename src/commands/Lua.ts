import { InteractionContextType } from "discord.js";
import { grantBlock, grantFailure } from "../helpers/Grants.ts";
import { ensureRole, Perms } from "../helpers/Permissions.ts";
import { resolveUser, UserError } from "../helpers/Roblox.ts";
import { Command } from "./Command.ts";

const BLOCK_ID = "luacircuit";
/** Held once claimed. Both the re-run guard and the visibility deny key off this, so one role does both. */
export const LUA_VERIFIED_ROLE = "Lua Verified";

export const lua = new Command({
	name: "lua",
	description: "Claim the Lua Circuit block for your Roblox account",
	permissions: Perms.None,
	hiddenFromRole: LUA_VERIFIED_ROLE,
	contexts: InteractionContextType.Guild,
	ephemeral: true,
	// biome-ignore format:  readability
	options: (data) => data
		.addStringOption((o) => o
			.setName("user")
			.setDescription("Your Roblox username or UserID")
			.setRequired(true).setMaxLength(40)),
	async execute(interaction) {
		const guild = interaction.guild;
		if (!guild) throw new UserError("Run this in the server, not in DMs.");

		const role = await ensureRole(guild, LUA_VERIFIED_ROLE);
		if (!role) throw new UserError("Could not resolve the verified role — tell an admin to check my permissions.");

		// The deny override hides this once claimed, but a stale client can still send it, so the role is
		// checked here too. Visibility is a convenience; this is the actual limit.
		const member = await guild.members.fetch(interaction.user.id).catch(() => null);
		if (!member) throw new UserError("Could not read your membership — try again in a moment.");
		if (member.roles.cache.has(role.id)) {
			throw new UserError("You've already claimed the Lua Circuit. Ask an admin if it needs moving accounts.");
		}

		const user = await resolveUser(interaction.options.getString("user", true));
		const outcome = await grantBlock(user.id, BLOCK_ID, 1);
		const failure = grantFailure(outcome);

		// Only mark them verified once the write actually landed, so a failed attempt stays retryable.
		if (failure) throw new UserError(`${failure}\nNothing was claimed — you can run this again.`);
		await member.roles.add(role.id).catch(() => {});

		await interaction.editReply({
			content:
				`**Claimed** — __${user.name}__ (${user.id}) can now place the Lua Circuit. It applies next time ` +
				"you join, and this is one per Discord account.",
			allowedMentions: { parse: [] },
		});
	},
});
