import { InteractionContextType, MessageFlags } from "discord.js";
import { Perms } from "../../helpers/Permissions.ts";
import { AddPhraseResponse, PhraseResponses, RemovePhraseResponse } from "../../helpers/PhraseResponses.ts";
import { FormatDuration, ParseDurationSeconds, UserError } from "../../helpers/Roblox.ts";
import { Match, MatchPreset } from "../../helpers/StringMatch.ts";
import { Command } from "../Command.ts";

// the /phrase-response override string is one 1/0 per flag, left to right, in this order
const FLAG_ORDER = [
	Match.Normalized,
	Match.Substring,
	Match.Wildcard,
	Match.Prefix,
	Match.Leet,
	Match.Stretch,
	Match.Stem,
];
const toBinary = (flags: number) => FLAG_ORDER.map((bit) => (flags & bit ? "1" : "0")).join("");

function parseFlags(binary: string): number {
	if (!/^[01]{1,6}$/.test(binary)) throw new UserError("Override must be 1–6 binary digits, e.g. `101000`.");
	let flags = 0;
	[...binary].forEach((bit, i) => {
		if (bit === "1") flags |= FLAG_ORDER[i] ?? 0;
	});
	return flags;
}

export const PhraseResponse = new Command({
	name: "phrase-response",
	description: "Manage phrase-triggered auto-responses",
	permissions: Perms.Configure,
	contexts: InteractionContextType.Guild,
	subcommands: {
		add: {
			description: "Add a phrase-response",
			options: {
				mode: {
					string: {
						description: "How the terms are matched",
						required: true,
						choices: {
							"exact — whole message, literal": "exact",
							"whole — whole message, case & punctuation ignored": "whole",
							"soft — appears as a substring": "soft",
							"wildcard — each word anywhere, any order": "wildcard",
							"prefix — a word starts with it": "prefix",
							"stem — a word in any conjugated / plural form": "stem",
						},
					},
				},
				terms: {
					string: {
						description: "wildcard/prefix: space-separated words; else a phrase, or a|b for alternatives",
						required: true,
						maxLength: 500,
					},
				},
				response: { string: { description: "What the bot replies with", required: true, maxLength: 1500 } },
				flags: {
					string: {
						description:
							"Override 1/0 per flag: Normalized Substring Wildcard Prefix Leet Stretch Stem (e.g. 1010000)",
						minLength: 1,
						maxLength: 7,
					},
				},
				count: {
					integer: {
						description: "Min terms that must match to fire (default: all for wildcard/prefix, else 1)",
						min: 1,
					},
				},
				rate: {
					integer: {
						description: "Max triggers per minute before the user is timed out (omit for none)",
						min: 1,
					},
				},
				timeout: {
					bool: { description: "Time the user out when they exceed the rate, or just go quiet. Default: on" },
				},
				timeout_response: {
					string: {
						description:
							"What to say when timing someone out for exceeding the rate (omit to do it silently)",
						maxLength: 1500,
					},
				},
				cooldown: {
					string: {
						description: "Stay quiet this long after answering one user, e.g. 30m, 1h, 1d (no timeout)",
						maxLength: 40,
					},
				},
			},
		},
		remove: {
			description: "Remove a phrase-response by its number in the list",
			options: {
				index: { integer: { description: "Number shown by /phrase-response list", required: true, min: 1 } },
			},
		},
		list: { description: "List phrase-responses" },
	},

	async execute(interaction) {
		const sub = interaction.options.getSubcommand();
		let reply: string;

		if (sub === "add") {
			const preset = interaction.options.getString("mode", true) as keyof typeof MatchPreset;
			const override = interaction.options.getString("flags");
			const flags = override ? parseFlags(override) : MatchPreset[preset];
			const input = interaction.options.getString("terms", true);
			const response = interaction.options.getString("response", true);

			// word-scoped flags take individual words; everything else takes the phrase whole (a|b = alternatives)
			const wordScoped = (flags & (Match.Wildcard | Match.Prefix)) !== 0;
			const terms = wordScoped
				? input.trim().split(/\s+/).filter(Boolean)
				: input
						.split("|")
						.map((t) => t.trim())
						.filter(Boolean);
			if (terms.length === 0) throw new UserError("Give at least one term.");

			const count = interaction.options.getInteger("count") ?? (wordScoped ? terms.length : 1);
			if (count > terms.length) throw new UserError(`Count ${count} exceeds the ${terms.length} term(s) given.`);

			const rate = interaction.options.getInteger("rate") ?? undefined;
			const timeout = interaction.options.getBoolean("timeout") ?? undefined;
			const timeoutResponse = interaction.options.getString("timeout_response") ?? undefined;
			const cooldownInput = interaction.options.getString("cooldown");
			const cooldownMs = cooldownInput ? ParseDurationSeconds(cooldownInput) * 1000 : undefined;

			// `timeout: false` asks for no punishment, which is already the case without a rate — nothing to
			// reconcile, so it is allowed to stand on its own as a statement of intent.
			if (rate === undefined && timeout !== false && (timeout !== undefined || timeoutResponse !== undefined)) {
				throw new UserError("`timeout` and `timeout_response` need a `rate` to react to.");
			}
			// the quiet path returns before replying, so the message would be stored and never sent
			if (timeout === false && timeoutResponse !== undefined) {
				throw new UserError("`timeout_response` is never sent when `timeout` is off — drop one of them.");
			}

			AddPhraseResponse({
				kind: "phrase",
				flags,
				terms,
				count,
				response,
				rate,
				cooldownMs,
				timeout,
				timeoutResponse,
			});
			const past = timeout === false ? "going quiet past" : "timing out past";
			reply =
				`Added — fires when **${count}** of \`${terms.join("`, `")}\` match (flags \`${toBinary(flags)}\`)` +
				`${rate ? `, ${past} ${rate}/min` : ""}` +
				`${cooldownMs ? `, then quiet for ${FormatDuration(`${cooldownMs / 1000}s`)} per user` : ""}.`;
		} else if (sub === "remove") {
			const removed = RemovePhraseResponse(interaction.options.getInteger("index", true));
			reply = removed
				? `Removed the response for \`${removed.terms.join("`, `")}\`.`
				: "No phrase-response at that number.";
		} else {
			reply =
				PhraseResponses.length === 0
					? "No phrase-responses set."
					: PhraseResponses.map((r, i) => {
							const meta = [`\`${toBinary(r.flags)}\``, `${r.count}×`];
							if (r.rate) {
								const past =
									r.timeout === false
										? "quiet"
										: `timeout${r.timeoutResponse ? ` → "${r.timeoutResponse}"` : ""}`;
								meta.push(`${r.rate}/min → ${past}`);
							}
							if (r.cooldownMs) meta.push(`${FormatDuration(`${r.cooldownMs / 1000}s`)} cooldown`);
							const trigger = r.kind === "mention" ? "**@-mention**" : `\`${r.terms.join("`, `")}\``;
							return `**${i + 1}.** [${meta.join(", ")}] ${trigger} → ${r.response}`;
						})
							.join("\n")
							.slice(0, 1900);
		}

		await interaction.reply({ content: reply, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
	},
});
