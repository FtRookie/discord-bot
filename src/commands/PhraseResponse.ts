import { InteractionContextType, MessageFlags } from "discord.js";
import { Perms } from "../helpers/Permissions.ts";
import { AddPhraseResponse, PhraseResponses, RemovePhraseResponse } from "../helpers/PhraseResponses.ts";
import { UserError } from "../helpers/Roblox.ts";
import { Match, MatchPreset } from "../helpers/StringMatch.ts";
import { Command } from "./Command.ts";

// The override string is one 1/0 per flag, left to right, in this order.
const FLAG_ORDER = [Match.Normalized, Match.Substring, Match.Wildcard, Match.Prefix, Match.Leet, Match.Stretch];
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
	// biome-ignore format:  readability
	options: (data) => data
		.addSubcommand((s) => s
			.setName("add")
			.setDescription("Add a phrase-response")
			.addStringOption((o) => o
				.setName("mode")
				.setDescription("How the terms are matched")
				.setRequired(true)
				.addChoices(
					{ name: "exact — whole message, literal", value: "exact" },
					{ name: "whole — whole message, case & punctuation ignored", value: "whole" },
					{ name: "soft — appears as a substring", value: "soft" },
					{ name: "wildcard — each word anywhere, any order", value: "wildcard" },
					{ name: "prefix — a word starts with it", value: "prefix" },
				))
			.addStringOption((o) => o
				.setName("terms")
				.setDescription("wildcard/prefix: space-separated words; else a phrase, or a|b for alternatives")
				.setRequired(true).setMaxLength(500))
			.addStringOption((o) => o
				.setName("response")
				.setDescription("What the bot replies with")
				.setRequired(true).setMaxLength(1500))
			.addStringOption((o) => o
				.setName("flags")
				.setDescription("Override, 1/0 per flag: Normalized Substring Wildcard Prefix Leet Stretch (e.g. 101000)")
				.setMinLength(1).setMaxLength(6))
			.addIntegerOption((o) => o
				.setName("count")
				.setDescription("Min terms that must match to fire (default: all for wildcard/prefix, else 1)")
				.setMinValue(1)))
		.addSubcommand((s) => s
			.setName("remove")
			.setDescription("Remove a phrase-response by its number in the list")
			.addIntegerOption((o) => o
				.setName("index")
				.setDescription("Number shown by /phrase-response list")
				.setRequired(true).setMinValue(1)))
		.addSubcommand((s) => s
			.setName("list")
			.setDescription("List phrase-responses")),

	async execute(interaction) {
		const sub = interaction.options.getSubcommand();
		let reply: string;

		if (sub === "add") {
			const preset = interaction.options.getString("mode", true) as keyof typeof MatchPreset;
			const override = interaction.options.getString("flags");
			const flags = override ? parseFlags(override) : MatchPreset[preset];
			const input = interaction.options.getString("terms", true);
			const response = interaction.options.getString("response", true);

			// Word-scoped flags take individual words; everything else takes the phrase whole (a|b = alternatives).
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

			AddPhraseResponse({ flags, terms, count, response });
			reply = `Added — fires when **${count}** of \`${terms.join("`, `")}\` match (flags \`${toBinary(flags)}\`).`;
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
								`**${i + 1}.** [\`${toBinary(r.flags)}\`, ${r.count}×] \`${r.terms.join("`, `")}\` → ${r.response}`,
						)
							.join("\n")
							.slice(0, 1900);
		}

		await interaction.reply({ content: reply, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
	},
});
