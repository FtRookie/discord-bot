import {
    InteractionContextType,
    PermissionFlagsBits,
    SlashCommandBuilder,
} from "discord.js";
import {
    expiryTimestamp,
    formatDuration,
    parseDurationSeconds,
    resolveUser,
    updateRestriction,
} from "../roblox.ts";
import { auditTag, type Command } from "./command.ts";

const PERMANENT_WORDS = ["perm", "permanent", "forever"];

export const ban: Command = {
    data: new SlashCommandBuilder()
        .setName("ban")
        .setDescription("Ban a Roblox user from the game")
        .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
        .setContexts(InteractionContextType.Guild)
        .addStringOption((o) => o.setName("user").setDescription("Roblox username or user ID").setRequired(true).setMaxLength(40))
        .addStringOption((o) => o.setName("duration").setDescription('How long, e.g. "30m", "12h", "7d", "1w2d" — omit for a permanent ban').setMaxLength(40))
        .addStringOption((o) => o.setName("reason").setDescription("Private reason, recorded for moderators (view with /banlog)").setMaxLength(900))
        .addStringOption((o) => o.setName("display_reason").setDescription("Reason shown to the banned user").setMaxLength(400))
        .addBooleanOption((o) => o.setName("exclude_alts").setDescription("Don't extend the ban to alt accounts (default: alts are banned too)")),
    async execute(interaction) {
        await interaction.deferReply();
        const user = await resolveUser(interaction.options.getString("user", true));
        const durationInput = interaction.options.getString("duration");
        const seconds = durationInput && !PERMANENT_WORDS.includes(durationInput.trim().toLowerCase())
            ? parseDurationSeconds(durationInput)
            : undefined;
        const reason = interaction.options.getString("reason");
        const displayReason = interaction.options.getString("display_reason");
        const excludeAlts = interaction.options.getBoolean("exclude_alts") ?? false;

        const audit = auditTag(interaction);
        const result = await updateRestriction(user.id, {
            active: true,
            ...(seconds !== undefined ? { duration: `${seconds}s` } : {}),
            privateReason: (reason ? `${reason} — ${audit}` : `Banned by ${audit}`).slice(0, 1000),
            ...(displayReason ? { displayReason: displayReason.slice(0, 400) } : {}),
            excludeAltAccounts: excludeAlts,
        });

        const expires = expiryTimestamp(result.gameJoinRestriction ?? {});
        // The private reason stays out of this public confirmation; /banlog shows it.
        const lines = [
            `🔨 Banned **${user.name}** (${user.id}) ` +
            (seconds !== undefined
                ? `for **${formatDuration(`${seconds}s`)}**${expires ? `, expires ${expires}` : ""}.`
                : "**permanently**."),
            ...(reason ? ["> Private reason recorded — view with /banlog"] : []),
            ...(displayReason ? [`> Shown to user: ${displayReason}`] : []),
            `> Alt accounts: ${excludeAlts ? "not affected" : "also banned"}`,
        ];
        await interaction.editReply({ content: lines.join("\n"), allowedMentions: { parse: [] } });
    },
};
