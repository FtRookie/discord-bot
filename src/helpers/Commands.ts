import { randomUUID } from "node:crypto";
import { openCommand } from "./AckServer.ts";
import { publishMessage } from "./Roblox.ts";

export const COMMAND_TOPIC = "COMMAND";

export type CommandEnvelope = {
	id: string;
	name: string;
	/** Bot-stamped so servers compare a watermark against our clock only, never each other's. */
	issuedAt: number;
	args?: Record<string, unknown>;
};

/**
 * Recent commands, oldest first. This is what the game's catch-up poll reads, so a command whose push failed
 * is still delivered — late, but delivered. A buffer, not a history: trimmed by age.
 */
const log: CommandEnvelope[] = [];
const LOG_TTL_MS = 10 * 60 * 1000;

const trim = () => {
	const cutoff = Date.now() - LOG_TTL_MS;
	while (log.length > 0 && (log[0]?.issuedAt ?? 0) < cutoff) log.shift();
};

export function commandsSince(since: number): CommandEnvelope[] {
	trim();
	return log.filter((command) => command.issuedAt > since);
}

export function getCommand(id: string): CommandEnvelope | undefined {
	return log.find((command) => command.id === id);
}

/**
 * Mint a command and make it pollable. Separate from publishing so a retry re-pushes the SAME id — minting
 * per attempt would leave servers treating each retry as a distinct command and warning players twice.
 */
export function createCommand(name: string, args?: Record<string, unknown>): CommandEnvelope {
	const command: CommandEnvelope = { id: randomUUID(), name, issuedAt: Date.now(), args };

	openCommand(command.id);
	log.push(command);
	trim();

	return command;
}

export function publishCommand(command: CommandEnvelope): Promise<void> {
	return publishMessage(COMMAND_TOPIC, command);
}
