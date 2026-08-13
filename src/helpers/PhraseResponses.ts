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
 * The two limits are different tools. `rate` (triggers per minute) is the punishing one: a user past it is
 * timed out for Config.phrase.timeoutMs instead of getting the reply, silently unless `timeoutResponse` gives
 * the bot something to say. `cooldownMs` only paces: the rule goes quiet for that user and nothing else
 * happens. Set `timeout: false` to keep the rate limit but drop the punishment, leaving it quiet too.
 */
export type PhraseRule = {
	kind?: PhraseTrigger; // absent means "phrase", so every rule written before mentions existed still works
	flags: number;
	terms: string[];
	count: number;
	response: string;
	rate?: number;
	cooldownMs?: number;
	timeout?: boolean; // absent means true, so a rule written before this existed still punishes
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
	cooldown_ms: number | null;
	timeout: number | null;
	timeout_response: string | null;
	timeout_reason: string | null;
};

const COLUMNS = [
	"kind",
	"flags",
	"terms",
	"count",
	"response",
	"rate",
	"cooldown_ms",
	"timeout",
	"timeout_response",
	"timeout_reason",
];

// Derived from COLUMNS rather than written out, so a column added to the write list cannot be missing from
// the read. Forgetting one is silent: the field arrives undefined and every guard below reads it as "set".
const SELECT = COLUMNS.map((column) => (column === "count" ? `"${column}"` : column)).join(", ");

const isSet = (value: unknown) => value !== null && value !== undefined;

// spread rather than assigned throughout: the consumers test `=== undefined`, which a null would slip past
export const RowToRule = (row: Row): PhraseRule => ({
	kind: row.kind,
	flags: row.flags,
	terms: JSON.parse(row.terms) as string[],
	count: row.count,
	response: row.response,
	...(isSet(row.rate) ? { rate: row.rate } : {}),
	...(isSet(row.cooldown_ms) ? { cooldownMs: row.cooldown_ms } : {}),
	...(isSet(row.timeout) ? { timeout: row.timeout !== 0 } : {}), // SQLite has no boolean
	...(isSet(row.timeout_response) ? { timeoutResponse: row.timeout_response } : {}),
	...(isSet(row.timeout_reason) ? { timeoutReason: row.timeout_reason } : {}),
});

export const PhraseResponses: PhraseRule[] = (
	db.query(`SELECT ${SELECT} FROM phrase_responses ORDER BY id`).all() as Row[]
).map(RowToRule);

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
			cooldown_ms: rule.cooldownMs,
			timeout: rule.timeout === undefined ? undefined : Number(rule.timeout),
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

// Also per rule, and separate from the timeout windows: a rule can pace itself without punishing anyone.
const cooldowns = new WeakMap<PhraseRule, RateWindow>();

function cooldownWindow(rule: PhraseRule): RateWindow | undefined {
	if (rule.cooldownMs === undefined) return undefined;
	const existing = cooldowns.get(rule);
	if (existing) return existing;
	const created = new RateWindow(rule.cooldownMs);
	cooldowns.set(rule, created);
	return created;
}

/** Whether `rule` has already answered `userId` inside its cooldown. A query — it starts nothing. */
export const OnCooldown = (rule: PhraseRule, userId: string): boolean =>
	(cooldownWindow(rule)?.peek(userId).count ?? 0) > 0;

/**
 * Start the cooldown, once the rule has actually replied. Deliberately not called on the suppressed path: the
 * clock runs from the last answer, so asking again mid-cooldown does not push the next one further away.
 */
export const StartCooldown = (rule: PhraseRule, userId: string): void => void cooldownWindow(rule)?.hit(userId);

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
		cooldownMs: 60 * 60 * 1000, // asking twice in an hour is the same person, not a second person asking
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
