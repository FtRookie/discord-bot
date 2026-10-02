import { InteractionContextType } from "discord.js";
import { LogChannel, SetLogChannel } from "../../../helpers/Log.ts";
import { Perms } from "../../../helpers/Permissions.ts";
import { Command } from "../../Command.ts";

export const LogCommand = new Command({
	name: "log",
	description: "Post moderation events and deleted or edited messages to a channel (again on it to turn off)",
	permissions: Perms.Moderate,
	contexts: InteractionContextType.Guild,
	ephemeral: true,
	options: { channel: { channel: { description: "The log channel", required: true } } },
	async execute(interaction) {
		const channel = interaction.options.getChannel("channel", true);
		let content: string;
		// a toggle, so one command both starts and stops it
		if (LogChannel() === channel.id) {
			SetLogChannel(undefined);
			content = `Stopped logging to <#${channel.id}>.`;
		} else {
			SetLogChannel(channel.id);
			content =
				`Logging to <#${channel.id}>: honeypot bans and unbans, and deleted and edited messages. ` +
				"Keep it private — deleted messages are reposted there in full. Run `/log` on it again to stop.";
		}
		await interaction.editReply({ content, allowedMentions: { parse: [] } });
	},
});
