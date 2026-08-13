import { Database } from "bun:sqlite";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

// Every persisted store lives in this one file at the repo root (gitignored), two levels up from src/helpers/.
const file = join(import.meta.dirname, "..", "..", "data.db");

export const db = new Database(file, { create: true });

// The default journal mode is deliberate: WAL would leave -wal and -shm files beside the database, which is
// the sprawl this replaced. One process writes, so WAL buys nothing here.
db.run(`
	CREATE TABLE IF NOT EXISTS reactions (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		"match" TEXT NOT NULL UNIQUE,
		emoji TEXT NOT NULL
	);
	CREATE TABLE IF NOT EXISTS replies (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		"match" TEXT NOT NULL UNIQUE,
		text TEXT NOT NULL
	);
	CREATE TABLE IF NOT EXISTS phrase_responses (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		flags INTEGER NOT NULL,
		terms TEXT NOT NULL,
		"count" INTEGER NOT NULL,
		response TEXT NOT NULL,
		rate INTEGER
	);
	CREATE TABLE IF NOT EXISTS reminders (
		id TEXT PRIMARY KEY,
		userId TEXT NOT NULL,
		channelId TEXT NOT NULL,
		message TEXT NOT NULL,
		fireAt INTEGER NOT NULL
	);
	CREATE TABLE IF NOT EXISTS state (
		key TEXT PRIMARY KEY,
		value TEXT NOT NULL
	);
`);

/**
 * Replace a table's contents with `rows`, in order. The in-memory array each store exports stays the
 * authoritative copy and every mutation rewrites the whole table, exactly as the JSON stores rewrote the
 * whole file — so row order tracks array order and /phrase-response's 1-based indices keep their meaning.
 * These tables hold a handful of rows and only change on a slash command.
 */
export function ReplaceAll(table: string, columns: string[], rows: Record<string, unknown>[]): void {
	const names = columns.map((c) => `"${c}"`).join(", ");
	const holes = columns.map(() => "?").join(", ");
	const insert = db.query(`INSERT INTO ${table} (${names}) VALUES (${holes})`);
	db.transaction(() => {
		db.run(`DELETE FROM ${table}`);
		for (const row of rows) insert.run(...columns.map((c) => (row[c] ?? null) as string | number | null));
	})();
}

export function GetState(key: string): string | undefined {
	const row = db.query(`SELECT value FROM state WHERE key = ?`).get(key) as { value: string } | null;
	return row?.value;
}

export function SetState(key: string, value: string): void {
	db.query(`INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(
		key,
		value,
	);
}

export function ClearState(key: string): void {
	db.query(`DELETE FROM state WHERE key = ?`).run(key);
}

export const PENDING_RESTART = "pending-restart";

/**
 * One-time lift of the JSON stores this replaced, run before any store reads its table. Deleting the file is
 * what stops a second run; the empty check is the backstop for a crash between import and delete. A file
 * sitting beside a non-empty table is left alone and logged rather than merged, since which of the two is
 * current cannot be decided from here.
 */
function importLegacy<T>(name: string, isEmpty: () => boolean, insert: (parsed: T) => void): void {
	const path = join(import.meta.dirname, "..", "..", name);
	if (!existsSync(path)) return;
	if (!isEmpty()) {
		console.warn(`[db] ${name} exists but its table already has rows — leaving the file in place`);
		return;
	}
	try {
		insert(JSON.parse(readFileSync(path, "utf8")) as T);
	} catch (err) {
		console.error(`[db] could not import ${name}, leaving it in place:`, err);
		return;
	}
	unlinkSync(path);
	console.log(`[db] imported ${name}`);
}

const empty = (table: string) => (db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n === 0;

importLegacy(
	"reactions.json",
	() => empty("reactions"),
	(rows: Record<string, unknown>[]) => ReplaceAll("reactions", ["match", "emoji"], rows),
);
importLegacy(
	"replies.json",
	() => empty("replies"),
	(rows: Record<string, unknown>[]) => ReplaceAll("replies", ["match", "text"], rows),
);
importLegacy(
	"phrase-responses.json",
	() => empty("phrase_responses"),
	(rows: { terms: string[] }[]) =>
		ReplaceAll(
			"phrase_responses",
			["flags", "terms", "count", "response", "rate"],
			rows.map((rule) => ({ ...rule, terms: JSON.stringify(rule.terms) })),
		),
);
importLegacy(
	"reminders.json",
	() => empty("reminders"),
	(rows: Record<string, unknown>[]) =>
		ReplaceAll("reminders", ["id", "userId", "channelId", "message", "fireAt"], rows),
);
importLegacy(
	"pending-restart.json",
	() => GetState(PENDING_RESTART) === undefined,
	(state: unknown) => SetState(PENDING_RESTART, JSON.stringify(state)),
);
// oauth.json is not imported: RefreshToken.ts keeps the credential in its own 0600 file, out of here.
