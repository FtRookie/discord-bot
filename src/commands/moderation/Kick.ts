import { InteractionContextType, PermissionFlagsBits } from "discord.js";
import { config } from "../../Config.ts";
import { closeCommand, targetedVerdict } from "../../helpers/AckServer.ts";
import { createCommand, publishCommand } from "../../helpers/Commands.ts";
import { screen } from "../../helpers/Filter.ts";
import { resolveUser, UserError } from "../../helpers/Roblox.ts";
import { Command } from "../Command.ts";

export const kick = new Command({
	name: "kick",
	description: "Kick a Roblox user from any live game server they're in",
	userPermissions: PermissionFlagsBits.KickMembers,
	contexts: InteractionContextType.Guild,
	ephemeral: true,
	// biome-ignore format:  readability
	options: (data) => data
		.addStringOption((o) => o
			.setName("user")
			.setDescription("Username or UserID")
			.setRequired(true).setMaxLength(40))
		.addStringOption((o) => o
			.setName("reason")
			.setDescription("Shown to the kicked player (defaults to a generic message)")
			.setMaxLength(400)),
	async execute(interaction) {
		const reason = interaction.options.getString("reason")?.trim();
		const hit = reason ? screen(reason) : undefined;
		if (hit) {
			throw new UserError(
				`Blocked word "${hit.word}" in the reason — edit and resend. If it's a false flag:\n\`\`\`\n${hit.snippet}\n\`\`\``,
			);
		}

		const user = await resolveUser(interaction.options.getString("user", true));

		// A kick only ends an active session; /ban is what keeps them out. Broadcast-and-collect: only one
		// server can hold the player, but every server answers, so "offline" is proven by all of them
		// reporting no such player — silence alone would equally mean a dropped delivery.
		const command = createCommand("kick", { userId: user.id, ...(reason ? { reason } : {}) });
		try {
			await publishCommand(command);
			await new Promise((resolve) => setTimeout(resolve, config.probe.windowMs));
		} catch (err) {
			closeCommand(command.id); // a failed publish must not leak the pending entry
			throw err;
		}

		const verdict = targetedVerdict(closeCommand(command.id));
		const who = `__${user.name}__ (${user.id})`;

		let content: string;
		switch (verdict.kind) {
			case "acted": {
				const { ack, outcome } = verdict;
				if (outcome === "Success")
					content = `**Kicked** ${who} from \`${ack.jobId}\` (${ack.kind ?? "unknown"}).`;
				else if (outcome === "Refused")
					content = `**Refused** — ${who} is staff. The game blocks that on every path, not just this one.`;
				else content = `**Errored** kicking ${who} on \`${ack.jobId}\`: ${ack.response ?? "unknown error"}.`;
				break;
			}
			case "unconfirmed":
				content =
					`**Unconfirmed** — no server that answered had ${who}, but ${verdict.stale.length} are on an old ` +
					`build and couldn't be checked (${verdict.stale.map((a) => `\`${a.jobId}\``).join(", ")}). ` +
					"Retry once they've updated.";
				break;
			case "absent":
				content =
					`${who} is **not online** — ${verdict.answered} server(s) answered and none had them. ` +
					"To keep them out, use /ban.";
				break;
			case "silent":
				content =
					`**Nothing answered** within ${config.probe.windowMs / 1000}s, so this is unconfirmed and the ` +
					"kick may still land via catch-up. Either no servers are up, or the live build predates `kick`.";
				break;
		}

		await interaction.editReply({ content, allowedMentions: { parse: [] } });
	},
});
