import { InteractionContextType, PermissionFlagsBits } from "discord.js";
import { config } from "../Config.ts";
import type { CommandAck } from "../helpers/AckServer.ts";
import { closeCommand, knownServers } from "../helpers/AckServer.ts";
import { createCommand, publishCommand } from "../helpers/Commands.ts";
import { paginate } from "../helpers/Paginate.ts";
import { Command } from "./Command.ts";

/** Rows per page: a shorter list stays a single button-less message, a longer one paginates. */
const SERVERS_PER_PAGE = 10;

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
		if (acks.length === 0 && silent.length === 0) {
			const content = `${liveHeading}\n_Nobody answered — either no servers are up, or the game has no \`ping\` handler yet._`;
			await interaction.editReply({ content, allowedMentions: { parse: [] } });
			return;
		}

		// `response` is game-authored free text — the ping handler puts the player count there. A missing
		// `kind` means the server predates the field, so the build itself is likely behind.
		const row = (a: CommandAck) => `${a.jobId}  ${a.kind ?? "unknown, maybe stale"}  ${a.response ?? ""}`.trimEnd();
		const pages =
			acks.length > 0
				? chunk(acks.map(row), SERVERS_PER_PAGE).map(
						(group) => `${liveHeading}\n\`\`\`\n${group.join("\n")}\n\`\`\``,
					)
				: [liveHeading];

		// Peer-attested entries come from other servers' rosters, which outlive the server by a few announce
		// intervals — a name here can be minutes-dead, so it is never folded into the live count. Shown once on
		// the final page, capped so it can't push that page past the limit.
		if (silent.length > 0) {
			const heading = `**${silent.length}** peer-attested but silent — may be stale`;
			pages[pages.length - 1] += `\n${heading}\n${block(silent, 900)}`;
		}

		await paginate(interaction, pages);
	},
});

/** Split into fixed-size groups, preserving order. */
function chunk<T>(items: T[], size: number): T[][] {
	const groups: T[][] = [];
	for (let i = 0; i < items.length; i += size) groups.push(items.slice(i, i + size));
	return groups;
}

/**
 * Render lines as a code block that fits `budget` characters, replacing the overflow with a count. Budgeting
 * against a real limit rather than a fixed row count means the section uses whatever room it has, and stays
 * valid however long a jobId turns out to be.
 */
function block(lines: string[], budget: number): string {
	const overflow = (dropped: number) => `…and ${dropped} more`;
	const kept: string[] = [];
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
