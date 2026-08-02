import {
	type ChatInputCommandInteraction,
	type InteractionContextType,
	MessageFlags,
	SlashCommandBuilder,
} from "discord.js";
import { Perms } from "../helpers/Permissions.ts";

/** One slash command: its registration data and its handler. */
export class Command {
	readonly data: SlashCommandBuilder;
	/** Perms bits the caller must all hold. Defaults to Perms.Owner, so a new command is locked until it says otherwise. */
	readonly permissions: number;
	readonly execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
	/** Role name denied visibility of this command, for one-shot commands that grant the role they hide behind. */
	readonly hiddenFromRole?: string;

	constructor(args: {
		name: string;
		description: string;
		contexts?: InteractionContextType;
		permissions?: number;
		ephemeral?: boolean;
		/** Delete the reply after this many seconds, unless it ended up ephemeral. */
		timeout?: number;
		options?: (data: SlashCommandBuilder) => unknown;
		hiddenFromRole?: string;
		execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
	}) {
		const data = new SlashCommandBuilder().setName(args.name).setDescription(args.description);
		if (args.contexts !== undefined) data.setContexts(args.contexts);
		args.options?.(data);
		this.permissions = args.permissions ?? Perms.Owner;
		// Gated commands (anything past Perms.None) are hidden from non-admins in the client; the Perms table
		// still decides who may run them, and per-role visibility is granted in Server Settings → Integrations.
		if (this.permissions !== Perms.None) data.setDefaultMemberPermissions(0n);
		this.data = data;
		this.hiddenFromRole = args.hiddenFromRole;
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
export function AuditTag(interaction: ChatInputCommandInteraction): string {
	return `@${interaction.user.username} (${interaction.user.id}) via Discord`;
}
