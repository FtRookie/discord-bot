import { InteractionContextType, PermissionFlagsBits } from "discord.js";
import { config } from "../Config.ts";
import type { CommandAck, TargetedVerdict } from "../helpers/AckServer.ts";
import { closeCommand, targetedVerdict } from "../helpers/AckServer.ts";
import { createCommand, publishCommand } from "../helpers/Commands.ts";
import { paginate } from "../helpers/Paginate.ts";
import { Command } from "./Command.ts";

/** Room for the heading and the code fences under Discord's 2000-char message limit. */
const PAGE_BODY_LIMIT = 1800;

/** Usernames can't contain a comma, so the game joins them with ", " and we split them back. */
const namesOf = (ack: CommandAck): string[] => (ack.response ? ack.response.split(", ") : []);

/** One server as a header line plus a ├─/└─ chain of its players. */
function tree(ack: CommandAck): string[] {
	const names = namesOf(ack);
	const header = `${ack.jobId}  [${ack.kind ?? "?"}]  ${names.length}`;
	if (names.length === 0) return [header, "└─ (empty)"];
	return [header, ...names.map((name, i) => `${i === names.length - 1 ? "└─" : "├─"} ${name}`)];
}

/** Packs whole server trees onto pages. A server holds ≤10 players, so it always fits one page and never splits. */
function pagesFor(servers: CommandAck[], heading: string): string[] {
	const pages: string[][] = [];
	let current: string[] = [];
	let used = 0;

	for (const ack of servers) {
		const lines = tree(ack);
		const size = lines.reduce((sum, line) => sum + line.length + 1, 0);
		if (current.length > 0 && used + 1 + size > PAGE_BODY_LIMIT) {
			pages.push(current);
			current = [];
			used = 0;
		}
		if (current.length > 0) {
			current.push("");
			used += 1;
		}
		current.push(...lines);
		used += size;
	}
	if (current.length > 0) pages.push(current);

	return pages.map((lines) => `${heading}\n\`\`\`\n${lines.join("\n")}\n\`\`\``);
}

export const players = new Command({
	name: "players",
	description: "List the players on each live server",
	userPermissions: PermissionFlagsBits.ManageGuild,
	contexts: InteractionContextType.Guild,
	ephemeral: true,
	// biome-ignore format:  readability
	options: (data) => data
		.addStringOption((o) => o
			.setName("target")
			.setDescription("JobId of one server (from /servers). Omit to list every server")
			.setMaxLength(64)),
	async execute(interaction) {
		const target = interaction.options.getString("target") ?? undefined;

		const command = createCommand("players", undefined, target);
		try {
			await publishCommand(command);
			await new Promise((resolve) => setTimeout(resolve, config.probe.windowMs));
		} catch (err) {
			closeCommand(command.id); // a failed publish must not leak the pending entry
			throw err;
		}

		const acks = closeCommand(command.id);

		if (target !== undefined) {
			const verdict = targetedVerdict(acks);
			if (verdict.kind === "acted" && verdict.outcome === "Success") {
				await paginate(interaction, pagesFor([verdict.ack], `Players on \`${target}\``));
				return;
			}
			await interaction.editReply({ content: targetedMiss(verdict, target), allowedMentions: { parse: [] } });
			return;
		}

		const live = acks.filter((a) => a.outcome === "Success");
		if (live.length === 0) {
			const content =
				acks.length === 0
					? `_No server answered within ${config.probe.windowMs / 1000}s — none up, or the build predates \`players\`._`
					: "_Servers answered but none reported a list._";
			await interaction.editReply({ content, allowedMentions: { parse: [] } });
			return;
		}

		const total = live.reduce((sum, a) => sum + namesOf(a).length, 0);
		const stale = acks.filter((a) => a.outcome === "Unsupported").length;
		const heading =
			`**Live players** — ${live.length} server(s), ${total} online` +
			(stale > 0 ? ` · ${stale} on an old build` : "");
		await paginate(interaction, pagesFor(live, heading));
	},
});

function targetedMiss(verdict: TargetedVerdict, target: string): string {
	switch (verdict.kind) {
		case "acted":
			return `**Errored** on \`${verdict.ack.jobId}\`: ${verdict.ack.response ?? "unknown error"}.`;
		case "unconfirmed":
			return `**Unconfirmed** — \`${target}\` didn't answer, and ${verdict.stale.length} server(s) are on an old build.`;
		case "absent":
			return `\`${target}\` **isn't running** — ${verdict.answered} other server(s) answered, none was it.`;
		case "silent":
			return `**Nothing answered** within ${config.probe.windowMs / 1000}s.`;
	}
}
