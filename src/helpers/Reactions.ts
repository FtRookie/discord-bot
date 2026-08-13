import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type Reaction = { match: string; emoji: string };

// Runtime data lives at the repo root (gitignored), two levels up from src/helpers/.
const file = join(import.meta.dirname, "..", "..", "reactions.json");

// case-insensitive substrings matched anywhere in a message → emoji reaction
export const Reactions: Reaction[] = load();

function load(): Reaction[] {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return [];
	}
}

export function AddReaction(match: string, emoji: string) {
	RemoveReaction(match);
	Reactions.push({ match: match.toLowerCase(), emoji });
	writeFileSync(file, `${JSON.stringify(Reactions, null, 4)}\n`);
}

export function RemoveReaction(match: string): boolean {
	const index = Reactions.findIndex((r) => r.match === match.toLowerCase());
	if (index === -1) return false;
	Reactions.splice(index, 1);
	writeFileSync(file, `${JSON.stringify(Reactions, null, 4)}\n`);
	return true;
}
