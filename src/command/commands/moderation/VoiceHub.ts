import { ChannelType, InteractionContextType } from "discord.js";
import { Perms } from "../../../helpers/Permissions.ts";
import { SetVoiceHub, VoiceHubChannel } from "../../../helpers/VoiceRooms.ts";
import { Command } from "../../Command.ts";

export const VoiceHub = new Command({
	name: "voice-hub",
	description: "A voice channel that gives everyone who joins it their own voice channel",
	permissions: Perms.Moderate,
	contexts: InteractionContextType.Guild,
	ephemeral: true,
	subcommands: {
		set: {
			description: "Make a voice channel the hub — joining it creates a channel for you and moves you in",
			options: {
				channel: {
					channel: { description: "The hub voice channel", required: true, types: [ChannelType.GuildVoice] },
				},
			},
		},
		clear: { description: "Turn the hub off (existing rooms still clean up when they empty)" },
		status: { description: "Show which channel is the hub" },
	},
	async execute(interaction) {
		let content: string;
		switch (interaction.options.getSubcommand()) {
			case "set": {
				const channel = interaction.options.getChannel("channel", true);
				SetVoiceHub(channel.id);
				content =
					`<#${channel.id}> is now the hub: joining it creates a voice channel for that person in the same ` +
					"category and moves them in, deleted once everyone leaves. The bot needs Manage Channels and Move Members.";
				break;
			}
			case "clear":
				SetVoiceHub(undefined);
				content = "Voice hub off.";
				break;
			default: {
				const id = VoiceHubChannel();
				content = id ? `The voice hub is <#${id}>.` : "No voice hub is set.";
			}
		}
		await interaction.editReply({ content, allowedMentions: { parse: [] } });
	},
});
