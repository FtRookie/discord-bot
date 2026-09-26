import { InteractionContextType } from "discord.js";
import { HoneypotChannel, SetHoneypotChannel } from "../../../helpers/Honeypot.ts";
import { Perms } from "../../../helpers/Permissions.ts";
import { Command } from "../../Command.ts";

export const Honeypot = new Command({
	name: "honeypot",
	description: "Ban for a day anyone who posts in a trap channel (catches compromised accounts)",
	permissions: Perms.Moderate,
	contexts: InteractionContextType.Guild,
	ephemeral: true,
	subcommands: {
		set: {
			description: "Make a channel the honeypot — posting there bans for a day and wipes recent messages",
			options: { channel: { channel: { description: "The trap channel", required: true } } },
		},
		clear: { description: "Turn the honeypot off" },
		status: { description: "Show which channel is the honeypot" },
	},
	async execute(interaction) {
		let content: string;
		switch (interaction.options.getSubcommand()) {
			case "set": {
				const channel = interaction.options.getChannel("channel", true);
				SetHoneypotChannel(channel.id);
				content =
					`<#${channel.id}> is now the honeypot: anyone without bot permissions who posts there is banned ` +
					"for a day and their last day of messages is deleted server-wide. The bot needs Ban Members.";
				break;
			}
			case "clear":
				SetHoneypotChannel(undefined);
				content = "Honeypot off.";
				break;
			default: {
				const id = HoneypotChannel();
				content = id ? `The honeypot is <#${id}>.` : "No honeypot is set.";
			}
		}
		await interaction.editReply({ content, allowedMentions: { parse: [] } });
	},
});
