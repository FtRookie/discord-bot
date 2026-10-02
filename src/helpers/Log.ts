import { type Client, EmbedBuilder, Events, type Message, type PartialMessage, type User } from "discord.js";
import { Channels, Forget, Missing, Remember, Revise, Snap, type Snapshot, Window } from "./Archive.ts";
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

const NOT_CACHED = "*not cached — sent before the bot last started*";

function body(snapshot: Snapshot | undefined): string {
	if (!snapshot) return NOT_CACHED;
	const parts = [snapshot.content || "*no text*"];
	if (snapshot.attachments.length) parts.push(`Attachments: ${snapshot.attachments.join(", ")}`);
	return clip(parts.join("\n"));
}

/** Bots are skipped: their edits are mostly link embeds resolving, and their deletes are the bot's own cleanup. */
const ignored = (message: Message | PartialMessage) =>
	!message.inGuild() || message.channelId === channelId || message.author?.bot === true;

function deleted(snapshot: Snapshot | undefined, channel: string, created: number, title: string): EmbedBuilder {
	return new EmbedBuilder()
		.setColor(LogColor.Delete)
		.setTitle(title)
		.addFields(
			{
				name: "Author",
				value: snapshot ? Who({ id: snapshot.authorId, tag: snapshot.authorTag }) : "*unknown — not cached*",
			},
			{ name: "Channel", value: `<#${channel}>`, inline: true },
			{ name: "Sent", value: When(created), inline: true },
			{ name: "Deleted", value: When(Date.now()), inline: true },
			{ name: "Content", value: body(snapshot) },
		);
}

// IDs a sweep already logged, so their delete event arriving afterward doesn't log them twice
const swept = new Set<string>();

async function onDelete(message: Message | PartialMessage): Promise<void> {
	if (ignored(message)) return;
	const archived = Forget(message.channelId, message.id);
	if (swept.delete(message.id)) return;
	const snapshot = message.partial ? archived : Snap(message);
	await Log(deleted(snapshot, message.channelId, message.createdTimestamp, "Message deleted"));
	queueSweep(message.channelId);
}

async function onEdit(before: Message | PartialMessage, after: Message | PartialMessage): Promise<void> {
	if (ignored(after)) return;
	if (after.partial) after = await after.fetch().catch(() => after);
	if (after.partial || after.author.bot) return;
	if (!before.partial && before.content === after.content) return; // an embed resolving, a pin, and the like

	const archived = Window(after.channelId).find((s) => s.id === after.id);
	const previous = before.partial ? archived : Snap(before);
	Revise(Snap(after));

	const embed = new EmbedBuilder()
		.setColor(LogColor.Edit)
		.setTitle("Message edited")
		.setURL(after.url)
		.addFields(
			{ name: "Author", value: Who(after.author) },
			{ name: "Channel", value: `<#${after.channelId}>`, inline: true },
			{ name: "Sent", value: When(after.createdTimestamp), inline: true },
			{ name: "Edited", value: When(after.editedTimestamp ?? Date.now()), inline: true },
			{ name: "Before", value: body(previous) },
			{ name: "After", value: body(Snap(after)) },
		);
	await Log(embed);
}

// a cleanup deletes in bursts; one check per channel per burst is enough
const SWEEP_DELAY_MS = 2000;
const pending = new Map<string, ReturnType<typeof setTimeout>>();

function queueSweep(channel: string): void {
	clearTimeout(pending.get(channel));
	pending.set(
		channel,
		setTimeout(() => {
			pending.delete(channel);
			void Sweep(channel);
		}, SWEEP_DELAY_MS),
	);
}

/**
 * Check that every message in a channel's archive window still exists, and log any that vanished without a
 * delete event reaching the bot. One fetch from the window's oldest message forward covers it.
 */
export async function Sweep(channel: string): Promise<void> {
	const window = Window(channel);
	const oldest = window[0];
	if (!oldest) return;
	try {
		const target = await client.channels.fetch(channel);
		if (!target?.isTextBased()) return;
		const limit = 100;
		// `after` is exclusive, so start one snowflake earlier to include the oldest itself
		const fetched = await target.messages.fetch({
			after: (BigInt(oldest.id) - 1n).toString(),
			limit,
			cache: false,
		});
		const present = new Set(fetched.keys());
		// a full page may have stopped short of the newest archived message, which is then unchecked, not missing
		const newest =
			fetched.size < limit ? undefined : [...present].reduce((a, b) => (BigInt(a) > BigInt(b) ? a : b));
		for (const snapshot of Missing(channel, present, newest)) {
			Forget(channel, snapshot.id);
			swept.add(snapshot.id);
			setTimeout(() => swept.delete(snapshot.id), 60_000);
			await Log(deleted(snapshot, channel, snapshot.createdTimestamp, "Message deleted (found missing)"));
		}
	} catch (err) {
		console.error(`[log] sweeping ${channel} failed:`, err);
	}
}

/** Sweep every channel with an archive window, e.g. after a ban purged someone's messages everywhere. */
export async function SweepAll(): Promise<void> {
	for (const channel of [...Channels()]) await Sweep(channel);
}

function onCreate(message: Message): void {
	if (ignored(message)) return;
	Remember(Snap(message));
}

export function StartLog(c: Client): void {
	client = c;
	client.on(Events.MessageCreate, onCreate);
	client.on(Events.MessageDelete, (message) => void onDelete(message));
	client.on(Events.MessageBulkDelete, (messages) => {
		for (const message of messages.values()) void onDelete(message);
	});
	client.on(Events.MessageUpdate, (before, after) => void onEdit(before, after));
}
