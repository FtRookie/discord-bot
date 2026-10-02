import { InteractionContextType } from "discord.js";
import { LogChannel, SetLogChannel } from "../../../helpers/Log.ts";
import { Perms } from "../../../helpers/Permissions.ts";
import { Command } from "../../Command.ts";

export const LogCommand = new Command({
	name: "log",
	description: "Report moderation events and deleted or edited messages to a channel",
	permissions: Perms.Moderate,
	contexts: InteractionContextType.Guild,
	ephemeral: true,
	subcommands: {
		set: {
			description: "Send the log to a channel",
			options: { channel: { channel: { description: "The log channel", required: true } } },
		},
		clear: { description: "Stop logging" },
		status: { description: "Show which channel is the log" },
	},
	async execute(interaction) {
		let content: string;
		switch (interaction.options.getSubcommand()) {
			case "set": {
				const channel = interaction.options.getChannel("channel", true);
				SetLogChannel(channel.id);
				content =
					`Logging to <#${channel.id}>: honeypot bans and unbans, and deleted and edited messages. ` +
					"Keep it private — deleted messages are reposted there in full.";
				break;
			}
			case "clear":
				SetLogChannel(undefined);
				content = "Logging off.";
				break;
			default: {
				const id = LogChannel();
				content = id ? `Logging to <#${id}>.` : "No log channel is set.";
			}
		}
		await interaction.editReply({ content, allowedMentions: { parse: [] } });
	},
});
