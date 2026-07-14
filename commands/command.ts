import {
    MessageFlags,
    SlashCommandBuilder,
    type ChatInputCommandInteraction,
    type InteractionContextType,
} from "discord.js";

/** One slash command: its registration data and its handler. */
export class Command {
    readonly data: SlashCommandBuilder;
    readonly execute: (interaction: ChatInputCommandInteraction) => Promise<void>;

    constructor(args: {
        name: string,
        description: string,
        userPermissions?: bigint,
        contexts?: InteractionContextType,
        ephemeral?: boolean,
        options?: (data: SlashCommandBuilder) => unknown,
        execute: (interaction: ChatInputCommandInteraction) => Promise<void>,
    }) {
        const data = new SlashCommandBuilder()
            .setName(args.name)
            .setDescription(args.description);
        if (args.userPermissions !== undefined) data.setDefaultMemberPermissions(args.userPermissions);
        if (args.contexts !== undefined) data.setContexts(args.contexts);
        args.options?.(data);
        this.data = data;
        this.execute = args.ephemeral
            ? async (interaction) => {
                await interaction.deferReply({ flags: MessageFlags.Ephemeral });
                await args.execute(interaction);
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
