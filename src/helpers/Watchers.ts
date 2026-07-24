import { readFile, unlink, writeFile } from "node:fs/promises";
import type { Client } from "discord.js";
import { config, env } from "../Config.ts";
import { closeCommand, knownServers, peekAcks } from "./AckServer.ts";
import type { CommandEnvelope } from "./Commands.ts";
import { createCommand, getCommand, publishCommand } from "./Commands.ts";
import { restartServers } from "./Roblox.ts";

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

	void resumePendingRestart();
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
	void announceAndRestart(); // any publish rolls out to outdated servers, changelog entry or not
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

/** Prevents scheduling a second restart while one is already pending. */
let restartPending = false;

/**
 * A publish rolled out a new version — warn players in-game, then restart outdated servers once the warning
 * window elapses. Runs on any publish, changelog entry or not. Skipped in test mode (it must never touch real
 * servers). Never throws, so it can't disrupt the publish poll.
 */
async function announceAndRestart() {
	if (config.discord.testMode || restartPending) return;
	restartPending = true;

	// `ttl` is derived from warnMs, so the countdown can never drift from the actual restart. The text
	// carries no duration of its own: the game states the exact time left, which keeps a replay to a late
	// joiner as accurate as the original broadcast.
	const command = createCommand("restart", {
		ttl: Math.round(config.restart.warnMs / 1000),
		text: "A new update is live!",
	});

	// The command is in the log the moment it is created, so even a total push failure still reaches servers
	// on their next catch-up poll. Proceeding is therefore the consistent choice: deferring would leave a
	// command that servers execute anyway, warning players about a restart that never comes.
	if (!(await pushWithRetry(command))) {
		console.warn("[restart] push failed — servers will pick the command up on their next poll");
	}

	await writePending({ commandId: command.id, restartAt: Date.now() + config.restart.warnMs });
	scheduleRestart(command.id, config.restart.warnMs);
}

/** Re-pushes the SAME envelope; a fresh id per attempt would warn players once per retry. */
async function pushWithRetry(command: CommandEnvelope): Promise<boolean> {
	for (let attempt = 1; attempt <= 3; attempt++) {
		try {
			await publishCommand(command);
			return true;
		} catch (err) {
			console.error(`[restart] command push failed (attempt ${attempt}/3):`, err);
			if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 2_000));
		}
	}
	return false;
}

function scheduleRestart(commandId: string, delayMs: number) {
	// Halfway, so a reissue still leaves stragglers a real warning rather than a formality.
	setTimeout(() => void reissueIfShort(commandId), delayMs / 2);

	setTimeout(() => {
		closeCommand(commandId);
		void clearPending();
		restartServers()
			.then(() => console.log("[restart] servers restarted for the new update"))
			.catch((err) => console.error("[restart] failed:", err))
			.finally(() => {
				restartPending = false;
			});
	}, delayMs);
}

/**
 * Compares acknowledgements against the servers those acknowledgements collectively know about. Short means
 * someone never answered, so the same command goes out once more — servers that already ran it recognise the
 * id and simply re-acknowledge, which also repairs an acknowledgement lost on the way back.
 *
 * Exactly one reissue: a wedged or departed server must not block every future command.
 */
async function reissueIfShort(commandId: string) {
	const acks = peekAcks(commandId);
	const known = knownServers(acks);
	console.log(`[restart] ${acks.length}/${known.size} servers acknowledged`);

	if (known.size <= acks.length) return;

	const command = getCommand(commandId);
	if (!command) return;

	console.warn(`[restart] ${known.size - acks.length} server(s) silent — reissuing once`);
	await publishCommand(command).catch((err) => console.error("[restart] reissue failed:", err));
}

type PendingRestart = { commandId: string; restartAt: number };

async function writePending(state: PendingRestart) {
	try {
		await writeFile(config.restart.statePath, JSON.stringify(state));
	} catch (err) {
		console.error("[restart] could not persist pending restart:", err);
	}
}

async function clearPending() {
	await unlink(config.restart.statePath).catch(() => {});
}

/**
 * A restart scheduled before the process died still has to happen — otherwise players were warned for a
 * restart that silently never arrives, and the rollout is skipped (the publish poll re-seeds on boot and
 * won't re-detect it).
 */
async function resumePendingRestart() {
	if (config.discord.testMode) return;

	let state: PendingRestart;
	try {
		state = JSON.parse(await readFile(config.restart.statePath, "utf8")) as PendingRestart;
	} catch {
		return; // nothing pending, which is the normal case
	}

	const remaining = state.restartAt - Date.now();
	if (remaining > 0) {
		console.log(`[restart] resuming pending restart in ${Math.round(remaining / 1000)}s`);
		restartPending = true;
		scheduleRestart(state.commandId, remaining);
		return;
	}

	// Overdue: the window expired while we were down and players have joined since, so the original
	// countdown is meaningless. Warn again from scratch rather than restarting into an unwarned shutdown.
	console.warn("[restart] pending restart was overdue — re-warning with a fresh window");
	await clearPending();
	await announceAndRestart();
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
