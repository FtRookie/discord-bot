// Screens player-facing command text (/announce, /kick reason, /ban public reason) before it is broadcast to
// the game. Catches operator mistakes and common meme/leetspeak parodies; NOT a defense against determined
// evasion. Word-boundary based throughout to avoid the "Scunthorpe problem" — clean words like assassin,
// class, spicy, arsenal, cocktail and Nigeria must never trip it.

import { UserError } from "./Roblox.ts";
import { Match, Matches } from "./StringMatch.ts";

// Matched at a LEADING word boundary, so suffixed forms ("shitty", "bitches") and stretched letters
// ("shiiit") are caught. Only words no common clean word begins with belong here.
const PREFIX_WORDS = [
	"fuck",
	"shit",
	"bitch",
	"cunt",
	"pussy",
	"slut",
	"whore",
	"wank",
	"twat",
	"bastard",
	"bollock",
	"douche",
	"piss",
	"bullshit",
	"dipshit",
	"jackass",
	"dumbass",
	"badass",
	"asshole",
	"motherfuck",
	"goddamn",
	"dickhead",
	// slurs, listed precisely so broadcast text can never carry them
	"nigger",
	"nigga",
	"faggot",
	"fag",
	"retard",
	"kike",
	"wetback",
	"tranny",
	"coon",
	// common meme / phonetic parodies the normalizer can't reach on its own
	"shid",
	"phuck",
	"phuk",
	"fuk",
	"fuq",
	"fck",
	"fcuk",
	"biatch",
	"biotch",
	"beatch",
	"beotch",
	"azz",
	"niga",
];

// Too short or too embedded in clean words to prefix-match, so these require a STANDALONE word
// ("ass" in assassin/class, "cum" in document/cucumber, "spic" in spicy, "cock" in cocktail).
const WHOLE_WORDS = ["ass", "cum", "cock", "dick", "arse", "prick", "spic", "chink", "dyke", "damn", "crap", "hell"];

// Leet + Stretch fold evasion; Prefix catches suffixed forms, Wildcard requires a standalone word.
const PREFIX_FLAGS = Match.Normalized | Match.Leet | Match.Stretch | Match.Prefix;
const WHOLE_FLAGS = Match.Normalized | Match.Leet | Match.Stretch | Match.Wildcard;

/** The leftmost occurrence of any of `words` in `text` under `flags`, as an original-text span. */
function firstHit(text: string, words: string[], flags: number): { start: number; end: number } | undefined {
	let best: { start: number; end: number } | undefined;
	for (const word of words) {
		const { hits, indices, lengths } = Matches(text, word, flags);
		const start = indices[0];
		if (hits > 0 && start !== undefined && (!best || start < best.start)) {
			best = { start, end: start + (lengths[0] ?? 0) };
		}
	}
	return best;
}

/**
 * The flagged span of the ORIGINAL text plus a short snippet with it marked (»…«), so a false flag is easy to
 * eyeball — or undefined when the text is clean.
 */
export function Screen(text: string): { word: string; snippet: string } | undefined {
	const hit = firstHit(text, PREFIX_WORDS, PREFIX_FLAGS) ?? firstHit(text, WHOLE_WORDS, WHOLE_FLAGS);
	if (!hit) return undefined;

	const { start, end } = hit;
	const from = Math.max(0, start - 24);
	const to = Math.min(text.length, end + 24);
	const snippet =
		`${from > 0 ? "…" : ""}${text.slice(from, start)}»${text.slice(start, end)}«${text.slice(end, to)}${to < text.length ? "…" : ""}`
			.replace(/[`\r\n]+/g, " ")
			.trim();
	return { word: text.slice(start, end), snippet };
}

export type ScreenHit = NonNullable<ReturnType<typeof Screen>>;

/** `where` names the field, so an operator with several text options knows which one to edit. */
export function BlockedWord(hit: ScreenHit, where: string): UserError {
	return new UserError(
		`Blocked word "${hit.word}" in ${where} — edit and resend. If it's a false flag:\n\`\`\`\n${hit.snippet}\n\`\`\``,
	);
}
