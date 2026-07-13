import type {
    ChatInputCommandInteraction,
    SlashCommandOptionsOnlyBuilder,
    SlashCommandSubcommandsOnlyBuilder,
} from "discord.js";

/** One slash command: its registration data and its handler. */
export type Command = {
    data: SlashCommandOptionsOnlyBuilder | SlashCommandSubcommandsOnlyBuilder;
    execute(interaction: ChatInputCommandInteraction): Promise<void>;
};

/**
 * Who ran a moderation command, for Roblox-side audit trails. All bans go
 * through one API key, and Discord usernames are mutable, so the immutable
 * user ID is included.
 */
export function auditTag(interaction: ChatInputCommandInteraction): string {
    return `@${interaction.user.username} (${interaction.user.id}) via Discord`;
}
