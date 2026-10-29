import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Config } from "../Config.ts";
import { GetBlockGrants, GrantBlock } from "./Grants.ts";
import { UserError } from "./Roblox.ts";

type Call = { url: string; method: string; auth: string | null; body: unknown };

const realFetch = globalThis.fetch;
let calls: Call[] = [];

/** Swap fetch for one answering `status` with `body`, recording what was asked. */
function respond(status: number, body: unknown) {
	globalThis.fetch = (async (url: string, init: RequestInit) => {
		calls.push({
			url,
			method: init.method ?? "GET",
			auth: new Headers(init.headers).get("authorization"),
			body: init.body ? JSON.parse(init.body as string) : undefined,
		});
		return new Response(JSON.stringify(body), { status });
	}) as typeof fetch;
}

describe("grants go straight to the database", () => {
	beforeEach(() => {
		calls = [];
		process.env.BACKEND_TOKEN = "tok";
	});
	afterEach(() => {
		globalThis.fetch = realFetch;
	});

	test("a grant is a PUT of the limit, authorised with BACKEND_TOKEN", async () => {
		respond(200, { playerID: "1", blocks: { luacircuit: 1 } });
		expect(await GrantBlock(1, "luacircuit", 1)).toEqual({ luacircuit: 1 });
		expect(calls).toEqual([
			{
				url: `${Config.backend.baseUrl}/bot/player/1/blocks/luacircuit`,
				method: "PUT",
				auth: "Bearer tok",
				body: { limit: 1 },
			},
		]);
	});

	test("no limit is a DELETE, so a revoked block leaves no key", async () => {
		respond(200, { playerID: "1", blocks: {} });
		expect(await GrantBlock(1, "luacircuit")).toEqual({});
		expect(calls[0]?.method).toBe("DELETE");
		expect(calls[0]?.body).toBeUndefined();
	});

	test("listing reads the player's grants", async () => {
		respond(200, { playerID: "7", blocks: { motorblock: 50 } });
		expect(await GetBlockGrants(7)).toEqual({ motorblock: 50 });
		expect(calls[0]?.url).toBe(`${Config.backend.baseUrl}/bot/player/7/blocks`);
	});

	test("every failure reaches the moderator as a UserError", async () => {
		for (const [status, body, says] of [
			[401, { error: "Incorrect token" }, "BACKEND_TOKEN"],
			[404, "NOT_FOUND", "no bot API"],
			[422, {}, "malformed"],
			[500, { error: "Stored data for player 1 is not valid JSON" }, "not valid JSON"],
			[200, { error: "Using placeholder token" }, "placeholder"],
		] as const) {
			respond(status, body);
			const err = await GrantBlock(1, "luacircuit", 1).catch((e: unknown) => e);
			expect(err).toBeInstanceOf(UserError);
			expect((err as Error).message).toContain(says);
		}
	});

	test("an unreachable database is a UserError too", async () => {
		globalThis.fetch = (async () => {
			throw new Error("Unable to connect");
		}) as unknown as typeof fetch;
		const err = await GetBlockGrants(1).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(UserError);
		expect((err as Error).message).toContain("Could not reach the database");
	});
});
