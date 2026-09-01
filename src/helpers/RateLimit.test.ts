import { describe, expect, setSystemTime, test } from "bun:test";
import { RateWindow } from "./RateLimit.ts";

describe("RateWindow", () => {
	test("counts only what it has recorded", () => {
		const window = new RateWindow(60_000);
		expect(window.peek("a").count).toBe(0);
		expect(window.hit("a").count).toBe(1);
		expect(window.hit("a").count).toBe(2);
		expect(window.peek("a").count).toBe(2);
	});

	test("keys are independent, which is what splits /render's public and private allowances", () => {
		const window = new RateWindow(60_000);
		window.hit("user:visible");
		window.hit("user:visible");
		expect(window.peek("user:visible").count).toBe(2);
		expect(window.peek("user:ephemeral").count).toBe(0);
	});

	test("peek does not record, so a rejected request cannot extend the window that rejected it", () => {
		const window = new RateWindow(60_000);
		window.hit("a");
		for (let i = 0; i < 5; i++) window.peek("a");
		expect(window.peek("a").count).toBe(1);
	});

	test("clear forgets the key", () => {
		const window = new RateWindow(60_000);
		window.hit("a");
		window.hit("a");
		window.clear("a");
		expect(window.peek("a").count).toBe(0);
	});

	test("hits leave the window once it has passed", () => {
		try {
			setSystemTime(new Date("2026-01-01T00:00:00Z"));
			const window = new RateWindow(60_000);
			window.hit("a");
			window.hit("a");
			expect(window.peek("a").count).toBe(2);

			setSystemTime(new Date("2026-01-01T00:00:59Z"));
			expect(window.peek("a").count).toBe(2); // still inside

			setSystemTime(new Date("2026-01-01T00:01:01Z"));
			expect(window.peek("a").count).toBe(0); // both aged out
		} finally {
			setSystemTime();
		}
	});

	test("retryAfterMs counts down to the oldest hit expiring", () => {
		try {
			setSystemTime(new Date("2026-01-01T00:00:00Z"));
			const window = new RateWindow(60_000);
			window.hit("a");
			expect(window.peek("a").retryAfterMs).toBe(60_000);

			setSystemTime(new Date("2026-01-01T00:00:45Z"));
			expect(window.peek("a").retryAfterMs).toBe(15_000);

			setSystemTime(new Date("2026-01-01T00:02:00Z"));
			expect(window.peek("a").retryAfterMs).toBe(0); // nothing left to wait for
		} finally {
			setSystemTime();
		}
	});

	// The four callers all allow exactly `max` per window; they just disagreed about whether to compare
	// before or after recording. This pins the shared arithmetic to the behaviour they had.
	test("the peek-then-hit pattern admits exactly max per window", () => {
		const window = new RateWindow(60_000);
		const max = 3;
		const attempt = () => {
			if (window.peek("a").count >= max) return false;
			window.hit("a");
			return true;
		};
		expect([attempt(), attempt(), attempt(), attempt(), attempt()]).toEqual([true, true, true, false, false]);
	});

	test("the hit-then-compare pattern admits exactly rate per window", () => {
		const window = new RateWindow(60_000);
		const rate = 3;
		const attempt = () => window.hit("a").count > rate;
		expect([attempt(), attempt(), attempt(), attempt()]).toEqual([false, false, false, true]);
	});
});
