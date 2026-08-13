import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CountMatches } from "./StringMatch.ts";

/**
 * Fires when at least `count` of `terms` match a message under `flags` (see Match), replying `response`.
 * With `rate` set (triggers per minute), a user who exceeds it is timed out (for Config.phrase.timeoutMs)
 * instead of getting the reply.
 */
export type PhraseRule = { flags: number; terms: string[]; count: number; response: string; rate?: number };

// Runtime data lives at the repo root (gitignored), two levels up from src/helpers/.
const file = join(import.meta.dirname, "..", "..", "phrase-responses.json");

export const PhraseResponses: PhraseRule[] = load();

function load(): PhraseRule[] {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return [];
	}
}

function save() {
	writeFileSync(file, `${JSON.stringify(PhraseResponses, null, 4)}\n`);
}

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

// Per-rule, per-user hit times for the optional spam timeout. Keyed by the rule object, so a removed rule's
// bookkeeping is collected along with it.
const timeoutHits = new WeakMap<PhraseRule, Map<string, number[]>>();

/**
 * Records that `userId` just tripped `rule`, and reports whether that puts them past its per-minute `rate`.
 * A rule without a `rate` is never recorded and never returns true.
 */
export function ShouldTimeout(rule: PhraseRule, userId: string): boolean {
	if (rule.rate === undefined) return false;
	const now = Date.now();
	const perUser = timeoutHits.get(rule) ?? new Map<string, number[]>();
	const recent = (perUser.get(userId) ?? []).filter((t) => now - t < 60_000);
	recent.push(now);
	perUser.set(userId, recent);
	timeoutHits.set(rule, perUser);
	return recent.length > rule.rate;
}
