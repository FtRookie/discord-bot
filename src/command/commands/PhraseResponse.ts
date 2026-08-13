import { InteractionContextType, MessageFlags } from "discord.js";
import { Perms } from "../../helpers/Permissions.ts";
import { AddPhraseResponse, PhraseResponses, RemovePhraseResponse } from "../../helpers/PhraseResponses.ts";
import { UserError } from "../../helpers/Roblox.ts";
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
			AddPhraseResponse({ flags, terms, count, response, rate });
			reply = `Added — fires when **${count}** of \`${terms.join("`, `")}\` match (flags \`${toBinary(flags)}\`)${
				rate ? `, timing out past ${rate}/min` : ""
			}.`;
		} else if (sub === "remove") {
			const removed = RemovePhraseResponse(interaction.options.getInteger("index", true));
			reply = removed
				? `Removed the response for \`${removed.terms.join("`, `")}\`.`
				: "No phrase-response at that number.";
		} else {
			reply =
				PhraseResponses.length === 0
					? "No phrase-responses set."
					: PhraseResponses.map(
							(r, i) =>
								`**${i + 1}.** [\`${toBinary(r.flags)}\`, ${r.count}×${r.rate ? `, ${r.rate}/min` : ""}] \`${r.terms.join("`, `")}\` → ${r.response}`,
						)
							.join("\n")
							.slice(0, 1900);
		}

		await interaction.reply({ content: reply, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
	},
});
