import { InteractionContextType, PermissionFlagsBits } from "discord.js";
import { config } from "../Config.ts";
import type { CommandAck } from "../helpers/AckServer.ts";
import { closeCommand, targetedVerdict } from "../helpers/AckServer.ts";
import { createCommand, publishCommand } from "../helpers/Commands.ts";
import { screen } from "../helpers/Filter.ts";
import { UserError } from "../helpers/Roblox.ts";
import { Command } from "./Command.ts";

/** Comma-joined jobIds, capped so a wide failure can't overflow Discord's message limit. */
const jobIds = (acks: CommandAck[]): string => {
	const shown = acks.slice(0, 8).map((a) => `\`${a.jobId}\``);
	return acks.length > 8 ? `${shown.join(", ")} …and ${acks.length - 8} more` : shown.join(", ");
};

export const announce = new Command({
	name: "announce",
	description: "Broadcast an announcement to everyone in the live game",
	userPermissions: PermissionFlagsBits.ManageGuild,
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
			.addChoices({ name: "chat", value: "chat" }, { name: "popup", value: "popup" }, { name: "both", value: "both" }))
		.addIntegerOption((o) => o
			.setName("duration")
			.setDescription("Seconds it keeps showing to players who join late. Default: 60")
			.setMinValue(0).setMaxValue(3600))
		.addStringOption((o) => o
			.setName("target")
			.setDescription("JobId of one server (from /servers). Omit to announce to all")
			.setMaxLength(64)),
	async execute(interaction) {
		// The game clamps text to 400; clamp here too so the payload stays well under the 1 KiB limit.
		const text = interaction.options.getString("text", true).slice(0, 400);
		const display = interaction.options.getString("display") ?? "both";
		// Replay window only — a player joining inside it still sees the message. The game renders no
		// countdown for an announcement; that wording belongs to the restart command alone.
		const ttl = interaction.options.getInteger("duration") ?? 60;
		const target = interaction.options.getString("target") ?? undefined;

		const hit = screen(text);
		if (hit) {
			throw new UserError(
				`Blocked word "${hit.word}" in your announcement — edit and resend. If it's a false flag, here's the spot:\n\`\`\`\n${hit.snippet}\n\`\`\``,
			);
		}

		const command = createCommand("announce", { text, display, ttl }, target);
		try {
			await publishCommand(command);
			await new Promise((resolve) => setTimeout(resolve, config.probe.windowMs));
		} catch (err) {
			closeCommand(command.id); // a failed publish must not leak the pending entry
			throw err;
		}

		const acks = closeCommand(command.id);
		const scope = `${display}, replays ${ttl}s`;
		const content = target ? targetedReply(acks, target, scope) : broadcastReply(acks, scope, text);

		await interaction.editReply({ content, allowedMentions: { parse: [] } });
	},
});

function broadcastReply(acks: CommandAck[], scope: string, text: string): string {
	const shown = acks.filter((a) => a.outcome === "Success").length;
	const failed = acks.filter((a) => a.outcome === "Fail");
	const stale = acks.filter((a) => a.outcome === "Unsupported");
	// A broadcast has no "not applicable" and no refusal, so either turning up is a contract violation.
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
	const verdict = targetedVerdict(acks);
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
			return `**Nothing answered** within ${config.probe.windowMs / 1000}s — unconfirmed; it may still show via catch-up.`;
	}
}
