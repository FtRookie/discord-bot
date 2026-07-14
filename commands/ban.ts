import {
    InteractionContextType,
    MessageFlags,
    PermissionFlagsBits,
} from "discord.js";
import {
    expiryTimestamp,
    formatDuration,
    parseDurationSeconds,
    resolveUser,
    updateRestriction,
} from "../roblox.ts";
import { auditTag, Command } from "./command.ts";

const PERMANENT_WORDS = ["perm", "permanent", "forever"];

export const ban = new Command({
    name: "ban",
    description: "Ban a Roblox user from the game",
    userPermissions: PermissionFlagsBits.BanMembers,
    contexts: InteractionContextType.Guild,
    timeout: 15,
    options: (data) =>
        data
            .addStringOption((o) => o.setName("user").setDescription("Username or UserID").setRequired(true).setMaxLength(40))
            .addStringOption((o) => o.setName("duration").setDescription('How long, e.g. "30m", "12h", "7d", "1w2d" — omit for a permanent ban').setMaxLength(40))
            .addStringOption((o) => o.setName("reason").setDescription("Private moderation reason (view with /banlog)").setMaxLength(900))
            .addStringOption((o) => o.setName("display_reason").setDescription("Reason shown to the banned user").setMaxLength(400))
            .addBooleanOption((o) => o.setName("visible").setDescription("Whether or not the ban message is visible, default true")),
    async execute(interaction) {
        const options = interaction.options;
        await interaction.deferReply(options.getBoolean("visible") ?? true ? {} : { flags: MessageFlags.Ephemeral });
        const user = await resolveUser(options.getString("user", true));
        const durationInput = options.getString("duration");
        const seconds = durationInput && !PERMANENT_WORDS.includes(durationInput.trim().toLowerCase())
            ? parseDurationSeconds(durationInput)
            : undefined;
        const reason = options.getString("reason");
        const displayReason = options.getString("display_reason");

        const audit = auditTag(interaction);
        const result = await updateRestriction(user.id, {
            active: true,
            ...(seconds !== undefined ? { duration: `${seconds}s` } : {}),
            privateReason: (reason ? `${reason} — ${audit}` : `Banned by ${audit}`).slice(0, 1000),
            ...(displayReason ? { displayReason: displayReason.slice(0, 400) } : {}),
        });

        const expires = expiryTimestamp(result.gameJoinRestriction ?? {});
        // The private reason stays out of this public confirmation; /banlog shows it.
        const lines = [
            `**Banned** __${user.name}__ (${user.id}) ` +
            (seconds !== undefined
                ? `for **${formatDuration(`${seconds}s`)}**${expires ? `, expires ${expires}` : ""}.`
                : "**permanently**."),
            ...(reason ? ["> Private reason recorded — view with /banlog"] : ["> No reason was given"]),
            ...(displayReason ? [`> Reason: ${displayReason}`] : []),
        ];
        await interaction.editReply({ content: lines.join("\n"), allowedMentions: { parse: [] } });
    },
});
