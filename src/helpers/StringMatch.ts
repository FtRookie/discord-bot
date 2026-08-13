import lemmatize from "wink-lemmatizer";

/** Composable match flags (Perms-style): a spec is normalization + a shape, OR'd together. */
export const Match = {
	Normalized: 1 << 0, // lowercase, no punctuation, any spaces
	Substring: 1 << 1, // term appears anywhere, including mid-word
	Wildcard: 1 << 2, // term is a standalone word, any position and order
	Prefix: 1 << 3, // term begins a word ("shit" → "shitty")
	Leet: 1 << 4, // fold leet swaps before matching ("sh!t" → "shit")
	Stretch: 1 << 5, // let the term's letters repeat ("shiiit" → "shit")
	Stem: 1 << 6, // reduce words to their lemma, so conjugations/plurals match ("ran"/"running" → "run")
} as const;

/** The friendly presets, each a flag combo — the /phrase-response mode dropdown maps to these. */
export const MatchPreset = {
	exact: 0,
	whole: Match.Normalized,
	soft: Match.Normalized | Match.Substring,
	wildcard: Match.Normalized | Match.Wildcard,
	prefix: Match.Normalized | Match.Prefix,
	stem: Match.Normalized | Match.Wildcard | Match.Stem,
} as const;

/** Non-overlapping hits, with `indices` and `lengths` parallel to each other so a caller can slice the span. */
export type MatchResult = { hits: number; indices: number[]; lengths: number[] };

// Folded when Match.Leet is set. Strictly 1-for-1, so it's length-preserving and match indices still address
// the original text.
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

// Apostrophe-dropped contractions and shorthand people type online, folded before lemmatizing so a term still
// matches the sloppy form. Only spellings that aren't a different real word — so not "its" or "were".
const CONTRACTIONS: Record<string, string> = {
	wheres: "where",
	heres: "here",
	theres: "there",
	whats: "what",
	thats: "that",
	hows: "how",
	whos: "who",
	hes: "he",
	shes: "she",
	youre: "you",
	theyre: "they",
	ur: "your",
	ure: "you",
	u: "you",
};

/**
 * The dictionary lemma of an English word, so conjugated and plural forms collapse together for Match.Stem.
 * With no part of speech to go on the chain is noun → verb → adjective: collapsing plurals first keeps a
 * word's own inflections together even for noun/verb homographs ("rose"/"roses" reduce to the same lemma).
 */
const lemma = (word: string) => {
	const w = word.toLowerCase();
	return CONTRACTIONS[w] ?? lemmatize.adjective(lemmatize.verb(lemmatize.noun(w)));
};

// Stretch, whitespace and punctuation tolerance all live in the pattern rather than in a rewritten message,
// so the reported indices stay true to the original text.
function regexBody(term: string, flags: number, wordScope: boolean): string {
	const atoms = Array.from(term, (c) => (/\s/.test(c) ? "\\s+" : escapeRe(c) + (flags & Match.Stretch ? "+" : "")));
	const glue = (flags & Match.Normalized) !== 0 && !wordScope ? "\\p{P}*" : "";
	return atoms.join(glue);
}

/**
 * Where `term` matches `message` under `flags` (see Match; MatchPreset holds the common combos). Indices are
 * into the ORIGINAL message — only length-preserving folds (Leet, and case via the regex flag) touch the text.
 */
export function Matches(message: string, term: string, flags: number): MatchResult {
	const wordScope = (flags & (Match.Wildcard | Match.Prefix)) !== 0;
	// stemming changes word lengths, so with Stem the reported indices are approximate — fine for counting,
	// and Filter, which relies on exact spans, never sets it
	const stem = (s: string) => (flags & Match.Stem ? s.replace(/\p{L}+/gu, lemma) : s);
	const searched = stem(flags & Match.Leet ? foldLeet(message) : message);
	const t = stem((flags & Match.Leet ? foldLeet(term) : term).trim());
	if (!t) return { hits: 0, indices: [], lengths: [] };

	const edge = "(?<![\\p{L}\\p{N}])"; // unicode-aware word edge; ASCII-only \b mishandles accents
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
