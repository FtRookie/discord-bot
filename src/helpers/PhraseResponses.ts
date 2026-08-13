import { db, ReplaceAll } from "./Database.ts";
import { RateWindow } from "./RateLimit.ts";
import { CountMatches } from "./StringMatch.ts";

/**
 * Fires when at least `count` of `terms` match a message under `flags` (see Match), replying `response`.
 * With `rate` set (triggers per minute), a user who exceeds it is timed out (for Config.phrase.timeoutMs)
 * instead of getting the reply.
 */
export type PhraseRule = { flags: number; terms: string[]; count: number; response: string; rate?: number };

type Row = { flags: number; terms: string; count: number; response: string; rate: number | null };

export const PhraseResponses: PhraseRule[] = (
	db.query(`SELECT flags, terms, "count", response, rate FROM phrase_responses ORDER BY id`).all() as Row[]
).map((row) => ({
	flags: row.flags,
	terms: JSON.parse(row.terms) as string[],
	count: row.count,
	response: row.response,
	// spread rather than assigned: ShouldTimeout tests `rate === undefined`, which a null would slip past
	...(row.rate === null ? {} : { rate: row.rate }),
}));

const save = () =>
	ReplaceAll(
		"phrase_responses",
		["flags", "terms", "count", "response", "rate"],
		PhraseResponses.map((rule) => ({ ...rule, terms: JSON.stringify(rule.terms) })),
	);

export function AddPhraseResponse(rule: PhraseRule) {
	PhraseResponses.push(rule);
	save();
}

/** `index` is 1-based, as shown by /phrase-response list. Undefined when out of range. */
export function RemovePhraseResponse(index: number): PhraseRule | undefined {
	if (index < 1 || index > PhraseResponses.length) return undefined;
	const [removed] = PhraseResponses.splice(index - 1, 1);
	save();
	return removed;
}

/** The first rule whose match count meets its threshold, else undefined. */
export function MatchPhrase(message: string): PhraseRule | undefined {
	return PhraseResponses.find((rule) => CountMatches(message, rule.terms, rule.flags) >= rule.count);
}

// One window per rule, keyed by the rule object so a removed rule's bookkeeping is collected along with it.
const timeoutHits = new WeakMap<PhraseRule, RateWindow>();

/**
 * Records that `userId` just tripped `rule`, and reports whether that puts them past its per-minute `rate`.
 * A rule without a `rate` is never recorded and never returns true.
 */
export function ShouldTimeout(rule: PhraseRule, userId: string): boolean {
	if (rule.rate === undefined) return false;
	const window = timeoutHits.get(rule) ?? new RateWindow(60_000);
	timeoutHits.set(rule, window);
	return window.hit(userId).count > rule.rate;
}
