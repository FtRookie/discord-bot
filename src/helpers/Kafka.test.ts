import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Config } from "../Config.ts";
import { AckFromKafka } from "./AckServer.ts";
import { CreateCommand, PublishCommand, ToKafkaCommand } from "./GameCommands.ts";

const realFetch = globalThis.fetch;
let urls: string[] = [];
let kafkaBodies: unknown[] = [];

/** Swap fetch for one where Open Cloud answers `push` and the Kafka client answers `kafka`. */
function respond(push: number, kafka: { status: number; body: unknown }) {
	globalThis.fetch = (async (url: string, init: RequestInit) => {
		urls.push(url);
		if (!url.startsWith(Config.kafka.baseUrl)) return new Response("{}", { status: push });

		kafkaBodies.push(JSON.parse(init.body as string));
		return new Response(JSON.stringify(kafka.body), { status: kafka.status });
	}) as typeof fetch;
}

const accepted = { status: 200, body: { status: "ok", accepted: 1, duplicates: 0, rejected: [] } };

describe("commands go to Kafka as well as MessagingService", () => {
	beforeEach(() => {
		urls = [];
		kafkaBodies = [];
		process.env.ROBLOX_API_KEY = "key";
		process.env.KAFKA_TOKEN = "tok";
	});
	afterEach(() => {
		globalThis.fetch = realFetch;
		delete process.env.KAFKA_TOKEN;
	});

	test("a command becomes a bot.command message: id is the eventId, issuedAt the timestamp", () => {
		const command = CreateCommand("kick", { userId: 1 }, "job");
		expect(ToKafkaCommand(command)).toEqual({
			eventId: command.id,
			topic: "bot.command",
			at: command.issuedAt,
			data: { name: "kick", args: { userId: 1 }, targetJobId: "job" },
		});
	});

	test("without KAFKA_TOKEN only the push is sent", async () => {
		delete process.env.KAFKA_TOKEN;
		respond(200, accepted);
		await PublishCommand(CreateCommand("ping"));
		expect(urls.some((url) => url.startsWith(Config.kafka.baseUrl))).toBe(false);
		expect(urls).toHaveLength(1);
	});

	test("with KAFKA_TOKEN both paths are sent", async () => {
		respond(200, accepted);
		const command = CreateCommand("ping");
		await PublishCommand(command);
		expect(urls).toContain(`${Config.kafka.baseUrl}/messages`);
		expect(kafkaBodies).toEqual([{ messages: [JSON.parse(JSON.stringify(ToKafkaCommand(command)))] }]);
	});

	test("one path taking it is enough", async () => {
		respond(500, accepted);
		await PublishCommand(CreateCommand("ping"));

		respond(200, { status: 503, body: { error: "down", err_type: "KAFKA_UNAVAILABLE" } });
		await PublishCommand(CreateCommand("ping"));
	});

	test("both failing throws, and a rejected message counts as a failure", async () => {
		respond(500, {
			status: 200,
			body: { status: "ok", accepted: 0, duplicates: 0, rejected: [{ eventId: "x", error: "no" }] },
		});
		expect(PublishCommand(CreateCommand("ping"))).rejects.toBeDefined();
	});
});

describe("acknowledgements read from Kafka", () => {
	test("the jobId comes from the envelope, the rest from the data", () => {
		const data = {
			commandId: "cmd",
			outcome: "Success",
			response: "Kicked Foo",
			kind: "public",
			roster: ["a", "b"],
		};
		expect(
			AckFromKafka({
				eventId: "e",
				topic: "game.command_execution",
				at: 0,
				server: { jobId: "a", placeVersion: 1 },
				data,
			}),
		).toEqual({
			commandId: "cmd",
			ack: { jobId: "a", outcome: "Success", response: "Kicked Foo", kind: "public", roster: ["a", "b"] },
		});
	});

	test("an envelope without a server is not an acknowledgement", () => {
		expect(AckFromKafka({ eventId: "e", topic: "game.command_execution", at: 0, data: {} })).toBeUndefined();
	});
});
