import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type Reaction = { match: string; emoji: string };

// Runtime data lives at the repo root (gitignored), two levels up from src/helpers/.
const file = join(import.meta.dirname, "..", "..", "reactions.json");

/** Case-insensitive substrings matched anywhere in a message → emoji reaction. */
export const reactions: Reaction[] = load();

function load(): Reaction[] {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return [];
	}
}

export function addReaction(match: string, emoji: string) {
	removeReaction(match);
	reactions.push({ match: match.toLowerCase(), emoji });
	writeFileSync(file, JSON.stringify(reactions, null, 4) + "\n");
}

export function removeReaction(match: string): boolean {
	const index = reactions.findIndex((r) => r.match === match.toLowerCase());
	if (index === -1) return false;
	reactions.splice(index, 1);
	writeFileSync(file, JSON.stringify(reactions, null, 4) + "\n");
	return true;
}
