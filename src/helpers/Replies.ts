import { db, ReplaceAll } from "./Database.ts";

export type Reply = { match: string; text: string };

// case-insensitive substrings matched anywhere in a message → text reply
export const Replies: Reply[] = db.query(`SELECT "match", text FROM replies ORDER BY id`).all() as Reply[];

const save = () => ReplaceAll("replies", ["match", "text"], Replies);

export function AddReply(match: string, text: string) {
	RemoveReply(match);
	Replies.push({ match: match.toLowerCase(), text });
	save();
}

export function RemoveReply(match: string): boolean {
	const index = Replies.findIndex((r) => r.match === match.toLowerCase());
	if (index === -1) return false;
	Replies.splice(index, 1);
	save();
	return true;
}
