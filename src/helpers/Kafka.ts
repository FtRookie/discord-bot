import { Config } from "../Config.ts";

/**
 * Bot ↔ the Kafka client (oe-bun-kafka-client), the only process that talks to Kafka; same box, over loopback.
 * Optional: without KAFKA_TOKEN every call here is a no-op and the bot runs on MessagingService and /ack alone.
 * The token must equal the client's `Access Tokens/BOT_TOKEN`.
 */
const token = (): string | undefined => process.env.KAFKA_TOKEN || undefined;

export type KafkaEnvelope<T = unknown> = {
	eventId: string; // unique per message; the client drops a resent duplicate
	topic: string;
	at: number; // unix ms when it happened at the source, and the Kafka record timestamp
	server?: { jobId: string; placeVersion: number }; // set on everything a game server sends
	data: T; // already checked by the client against the topic's schema
};

export const KafkaEnabled = (): boolean => token() !== undefined;

const headers = (key: string) => ({ Authorization: `Bearer ${key}`, "Content-Type": "application/json" });

/** Throws unless the client accepted every message, so a caller can tell "published" from "not". */
export async function KafkaPublish(messages: KafkaEnvelope[]): Promise<void> {
	const key = token();
	if (!key) return;

	const res = await fetch(`${Config.kafka.baseUrl}/messages`, {
		method: "POST",
		headers: headers(key),
		body: JSON.stringify({ messages }),
		signal: AbortSignal.timeout(Config.kafka.timeoutMs),
	});
	const body = (await res.json().catch(() => undefined)) as
		| { error?: string; rejected?: { eventId: string; error: string }[] }
		| undefined;
	if (!res.ok) throw new Error(`Kafka client responded ${res.status}${body?.error ? `: ${body.error}` : ""}`);
	const rejected = body?.rejected?.[0];
	if (rejected) throw new Error(`Kafka client rejected ${rejected.eventId}: ${rejected.error}`);
}

async function readSince(key: string, topic: string, since: number): Promise<KafkaEnvelope[]> {
	const res = await fetch(`${Config.kafka.baseUrl}/messages/${topic}?since=${since}`, {
		headers: headers(key),
		signal: AbortSignal.timeout(Config.kafka.timeoutMs),
	});
	if (!res.ok) throw new Error(`Kafka client responded ${res.status}`);
	return ((await res.json()) as { messages: KafkaEnvelope[] }).messages;
}

/**
 * Every new message on `topics`, live over WebSocket; reconnects on its own. A reconnect first reads back what
 * arrived while it was down, from shortly before the drop, so `onMessage` must tolerate seeing one twice.
 */
export function KafkaSubscribe(topics: string[], onMessage: (envelope: KafkaEnvelope) => void): void {
	const key = token();
	if (!key) {
		console.log("[kafka] KAFKA_TOKEN not set, not subscribing");
		return;
	}

	let droppedAt: number | undefined;
	const connect = () => {
		const ws = new WebSocket(`${Config.kafka.baseUrl.replace(/^http/, "ws")}/ws`, {
			headers: { Authorization: `Bearer ${key}` },
		});
		ws.addEventListener("open", () => {
			ws.send(JSON.stringify({ subscribe: topics }));
			if (droppedAt === undefined) return;

			// at is stamped at the source and batches arrive late, so the read-back starts a margin before the drop
			const since = droppedAt - Config.kafka.catchUpMarginMs;
			droppedAt = undefined;
			for (const topic of topics) {
				readSince(key, topic, since)
					.then((missed) => {
						for (const envelope of missed) onMessage(envelope);
					})
					.catch((err) => console.error(`[kafka] read-back of ${topic} failed:`, err));
			}
		});
		ws.addEventListener("message", (event) => {
			const message = JSON.parse(String(event.data)) as KafkaEnvelope | { denied?: string[] };
			if ("eventId" in message) onMessage(message);
			else if (message.denied?.length) console.error(`[kafka] not allowed to read: ${message.denied.join(", ")}`);
		});
		ws.addEventListener("close", () => {
			droppedAt ??= Date.now();
			setTimeout(connect, Config.kafka.reconnectMs);
		});
	};
	connect();
}
