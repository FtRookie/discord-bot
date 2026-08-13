import { afterAll, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import { PhraseResponse } from "../command/commands/PhraseResponse.ts";
import { db } from "./Database.ts";
import {
	AddPhraseResponse,
	MatchPhrase,
	MentionRule,
	OnCooldown,
	PhraseResponses,
	type PhraseRule,
	RemovePhraseResponse,
	RowToRule,
	ShouldTimeout,
	StartCooldown,
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

describe("the timeout switch", () => {
	test("absent means punish, so a rule written before the switch existed is unchanged", () => {
		clear();
		AddPhraseResponse({ flags: 0, terms: ["a"], count: 1, response: "b", rate: 1 });
		expect(PhraseResponses[0]?.timeout).toBeUndefined();
		expect(db.query(`SELECT timeout FROM phrase_responses ORDER BY id DESC LIMIT 1`).get()).toEqual({
			timeout: null,
		});
	});

	test("false is written as 0 and true as 1", () => {
		clear();
		AddPhraseResponse({ flags: 0, terms: ["a"], count: 1, response: "b", rate: 1, timeout: false });
		expect(db.query(`SELECT timeout FROM phrase_responses ORDER BY id DESC LIMIT 1`).get()).toEqual({ timeout: 0 });
		clear();
		AddPhraseResponse({ flags: 0, terms: ["a"], count: 1, response: "b", rate: 1, timeout: true });
		expect(db.query(`SELECT timeout FROM phrase_responses ORDER BY id DESC LIMIT 1`).get()).toEqual({ timeout: 1 });
	});
});

/**
 * Reading is tested against RowToRule directly, because AddPhraseResponse stores the object it is handed —
 * so asserting on PhraseResponses after a write proves nothing about what a restart would load. That gap is
 * how `timeout: false` came back as true: the column was missing from the SELECT, arrived undefined, and the
 * null guard read it as set.
 */
describe("RowToRule", () => {
	const row = (over: Partial<Parameters<typeof RowToRule>[0]> = {}) =>
		RowToRule({
			kind: "phrase",
			flags: 0,
			terms: '["a"]',
			count: 1,
			response: "b",
			rate: null,
			cooldown_ms: null,
			timeout: null,
			timeout_response: null,
			timeout_reason: null,
			...over,
		});

	test("0 becomes false, not a truthy number", () => {
		expect(row({ timeout: 0 }).timeout).toBe(false);
	});

	test("1 becomes true", () => {
		expect(row({ timeout: 1 }).timeout).toBe(true);
	});

	test("null stays absent, so the rule falls back to punishing", () => {
		expect("timeout" in row()).toBe(false);
	});

	test("a column missing from the SELECT stays absent rather than reading as set", () => {
		// what undefined looked like before SELECT was derived from COLUMNS
		expect("timeout" in row({ timeout: undefined as unknown as null })).toBe(false);
	});

	test("every optional field survives the mapping", () => {
		expect(
			row({ rate: 3, cooldown_ms: 3_600_000, timeout: 0, timeout_response: "bye", timeout_reason: "spam" }),
		).toEqual({
			kind: "phrase",
			flags: 0,
			terms: ["a"],
			count: 1,
			response: "b",
			rate: 3,
			cooldownMs: 3_600_000,
			timeout: false,
			timeoutResponse: "bye",
			timeoutReason: "spam",
		});
	});
});

/**
 * The only handler test in the suite, because this validation lives in the command rather than the store and
 * would otherwise ship uncovered. The interaction is stubbed down to the four accessors /phrase-response add
 * actually reads.
 */
describe("/phrase-response add validation", () => {
	const add = async (options: Record<string, string | number | boolean>) => {
		const get = (name: string) => (name in options ? options[name] : null);
		const interaction = {
			options: {
				getSubcommand: () => "add",
				getString: (name: string) => get(name) as string | null,
				getInteger: (name: string) => get(name) as number | null,
				getBoolean: (name: string) => get(name) as boolean | null,
			},
			reply: async () => {},
		};
		await PhraseResponse.execute(interaction as never);
	};

	const base = { mode: "soft", terms: "x", response: "y" };

	test("timeout: false needs no rate — it only restates what no rate already means", async () => {
		clear();
		await add({ ...base, timeout: false });
		expect(PhraseResponses[0]?.timeout).toBe(false);
	});

	test("timeout: true without a rate is rejected, since nothing would trigger it", async () => {
		clear();
		await expect(add({ ...base, timeout: true })).rejects.toThrow("need a `rate`");
	});

	test("timeout_response without a rate is rejected", async () => {
		clear();
		await expect(add({ ...base, timeout_response: "bye" })).rejects.toThrow("need a `rate`");
	});

	test("both are accepted alongside a rate", async () => {
		clear();
		await add({ ...base, rate: 2, timeout: true, timeout_response: "bye" });
		expect(PhraseResponses[0]).toMatchObject({ rate: 2, timeout: true, timeoutResponse: "bye" });
	});
});

describe("cooldowns", () => {
	const rule = (cooldownMs?: number): PhraseRule => ({ flags: 0, terms: ["x"], count: 1, response: "y", cooldownMs });

	test("a rule with no cooldown is never quiet", () => {
		const r = rule();
		expect(OnCooldown(r, "user")).toBe(false);
		StartCooldown(r, "user");
		expect(OnCooldown(r, "user")).toBe(false);
	});

	test("OnCooldown is a query — checking alone never starts the clock", () => {
		const r = rule(3_600_000);
		expect([1, 2, 3].map(() => OnCooldown(r, "user"))).toEqual([false, false, false]);
	});

	test("answering starts it, and it holds for the full hour", () => {
		try {
			setSystemTime(new Date("2026-01-01T00:00:00Z"));
			const r = rule(3_600_000);
			expect(OnCooldown(r, "user")).toBe(false);
			StartCooldown(r, "user");

			expect(OnCooldown(r, "user")).toBe(true);
			setSystemTime(new Date("2026-01-01T00:59:00Z"));
			expect(OnCooldown(r, "user")).toBe(true);
			setSystemTime(new Date("2026-01-01T01:00:01Z"));
			expect(OnCooldown(r, "user")).toBe(false);
		} finally {
			setSystemTime();
		}
	});

	// the reason StartCooldown is not called on the suppressed path
	test("asking again mid-cooldown does not push the next answer further away", () => {
		try {
			setSystemTime(new Date("2026-01-01T00:00:00Z"));
			const r = rule(3_600_000);
			StartCooldown(r, "user");

			setSystemTime(new Date("2026-01-01T00:30:00Z"));
			expect(OnCooldown(r, "user")).toBe(true); // asks again, gets nothing, clock untouched

			setSystemTime(new Date("2026-01-01T01:00:01Z"));
			expect(OnCooldown(r, "user")).toBe(false); // still an hour from the answer, not from the retry
		} finally {
			setSystemTime();
		}
	});

	test("cooldowns are per user, so one person asking does not mute the bot for everyone", () => {
		const r = rule(3_600_000);
		StartCooldown(r, "a");
		expect(OnCooldown(r, "a")).toBe(true);
		expect(OnCooldown(r, "b")).toBe(false);
	});

	test("cooldownMs survives a write to SQLite", () => {
		clear();
		AddPhraseResponse({ flags: 0, terms: ["a"], count: 1, response: "b", cooldownMs: 3_600_000 });
		expect(PhraseResponses[0]?.cooldownMs).toBe(3_600_000);
		expect(db.query(`SELECT cooldown_ms FROM phrase_responses ORDER BY id DESC LIMIT 1`).get()).toEqual({
			cooldown_ms: 3_600_000,
		});
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
