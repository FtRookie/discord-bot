import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Config } from "../Config.ts";
import { CountMatches } from "./StringMatch.ts";

/**
 * Fires when at least `count` of `terms` match a message under `flags` (see Match), replying `response`.
 * With `timeout` set (seconds), a user who trips it more than Config.phrase.maxHits times within the window
 * is timed out for that long instead of getting the reply.
 */
export type PhraseRule = { flags: number; terms: string[]; count: number; response: string; timeout?: number };

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

/** Remove the 1-based rule as shown by /phrase-response list; returns it, or undefined if out of range. */
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
// bookkeeping is garbage-collected along with it.
const timeoutHits = new WeakMap<PhraseRule, Map<string, number[]>>();

/**
 * Record that `userId` just tripped `rule`, and report whether they've now exceeded Config.phrase.maxHits
 * within the window — i.e. whether they should be timed out. Only meaningful for rules that set a `timeout`.
 */
export function ShouldTimeout(rule: PhraseRule, userId: string): boolean {
	const now = Date.now();
	const perUser = timeoutHits.get(rule) ?? new Map<string, number[]>();
	const recent = (perUser.get(userId) ?? []).filter((t) => now - t < Config.phrase.windowMs);
	recent.push(now);
	perUser.set(userId, recent);
	timeoutHits.set(rule, perUser);
	return recent.length > Config.phrase.maxHits;
}
