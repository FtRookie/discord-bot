import { InteractionContextType } from "discord.js";
import { Config } from "../Config.ts";
import type { CommandAck } from "../helpers/AckServer.ts";
import { CloseCommand, KnownServers } from "../helpers/AckServer.ts";
import { CreateCommand, PublishCommand } from "../helpers/Commands.ts";
import { Paginate } from "../helpers/Paginate.ts";
import { Perms } from "../helpers/Permissions.ts";
import { Command } from "./Command.ts";

const SERVERS_PER_PAGE = 10; // a shorter list stays one button-less message, a longer one paginates

export const Servers = new Command({
	name: "servers",
	description: "Probe the live game servers and list the ones that answer",
	permissions: Perms.Inspect,
	contexts: InteractionContextType.Guild,
	ephemeral: true,
	async execute(interaction) {
		// no unicast, and SERVERS can't be subscribed to from outside Roblox, so liveness is broadcast-and-
		// collect. A fresh id each time makes the answers current by construction, unlike the roster they carry.
		const command = CreateCommand("ping");
		try {
			await PublishCommand(command);
			await new Promise((resolve) => setTimeout(resolve, Config.probe.windowMs));
		} catch (err) {
			CloseCommand(command.id); // a failed publish would otherwise leave the pending entry behind
			throw err;
		}

		const acks = CloseCommand(command.id);
		const answered = new Set(acks.map((ack) => ack.jobId));
		const silent = [...KnownServers(acks)].filter((jobId) => !answered.has(jobId));

		const liveHeading = `**${acks.length} live** — answered within ${Config.probe.windowMs / 1000}s`;
		if (acks.length === 0 && silent.length === 0) {
			const content = `${liveHeading}\n_Nobody answered — either no servers are up, or the game has no \`ping\` handler yet._`;
			await interaction.editReply({ content, allowedMentions: { parse: [] } });
			return;
		}

		// `response` is game-authored free text; the ping handler puts the player count there. A missing
		// `kind` means the server predates the field, so its build is likely behind too.
		const row = (a: CommandAck) => `${a.jobId}  ${a.kind ?? "unknown, maybe stale"}  ${a.response ?? ""}`.trimEnd();
		const pages =
			acks.length > 0
				? chunk(acks.map(row), SERVERS_PER_PAGE).map(
						(group) => `${liveHeading}\n\`\`\`\n${group.join("\n")}\n\`\`\``,
					)
				: [liveHeading];

		// peer-attested entries come from rosters that outlive a server by a few announce intervals, so a name
		// here can be minutes-dead and is never folded into the live count
		if (silent.length > 0) {
			const heading = `**${silent.length}** peer-attested but silent — may be stale`;
			pages[pages.length - 1] += `\n${heading}\n${block(silent, 900)}`;
		}

		await Paginate(interaction, pages);
	},
});

function chunk<T>(items: T[], size: number): T[][] {
	const groups: T[][] = [];
	for (let i = 0; i < items.length; i += size) groups.push(items.slice(i, i + size));
	return groups;
}

/**
 * Lines as a code block fitting `budget` characters, with the overflow replaced by a count. Budgeting against
 * a character limit rather than a fixed row count holds however long a jobId turns out to be.
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
