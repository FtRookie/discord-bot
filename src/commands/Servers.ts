import { InteractionContextType, PermissionFlagsBits } from "discord.js";
import { config } from "../Config.ts";
import type { CommandAck } from "../helpers/AckServer.ts";
import { closeCommand, knownServers } from "../helpers/AckServer.ts";
import { createCommand, publishCommand } from "../helpers/Commands.ts";
import { Command } from "./Command.ts";

export const servers = new Command({
	name: "servers",
	description: "Probe the live game servers and list the ones that answer",
	userPermissions: PermissionFlagsBits.ManageGuild,
	contexts: InteractionContextType.Guild,
	ephemeral: true,
	async execute(interaction) {
		// Liveness cannot be queried — there is no unicast, and SERVERS cannot be subscribed to from outside
		// Roblox — so it is broadcast-and-collect. A fresh id every time makes the answers current by
		// construction, unlike the roster they carry.
		const command = createCommand("ping");
		try {
			await publishCommand(command);
			await new Promise((resolve) => setTimeout(resolve, config.probe.windowMs));
		} catch (err) {
			closeCommand(command.id); // a failed publish must not leak the pending entry
			throw err;
		}

		const acks = closeCommand(command.id);
		const answered = new Set(acks.map((ack) => ack.jobId));
		const silent = [...knownServers(acks)].filter((jobId) => !answered.has(jobId));

		const liveHeading = `**${acks.length} live** — answered within ${config.probe.windowMs / 1000}s`;
		const parts = [liveHeading];
		let budget = MESSAGE_LIMIT - liveHeading.length - 1;

		if (acks.length > 0) {
			// `response` is game-authored free text — the ping handler puts the player count there. A missing
			// `kind` means the server predates the field, so the build itself is likely behind.
			const row = (a: CommandAck) =>
				`${a.jobId}  ${a.kind ?? "unknown, maybe stale"}  ${a.response ?? ""}`.trimEnd();
			const rendered = block(acks.map(row), budget);
			parts.push(rendered);
			budget -= rendered.length + 1;
		}
		// Peer-attested entries come from other servers' rosters, which expire only after three announce
		// intervals — one can name a server that died minutes ago, so it is never folded into the live count.
		if (silent.length > 0) {
			const silentHeading = `**${silent.length}** peer-attested but silent — may be stale`;
			// Dropped whole rather than shown empty when the live list has already eaten the budget.
			if (budget > silentHeading.length + 60) {
				parts.push(silentHeading, block(silent, budget - silentHeading.length - 1));
			}
		}
		if (acks.length === 0 && silent.length === 0) {
			parts.push("_Nobody answered — either no servers are up, or the game has no `ping` handler yet._");
		}

		await interaction.editReply({ content: parts.join("\n"), allowedMentions: { parse: [] } });
	},
});

/** Discord rejects message content longer than this. */
const MESSAGE_LIMIT = 2000;

/**
 * Render lines as a code block that fits `budget` characters, replacing the overflow with a count. Budgeting
 * against the real limit rather than a fixed row count means the reply uses whatever room it actually has,
 * and stays valid however long a jobId, kind or response turns out to be.
 */
function block(lines: string[], budget: number): string {
	const overflow = (dropped: number) => `…and ${dropped} more`;
	const kept: string[] = [];
	// Reserve the fences and a worst-case overflow note up front, so appending it can never bust the budget.
	let used = "```\n\n```".length + overflow(lines.length).length;

	for (const line of lines) {
		if (used + line.length + 1 > budget) break;
		kept.push(line);
		used += line.length + 1;
	}

	const dropped = lines.length - kept.length;
	if (dropped > 0) kept.push(overflow(dropped));
	return `\`\`\`\n${kept.join("\n")}\n\`\`\``;
}
