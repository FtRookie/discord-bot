import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	type Client,
	EmbedBuilder,
	Events,
	type Message,
	MessageFlags,
	type PartialMessage,
	type User,
} from "discord.js";
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

/** A Discord timestamp, rendered in each reader's own timezone. */
export const When = (ms: number, format: "f" | "R" = "f") => `<t:${Math.floor(ms / 1000)}:${format}>`;

export const Who = (user: Pick<User, "id" | "tag">) => `<@${user.id}> (${user.tag}, ${user.id})`;

// Discord's ```ansi blocks honor SGR codes; these are the colors its client actually renders
const ESC = "\u001b[";
const Ansi = { reset: `${ESC}0m`, gray: `${ESC}30m`, red: `${ESC}31m`, green: `${ESC}32m`, cyan: `${ESC}36m` };
const paint = (color: string, text: string) => `${color}${text}${Ansi.reset}`;

/**
 * A fenced ```ansi block with every line painted. Painted per line because Discord resets color at each
 * newline, and with the user's backticks broken up by zero-width spaces so a ``` in the message can't close the
 * fence early and spill the rest of the embed out as markdown.
 */
function block(color: string, text: string, max: number): string {
	const safe = text.replaceAll("`", "`​");
	const clipped = safe.length > max ? `${safe.slice(0, max - 1)}…` : safe;
	return `\`\`\`ansi\n${clipped
		.split("\n")
		.map((line) => paint(color, line))
		.join("\n")}\n\`\`\``;
}

const ids = (authorId: string | undefined, messageId: string) =>
	`\`\`\`ansi\n${paint(Ansi.gray, "Author: ")}${paint(Ansi.cyan, authorId ?? "unknown")}` +
	`${paint(Ansi.gray, " | Message ID: ")}${paint(Ansi.cyan, messageId)}\n\`\`\``;

function text(snapshot: Snapshot | undefined): string | undefined {
	if (!snapshot) return undefined;
	const parts = [snapshot.content];
	if (snapshot.attachments.length) parts.push(`[attachments: ${snapshot.attachments.join(", ")}]`);
	return parts.filter(Boolean).join("\n") || undefined;
}

const NOT_CACHED = "*Content unknown — sent before the bot last started, or too far back to be archived.*";

/** Copyable on mobile, where an ID in an embed can't be selected. */
const USER_ID_BUTTON = "log:user-id:";

function buttons(authorId: string | undefined, jump: string, jumpLabel: string) {
	const row = new ActionRowBuilder<ButtonBuilder>();
	if (authorId) {
		row.addComponents(
			new ButtonBuilder()
				.setCustomId(`${USER_ID_BUTTON}${authorId}`)
				.setLabel("Get User ID")
				.setStyle(ButtonStyle.Secondary),
		);
	}
	row.addComponents(new ButtonBuilder().setURL(jump).setLabel(jumpLabel).setStyle(ButtonStyle.Link));
	return [row];
}

/**
 * Post an event to the /log channel. Best-effort and never throws: a missing channel or a lost permission
 * must not break whatever was being logged, so failures go to the console instead.
 */
export async function Log(embed: EmbedBuilder, components: ActionRowBuilder<ButtonBuilder>[] = []): Promise<void> {
	if (!channelId || !client) return;
	try {
		const channel = await client.channels.fetch(channelId);
		if (!channel?.isSendable()) throw new Error("not a channel the bot can send to");
		await channel.send({ embeds: [embed], components, allowedMentions: { parse: [] } });
	} catch (err) {
		console.error(`[log] posting to ${channelId} failed:`, err);
	}
}

/** Bots are skipped: their edits are mostly link embeds resolving, and their deletes are the bot's own cleanup. */
const ignored = (message: Message | PartialMessage) =>
	!message.inGuild() || message.channelId === channelId || message.author?.bot === true;

type Deletion = { guildId: string; channelId: string; messageId: string; created: number };

async function logDeleted(snapshot: Snapshot | undefined, at: Deletion, title: string): Promise<void> {
	const content = text(snapshot);
	const from = snapshot ? `<@${snapshot.authorId}>` : "*unknown*";
	const embed = new EmbedBuilder()
		.setColor(LogColor.Delete)
		.setTitle(title)
		.setDescription(
			[
				`**From:** ${from}　**In:** <#${at.channelId}>`,
				content ? block(Ansi.red, content, 3500) : NOT_CACHED,
				ids(snapshot?.authorId, at.messageId),
				`**Sent** ${When(at.created)}　**Deleted** ${When(Date.now())} (${When(Date.now(), "R")})`,
			].join("\n"),
		);

	// the message itself is gone, so jump to the archived one just before it, or else to the channel
	const before = Window(at.channelId).findLast((s) => BigInt(s.id) < BigInt(at.messageId));
	const channelUrl = `https://discord.com/channels/${at.guildId}/${at.channelId}`;
	const jump = before ? `${channelUrl}/${before.id}` : channelUrl;
	await Log(embed, buttons(snapshot?.authorId, jump, "Jump to Context"));
}

// IDs a sweep already logged, so their delete event arriving afterward doesn't log them twice
const swept = new Set<string>();

async function onDelete(message: Message | PartialMessage): Promise<void> {
	if (ignored(message) || !message.guildId) return;
	const archived = Forget(message.channelId, message.id);
	if (swept.delete(message.id)) return;
	const snapshot = message.partial ? archived : Snap(message);
	await logDeleted(
		snapshot,
		{
			guildId: message.guildId,
			channelId: message.channelId,
			messageId: message.id,
			created: message.createdTimestamp,
		},
		"Message Deleted",
	);
	queueSweep(message.channelId);
}

async function onEdit(before: Message | PartialMessage, after: Message | PartialMessage): Promise<void> {
	if (ignored(after)) return;
	if (after.partial) after = await after.fetch().catch(() => after);
	if (after.partial || after.author.bot) return;
	if (!before.partial && before.content === after.content) return; // an embed resolving, a pin, and the like

	const archived = Window(after.channelId).find((s) => s.id === after.id);
	const previous = text(before.partial ? archived : Snap(before));
	Revise(Snap(after));

	const embed = new EmbedBuilder()
		.setColor(LogColor.Edit)
		.setTitle("Message Edited")
		.setDescription(
			[
				`**From:** <@${after.author.id}>　**In:** <#${after.channelId}>`,
				"**Before**",
				previous ? block(Ansi.red, previous, 1700) : NOT_CACHED,
				"**After**",
				block(Ansi.green, text(Snap(after)) ?? "", 1700),
				ids(after.author.id, after.id),
				`**Sent** ${When(after.createdTimestamp)}　**Edited** ${When(after.editedTimestamp ?? Date.now())}`,
			].join("\n"),
		);
	await Log(embed, buttons(after.author.id, after.url, "Jump to Message"));
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
	const oldest = Window(channel)[0];
	if (!oldest) return;
	try {
		const target = await client.channels.fetch(channel);
		if (!target?.isTextBased() || target.isDMBased()) return;
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
			await logDeleted(
				snapshot,
				{
					guildId: target.guildId,
					channelId: channel,
					messageId: snapshot.id,
					created: snapshot.createdTimestamp,
				},
				"Message Deleted (found missing)",
			);
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
	client.on(Events.InteractionCreate, (interaction) => {
		if (!interaction.isButton() || !interaction.customId.startsWith(USER_ID_BUTTON)) return;
		// bare, so a long-press copies just the ID
		void interaction
			.reply({ content: interaction.customId.slice(USER_ID_BUTTON.length), flags: MessageFlags.Ephemeral })
			.catch(() => {});
	});
}
