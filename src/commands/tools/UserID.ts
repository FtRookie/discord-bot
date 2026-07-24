import { InteractionContextType } from "discord.js";
import { config } from "../../Config.ts";
import { resolveUser, UserError } from "../../helpers/Roblox.ts";
import { Command } from "../Command.ts";

// Per-user lookup timestamps. Entries are pruned lazily.
const history = new Map<string, number[]>();

export const userid = new Command({
	name: "userid",
	description: "Look up a Roblox user ID from a username",
	contexts: InteractionContextType.Guild,
	ownerOnly: false,
	ephemeral: true,
	// biome-ignore format:  readability
	options: (data) => data
		.addStringOption((o) => o
			.setName("username")
			.setDescription("Roblox username (a user ID also works and is echoed back)")
			.setRequired(true).setMaxLength(40)),
	async execute(interaction) {
		if (interaction.user.id !== config.discord.ownerId) rateLimit(interaction.user.id);

		const user = await resolveUser(interaction.options.getString("username", true));
		const alias = user.displayName && user.displayName !== user.name ? ` (aka ${user.displayName})` : "";
		await interaction.editReply({
			content: `**${user.name}**${alias} → user ID \`${user.id}\``,
			allowedMentions: { parse: [] },
		});
	},
});

/** Throw if the user has exceeded their per-minute lookup allowance (owner exempt, checked by the caller). */
function rateLimit(userId: string): void {
	const now = Date.now();
	const cutoff = now - config.userid.windowMs;
	const recent = (history.get(userId) ?? []).filter((t) => t > cutoff);
	if (recent.length >= config.userid.maxLookups) {
		const oldest = recent[0] ?? now;
		const wait = Math.ceil((oldest + config.userid.windowMs - now) / 1000);
		throw new UserError(`Slow down — ${config.userid.maxLookups} lookups per minute. Try again in ${wait}s.`);
	}
	recent.push(now);
	history.set(userId, recent);
}
