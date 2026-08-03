import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CountMatches } from "./StringMatch.ts";

/** Fires when at least `count` of `terms` match a message under `flags` (see Match), replying `response`. */
export type PhraseRule = { flags: number; terms: string[]; count: number; response: string };

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

/** The response of the first rule whose match count meets its threshold, else undefined. */
export function MatchPhrase(message: string): string | undefined {
	for (const rule of PhraseResponses) {
		if (CountMatches(message, rule.terms, rule.flags) >= rule.count) return rule.response;
	}
	return undefined;
}
