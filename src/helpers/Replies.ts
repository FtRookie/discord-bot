import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type Reply = { match: string; text: string };

// Runtime data lives at the repo root (gitignored), two levels up from src/helpers/.
const file = join(import.meta.dirname, "..", "..", "replies.json");

/** Case-insensitive substrings matched anywhere in a message → text reply. */
export const Replies: Reply[] = load();

function load(): Reply[] {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return [];
	}
}

export function AddReply(match: string, text: string) {
	RemoveReply(match);
	Replies.push({ match: match.toLowerCase(), text });
	writeFileSync(file, `${JSON.stringify(Replies, null, 4)}\n`);
}

export function RemoveReply(match: string): boolean {
	const index = Replies.findIndex((r) => r.match === match.toLowerCase());
	if (index === -1) return false;
	Replies.splice(index, 1);
	writeFileSync(file, `${JSON.stringify(Replies, null, 4)}\n`);
	return true;
}
