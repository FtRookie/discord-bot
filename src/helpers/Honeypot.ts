import { type Client, Events, type Message } from "discord.js";
import { ClearState, GetState, SetState } from "./Database.ts";
import { PermsOf } from "./Permissions.ts";

const KEY = "honeypot-channel";

let channelId = GetState(KEY);

export function HoneypotChannel(): string | undefined {
	return channelId;
}

export function SetHoneypotChannel(id: string | undefined): void {
	channelId = id;
	if (id) SetState(KEY, id);
	else ClearState(KEY);
}

/**
 * A channel no human has a reason to post in. Spam bots blast every channel they can see, so anything that
 * lands here is deleted and its author kicked. Staff (anyone in the Perms table) are exempt, so testing or
 * setting it up never costs anyone their membership.
 */
async function trap(message: Message): Promise<void> {
	if (!channelId || message.channelId !== channelId) return;
	if (message.author.bot || message.system || !message.inGuild()) return;
	if (PermsOf(message.author.id) !== 0) return;

	await message.delete().catch(() => {});

	const member = message.member ?? (await message.guild.members.fetch(message.author.id).catch(() => null));
	if (!member) return; // already gone
	if (!member.kickable) {
		console.warn(
			`[honeypot] cannot kick ${message.author.tag}: they own the guild, outrank the bot, or the bot is ` +
				"missing Kick Members",
		);
		return;
	}
	await member
		.kick("Posted in the honeypot channel")
		.then(() => console.log(`[honeypot] kicked ${message.author.tag} (${message.author.id})`))
		.catch((err) => console.error(`[honeypot] kicking ${message.author.tag} failed:`, err));
}

export function StartHoneypot(client: Client): void {
	client.on(Events.MessageCreate, (message) => void trap(message));
}
