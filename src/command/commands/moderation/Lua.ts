import { InteractionContextType } from "discord.js";
import { GrantBlock, RefreshPlayer } from "../../../helpers/Grants.ts";
import { EnsureRole, Perms } from "../../../helpers/Permissions.ts";
import { ResolveUser, UserError } from "../../../helpers/Roblox.ts";
import { Command, UserOption } from "../../Command.ts";

const BLOCK_ID = "luacircuit";
// held once claimed; both the re-run guard and the visibility deny key off it, so one role does both
export const LUA_VERIFIED_ROLE = "Lua Verified";

export const Lua = new Command({
	name: "lua",
	description: "Claim the Lua Circuit block for your Roblox account",
	permissions: Perms.None,
	hiddenFromRole: LUA_VERIFIED_ROLE,
	contexts: InteractionContextType.Guild,
	ephemeral: true,
	options: {
		user: UserOption({ description: "Your Roblox username or UserID" }),
	},
	async execute(interaction) {
		const guild = interaction.guild;
		if (!guild) throw new UserError("Run this in the server, not in DMs.");

		const role = await EnsureRole(guild, LUA_VERIFIED_ROLE);
		if (!role) throw new UserError("Could not resolve the verified role — tell an admin to check my permissions.");

		// the deny override hides this once claimed, but a stale client can still send it — visibility is a
		// convenience, and this check is the actual limit
		const member = await guild.members.fetch(interaction.user.id).catch(() => null);
		if (!member) throw new UserError("Could not read your membership — try again in a moment.");
		if (member.roles.cache.has(role.id)) {
			throw new UserError("You've already claimed the Lua Circuit. Ask an admin if it needs moving accounts.");
		}

		const user = await ResolveUser(interaction.options.getString("user", true));
		// verified only once the write landed, so a failed attempt stays retryable
		await GrantBlock(user.id, BLOCK_ID, 1).catch((err: unknown) => {
			if (!(err instanceof UserError)) throw err;
			throw new UserError(`${err.message}\nNothing was claimed — you can run this again.`);
		});
		await member.roles.add(role.id).catch(() => {});
		await RefreshPlayer(user.id);

		await interaction.editReply({
			content:
				`**Claimed** — __${user.name}__ (${user.id}) can now place the Lua Circuit. It applies in game ` +
				"within seconds, or when you next join, and this is one per Discord account.",
			allowedMentions: { parse: [] },
		});
	},
});
