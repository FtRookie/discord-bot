import { InteractionContextType } from "discord.js";
import { Config } from "../../../Config.ts";
import type { CommandAck } from "../../../helpers/AckServer.ts";
import { TargetedVerdict } from "../../../helpers/AckServer.ts";
import { CreateCommand, PublishAndCollect } from "../../../helpers/GameCommands.ts";
import { Paginate } from "../../../helpers/Paginate.ts";
import { Perms } from "../../../helpers/Permissions.ts";
import { Command } from "../../Command.ts";

const PAGE_BODY_LIMIT = 1800; // leaves room for the heading and code fences under Discord's 2000-char limit

// usernames can't contain a comma, so the game joins them with ", "
const namesOf = (ack: CommandAck): string[] => (ack.response ? ack.response.split(", ") : []);

function tree(ack: CommandAck): string[] {
	const names = namesOf(ack);
	const header = `${ack.jobId}  [${ack.kind ?? "?"}]  ${names.length}`;
	if (names.length === 0) return [header, "└─ (empty)"];
	return [header, ...names.map((name, i) => `${i === names.length - 1 ? "└─" : "├─"} ${name}`)];
}

/** A server holds ≤10 players, so its tree always fits one page and is never split across two. */
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

export const Players = new Command({
	name: "players",
	description: "List the players on each live server",
	permissions: Perms.Inspect,
	contexts: InteractionContextType.Guild,
	ephemeral: true,
	options: {
		target: {
			string: { description: "JobId of one server (from /servers). Omit to list every server", maxLength: 64 },
		},
	},
	async execute(interaction) {
		const target = interaction.options.getString("target") ?? undefined;

		const command = CreateCommand("players", undefined, target);
		// a targeted probe has one possible answerer, so there is no partial list worth showing
		const acks = await PublishAndCollect(
			command,
			target !== undefined
				? undefined
				: async (partial) => {
						const live = partial.filter((a) => a.outcome === "Success");
						if (live.length === 0) return;
						const [page] = pagesFor(live, heading(live, partial, false));
						await interaction.editReply({ content: page ?? "", allowedMentions: { parse: [] } });
					},
		);

		if (target !== undefined) {
			const verdict = TargetedVerdict(acks);
			if (verdict.kind === "acted" && verdict.outcome === "Success") {
				await Paginate(interaction, pagesFor([verdict.ack], `Players on \`${target}\``));
				return;
			}
			await interaction.editReply({ content: targetedMiss(verdict, target), allowedMentions: { parse: [] } });
			return;
		}

		const live = acks.filter((a) => a.outcome === "Success");
		if (live.length === 0) {
			const content =
				acks.length === 0
					? `_No server answered within ${Config.probe.windowMs / 1000}s — none up, or the build predates \`players\`._`
					: "_Servers answered but none reported a list._";
			await interaction.editReply({ content, allowedMentions: { parse: [] } });
			return;
		}

		await Paginate(interaction, pagesFor(live, heading(live, acks, true)));
	},
});

/** `settled` distinguishes the final count from one still filling in. */
function heading(live: CommandAck[], acks: CommandAck[], settled: boolean): string {
	const total = live.reduce((sum, a) => sum + namesOf(a).length, 0);
	const stale = acks.filter((a) => a.outcome === "Unsupported").length;
	return (
		`**Live players** — ${live.length} server(s), ${total} online` +
		(stale > 0 ? ` · ${stale} on an old build` : "") +
		(settled ? "" : " · still listening…")
	);
}

function targetedMiss(verdict: TargetedVerdict, target: string): string {
	switch (verdict.kind) {
		case "acted":
			return `**Errored** on \`${verdict.ack.jobId}\`: ${verdict.ack.response ?? "unknown error"}.`;
		case "unconfirmed":
			return `**Unconfirmed** — \`${target}\` didn't answer, and ${verdict.stale.length} server(s) are on an old build.`;
		case "absent":
			return `\`${target}\` **isn't running** — ${verdict.answered} other server(s) answered, none was it.`;
		case "silent":
			return `**Nothing answered** within ${Config.probe.windowMs / 1000}s.`;
	}
}
