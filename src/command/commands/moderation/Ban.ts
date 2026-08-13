import { InteractionContextType, MessageFlags } from "discord.js";
import { BlockedWord, Screen } from "../../../helpers/Filter.ts";
import { Perms } from "../../../helpers/Permissions.ts";
import {
	ExpiryTimestamp,
	FormatDuration,
	ParseDurationSeconds,
	ResolveUser,
	UpdateRestriction,
} from "../../../helpers/Roblox.ts";
import { AuditTag, Command, UserOption } from "../../Command.ts";

const PERMANENT_WORDS = ["perm", "permanent", "forever"];

export const Ban = new Command({
	name: "ban",
	description: "Ban a Roblox user from the game",
	permissions: Perms.Moderate,
	contexts: InteractionContextType.Guild,
	options: {
		user: UserOption(),
		duration: {
			string: {
				description: 'How long, e.g. "30m", "12h", "7d", "1w2d" — omit for a permanent ban',
				maxLength: 40,
			},
		},
		reason: {
			string: {
				description: "Private moderation reason (view with /banlog)",
				maxLength: 900,
			},
		},
		display_reason: {
			string: {
				description: "Reason shown to the banned user",
				maxLength: 400,
			},
		},
		visible: {
			bool: {
				description: "Whether or not the ban message is visible, default true",
			},
		},
	},

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
		if (hit) throw BlockedWord(hit, "the public reason");

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
