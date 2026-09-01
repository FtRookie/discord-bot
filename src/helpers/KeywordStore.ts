import { db, ReplaceAll } from "./Database.ts";

export type Keyword = { match: string; value: string };

export type KeywordStore = {
	/** Scanned once per message, so this is the same array instance throughout, never reassigned. */
	readonly items: Keyword[];
	add(match: string, value: string): void;
	remove(match: string): boolean;
};

/**
 * A table of lowercase `match` → one value. `column` names the value in SQLite, which differs per table
 * (emoji, text) while the in-memory shape stays uniform, so nothing had to be migrated to share this.
 *
 * Adding a match that already exists removes it first, which moves it to the end of the scan order rather
 * than updating it in place. That is what the JSON stores did.
 */
export function KeywordStore(table: string, column: string): KeywordStore {
	const items = db.query(`SELECT "match", "${column}" AS value FROM ${table} ORDER BY id`).all() as Keyword[];
	const save = () =>
		ReplaceAll(
			table,
			["match", column],
			items.map(({ match, value }) => ({ match, [column]: value })),
		);

	const remove = (match: string): boolean => {
		const index = items.findIndex((entry) => entry.match === match.toLowerCase());
		if (index === -1) return false;
		items.splice(index, 1);
		save();
		return true;
	};

	return {
		items,
		add(match, value) {
			remove(match);
			items.push({ match: match.toLowerCase(), value });
			save();
		},
		remove,
	};
}
