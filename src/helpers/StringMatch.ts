/** Composable match flags (Perms-style): a spec is normalization + a shape, OR'd together. */
export const Match = {
	Normalized: 1 << 0, // fold case + tolerate punctuation + flexible whitespace
	Substring: 1 << 1, // term appears anywhere (else: the whole message)
	Wildcard: 1 << 2, // term is a standalone word, any position and order
	Prefix: 1 << 3, // term begins a word ("shit" → "shitty")
	Leet: 1 << 4, // fold leet swaps before matching ("sh!t" → "shit")
	Stretch: 1 << 5, // let the term's letters repeat ("shiiit" → "shit")
} as const;

/** The friendly presets, each a flag combo — the /phrase-response mode dropdown maps to these. */
export const MatchPreset = {
	exact: 0,
	whole: Match.Normalized,
	soft: Match.Normalized | Match.Substring,
	wildcard: Match.Normalized | Match.Wildcard,
	prefix: Match.Normalized | Match.Prefix,
} as const;

/**
 * How a term matched: the number of (non-overlapping) hits, and — parallel to it — each one's start index
 * and length in the message, so a caller can slice out the exact matched span (e.g. to mark it).
 */
export type MatchResult = { hits: number; indices: number[]; lengths: number[] };

// Common letter-for-symbol swaps, folded when Match.Leet is set. Kept strictly 1-for-1 so it's
// length-preserving and match indices still address the original text.
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
const foldLeet = (text: string) => Array.from(text, (c) => LEET[c] ?? c).join("");
const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Build the term as a regex body: letter-stretch, flexible whitespace, and — for non-word Normalized
// matching — tolerance for punctuation between characters. This all lives in the pattern rather than
// mutating the message, so the reported indices stay true to the original text.
function regexBody(term: string, flags: number, wordScope: boolean): string {
	const atoms = Array.from(term, (c) => (/\s/.test(c) ? "\\s+" : escapeRe(c) + (flags & Match.Stretch ? "+" : "")));
	const glue = (flags & Match.Normalized) !== 0 && !wordScope ? "\\p{P}*" : "";
	return atoms.join(glue);
}

/**
 * Find where `term` matches `message` under `flags` (see Match). Returns how many times it hit and the
 * start index of each occurrence in the ORIGINAL message — only length-preserving folds (Leet, and case
 * via the regex flag) touch the text, so the indices stay true to `message`. MatchPreset holds the common
 * flag combos.
 */
export function Matches(message: string, term: string, flags: number): MatchResult {
	const wordScope = (flags & (Match.Wildcard | Match.Prefix)) !== 0;
	const searched = flags & Match.Leet ? foldLeet(message) : message;
	const t = (flags & Match.Leet ? foldLeet(term) : term).trim();
	if (!t) return { hits: 0, indices: [], lengths: [] };

	const edge = "(?<![\\p{L}\\p{N}])"; // a unicode-aware word edge — ASCII-only \b mishandles accents
	const ends = (flags & Match.Normalized) !== 0 ? "[\\s\\p{P}]*" : "\\s*";
	const b = regexBody(t, flags, wordScope);
	const source =
		flags & Match.Wildcard
			? `${edge}${b}(?![\\p{L}\\p{N}])`
			: flags & Match.Prefix
				? `${edge}${b}`
				: flags & Match.Substring
					? b
					: `^${ends}${b}${ends}$`;

	const re = new RegExp(source, (flags & Match.Normalized) !== 0 ? "gui" : "gu");
	const found = [...searched.matchAll(re)];
	return {
		hits: found.length,
		indices: found.map((m) => m.index ?? 0),
		lengths: found.map((m) => (m[0] ?? "").length),
	};
}

/** How many of `terms` match `message` under `flags` — the count a rule is thresholded against. */
export function CountMatches(message: string, terms: string[], flags: number): number {
	return terms.reduce((n, term) => n + (Matches(message, term, flags).hits > 0 ? 1 : 0), 0);
}
