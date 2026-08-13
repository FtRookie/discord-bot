import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { db } from "./Database.ts";
import {
	AddPhraseResponse,
	MatchPhrase,
	MentionRule,
	PhraseResponses,
	type PhraseRule,
	RemovePhraseResponse,
	ShouldTimeout,
} from "./PhraseResponses.ts";
import { MatchPreset } from "./StringMatch.ts";

// This module owns one table and loads it at import, so the run has to give back whatever was already there.
const original = [...PhraseResponses];

const clear = () => {
	PhraseResponses.length = 0;
	// AddPhraseResponse is the only exported write, so an empty table needs a write that ends empty
	AddPhraseResponse({ flags: 0, terms: ["__test_placeholder__"], count: 1, response: "x" });
	RemovePhraseResponse(1);
};

beforeAll(clear);
afterAll(() => {
	clear();
	for (const rule of original) AddPhraseResponse(rule);
});

const lastRow = () =>
	db
		.query(`SELECT kind, rate, timeout_response, timeout_reason FROM phrase_responses ORDER BY id DESC LIMIT 1`)
		.get() as Record<string, unknown>;

describe("phrase rules", () => {
	test("a mention rule never matches on text, however its terms read", () => {
		AddPhraseResponse({ kind: "mention", flags: 0, terms: [], count: 0, response: "ping" });
		// count 0 would make an empty term list match everything if the kind were not checked
		expect(MatchPhrase("literally anything")).toBeUndefined();
		expect(MatchPhrase("")).toBeUndefined();
		expect(MentionRule()?.response).toBe("ping");
	});

	test("a text rule is found by MatchPhrase and ignored by MentionRule", () => {
		clear();
		AddPhraseResponse({ flags: MatchPreset.stem, terms: ["game", "where"], count: 2, response: "link" });
		expect(MatchPhrase("wheres the game")?.response).toBe("link");
		expect(MatchPhrase("somewhere in the endgame")).toBeUndefined(); // whole-word, so neither substring fires
		expect(MentionRule()).toBeUndefined();
	});

	test("a rule with no kind is treated as text, so rules written before mentions existed still fire", () => {
		clear();
		AddPhraseResponse({ flags: MatchPreset.soft, terms: ["hello"], count: 1, response: "hi" });
		expect(PhraseResponses[0]?.kind).toBeUndefined();
		expect(MatchPhrase("well hello there")?.response).toBe("hi");
	});

	test("the first matching rule wins, so a rule added later can shadow one seeded earlier", () => {
		clear();
		AddPhraseResponse({ flags: MatchPreset.soft, terms: ["game"], count: 1, response: "first" });
		AddPhraseResponse({ flags: MatchPreset.soft, terms: ["game"], count: 1, response: "second" });
		expect(MatchPhrase("the game")?.response).toBe("first");
	});

	test("kind, rate and both timeout fields survive a write to SQLite", () => {
		clear();
		AddPhraseResponse({
			kind: "mention",
			flags: 0,
			terms: [],
			count: 0,
			response: "link",
			rate: 3,
			timeoutResponse: "Shut up, bye",
			timeoutReason: "Spamming bot pings",
		});
		expect(lastRow()).toEqual({
			kind: "mention",
			rate: 3,
			timeout_response: "Shut up, bye",
			timeout_reason: "Spamming bot pings",
		});
	});

	test("an omitted timeout message stores NULL rather than the string 'undefined'", () => {
		clear();
		AddPhraseResponse({ flags: 0, terms: ["a"], count: 1, response: "b", rate: 2 });
		expect(lastRow()).toEqual({ kind: "phrase", rate: 2, timeout_response: null, timeout_reason: null });
	});
});

describe("ShouldTimeout", () => {
	const rule = (rate?: number): PhraseRule => ({ flags: 0, terms: ["x"], count: 1, response: "y", rate });

	test("a rule without a rate never times anyone out", () => {
		const r = rule();
		expect([1, 2, 3, 4, 5].map(() => ShouldTimeout(r, "user"))).toEqual([false, false, false, false, false]);
	});

	test("a rate of 3 admits three hits a minute and trips on the fourth", () => {
		const r = rule(3);
		expect([1, 2, 3, 4].map(() => ShouldTimeout(r, "user"))).toEqual([false, false, false, true]);
	});

	test("windows are per user, so one spammer cannot time out anyone else", () => {
		const r = rule(1);
		expect(ShouldTimeout(r, "a")).toBe(false);
		expect(ShouldTimeout(r, "b")).toBe(false);
		expect(ShouldTimeout(r, "a")).toBe(true);
		expect(ShouldTimeout(r, "b")).toBe(true);
	});

	test("windows are per rule, so two rules do not share one budget", () => {
		const first = rule(1);
		const second = rule(1);
		expect(ShouldTimeout(first, "user")).toBe(false);
		expect(ShouldTimeout(second, "user")).toBe(false);
		expect(ShouldTimeout(first, "user")).toBe(true);
	});
});
