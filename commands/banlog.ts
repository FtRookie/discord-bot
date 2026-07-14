import {
    InteractionContextType,
    PermissionFlagsBits,
} from "discord.js";
import {
    expiryTimestamp,
    formatDuration,
    getRestriction,
    listBanLogs,
    lookupNames,
    relativeTime,
    resolveUser,
} from "../roblox.ts";
import { Command } from "./command.ts";

export const banlog = new Command({
    name: "banlog",
    description: "Show recent game moderation history for a user",
    userPermissions: PermissionFlagsBits.BanMembers,
    contexts: InteractionContextType.Guild,
    ephemeral: true, // contains the private moderation reason.
    options: (data) =>
        data.addStringOption(
            (o) => o.setName("user").setDescription("Filter by Roblox username or user ID").setMaxLength(40)
        ),
    async execute(interaction) {
        const input = interaction.options.getString("user");
        const user = input ? await resolveUser(input) : undefined;

        const [restriction, { logs = [] }] = await Promise.all([
            user ? getRestriction(user.id) : Promise.resolve(undefined),
            listBanLogs(user?.id),
        ]);

        const idOf = (path: string | undefined) => {
            const id = Number(path?.split("/")[1]);
            return Number.isInteger(id) && id > 0 ? id : undefined;
        };
        const ids = new Set<number>();
        for (const log of logs) {
            for (const path of [log.user, log.moderator?.robloxUser]) {
                const id = idOf(path);
                if (id !== undefined) ids.add(id);
            }
        }
        const names = await lookupNames([...ids]);
        const label = (path: string | undefined) => {
            const id = idOf(path);
            if (id === undefined) return "unknown user";
            const name = names.get(id);
            return name ? `**${name}** (${id})` : `user ${id}`;
        };

        const blocks: string[] = [];
        if (user) {
            const r = restriction?.gameJoinRestriction;
            const status = r?.active
                ? `**banned** ${r.duration ? `for ${formatDuration(r.duration)}${expiryTimestamp(r) ? `, expires ${expiryTimestamp(r)}` : ""}` : "permanently"}`
                : "not banned";
            blocks.push(`**${user.name}** (${user.id}) is currently ${status}.`);
        }
        if (logs.length === 0) {
            blocks.push(user ? "No ban history for this user." : "No ban history in this game yet.");
        }
        for (const log of logs) {
            const moderator = log.moderator?.robloxUser
                ? label(log.moderator.robloxUser)
                : log.moderator?.gameServerScript
                    ? "game server script"
                    : "API key";
            const details = [
                `by ${moderator} ${relativeTime(log.createTime)}${log.place ? " (place-level)" : ""}`,
                ...(log.privateReason ? [`reason: ${log.privateReason}`] : []),
                ...(log.displayReason ? [`Public reason: ${log.displayReason}`] : []),
            ];
            const head = log.active
                ? `🔨 **Ban** — ${label(log.user)} for ${formatDuration(log.duration)}`
                : `♻️ **Unban** — ${label(log.user)}`;
            blocks.push(`${head}\n> ${details.join("\n> ")}`);
        }

        // Trim whole blocks to stay inside Discord's 2000-char message limit.
        let content = "";
        let kept = 0;
        for (const block of blocks) {
            const next = content ? `${content}\n${block}` : block;
            if (next.length > 1950) break;
            content = next;
            kept++;
        }
        const hidden = blocks.length - kept;
        await interaction.editReply({
            content: hidden > 0 ? `${content}\n… and ${hidden} more` : content,
            allowedMentions: { parse: [] },
        });
    },
});
