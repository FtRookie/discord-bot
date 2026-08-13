import { db, ReplaceAll } from "./Database.ts";

export type Reaction = { match: string; emoji: string };

// case-insensitive substrings matched anywhere in a message → emoji reaction
export const Reactions: Reaction[] = db.query(`SELECT "match", emoji FROM reactions ORDER BY id`).all() as Reaction[];

const save = () => ReplaceAll("reactions", ["match", "emoji"], Reactions);

export function AddReaction(match: string, emoji: string) {
	RemoveReaction(match);
	Reactions.push({ match: match.toLowerCase(), emoji });
	save();
}

export function RemoveReaction(match: string): boolean {
	const index = Reactions.findIndex((r) => r.match === match.toLowerCase());
	if (index === -1) return false;
	Reactions.splice(index, 1);
	save();
	return true;
}
