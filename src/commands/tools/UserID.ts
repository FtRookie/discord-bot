import { InteractionContextType } from "discord.js";
import { Config } from "../../Config.ts";
import { Can, Perms } from "../../helpers/Permissions.ts";
import { ResolveUser, UserError } from "../../helpers/Roblox.ts";
import { Command } from "../Command.ts";

// per-user lookup timestamps; pruned lazily
const history = new Map<string, number[]>();

export const Userid = new Command({
	name: "userid",
	description: "Look up a Roblox user ID from a username",
	contexts: InteractionContextType.Guild,
	permissions: Perms.None,
	ephemeral: true,
	// biome-ignore format:  readability
	options: (data) => data
		.addStringOption((o) => o
			.setName("username")
			.setDescription("Roblox username (a user ID also works and is echoed back)")
			.setRequired(true).setMaxLength(40)),
	async execute(interaction) {
		if (!Can(interaction.user.id, Perms.Unlimited)) rateLimit(interaction.user.id);

		const user = await ResolveUser(interaction.options.getString("username", true));
		const alias = user.displayName && user.displayName !== user.name ? ` (aka ${user.displayName})` : "";
		await interaction.editReply({
			content: `**${user.name}**${alias} → user ID \`${user.id}\``,
			allowedMentions: { parse: [] },
		});
	},
});

/** Throws past the per-minute lookup allowance; the caller exempts Perms.Unlimited. */
function rateLimit(userId: string): void {
	const now = Date.now();
	const cutoff = now - Config.userid.windowMs;
	const recent = (history.get(userId) ?? []).filter((t) => t > cutoff);
	if (recent.length >= Config.userid.maxLookups) {
		const oldest = recent[0] ?? now;
		const wait = Math.ceil((oldest + Config.userid.windowMs - now) / 1000);
		throw new UserError(`Slow down — ${Config.userid.maxLookups} lookups per minute. Try again in ${wait}s.`);
	}
	recent.push(now);
	history.set(userId, recent);
}
