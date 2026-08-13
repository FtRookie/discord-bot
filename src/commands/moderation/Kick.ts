import { InteractionContextType } from "discord.js";
import { Config } from "../../Config.ts";
import { CloseCommand, TargetedVerdict } from "../../helpers/AckServer.ts";
import { CreateCommand, PublishCommand } from "../../helpers/Commands.ts";
import { Screen } from "../../helpers/Filter.ts";
import { Perms } from "../../helpers/Permissions.ts";
import { ResolveUser, UserError } from "../../helpers/Roblox.ts";
import { Command } from "../Command.ts";

export const Kick = new Command({
	name: "kick",
	description: "Kick a Roblox user from any live game server they're in",
	permissions: Perms.Moderate,
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
		const hit = reason ? Screen(reason) : undefined;
		if (hit) {
			throw new UserError(
				`Blocked word "${hit.word}" in the reason — edit and resend. If it's a false flag:\n\`\`\`\n${hit.snippet}\n\`\`\``,
			);
		}

		const user = await ResolveUser(interaction.options.getString("user", true));

		// broadcast-and-collect: only one server can hold the player, but every server answers, so "offline"
		// takes all of them reporting no such player — silence alone would equally mean a dropped delivery
		const command = CreateCommand("kick", { userId: user.id, ...(reason ? { reason } : {}) });
		try {
			await PublishCommand(command);
			await new Promise((resolve) => setTimeout(resolve, Config.probe.windowMs));
		} catch (err) {
			CloseCommand(command.id); // a failed publish would otherwise leave the pending entry behind
			throw err;
		}

		const verdict = TargetedVerdict(CloseCommand(command.id));
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
					`**Nothing answered** within ${Config.probe.windowMs / 1000}s, so this is unconfirmed and the ` +
					"kick may still land via catch-up. Either no servers are up, or the live build predates `kick`.";
				break;
		}

		await interaction.editReply({ content, allowedMentions: { parse: [] } });
	},
});
