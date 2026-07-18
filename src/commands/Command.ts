import {
	type ChatInputCommandInteraction,
	type InteractionContextType,
	MessageFlags,
	SlashCommandBuilder,
} from "discord.js";

/** One slash command: its registration data and its handler. */
export class Command {
	readonly data: SlashCommandBuilder;
	/** When true (the default), only the bot owner may run this command. */
	readonly ownerOnly: boolean;
	readonly execute: (interaction: ChatInputCommandInteraction) => Promise<void>;

	constructor(args: {
		name: string;
		description: string;
		userPermissions?: bigint;
		contexts?: InteractionContextType;
		ownerOnly?: boolean;
		ephemeral?: boolean;
		/** Delete the reply after this many seconds, unless it ended up ephemeral. */
		timeout?: number;
		options?: (data: SlashCommandBuilder) => unknown;
		execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
	}) {
		const data = new SlashCommandBuilder().setName(args.name).setDescription(args.description);
		if (args.userPermissions !== undefined) data.setDefaultMemberPermissions(args.userPermissions);
		if (args.contexts !== undefined) data.setContexts(args.contexts);
		args.options?.(data);
		this.data = data;
		this.ownerOnly = args.ownerOnly ?? true;
		this.execute =
			args.ephemeral || args.timeout
				? async (interaction) => {
						if (args.ephemeral) await interaction.deferReply({ flags: MessageFlags.Ephemeral });
						await args.execute(interaction);
						if (args.timeout && interaction.ephemeral !== true) {
							setTimeout(() => interaction.deleteReply().catch(() => {}), args.timeout * 1000);
						}
					}
				: args.execute;
	}
}

/**
 * Who ran a moderation command, for Roblox-side audit trails. All bans go
 * through one API key, and Discord usernames are mutable, so the immutable
 * user ID is included.
 */
export function auditTag(interaction: ChatInputCommandInteraction): string {
	return `@${interaction.user.username} (${interaction.user.id}) via Discord`;
}
