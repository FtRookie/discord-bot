import type { Client } from "discord.js";
import { Config, Env } from "../Config.ts";
import { CloseCommand, KnownServers, PeekAcks } from "./AckServer.ts";
import { ClearState, GetState, PENDING_RESTART, SetState } from "./Database.ts";
import type { CommandEnvelope } from "./GameCommands.ts";
import { CreateCommand, GetCommand, PublishCommand } from "./GameCommands.ts";
import { RichTextToMarkdown } from "./RichText.ts";
import { RestartServers } from "./Roblox.ts";

// A publish opens a window in which the newest changelog entry may be posted, provided its date is within a
// day of the publish (timezone tolerance). Posting it, or finding it already posted, closes the window early.
// Edits to an already-posted entry go through at any time and never re-ping.
let lastPlaceUpdate: number | undefined;
let armedUntil = 0;
let armedPublishAt = 0;

export function StartWatchers(client: Client) {
	const every = (name: string, fn: () => Promise<void>) => {
		const run = async () => {
			try {
				await fn();
			} catch (err) {
				console.error(`[${name}] poll failed:`, err);
			}
		};
		void run();
		setInterval(run, Config.pollMs);
	};

	every("publish", () => checkGamePublish(client));
	every("changelog", () => syncChangelog(client));

	void resumePendingRestart();
}

async function checkGamePublish(client: Client) {
	const { universeId, placeId } = Config.roblox;
	const res = await fetch(`https://apis.roblox.com/cloud/v2/universes/${universeId}/places/${placeId}`, {
		headers: { "x-api-key": Env("ROBLOX_API_KEY") },
	});
	if (!res.ok) throw new Error(`Roblox API responded ${res.status}`);

	const place = (await res.json()) as { updateTime?: string };
	const updatedAt = Date.parse(place.updateTime ?? "");
	if (Number.isNaN(updatedAt)) return;

	// first poll after boot only seeds, so a restart never re-announces
	const published = lastPlaceUpdate !== undefined && updatedAt !== lastPlaceUpdate;
	lastPlaceUpdate = updatedAt;
	if (!published) return;

	armedUntil = Date.now() + Config.armWindowMs;
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
 * Reconciles the newest changelog entry with the channel: an existing announcement is edited whenever the
 * content changed, but a new one is only posted inside a window opened by a matching recent publish.
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

		const { testMode, pingRoleId } = Config.discord;
		const channelId = testMode ? Config.discord.testChannelId : Config.discord.channelId;
		// restrictive allow-list: stray mentions inside changelog text can never ping
		const allowedMentions = testMode ? { parse: [] } : { roles: [pingRoleId] };

		const channel = await client.channels.fetch(channelId);
		if (!channel?.isSendable()) throw new Error(`Channel ${channelId} is not sendable`);

		const heading = message.split("\n")[0];
		const recent = await channel.messages.fetch({ limit: 50 });
		const existing = recent.find((m) => m.author.id === m.client.user.id && m.content.split("\n")[0] === heading);

		if (existing) {
			armedUntil = 0; // this entry already announced the publish
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
		armedUntil = 0; // closed only once the send has succeeded
		lastSynced = message;
		console.log(`[changelog] announced: ${heading}`);
	} finally {
		syncing = false;
	}
}

let restartPending = false;

/**
 * Warn players in-game, then restart outdated servers once the warning window elapses. Runs on any publish,
 * changelog entry or not. Skipped in test mode, which must never touch real servers, and never throws, so it
 * cannot disrupt the publish poll.
 */
async function announceAndRestart() {
	if (Config.discord.testMode || restartPending) return;
	restartPending = true;

	// ttl derived from warnMs, so the countdown can't drift from the actual restart. The text carries no
	// duration of its own — the game states the time left, so a replay to a late joiner stays accurate.
	const command = CreateCommand("restart", {
		ttl: Math.round(Config.restart.warnMs / 1000),
		text: "A new update is live!",
	});

	// the command enters the log at creation, so a total push failure still reaches servers on their next
	// catch-up poll. Bailing out here would leave a command servers run anyway, with no restart behind it.
	if (!(await pushWithRetry(command))) {
		console.warn("[restart] push failed — servers will pick the command up on their next poll");
	}

	writePending({ commandId: command.id, restartAt: Date.now() + Config.restart.warnMs });
	scheduleRestart(command.id, Config.restart.warnMs);
}

/** The SAME envelope every attempt: a fresh id would warn players once per retry. */
async function pushWithRetry(command: CommandEnvelope): Promise<boolean> {
	for (let attempt = 1; attempt <= 3; attempt++) {
		try {
			await PublishCommand(command);
			return true;
		} catch (err) {
			console.error(`[restart] command push failed (attempt ${attempt}/3):`, err);
			if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 2_000));
		}
	}
	return false;
}

function scheduleRestart(commandId: string, delayMs: number) {
	// halfway, so a reissue still leaves stragglers a real warning rather than a formality
	setTimeout(() => void reissueIfShort(commandId), delayMs / 2);

	setTimeout(() => {
		CloseCommand(commandId);
		clearPending();
		RestartServers()
			.then(() => console.log("[restart] servers restarted for the new update"))
			.catch((err) => console.error("[restart] failed:", err))
			.finally(() => {
				restartPending = false;
			});
	}, delayMs);
}

/**
 * Short of the servers the acknowledgements collectively know about means someone never answered, so the same
 * command goes out once more — servers that already ran it recognise the id and re-acknowledge, which also
 * repairs an acknowledgement lost on the way back. Exactly once: a wedged or departed server must not block
 * every future command.
 */
async function reissueIfShort(commandId: string) {
	const acks = PeekAcks(commandId);
	const known = KnownServers(acks);
	console.log(`[restart] ${acks.length}/${known.size} servers acknowledged`);

	if (known.size <= acks.length) return;

	const command = GetCommand(commandId);
	if (!command) return;

	console.warn(`[restart] ${known.size - acks.length} server(s) silent — reissuing once`);
	await PublishCommand(command).catch((err) => console.error("[restart] reissue failed:", err));
}

type PendingRestart = { commandId: string; restartAt: number };

function writePending(state: PendingRestart) {
	try {
		SetState(PENDING_RESTART, JSON.stringify(state));
	} catch (err) {
		console.error("[restart] could not persist pending restart:", err);
	}
}

function clearPending() {
	ClearState(PENDING_RESTART);
}

/**
 * A restart scheduled before the process died still has to happen: players were warned for it, and the
 * publish poll re-seeds on boot, so nothing else would ever re-detect the rollout.
 */
async function resumePendingRestart() {
	if (Config.discord.testMode) return;

	const stored = GetState(PENDING_RESTART);
	if (!stored) return; // nothing pending is the normal case

	let state: PendingRestart;
	try {
		state = JSON.parse(stored) as PendingRestart;
	} catch {
		clearPending(); // unparseable, so it can never resume — drop it rather than trip every boot
		return;
	}

	const remaining = state.restartAt - Date.now();
	if (remaining > 0) {
		console.log(`[restart] resuming pending restart in ${Math.round(remaining / 1000)}s`);
		restartPending = true;
		scheduleRestart(state.commandId, remaining);
		return;
	}

	// overdue: the window expired while the bot was down and players have joined since, so the original
	// countdown means nothing to them — warn from scratch rather than restart into an unwarned shutdown
	console.warn("[restart] pending restart was overdue — re-warning with a fresh window");
	clearPending();
	await announceAndRestart();
}

let etag: string | undefined;
let cached: { message: string; date: string } | undefined;

async function fetchLatestAnnouncement(): Promise<{ message: string; date: string } | undefined> {
	const { owner, repo, filePath } = Config.github;
	const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`, {
		headers: {
			Authorization: `Bearer ${Env("GITHUB_TOKEN")}`,
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
	cached = { message: formatUpdateMessage(entry, Config.discord.pingRoleId), date: entry.date };
	return cached;
}

/** The publish must land within a day of either end of the entry's date, so any timezone pairing works. */
function matchesPublishDay(entryDate: string, publishAt: number): boolean {
	const day = Date.parse(`${entryDate}T00:00:00Z`);
	if (Number.isNaN(day) || publishAt === 0) return false;
	return publishAt >= day - 24 * 3_600_000 && publishAt < day + 48 * 3_600_000;
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	promise.catch(() => {}); // the race may settle first, leaving this rejection unhandled
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
	// commented-out entries are unreleased updates and must never be posted
	const code = source
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.split("\n")
		.filter((line) => !line.trim().startsWith("//"))
		.join("\n");

	// [^}]*? keeps the match inside one entry object, so a malformed entry can't borrow Date/Content from the next
	const m = code.match(
		/Header:\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')[^}]*?Date:\s*"(\d{4}-\d{2}-\d{2})"\s*,\s*Content:\s*`([^`]*)`/,
	);
	if (!m) return null;

	const header = RichTextToMarkdown((m[1] ?? m[2] ?? "").replace(/\\(.)/g, "$1")).trim();
	const date = m[3] ?? "";
	// convert the whole block first, so a <br/> becomes its own bullet line instead of an unquoted newline
	const lines = RichTextToMarkdown(m[4] ?? "")
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	if (!header || !date || lines.length === 0) return null;

	return { header, date, lines };
}

/** Bullets are dropped from the end until the message fits Discord's 2000-char limit. */
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
