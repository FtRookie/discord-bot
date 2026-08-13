import { InteractionContextType } from "discord.js";
import { Config } from "../../../Config.ts";
import type { CommandAck } from "../../../helpers/AckServer.ts";
import { TargetedVerdict } from "../../../helpers/AckServer.ts";
import { BlockedWord, Screen } from "../../../helpers/Filter.ts";
import { CreateCommand, PublishAndCollect } from "../../../helpers/GameCommands.ts";
import { Perms } from "../../../helpers/Permissions.ts";
import { UserError } from "../../../helpers/Roblox.ts";
import { Command } from "../../Command.ts";

// capped, so a wide failure can't overflow Discord's message limit
const jobIds = (acks: CommandAck[]): string => {
	const shown = acks.slice(0, 8).map((a) => `\`${a.jobId}\``);
	return acks.length > 8 ? `${shown.join(", ")} …and ${acks.length - 8} more` : shown.join(", ");
};

export const Announce = new Command({
	name: "announce",
	description: "Broadcast an announcement to everyone in the live game",
	permissions: Perms.Announce,
	contexts: InteractionContextType.Guild,
	ephemeral: true,
	options: {
		text: {
			string: {
				description: "The announcement (max 400 characters)",
				required: true,
				maxLength: 400,
			},
		},
		display: {
			string: {
				description: "Where it shows in-game. Default: both",
				choices: {
					chat: "chat",
					popup: "popup",
					both: "both",
				},
			},
		},
		duration: {
			integer: {
				description: "Seconds it keeps showing to players who join late. Default: 60",
				min: 0,
				max: 3600,
			},
		},
		target: {
			string: { description: "JobId of one server (from /servers). Omit to announce to all", maxLength: 64 },
		},
	},
	async execute(interaction) {
		const text = interaction.options.getString("text", true);
		if (text.length > 400) throw new UserError("That announcement is too long (max 400 characters).");
		const display = interaction.options.getString("display") ?? "both";
		const ttl = interaction.options.getInteger("duration") ?? 60;
		const target = interaction.options.getString("target") ?? undefined;

		const hit = Screen(text);
		if (hit) throw BlockedWord(hit, "your announcement");

		const acks = await PublishAndCollect(CreateCommand("announce", { text, display, ttl }, target));
		const scope = `${display}, replays ${ttl}s`;
		const response = target ? targetedReply(acks, target, scope) : broadcastReply(acks, scope, text);

		await interaction.editReply({ content: response, allowedMentions: { parse: [] } });
	},
});

/** Process for an all-servers announcement */
function broadcastReply(acks: CommandAck[], scope: string, text: string): string {
	const shown = acks.filter((a) => a.outcome === "Success").length;
	const failed = acks.filter((a) => a.outcome === "Fail");
	const stale = acks.filter((a) => a.outcome === "Unsupported");
	const anomalies = acks.filter((a) => a.outcome === "Nothing" || a.outcome === "Refused");

	const lines = [`**Announced** (${scope}) — shown on ${shown} server(s):\n> ${text}`];
	if (acks.length === 0) lines.push("_No server answered in time — it may still show via catch-up._");
	if (failed.length > 0) lines.push(`⚠️ errored on ${failed.length}: ${jobIds(failed)}`);
	if (stale.length > 0) lines.push(`${stale.length} on an old build, not shown: ${jobIds(stale)}`);
	if (anomalies.length > 0)
		lines.push(`⚠️ unexpected outcome (shouldn't happen for a broadcast): ${jobIds(anomalies)}`);
	return lines.join("\n");
}

/** Process for a single target announcement */
function targetedReply(acks: CommandAck[], target: string, scope: string): string {
	const verdict = TargetedVerdict(acks);
	switch (verdict.kind) {
		case "acted":
			return verdict.outcome === "Success"
				? `**Announced** to \`${target}\` (${scope}).`
				: `**Errored** announcing to \`${verdict.ack.jobId}\`: ${verdict.ack.response ?? "unknown error"}.`;
		case "unconfirmed":
			return `**Unconfirmed** — \`${target}\` didn't answer, and ${verdict.stale.length} server(s) are on an old build.`;
		case "absent":
			return `\`${target}\` **isn't running** — ${verdict.answered} other server(s) answered, none was it. It may have shut down.`;
		case "silent":
			return `**Nothing answered** within ${Config.probe.windowMs / 1000}s — unconfirmed; it may still show via catch-up.`;
	}
}
