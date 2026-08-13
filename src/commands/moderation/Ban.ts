import { InteractionContextType, MessageFlags } from "discord.js";
import { Screen } from "../../helpers/Filter.ts";
import { Perms } from "../../helpers/Permissions.ts";
import {
	ExpiryTimestamp,
	FormatDuration,
	ParseDurationSeconds,
	ResolveUser,
	UpdateRestriction,
	UserError,
} from "../../helpers/Roblox.ts";
import { AuditTag, Command } from "../Command.ts";

const PERMANENT_WORDS = ["perm", "permanent", "forever"];

export const Ban = new Command({
	name: "ban",
	description: "Ban a Roblox user from the game",
	permissions: Perms.Moderate,
	contexts: InteractionContextType.Guild,
	// biome-ignore format:  readability
	options: (data) => data
		.addStringOption((o) => o.setName("user")
			.setDescription("Username or UserID")
			.setRequired(true).setMaxLength(40))
		.addStringOption((o) => o
			.setName("duration")
			.setDescription('How long, e.g. "30m", "12h", "7d", "1w2d" — omit for a permanent ban')
			.setMaxLength(40))
		.addStringOption((o) => o
			.setName("reason")
			.setDescription("Private moderation reason (view with /banlog)")
			.setMaxLength(900))
		.addStringOption((o) => o
			.setName("display_reason")
			.setDescription("Reason shown to the banned user")
			.setMaxLength(400),
		)
		.addBooleanOption((o) => o
			.setName("visible")
			.setDescription("Whether or not the ban message is visible, default true"),
		),

	async execute(interaction) {
		const options = interaction.options;
		await interaction.deferReply((options.getBoolean("visible") ?? true) ? {} : { flags: MessageFlags.Ephemeral });
		const user = await ResolveUser(options.getString("user", true));
		const durationInput = options.getString("duration");
		const seconds =
			durationInput && !PERMANENT_WORDS.includes(durationInput.trim().toLowerCase())
				? ParseDurationSeconds(durationInput)
				: undefined;
		const displayReason = options.getString("display_reason");
		const reason = options.getString("reason") ?? displayReason;

		// only the player-facing reason is filtered; the private /banlog reason can be anything
		const hit = displayReason ? Screen(displayReason) : undefined;
		if (hit) {
			throw new UserError(
				`Blocked word "${hit.word}" in the public reason — edit and resend. If it's a false flag:\n\`\`\`\n${hit.snippet}\n\`\`\``,
			);
		}

		const audit = AuditTag(interaction);
		const result = await UpdateRestriction(user.id, {
			active: true,
			...(seconds !== undefined ? { duration: `${seconds}s` } : {}),
			privateReason: (reason ? `${reason} — ${audit}` : `Banned by ${audit}`).slice(0, 1000),
			...(displayReason ? { displayReason: displayReason.slice(0, 400) } : {}),
		});

		const expires = ExpiryTimestamp(result.gameJoinRestriction ?? {});
		// the private reason stays out of this public confirmation; /banlog shows it
		const lines = [
			`**Banned** __${user.name}__ (${user.id}) ` +
				(seconds !== undefined
					? `for **${FormatDuration(`${seconds}s`)}**${expires ? `, expires ${expires}` : ""}.`
					: "**permanently**."),
			...(reason ? ["> Private reason recorded — view with /banlog"] : []),
			...(displayReason ? [`> Reason: ${displayReason}`] : ["> No reason was given"]),
		];
		await interaction.editReply({ content: lines.join("\n"), allowedMentions: { parse: [] } });
	},
});
