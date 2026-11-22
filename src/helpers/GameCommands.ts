import { randomUUID } from "node:crypto";
import { Config } from "../Config.ts";
import type { AckListener, CommandAck } from "./AckServer.ts";
import { CloseCommand, CollectAcks, OpenCommand } from "./AckServer.ts";
import { KafkaEnabled, type KafkaEnvelope, KafkaPublish } from "./Kafka.ts";
import { PublishMessage } from "./Roblox.ts";

export const COMMAND_TOPIC = "COMMAND";

export type CommandEnvelope = {
	id: string;
	name: string;
	issuedAt: number; // bot-stamped, so servers only ever compare a watermark against this clock
	args?: Record<string, unknown>;
	targetJobId?: string; // only this server acts, every other answers Nothing; omitted = broadcast
};

// Recent commands, oldest first — what the game's catch-up poll reads, so a command whose push failed still
// gets delivered, late. A buffer, not a history: trimmed by age.
const log: CommandEnvelope[] = [];
const LOG_TTL_MS = 10 * 60 * 1000;

const trim = () => {
	const cutoff = Date.now() - LOG_TTL_MS;
	while (log.length > 0 && (log[0]?.issuedAt ?? 0) < cutoff) log.shift();
};

export function CommandsSince(since: number): CommandEnvelope[] {
	trim();
	return log.filter((command) => command.issuedAt > since);
}

export function GetCommand(id: string): CommandEnvelope | undefined {
	return log.find((command) => command.id === id);
}

/**
 * Separate from publishing so a retry re-pushes the SAME id: minting per attempt would have servers treat
 * each retry as a distinct command, warning players twice.
 */
export function CreateCommand(name: string, args?: Record<string, unknown>, targetJobId?: string): CommandEnvelope {
	// JSON.stringify drops `targetJobId: undefined`, so an untargeted command carries no such field
	const command: CommandEnvelope = { id: randomUUID(), name, issuedAt: Date.now(), args, targetJobId };

	OpenCommand(command.id);
	log.push(command);
	trim();

	return command;
}

/** The same command as a `bot.command` message: the id is the eventId, issuedAt the record timestamp. */
export function ToKafkaCommand(command: CommandEnvelope): KafkaEnvelope {
	return {
		eventId: command.id,
		topic: "bot.command",
		at: command.issuedAt,
		data: { name: command.name, args: command.args, targetJobId: command.targetJobId },
	};
}

/**
 * Kafka is where servers poll for commands; the MessagingService push is the fallback for a server that cannot
 * reach it. Published means at least one path took it, so only both failing throws — with the push's error,
 * which is the one worded for a Discord reply.
 */
export async function PublishCommand(command: CommandEnvelope): Promise<void> {
	if (!KafkaEnabled()) return PublishMessage(COMMAND_TOPIC, command);

	const [push, kafka] = await Promise.allSettled([
		PublishMessage(COMMAND_TOPIC, command),
		KafkaPublish([ToKafkaCommand(command)]),
	]);
	if (kafka.status === "rejected") console.error(`[kafka] command ${command.id} not published:`, kafka.reason);
	if (push.status === "rejected") {
		if (kafka.status === "rejected") throw push.reason;
		console.error(`[game] command ${command.id} push failed, delivered through Kafka only:`, push.reason);
	}
}

/**
 * Publish, hold for the acknowledgement window, and hand back what answered. The pending entry is closed on
 * both paths — a failed publish would otherwise leave one behind that nothing ever collects. `onUpdate` runs
 * as answers arrive, for a caller that would rather show partial results than a spinner.
 */
export async function PublishAndCollect(command: CommandEnvelope, onUpdate?: AckListener): Promise<CommandAck[]> {
	try {
		await PublishCommand(command);
		await CollectAcks(command.id, Config.probe.windowMs, onUpdate);
	} catch (err) {
		CloseCommand(command.id);
		throw err;
	}
	return CloseCommand(command.id);
}
