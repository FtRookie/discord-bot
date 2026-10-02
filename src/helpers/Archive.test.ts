import { describe, expect, test } from "bun:test";
import { Forget, Missing, Remember, Revise, type Snapshot, WINDOW, Window } from "./Archive.ts";

let next = 1000n;
const snap = (channelId: string, content = "hi"): Snapshot => ({
	id: (next++).toString(),
	channelId,
	authorId: "u",
	authorTag: "u",
	content,
	attachments: [],
	createdTimestamp: 0,
});

describe("archive window", () => {
	test("keeps only the newest WINDOW messages per channel", () => {
		const all = Array.from({ length: WINDOW + 5 }, () => snap("a"));
		for (const s of all) Remember(s);
		Remember(snap("b"));
		expect(Window("a").map((s) => s.id)).toEqual(all.slice(5).map((s) => s.id));
		expect(Window("b")).toHaveLength(1);
	});

	test("revise and forget", () => {
		const s = snap("c", "before");
		Remember(s);
		Revise({ ...s, content: "after" });
		expect(Forget("c", s.id)?.content).toBe("after");
		expect(Forget("c", s.id)).toBeUndefined();
	});

	test("missing is what a fetch didn't return, up to the newest it could have covered", () => {
		const [a, b, c, d] = [snap("d"), snap("d"), snap("d"), snap("d")];
		for (const s of [a, b, c, d]) Remember(s);
		expect(Missing("d", new Set([a.id, c.id, d.id])).map((s) => s.id)).toEqual([b.id]);
		// a full page that ended at c says nothing about d
		expect(Missing("d", new Set([a.id, c.id]), c.id).map((s) => s.id)).toEqual([b.id]);
	});

	test("snowflakes compare numerically across lengths", () => {
		const short = { ...snap("e"), id: "999" };
		const long = { ...snap("e"), id: "1000" };
		Remember(short);
		Remember(long);
		expect(Missing("e", new Set(), "999").map((s) => s.id)).toEqual(["999"]);
	});
});
