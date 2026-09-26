import { type Client, Events, type Message } from "discord.js";
import { Config } from "../Config.ts";
import { ClearState, db, GetState, SetState } from "./Database.ts";
import { PermsOf } from "./Permissions.ts";

const KEY = "honeypot-channel";

let channelId = GetState(KEY);
let client: Client;

// a compromised account posts to every channel at once, so several trap messages can arrive before the ban lands
const banning = new Set<string>();

export function HoneypotChannel(): string | undefined {
	return channelId;
}

export function SetHoneypotChannel(id: string | undefined): void {
	channelId = id;
	if (id) SetState(KEY, id);
	else ClearState(KEY);
}

type PendingUnban = { userId: string; guildId: string; unbanAt: number };

/**
 * A channel no human has a reason to post in. Compromised accounts and spam bots blast every channel they can
 * see, so anything that lands here gets its author banned for an hour with their recent messages wiped
 * server-wide, then unbanned — long enough to clean up, short enough that a hacked real person can come back.
 * Staff (anyone in the Perms table) are exempt, so testing or setting it up never costs anyone their membership.
 */
async function trap(message: Message): Promise<void> {
	if (!channelId || message.channelId !== channelId) return;
	if (message.author.bot || message.system || !message.inGuild()) return;
	if (PermsOf(message.author.id) !== 0) return;

	const { author, guild } = message;
	if (banning.has(author.id)) return;
	banning.add(author.id);
	try {
		// fetched for the hierarchy check only; a user who already left has no roles to outrank the bot with
		const member = message.member ?? (await guild.members.fetch(author.id).catch(() => null));
		if (member && !member.bannable) {
			console.warn(
				`[honeypot] cannot ban ${author.tag}: they own the guild, outrank the bot, or the bot is missing ` +
					"Ban Members",
			);
			await message.delete().catch(() => {});
			return;
		}

		// the ban's message purge covers this one too, across every channel
		await guild.bans.create(author.id, {
			deleteMessageSeconds: Config.honeypot.deleteMessageSeconds,
			reason: "Posted in the honeypot channel (likely a compromised account)",
		});
		const pending = { userId: author.id, guildId: guild.id, unbanAt: Date.now() + Config.honeypot.banMs };
		db.query(`INSERT OR REPLACE INTO honeypot_bans (userId, guildId, unbanAt) VALUES (?, ?, ?)`).run(
			pending.userId,
			pending.guildId,
			pending.unbanAt,
		);
		schedule(pending);
		console.log(`[honeypot] banned ${author.tag} (${author.id}) until ${new Date(pending.unbanAt).toISOString()}`);
	} catch (err) {
		console.error(`[honeypot] banning ${author.tag} failed:`, err);
	} finally {
		banning.delete(author.id);
	}
}

function schedule(pending: PendingUnban): void {
	setTimeout(() => void unban(pending), Math.max(0, pending.unbanAt - Date.now()));
}

async function unban(pending: PendingUnban): Promise<void> {
	// a later re-ban replaces the row with a later time; only the latest one unbans
	const row = db.query(`SELECT unbanAt FROM honeypot_bans WHERE userId = ?`).get(pending.userId) as {
		unbanAt: number;
	} | null;
	if (row?.unbanAt !== pending.unbanAt) return;

	// dropped first, so a failure (already unbanned by hand, bot removed) can't retry every boot
	db.query(`DELETE FROM honeypot_bans WHERE userId = ?`).run(pending.userId);
	try {
		const guild = await client.guilds.fetch(pending.guildId);
		await guild.bans.remove(pending.userId, "Honeypot ban expired");
		console.log(`[honeypot] unbanned ${pending.userId}`);
	} catch (err) {
		console.error(`[honeypot] unbanning ${pending.userId} failed (already unbanned?):`, err);
	}
}

/** Any unban that came due while the bot was down fires immediately. */
export function StartHoneypot(c: Client): void {
	client = c;
	const pending = db.query(`SELECT userId, guildId, unbanAt FROM honeypot_bans`).all() as PendingUnban[];
	for (const p of pending) schedule(p);
	client.on(Events.MessageCreate, (message) => void trap(message));
}
