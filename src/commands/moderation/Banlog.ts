import { InteractionContextType } from "discord.js";
import { Perms } from "../../helpers/Permissions.ts";
import {
	ExpiryTimestamp,
	FormatDuration,
	GetRestriction,
	ListBanLogs,
	LookupNames,
	RelativeTime,
	ResolveUser,
} from "../../helpers/Roblox.ts";
import { Command } from "../Command.ts";

export const Banlog = new Command({
	name: "banlog",
	description: "Show recent game moderation history for a user",
	permissions: Perms.Moderate,
	contexts: InteractionContextType.Guild,
	ephemeral: true, // carries the private moderation reason
	timeout: 15,
	// biome-ignore format:  readability
	options: (data) => data
		.addStringOption((o) => o
			.setName("user")
			.setDescription("Filter by Roblox username or user ID")
			.setMaxLength(40)),
	async execute(interaction) {
		const input = interaction.options.getString("user");
		const user = input ? await ResolveUser(input) : undefined;

		const [restriction, { logs = [] }] = await Promise.all([
			user ? GetRestriction(user.id) : Promise.resolve(undefined),
			ListBanLogs(user?.id),
		]);

		const idOf = (path: string | undefined) => {
			const id = Number(path?.split("/")[1]);
			return Number.isInteger(id) && id > 0 ? id : undefined;
		};
		const ids = new Set<number>();
		for (const log of logs) {
			for (const path of [log.user, log.moderator?.robloxUser]) {
				const id = idOf(path);
				if (id !== undefined) ids.add(id);
			}
		}
		const names = await LookupNames([...ids]);
		const label = (path: string | undefined) => {
			const id = idOf(path);
			if (id === undefined) return "unknown user";
			const name = names.get(id);
			return name ? `**${name}** (${id})` : `user ${id}`;
		};

		const blocks: string[] = [];
		if (user) {
			const r = restriction?.gameJoinRestriction;
			const status = r?.active
				? `**banned** ${r.duration ? `for ${FormatDuration(r.duration)}${ExpiryTimestamp(r) ? `, expires ${ExpiryTimestamp(r)}` : ""}` : "permanently"}`
				: "not banned";
			blocks.push(`**${user.name}** (${user.id}) is currently ${status}.`);
		}
		if (logs.length === 0) {
			blocks.push(user ? "No ban history for this user." : "No ban history in this game yet.");
		}
		for (const log of logs) {
			const moderator = log.moderator?.robloxUser
				? label(log.moderator.robloxUser)
				: log.moderator?.gameServerScript
					? "In-game"
					: "API key";
			const details = [
				`by ${moderator} ${RelativeTime(log.createTime)}${log.place ? " (place-level)" : ""}`,
				...(log.privateReason ? [`reason: ${log.privateReason}`] : []),
				...(log.displayReason ? [`Public reason: ${log.displayReason}`] : []),
			];
			const head = log.active
				? `**Ban** — ${label(log.user)} for ${FormatDuration(log.duration)}`
				: `**Unban** — ${label(log.user)}`;
			blocks.push(`${head}\n> ${details.join("\n> ")}`);
		}

		// whole blocks are dropped, so an entry is never shown half-rendered inside the 2000-char limit
		let content = "";
		let kept = 0;
		for (const block of blocks) {
			const next = content ? `${content}\n${block}` : block;
			if (next.length > 1950) break;
			content = next;
			kept++;
		}
		const hidden = blocks.length - kept;
		await interaction.editReply({
			content: hidden > 0 ? `${content}\n… and ${hidden} more` : content,
			allowedMentions: { parse: [] },
		});
	},
});
