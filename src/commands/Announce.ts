import { InteractionContextType } from "discord.js";
import { Config } from "../Config.ts";
import type { CommandAck } from "../helpers/AckServer.ts";
import { TargetedVerdict } from "../helpers/AckServer.ts";
import { CreateCommand, PublishAndCollect } from "../helpers/Commands.ts";
import { Screen } from "../helpers/Filter.ts";
import { Perms } from "../helpers/Permissions.ts";
import { UserError } from "../helpers/Roblox.ts";
import { Command } from "./Command.ts";

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
	// biome-ignore format:  readability
	options: (data) => data
		.addStringOption((o) => o
			.setName("text")
			.setDescription("The announcement (max 400 characters)")
			.setRequired(true).setMaxLength(400))
		.addStringOption((o) => o
			.setName("display")
			.setDescription("Where it shows in-game. Default: both")
			.addChoices(
				{ name: "chat", value: "chat" },
				{ name: "popup", value: "popup" },
				{ name: "both", value: "both" }
			))
		.addIntegerOption((o) => o
			.setName("duration")
			.setDescription("Seconds it keeps showing to players who join late. Default: 60")
			.setMinValue(0).setMaxValue(3600))
		.addStringOption((o) => o
			.setName("target")
			.setDescription("JobId of one server (from /servers). Omit to announce to all")
			.setMaxLength(64)),
	async execute(interaction) {
		const text = interaction.options.getString("text", true);
		if (text.length > 400) throw new UserError("That announcement is too long (max 400 characters).");
		const display = interaction.options.getString("display") ?? "both";
		// replay window only: a player joining inside it still sees the message. The game renders no countdown
		// for an announcement — that wording belongs to the restart command alone.
		const ttl = interaction.options.getInteger("duration") ?? 60;
		const target = interaction.options.getString("target") ?? undefined;

		const hit = Screen(text);
		if (hit) {
			throw new UserError(
				`Blocked word "${hit.word}" in your announcement — edit and resend. If it's a false flag:\n\`\`\`\n${hit.snippet}\n\`\`\``,
			);
		}

		const acks = await PublishAndCollect(CreateCommand("announce", { text, display, ttl }, target));
		const scope = `${display}, replays ${ttl}s`;
		const response = target ? targetedReply(acks, target, scope) : broadcastReply(acks, scope, text);

		await interaction.editReply({ content: response, allowedMentions: { parse: [] } });
	},
});

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
