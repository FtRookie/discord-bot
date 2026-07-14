import {
    InteractionContextType,
    PermissionFlagsBits,
} from "discord.js";
import { getRestriction, resolveUser, updateRestriction } from "../roblox.ts";
import { auditTag, Command } from "./command.ts";

export const unban = new Command({
    name: "unban",
    description: "Lift a Roblox game ban",
    userPermissions: PermissionFlagsBits.BanMembers,
    contexts: InteractionContextType.Guild,
    options: (data) =>
        data.addStringOption(
            (o) => o.setName("user").setDescription("Roblox username or user ID").setRequired(true).setMaxLength(40)
        ),
    async execute(interaction) {
        await interaction.deferReply();
        const user = await resolveUser(interaction.options.getString("user", true));
        const current = await getRestriction(user.id);
        if (current?.gameJoinRestriction?.active !== true) {
            await interaction.editReply({
                content: `**${user.name}** (${user.id}) has no game-wide ban to lift. ` +
                    "(Bans placed at place level show in /banlog but can't be lifted from here.)",
                allowedMentions: { parse: [] },
            });
            return;
        }
        // The unban would otherwise be attributed only to the shared API key.
        await updateRestriction(user.id, {
            active: false,
            privateReason: `Unbanned by ${auditTag(interaction)}`.slice(0, 1000),
        });
        await interaction.editReply({
            content: `♻️ Unbanned **${user.name}** (${user.id}).`,
            allowedMentions: { parse: [] },
        });
    },
});
