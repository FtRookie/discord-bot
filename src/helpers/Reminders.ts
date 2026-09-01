import { randomUUID } from "node:crypto";
import type { Client } from "discord.js";
import { db, ReplaceAll } from "./Database.ts";

export type Reminder = { id: string; userId: string; channelId: string; message: string; fireAt: number };

// setTimeout takes a signed-32-bit delay and fires anything longer at once, so long waits re-arm in chunks
const MAX_DELAY = 2 ** 31 - 1;

let reminders: Reminder[] = db
	.query(`SELECT id, userId, channelId, message, fireAt FROM reminders ORDER BY rowid`)
	.all() as Reminder[];
let client: Client;

const save = () => ReplaceAll("reminders", ["id", "userId", "channelId", "message", "fireAt"], reminders);

/** Any reminder that came due while the bot was down fires immediately. */
export function StartReminders(c: Client) {
	client = c;
	for (const reminder of reminders) schedule(reminder);
}

export function AddReminder(input: Omit<Reminder, "id">): Reminder {
	const reminder: Reminder = { id: randomUUID(), ...input };
	reminders.push(reminder);
	save();
	schedule(reminder);
	return reminder;
}

function schedule(reminder: Reminder) {
	const delay = reminder.fireAt - Date.now();
	if (delay > MAX_DELAY) {
		setTimeout(() => schedule(reminder), MAX_DELAY);
		return;
	}
	setTimeout(() => void fire(reminder), Math.max(0, delay));
}

async function fire(reminder: Reminder) {
	// dropped first, so a send failure (deleted channel, lost access) can't leave it re-firing every boot
	reminders = reminders.filter((r) => r.id !== reminder.id);
	save();
	try {
		const channel = await client.channels.fetch(reminder.channelId);
		if (channel?.isSendable()) {
			await channel.send({
				content: `<@${reminder.userId}> ⏰ ${reminder.message}`,
				allowedMentions: { users: [reminder.userId] },
			});
		}
	} catch (err) {
		console.error(`[reminder] failed to deliver ${reminder.id}:`, err);
	}
}
