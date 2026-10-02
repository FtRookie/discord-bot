import { type Client, Events, type Message } from "discord.js";
import { Config } from "../Config.ts";
import { LogColor, LogEvent } from "./Log.ts";

/**
 * A GitHub build/check notification reporting success. GitHub's Discord webhook puts the status in the embed
 * title — e.g. "[overengineered] build success on main", "[overengineered] GitHub Actions checks success on
 * main". Failures say "failure" and pushes say "N new commits", so neither matches: only a confident success
 * is ever deleted, and a failure is never removed.
 */
function isBuildSuccess(message: Message): boolean {
	if (message.author.id !== Config.discord.githubWebhookId) return false; // only the GitHub webhook's posts
	return message.embeds.some((embed) => {
		const title = (embed.title ?? "").toLowerCase();
		return title.includes("success") && !title.includes("fail");
	});
}

async function remove(message: Message): Promise<void> {
	if (
		!(await message.delete().then(
			() => true,
			() => false,
		))
	)
		return;
	const title = message.embeds.find((embed) => embed.title)?.title ?? "build success";
	await LogEvent("Build notification removed", LogColor.Info, [`In <#${message.channelId}>`], { text: title });
}

function deleteIfSuccess(message: Message): void {
	if (message.channelId === Config.discord.buildChannelId && isBuildSuccess(message)) void remove(message);
}

/**
 * Keep only build FAILURES in the GitHub-notifications channel by deleting the webhook's success messages. A
 * successful deploy runs `systemctl restart discord-bot`, so that success message usually lands while the bot
 * is down — hence a boot-time sweep of recent messages as well as the live listener.
 */
export function StartBuildNotifications(client: Client): void {
	client.on(Events.MessageCreate, deleteIfSuccess);
	void sweep(client);
}

async function sweep(client: Client): Promise<void> {
	try {
		const channel = await client.channels.fetch(Config.discord.buildChannelId);
		if (!channel?.isTextBased()) return;
		const recent = await channel.messages.fetch({ limit: 100 });
		for (const message of recent.values()) {
			if (isBuildSuccess(message)) await remove(message);
		}
	} catch (err) {
		console.error("[build] sweep failed:", err);
	}
}
