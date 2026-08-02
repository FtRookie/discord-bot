import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "discord.js";

export type Reminder = { id: string; userId: string; channelId: string; message: string; fireAt: number };

// Runtime data lives at the repo root (gitignored), two levels up from src/helpers/.
const file = join(import.meta.dirname, "..", "..", "reminders.json");

// setTimeout takes a signed-32-bit delay; anything longer fires at once, so long waits are re-armed in chunks.
const MAX_DELAY = 2 ** 31 - 1;

let reminders: Reminder[] = load();
let client: Client;

function load(): Reminder[] {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return [];
	}
}

function save() {
	writeFileSync(file, `${JSON.stringify(reminders, null, 4)}\n`);
}

/** Re-arm every persisted reminder on boot; any that came due while the bot was down fire immediately. */
export function StartReminders(c: Client) {
	client = c;
	for (const reminder of reminders) schedule(reminder);
}

/** Persist a new reminder and arm it. */
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
	// Drop it first so a send failure (deleted channel, lost access) can't leave it re-firing on every boot.
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
