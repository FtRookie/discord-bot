import type { Message } from "discord.js";

/** What the log needs from a message, kept after Discord has forgotten it. */
export type Snapshot = {
	id: string;
	channelId: string;
	authorId: string;
	authorTag: string;
	content: string;
	attachments: string[];
	createdTimestamp: number;
};

export const WINDOW = 30; // messages kept per channel

// channel ID → its newest messages, oldest first. In memory only: a restart starts every window empty.
const windows = new Map<string, Snapshot[]>();

export function Snap(message: Message): Snapshot {
	return {
		id: message.id,
		channelId: message.channelId,
		authorId: message.author.id,
		authorTag: message.author.tag,
		content: message.content,
		attachments: message.attachments.map((a) => a.name),
		createdTimestamp: message.createdTimestamp,
	};
}

export function Remember(snapshot: Snapshot): void {
	const window = windows.get(snapshot.channelId) ?? [];
	window.push(snapshot);
	if (window.length > WINDOW) window.shift();
	windows.set(snapshot.channelId, window);
}

/** Keeps the archived copy current, so a later delete shows what the message last said. */
export function Revise(snapshot: Snapshot): void {
	const window = windows.get(snapshot.channelId);
	const index = window?.findIndex((s) => s.id === snapshot.id) ?? -1;
	if (window && index !== -1) window[index] = snapshot;
}

/** Removes and returns a message's archived copy, if the window still holds it. */
export function Forget(channelId: string, id: string): Snapshot | undefined {
	const window = windows.get(channelId);
	const index = window?.findIndex((s) => s.id === id) ?? -1;
	if (!window || index === -1) return undefined;
	return window.splice(index, 1)[0];
}

export function Channels(): Iterable<string> {
	return windows.keys();
}

export function Window(channelId: string): readonly Snapshot[] {
	return windows.get(channelId) ?? [];
}

/**
 * The archived messages Discord no longer has. `present` is every ID a fetch returned, and `newestChecked` the
 * newest ID that fetch could have covered — anything past it is unknown rather than missing, so it is left
 * alone. Snowflakes are compared numerically: they are time-ordered, but not as strings of differing length.
 */
export function Missing(channelId: string, present: ReadonlySet<string>, newestChecked?: string): Snapshot[] {
	const limit = newestChecked === undefined ? undefined : BigInt(newestChecked);
	return Window(channelId).filter((s) => !present.has(s.id) && (limit === undefined || BigInt(s.id) <= limit));
}
