// Blocks accidental profanity and slurs in player-facing command text (/announce, /kick reason,
// /ban public reason) before it is broadcast to the game.
// Slurs are on the list precisely so they can never be sent.
// This catches operator mistakes plus common meme/leetspeak parodies —
// it is NOT a defense against determined evasion.
// Matching is word-boundary based to avoid the "Scunthorpe problem":
// clean words like assassin, class, spicy, arsenal, cocktail, Nigeria must never trip it.

// Fold common letter-for-symbol/number swaps back to letters first, so "sh!t", "b1tch", "@ss",
// "$hit", "5hit" are caught. Only maps chars clean announcement text rarely relies on.
const LEET: Record<string, string> = {
	"@": "a",
	"4": "a",
	"3": "e",
	"1": "i",
	"!": "i",
	"|": "i",
	"0": "o",
	$: "s",
	"5": "s",
	"7": "t",
};
// Substitute leet chars only — strictly one-for-one, so it stays length-preserving and a match's
// position maps straight back onto the original text (letter case is handled by the /i flag below).
function normalize(text: string): string {
	return Array.from(text, (c) => LEET[c] ?? c).join("");
}

// Matched at a LEADING word boundary, so suffixed forms ("shitty", "fucking", "bitches") and
// stretched letters ("shiiit") are caught. Only words no common clean word begins with belong here.
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
	// slurs — broadcast text must never carry these
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

// Too short or too embedded in clean words to prefix-match — require a STANDALONE word
// (e.g. "ass" in assassin/class, "cum" in document/cucumber, "spic" in spicy, "cock" in cocktail).
const WHOLE_WORDS = ["ass", "cum", "cock", "dick", "arse", "prick", "spic", "chink", "dyke", "damn", "crap", "hell"];

// Let each letter repeat so stretched spellings ("fuuuck") still match.
const stretch = (word: string) => Array.from(word, (c) => `${c}+`).join("");
const prefixRe = new RegExp(`\\b(?:${PREFIX_WORDS.map(stretch).join("|")})`, "i");
const wholeRe = new RegExp(`\\b(?:${WHOLE_WORDS.map(stretch).join("|")})\\b`, "i");

/**
 * Screen player-facing text for profanity. Returns the matched word plus a short snippet of the
 * ORIGINAL text with the exact flagged span marked (»…«), so a false flag is easy to eyeball — or
 * undefined when the text is clean.
 */
export function screen(text: string): { word: string; snippet: string } | undefined {
	const norm = normalize(text);
	const m = prefixRe.exec(norm) ?? wholeRe.exec(norm);
	const word = m?.[0];
	if (!m || word === undefined) return undefined;

	// The match is found in the (length-preserving) normalized text, so its indices also address the
	// original — slice the original around it and mark the exact span, windowed to keep the reply short.
	const start = m.index;
	const end = start + word.length;
	const from = Math.max(0, start - 24);
	const to = Math.min(text.length, end + 24);
	const snippet =
		`${from > 0 ? "…" : ""}${text.slice(from, start)}»${text.slice(start, end)}«${text.slice(end, to)}${to < text.length ? "…" : ""}`
			.replace(/[`\r\n]+/g, " ")
			.trim();
	return { word, snippet };
}
