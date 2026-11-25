import {
	ChannelType,
	type Client,
	Events,
	type Guild,
	type GuildMember,
	PermissionFlagsBits,
	type VoiceBasedChannel,
	type VoiceState,
} from "discord.js";
import { Config } from "../Config.ts";
import { db } from "./Database.ts";

// joining the hub twice before the first room exists would otherwise make two
const creating = new Set<string>();

function isRoom(channelId: string): boolean {
	return db.query(`SELECT 1 FROM voice_rooms WHERE channelId = ?`).get(channelId) !== null;
}

function forget(channelId: string): void {
	db.query(`DELETE FROM voice_rooms WHERE channelId = ?`).run(channelId);
}

/** The room this member already owns, if it still exists — rejoining the hub sends them back to it. */
function ownedRoom(guild: Guild, ownerId: string): VoiceBasedChannel | undefined {
	const row = db.query(`SELECT channelId FROM voice_rooms WHERE ownerId = ?`).get(ownerId) as {
		channelId: string;
	} | null;
	if (!row) return undefined;
	const channel = guild.channels.cache.get(row.channelId);
	if (channel?.isVoiceBased()) return channel;
	forget(row.channelId);
	return undefined;
}

/** Bots don't keep a room alive: a music bot left alone in one shouldn't hold it open forever. */
function isEmpty(channel: VoiceBasedChannel): boolean {
	return channel.members.every((m) => m.user.bot);
}

/**
 * Joining the hub creates a voice channel named after the member, beside the hub and with its category's
 * permissions, and moves them into it. The owner can rename it, set a limit and move people. It's deleted
 * once the last person leaves. Needs Manage Channels and Move Members.
 */
async function joinedHub(member: GuildMember, hub: VoiceBasedChannel): Promise<void> {
	if (member.user.bot || creating.has(member.id)) return;
	creating.add(member.id);
	try {
		const existing = ownedRoom(member.guild, member.id);
		if (existing) {
			await member.voice.setChannel(existing);
			return;
		}

		const inherited = [...(hub.parent?.permissionOverwrites.cache.values() ?? [])]
			.filter((o) => o.id !== member.id)
			.map((o) => ({ id: o.id, type: o.type, allow: o.allow, deny: o.deny }));
		const room = await member.guild.channels.create({
			name: `${member.displayName}'s channel`.slice(0, 100),
			type: ChannelType.GuildVoice,
			parent: hub.parentId,
			bitrate: hub.bitrate,
			permissionOverwrites: [
				...inherited,
				{ id: member.id, allow: [PermissionFlagsBits.ManageChannels, PermissionFlagsBits.MoveMembers] },
			],
			reason: `Voice room for ${member.user.tag}`,
		});
		db.query(`INSERT INTO voice_rooms (channelId, ownerId) VALUES (?, ?)`).run(room.id, member.id);

		// they may have left the hub while the room was being made: an empty room is removed rather than kept
		await member.voice.setChannel(room).catch(() => {});
		if (isEmpty(room)) await remove(room);
	} catch (err) {
		console.error(`[voice] making a room for ${member.user.tag} failed:`, err);
	} finally {
		creating.delete(member.id);
	}
}

async function remove(channel: VoiceBasedChannel): Promise<void> {
	forget(channel.id);
	await channel
		.delete("Voice room emptied")
		.catch((err) => console.error(`[voice] deleting ${channel.id} failed:`, err));
}

async function voiceUpdate(before: VoiceState, after: VoiceState): Promise<void> {
	if (before.guild.id !== Config.discord.guildId || before.channelId === after.channelId) return;
	// the cache already reflects the move, so the channel left behind no longer lists this member
	if (before.channel && isRoom(before.channel.id) && isEmpty(before.channel)) await remove(before.channel);
	if (after.channel && after.channelId === Config.voiceHub.channelId && after.member)
		await joinedHub(after.member, after.channel);
}

/** Rooms that emptied, or were deleted by hand, while the bot was down are cleaned up on start. */
export function StartVoiceRooms(client: Client): void {
	const rooms = db.query(`SELECT channelId FROM voice_rooms`).all() as { channelId: string }[];
	const guild = client.guilds.cache.get(Config.discord.guildId);
	for (const { channelId } of rooms) {
		const channel = guild?.channels.cache.get(channelId);
		if (!channel?.isVoiceBased()) forget(channelId);
		else if (isEmpty(channel)) void remove(channel);
	}

	client.on(Events.VoiceStateUpdate, (before, after) => void voiceUpdate(before, after));
	client.on(Events.ChannelDelete, (channel) => forget(channel.id));
}
