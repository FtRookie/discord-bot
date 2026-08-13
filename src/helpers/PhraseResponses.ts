import { Config } from "../Config.ts";
import { db, GetState, ReplaceAll, SetState } from "./Database.ts";
import { RateWindow } from "./RateLimit.ts";
import { CountMatches, MatchPreset } from "./StringMatch.ts";

/** How a rule is triggered. A mention is not text, so no combination of Match flags can express it. */
export type PhraseTrigger = "phrase" | "mention";

/**
 * A `phrase` rule fires when at least `count` of `terms` match a message under `flags` (see Match); a
 * `mention` rule fires when the message pings the bot directly, and ignores terms entirely. Either replies
 * `response`.
 *
 * With `rate` set (triggers per minute), a user past it is timed out for Config.phrase.timeoutMs instead of
 * getting the reply — silently, unless `timeoutResponse` gives the bot something to say about it.
 */
export type PhraseRule = {
	kind?: PhraseTrigger; // absent means "phrase", so every rule written before mentions existed still works
	flags: number;
	terms: string[];
	count: number;
	response: string;
	rate?: number;
	timeoutResponse?: string;
	timeoutReason?: string; // shown in Discord's audit log
};

type Row = {
	kind: PhraseTrigger;
	flags: number;
	terms: string;
	count: number;
	response: string;
	rate: number | null;
	timeout_response: string | null;
	timeout_reason: string | null;
};

const COLUMNS = ["kind", "flags", "terms", "count", "response", "rate", "timeout_response", "timeout_reason"];

// spread rather than assigned throughout: the consumers test `=== undefined`, which a null would slip past
const toRule = (row: Row): PhraseRule => ({
	kind: row.kind,
	flags: row.flags,
	terms: JSON.parse(row.terms) as string[],
	count: row.count,
	response: row.response,
	...(row.rate === null ? {} : { rate: row.rate }),
	...(row.timeout_response === null ? {} : { timeoutResponse: row.timeout_response }),
	...(row.timeout_reason === null ? {} : { timeoutReason: row.timeout_reason }),
});

export const PhraseResponses: PhraseRule[] = (
	db
		.query(`SELECT kind, flags, terms, "count", response, rate, timeout_response, timeout_reason
			FROM phrase_responses ORDER BY id`)
		.all() as Row[]
).map(toRule);

const save = () =>
	ReplaceAll(
		"phrase_responses",
		COLUMNS,
		PhraseResponses.map((rule) => ({
			kind: rule.kind ?? "phrase",
			flags: rule.flags,
			terms: JSON.stringify(rule.terms),
			count: rule.count,
			response: rule.response,
			rate: rule.rate,
			timeout_response: rule.timeoutResponse,
			timeout_reason: rule.timeoutReason,
		})),
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

/** The first text rule whose match count meets its threshold. Mention rules never match on text. */
export function MatchPhrase(message: string): PhraseRule | undefined {
	return PhraseResponses.find(
		(rule) => rule.kind !== "mention" && CountMatches(message, rule.terms, rule.flags) >= rule.count,
	);
}

/** The rule answering a direct ping, if one is still configured — it is deletable like any other. */
export function MentionRule(): PhraseRule | undefined {
	return PhraseResponses.find((rule) => rule.kind === "mention");
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

const GAME_LINK = "Game [here](https://www.roblox.com/games/86822363308738/Underengineered)";
const SEEDED = "seeded-builtin-rules";

/**
 * The two replies that used to be hardcoded in index.ts, inserted once and then owned by the table like any
 * other rule. Appended rather than prepended, so a rule added later can shadow them, and the marker means
 * deleting one is permanent rather than undone by the next restart.
 */
export function SeedBuiltinRules(): void {
	if (GetState(SEEDED) !== undefined) return;

	AddPhraseResponse({
		kind: "phrase",
		flags: MatchPreset.stem,
		terms: ["game", "where"],
		count: 2,
		response: GAME_LINK,
	});
	AddPhraseResponse({
		kind: "mention",
		flags: 0,
		terms: [],
		count: 0,
		response: GAME_LINK,
		rate: Config.mention.rate,
		timeoutResponse: "Shut up, bye",
		timeoutReason: "Spamming bot pings",
	});

	SetState(SEEDED, new Date().toISOString());
	console.log("[phrase] seeded the built-in game-link rules");
}
