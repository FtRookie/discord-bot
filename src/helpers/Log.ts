import { type Client, EmbedBuilder, Events, type Message, type PartialMessage, type User } from "discord.js";
import { ClearState, GetState, SetState } from "./Database.ts";

const KEY = "log-channel";

let channelId = GetState(KEY);
let client: Client;

export function LogChannel(): string | undefined {
	return channelId;
}

export function SetLogChannel(id: string | undefined): void {
	channelId = id;
	if (id) SetState(KEY, id);
	else ClearState(KEY);
}

export const LogColor = { Delete: 0xed4245, Edit: 0xfee75c, Moderation: 0x5865f2 } as const;

// embed field values cap at 1024 characters
const clip = (text: string, max = 1024) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** A Discord timestamp, rendered in each reader's own timezone. */
export const When = (ms: number) => `<t:${Math.floor(ms / 1000)}:f>`;

export const Who = (user: Pick<User, "id" | "tag">) => `<@${user.id}> (${user.tag}, ${user.id})`;

/**
 * Post an event to the /log channel. Best-effort and never throws: a missing channel or a lost permission
 * must not break whatever was being logged, so failures go to the console instead.
 */
export async function Log(embed: EmbedBuilder): Promise<void> {
	if (!channelId || !client) return;
	try {
		const channel = await client.channels.fetch(channelId);
		if (!channel?.isSendable()) throw new Error("not a channel the bot can send to");
		await channel.send({ embeds: [embed.setTimestamp()], allowedMentions: { parse: [] } });
	} catch (err) {
		console.error(`[log] posting to ${channelId} failed:`, err);
	}
}

function body(message: Message | PartialMessage): string {
	if (message.partial) return "*not cached — sent before the bot last started*";
	const parts = [message.content || "*no text*"];
	if (message.attachments.size) parts.push(`Attachments: ${message.attachments.map((a) => a.name).join(", ")}`);
	return clip(parts.join("\n"));
}

/** Bots are skipped: their edits are mostly link embeds resolving, and their deletes are the bot's own cleanup. */
const ignored = (message: Message | PartialMessage) =>
	!message.inGuild() || message.channelId === channelId || message.author?.bot === true;

async function onDelete(message: Message | PartialMessage): Promise<void> {
	if (ignored(message)) return;
	const embed = new EmbedBuilder()
		.setColor(LogColor.Delete)
		.setTitle("Message deleted")
		.addFields(
			{ name: "Author", value: message.author ? Who(message.author) : "*unknown — not cached*" },
			{ name: "Channel", value: `<#${message.channelId}>`, inline: true },
			{ name: "Sent", value: When(message.createdTimestamp), inline: true },
			{ name: "Deleted", value: When(Date.now()), inline: true },
			{ name: "Content", value: body(message) },
		);
	await Log(embed);
}

async function onEdit(before: Message | PartialMessage, after: Message | PartialMessage): Promise<void> {
	if (ignored(after)) return;
	if (after.partial) after = await after.fetch().catch(() => after);
	if (after.partial || after.author.bot) return;
	if (!before.partial && before.content === after.content) return; // an embed resolving, a pin, and the like

	const embed = new EmbedBuilder()
		.setColor(LogColor.Edit)
		.setTitle("Message edited")
		.setURL(after.url)
		.addFields(
			{ name: "Author", value: Who(after.author) },
			{ name: "Channel", value: `<#${after.channelId}>`, inline: true },
			{ name: "Sent", value: When(after.createdTimestamp), inline: true },
			{ name: "Edited", value: When(after.editedTimestamp ?? Date.now()), inline: true },
			{ name: "Before", value: body(before) },
			{ name: "After", value: body(after) },
		);
	await Log(embed);
}

export function StartLog(c: Client): void {
	client = c;
	client.on(Events.MessageDelete, (message) => void onDelete(message));
	client.on(Events.MessageBulkDelete, (messages) => {
		for (const message of messages.values()) void onDelete(message);
	});
	client.on(Events.MessageUpdate, (before, after) => void onEdit(before, after));
}
