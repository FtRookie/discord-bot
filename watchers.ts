import type { Client, SendableChannels } from "discord.js";
import { config, env } from "./config.ts";

// A game publish "arms" the announcer; a new changelog entry is posted only
// while armed AND dated within a day of the publish (timezone tolerance).
// Finding the entry already posted consumes the arm. Edits to an
// already-posted entry go through at any time and never re-ping.
let lastPlaceUpdate: number | undefined;
let armedUntil = 0;
let armedPublishAt = 0;

export function startWatchers(client: Client) {
	const every = (name: string, fn: () => Promise<void>) => {
		const run = async () => {
			try {
				await fn();
			} catch (err) {
				console.error(`[${name}] poll failed:`, err);
			}
		};
		void run();
		setInterval(run, config.pollMs);
	};

	every("publish", () => checkGamePublish(client));
	every("changelog", () => syncChangelog(client));
}

/** Detects a publish via the root place's updateTime and arms the announcer. */
async function checkGamePublish(client: Client) {
	const { universeId, placeId } = config.roblox;
	const res = await fetch(`https://apis.roblox.com/cloud/v2/universes/${universeId}/places/${placeId}`, {
		headers: { "x-api-key": env("ROBLOX_API_KEY") },
	});
	if (!res.ok) throw new Error(`Roblox API responded ${res.status}`);

	const place = (await res.json()) as { updateTime?: string };
	const updatedAt = Date.parse(place.updateTime ?? "");
	if (Number.isNaN(updatedAt)) return;

	// First successful poll after boot only seeds, so restarts never announce.
	const published = lastPlaceUpdate !== undefined && updatedAt !== lastPlaceUpdate;
	lastPlaceUpdate = updatedAt;
	if (!published) return;

	armedUntil = Date.now() + config.armWindowMs;
	armedPublishAt = updatedAt;
	lastSynced = undefined;
	console.log(`[publish] detected (place updated ${place.updateTime}) — announcements armed`);
	await syncChangelog(client);
}

let syncing = false;
let lastSynced: string | undefined;
let lastHoldLog: string | undefined;

/**
 * Reconciles the newest changelog entry with the channel: edits the bot's
 * existing announcement when the content changed, posts a new announcement
 * only while armed by a matching recent publish.
 */
async function syncChangelog(client: Client) {
	if (syncing) return;
	syncing = true;
	try {
		const latest = await fetchLatestAnnouncement();
		if (!latest) return;
		const { message, date } = latest;

		const armed = Date.now() < armedUntil;
		if (message === lastSynced && !armed) return; // nothing changed since the last full sync

		const { testMode, pingRoleId } = config.discord;
		const channelId = testMode ? config.discord.testChannelId : config.discord.channelId;
		// Restrictive allow-list: stray mentions inside changelog text can never ping.
		const allowedMentions = testMode ? { parse: [] } : { roles: [pingRoleId] };

		const channel = await client.channels.fetch(channelId);
		if (!channel?.isSendable()) throw new Error(`Channel ${channelId} is not sendable`);

		const heading = message.split("\n")[0];
		const recent = await channel.messages.fetch({ limit: 50 });
		const existing = recent.find((m) => m.author.id === m.client.user.id && m.content.split("\n")[0] === heading);

		if (existing) {
			armedUntil = 0; // this entry already announces the publish
			if (existing.content !== message) {
				await withTimeout(existing.edit({ content: message, allowedMentions }), 30_000, "edit");
				console.log(`[changelog] edited: ${heading}`);
			}
			lastSynced = message;
			return;
		}

		const hold = (reason: string) => {
			if (lastHoldLog !== `${heading}|${reason}`) {
				console.log(`[changelog] ${heading} ${reason}`);
				lastHoldLog = `${heading}|${reason}`;
			}
			lastSynced = message;
		};
		if (!armed) return hold("is waiting for a game publish");
		if (!matchesPublishDay(date, armedPublishAt)) {
			return hold(`is dated ${date}, which doesn't match the publish day — holding`);
		}

		await withTimeout(channel.send({ content: message, allowedMentions }) as Promise<unknown>, 30_000, "send");
		armedUntil = 0; // consume the arm only once the send has succeeded
		lastSynced = message;
		console.log(`[changelog] announced: ${heading}`);
	} finally {
		syncing = false;
	}
}

let etag: string | undefined;
let cached: { message: string; date: string } | undefined;

/** Fetches UpdateLogs.ts (conditionally via ETag) and formats its newest entry. */
async function fetchLatestAnnouncement(): Promise<{ message: string; date: string } | undefined> {
	const { owner, repo, filePath } = config.github;
	const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`, {
		headers: {
			Authorization: `Bearer ${env("GITHUB_TOKEN")}`,
			Accept: "application/vnd.github.raw+json",
			...(etag ? { "If-None-Match": etag } : {}),
		},
	});
	if (res.status === 304) return cached;
	if (!res.ok) throw new Error(`GitHub API responded ${res.status}`);

	etag = res.headers.get("etag") ?? undefined;
	const entry = parseLatestEntry(await res.text());
	if (!entry) {
		console.warn("[changelog] no entry parsed — has the UpdateLogs.ts format changed?");
		cached = undefined;
		return undefined;
	}
	cached = { message: formatUpdateMessage(entry, config.discord.pingRoleId), date: entry.date };
	return cached;
}

/** The publish must land on the entry's date ±1 day, so any timezone pairing works. */
function matchesPublishDay(entryDate: string, publishAt: number): boolean {
	const day = Date.parse(`${entryDate}T00:00:00Z`);
	if (Number.isNaN(day) || publishAt === 0) return false;
	return publishAt >= day - 24 * 3_600_000 && publishAt < day + 48 * 3_600_000;
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	promise.catch(() => {}); // the race may settle first; don't leave an unhandled rejection behind
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s — will retry`)), ms);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

type UpdateEntry = { header: string; date: string; lines: string[] };

function parseLatestEntry(source: string): UpdateEntry | null {
	// Commented-out entries are unreleased updates and must never be posted:
	// drop block comments, then whole-line // comments.
	const code = source
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.split("\n")
		.filter((line) => !line.trim().startsWith("//"))
		.join("\n");

	// [^}]*? keeps the match inside one entry object, so a malformed entry
	// can never borrow Date/Content from the next one.
	const m = code.match(
		/Header:\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')[^}]*?Date:\s*"(\d{4}-\d{2}-\d{2})"\s*,\s*Content:\s*`([^`]*)`/,
	);
	if (!m) return null;

	const header = (m[1] ?? m[2] ?? "").replace(/\\(.)/g, "$1").trim();
	const date = m[3] ?? "";
	const lines = (m[4] ?? "")
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	if (!header || !date || lines.length === 0) return null;

	return { header, date, lines };
}

/** Renders an entry as the Discord announcement, kept inside the 2000-char message limit. */
function formatUpdateMessage(entry: UpdateEntry, pingRoleId: string): string {
	const title = entry.header.slice(0, 200);
	const quoted = entry.lines.map((line) => `> ${line}`);
	const wrap = (bullets: string[]) =>
		[`# Update ${entry.date} "${title}"`, ...bullets, "", `|| <@&${pingRoleId}> ||`].join("\n");

	let kept = quoted.length;
	let message = wrap(quoted);
	while (message.length > 2000 && kept > 0) {
		kept--;
		message = wrap([...quoted.slice(0, kept), "> …"]);
	}
	return message;
}
