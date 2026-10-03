import {
	ActionRowBuilder,
	ApplicationCommandOptionType,
	ButtonBuilder,
	ButtonStyle,
	type ChatInputCommandInteraction,
	type Client,
	type CommandInteractionOption,
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

/** Embed color by how heavy the action was, so a scroll through the log reads at a glance. */
export const LogColor = {
	Ban: 0xed4245, // red: bans
	Remove: 0xe67e22, // orange: kicks, timeouts, deleted messages
	Change: 0xfee75c, // yellow: edited messages, config and announcements
	Lift: 0x57f287, // green: unbans, a punishment ending
	System: 0x5865f2, // blurple: the bot acting on its own (rollouts, restarts)
	Info: 0x99aab5, // gray: read-only commands, housekeeping
	Failed: 0xeb459e, // pink: anything that didn't go through — kept apart from red so it can't pass for a ban
} as const;

// commands not listed here only read, and log gray
const COMMAND_COLOR: Record<string, number> = {
	ban: LogColor.Ban,
	kick: LogColor.Remove,
	unban: LogColor.Lift,
	announce: LogColor.Change,
	blocks: LogColor.Change,
	honeypot: LogColor.Change,
	log: LogColor.Change,
	reaction: LogColor.Change,
	reply: LogColor.Change,
	"phrase-response": LogColor.Change,
};
// subcommands that only read, whatever their command's level
const READ_ONLY_SUBCOMMANDS = new Set(["list", "status"]);

function commandColor(interaction: ChatInputCommandInteraction): number {
	if (READ_ONLY_SUBCOMMANDS.has(interaction.options.getSubcommand(false) ?? "")) return LogColor.Info;
	return COMMAND_COLOR[interaction.commandName] ?? LogColor.Info;
}

/** A Discord timestamp, rendered in each reader's own timezone. */
export const When = (ms: number, format: "f" | "R" = "f") => `<t:${Math.floor(ms / 1000)}:${format}>`;

export const Who = (user: Pick<User, "id" | "tag">) => `<@${user.id}> (${user.tag}, ${user.id})`;

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** The Dyno-style footer: plain text, so the IDs stay selectable on desktop. */
const ids = (authorId: string | undefined, messageId: string) => ({
	text: `Author: ${authorId ?? "unknown"} | Message ID: ${messageId}`,
});

function text(snapshot: Snapshot | undefined): string | undefined {
	if (!snapshot) return undefined;
	const parts = [snapshot.content];
	if (snapshot.attachments.length) parts.push(`[attachments: ${snapshot.attachments.join(", ")}]`);
	return parts.filter(Boolean).join("\n") || undefined;
}

const NOT_CACHED = "*Content unknown — sent before the bot last started, or too far back to be archived.*";

/** Copyable on mobile, where an ID in an embed can't be selected. */
const USER_ID_BUTTON = "log:user-id:";

function buttons(authorId: string | undefined, jump?: string, jumpLabel = "Jump") {
	const row = new ActionRowBuilder<ButtonBuilder>();
	if (authorId) {
		row.addComponents(
			new ButtonBuilder()
				.setCustomId(`${USER_ID_BUTTON}${authorId}`)
				.setLabel("Get User ID")
				.setStyle(ButtonStyle.Secondary),
		);
	}
	if (jump) row.addComponents(new ButtonBuilder().setURL(jump).setLabel(jumpLabel).setStyle(ButtonStyle.Link));
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
		.setColor(LogColor.Remove)
		.setTitle(title)
		.setDescription(
			[
				`**From:** ${from}　**In:** <#${at.channelId}>`,
				"",
				content ? clip(content, 3500) : NOT_CACHED,
				"",
				`**Sent** ${When(at.created)}　**Deleted** ${When(Date.now())} (${When(Date.now(), "R")})`,
			].join("\n"),
		)
		.setFooter(ids(snapshot?.authorId, at.messageId));

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
		.setColor(LogColor.Change)
		.setTitle("Message Edited")
		.setDescription(
			[
				`**From:** <@${after.author.id}>　**In:** <#${after.channelId}>`,
				"",
				"**Before**",
				previous ? clip(previous, 1700) : NOT_CACHED,
				"",
				"**After**",
				clip(text(Snap(after)) ?? "*no text*", 1700),
				"",
				`**Sent** ${When(after.createdTimestamp)}　**Edited** ${When(after.editedTimestamp ?? Date.now())}`,
			].join("\n"),
		)
		.setFooter(ids(after.author.id, after.id));
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
	client.on(Events.InteractionCreate, async (interaction) => {
		if (!interaction.isButton() || !interaction.customId.startsWith(USER_ID_BUTTON)) return;
		const id = interaction.customId.slice(USER_ID_BUTTON.length);
		// fetched rather than cached-only: the user may have left or been banned since the entry was posted
		const user = await client.users.fetch(id).catch(() => null);
		const name = user
			? `**@${user.username}**${user.globalName && user.globalName !== user.username ? ` (${user.globalName})` : ""}`
			: "*unknown user*";
		// the ID on a line of its own, so it's easy to select
		await interaction
			.reply({ content: `${name}\n${id}`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } })
			.catch(() => {});
	});
}

/**
 * A one-off event with no message behind it: an automatic punishment, a game rollout, a guild the bot left.
 * `detail`, when given, follows the lines as its own paragraph.
 */
export async function LogEvent(title: string, color: number, lines: string[], detail?: string): Promise<void> {
	const parts = [...lines];
	if (detail) parts.push("", clip(detail, 1500), "");
	parts.push(`**At** ${When(Date.now())}`);
	await Log(new EmbedBuilder().setColor(color).setTitle(title).setDescription(parts.join("\n")));
}

function optionValue(option: CommandInteractionOption): string {
	switch (option.type) {
		case ApplicationCommandOptionType.Attachment:
			return option.attachment?.name ?? "attachment";
		// as mentions, so they render as links
		case ApplicationCommandOptionType.Channel:
			return `<#${option.value}>`;
		case ApplicationCommandOptionType.User:
			return `<@${option.value}>`;
		case ApplicationCommandOptionType.Role:
			return `<@&${option.value}>`;
		case ApplicationCommandOptionType.Mentionable:
			return option.role ? `<@&${option.value}>` : `<@${option.value}>`;
		default:
			return String(option.value) || "*empty*";
	}
}

/** The command and subcommand in bold, then each option on its own line. */
function invocation(interaction: ChatInputCommandInteraction): string {
	const names = [`/${interaction.commandName}`];
	const lines: string[] = [];
	const walk = (options: readonly CommandInteractionOption[]) => {
		for (const option of options) {
			if (
				option.type === ApplicationCommandOptionType.Subcommand ||
				option.type === ApplicationCommandOptionType.SubcommandGroup
			) {
				names.push(option.name);
				walk(option.options ?? []);
			} else {
				lines.push(`**${option.name}:** ${clip(optionValue(option), 400)}`);
			}
		}
	};
	walk(interaction.options.data);
	return [`**${names.join(" ")}**`, ...lines].join("\n");
}

/** What the command answered with, read back from the reply itself so every command is covered alike. */
async function replyText(interaction: ChatInputCommandInteraction): Promise<string> {
	const reply = await interaction.fetchReply().catch(() => null);
	if (!reply) return "(no reply)";
	const parts = [reply.content];
	for (const embed of reply.embeds) parts.push([embed.title, embed.description].filter(Boolean).join(" — "));
	if (reply.attachments.size) parts.push(`[attachments: ${reply.attachments.map((a) => a.name).join(", ")}]`);
	return parts.filter(Boolean).join("\n") || "(empty reply)";
}

/**
 * Who ran a command, where, with which arguments, and what came of it. `error` is the message the user was
 * shown when it threw, permission refusals included.
 */
export async function LogCommandRun(interaction: ChatInputCommandInteraction, error?: string): Promise<void> {
	if (!channelId) return;
	const result = error ?? (await replyText(interaction));
	const embed = new EmbedBuilder()
		.setColor(error ? LogColor.Failed : commandColor(interaction))
		.setTitle(`Command: /${interaction.commandName}${error ? " (failed)" : ""}`)
		.setDescription(
			[
				`**By:** <@${interaction.user.id}>　**In:** <#${interaction.channelId}>`,
				"",
				invocation(interaction),
				"",
				error ? "**Error**" : "**Result**",
				clip(result, 1500),
				"",
				`**Ran** ${When(interaction.createdTimestamp)}`,
			].join("\n"),
		);
	await Log(embed, buttons(interaction.user.id));
}
