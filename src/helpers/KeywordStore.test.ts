import { afterAll, describe, expect, test } from "bun:test";
import { db } from "./Database.ts";
import { KeywordStore } from "./KeywordStore.ts";

// A table of its own, so the reactions and replies the bot is actually using are never touched.
const TABLE = "keyword_store_test";
db.run(`
	CREATE TABLE IF NOT EXISTS ${TABLE} (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		"match" TEXT NOT NULL UNIQUE,
		val TEXT NOT NULL
	)
`);
db.run(`DELETE FROM ${TABLE}`);

afterAll(() => db.run(`DROP TABLE IF EXISTS ${TABLE}`));

const store = KeywordStore(TABLE, "val");
const rows = () => db.query(`SELECT "match", val FROM ${TABLE} ORDER BY id`).all() as { match: string; val: string }[];

describe("KeywordStore", () => {
	test("add writes through to SQLite and lowercases the match", () => {
		store.add("Hello", "👋");
		expect(store.items).toEqual([{ match: "hello", value: "👋" }]);
		expect(rows()).toEqual([{ match: "hello", val: "👋" }]);
	});

	test("re-adding replaces the value and moves the entry to the end of the scan order", () => {
		store.add("second", "2");
		store.add("hello", "🌊");
		expect(store.items.map((k) => k.match)).toEqual(["second", "hello"]);
		expect(store.items.at(-1)?.value).toBe("🌊");
		expect(rows().map((r) => r.match)).toEqual(["second", "hello"]);
	});

	test("remove reports whether it matched, and persists", () => {
		expect(store.remove("nothing-here")).toBe(false);
		expect(store.remove("SECOND")).toBe(true); // case-insensitive, like add
		expect(store.items.map((k) => k.match)).toEqual(["hello"]);
		expect(rows().map((r) => r.match)).toEqual(["hello"]);
	});

	// index.ts holds this array across every message, so replacing it rather than mutating it would leave the
	// message handler scanning a stale copy for the lifetime of the process.
	test("items is mutated in place, never reassigned", () => {
		const held = store.items;
		store.add("another", "x");
		store.remove("hello");
		expect(store.items).toBe(held);
		expect(held.map((k) => k.match)).toEqual(["another"]);
	});

	test("a second store over the same table reads back what the first wrote", () => {
		expect(KeywordStore(TABLE, "val").items).toEqual(store.items);
	});
});
