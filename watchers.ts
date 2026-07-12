import type { Client } from "discord.js";
import { config, env } from "./config.ts";

// A game publish "arms" the announcer; a new changelog entry is only posted
// while armed, so an update that was never published is never announced.
// Edits to an already-announced entry go through at any time.
let lastPlaceUpdate: string | undefined;
let armedUntil = 0;

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
    if (!place.updateTime) return;

    // First successful poll after boot only seeds, so restarts never announce.
    const published = lastPlaceUpdate !== undefined && place.updateTime !== lastPlaceUpdate;
    lastPlaceUpdate = place.updateTime;
    if (!published) return;

    armedUntil = Date.now() + config.armWindowMs;
    console.log(`[publish] detected (place updated ${place.updateTime}) — announcements armed`);
    await syncChangelog(client);
}

let syncing = false;
let gatedHeading: string | undefined;

/**
 * Fetches UpdateLogs.ts and reconciles its newest entry with the channel:
 * edits the bot's existing announcement if the content changed, posts a new
 * announcement only while armed by a recent publish.
 */
async function syncChangelog(client: Client) {
    if (syncing) return;
    syncing = true;
    try {
        const { owner, repo, filePath } = config.github;
        const { testMode, pingRoleId } = config.discord;
        const channelId = testMode ? config.discord.testChannelId : config.discord.channelId;
        const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`, {
            headers: {
                Authorization: `Bearer ${env("GITHUB_TOKEN")}`,
                Accept: "application/vnd.github.raw+json",
            },
        });
        if (!res.ok) throw new Error(`GitHub API responded ${res.status}`);

        const entry = parseLatestEntry(await res.text());
        if (!entry) {
            console.warn("[changelog] no entry parsed — has the UpdateLogs.ts format changed?");
            return;
        }

        const message = formatUpdateMessage(entry, pingRoleId);
        const heading = message.split("\n")[0];

        const channel = await client.channels.fetch(channelId);
        if (!channel?.isSendable()) throw new Error(`Channel ${channelId} is not sendable`);

        const recent = await channel.messages.fetch({ limit: 50 });
        const existing = recent.find(
            (m) => m.author.id === m.client.user.id && m.content.split("\n")[0] === heading,
        );

        if (existing) {
            if (existing.content !== message) {
                await existing.edit(message);
                console.log(`[changelog] edited: ${heading}`);
            }
            return;
        }

        if (Date.now() >= armedUntil) {
            if (gatedHeading !== heading) {
                console.log(`[changelog] ${heading} is waiting for a game publish`);
                gatedHeading = heading;
            }
            return;
        }

        armedUntil = 0;
        await channel.send({
            content: message,
            allowedMentions: testMode ? { parse: [] } : undefined,
        });
        console.log(`[changelog] announced: ${heading}`);
    } finally {
        syncing = false;
    }
}

export type UpdateEntry = { header: string; date: string; lines: string[] };

export function parseLatestEntry(source: string): UpdateEntry | null {
    // Strip whole-line comments first: commented-out entries are unreleased
    // updates and must never be posted.
    const code = source
        .split("\n")
        .filter((line) => !line.trim().startsWith("//"))
        .join("\n");

    const m = code.match(/Header:\s*(?:"([^"]*)"|'([^']*)')[\s\S]*?Date:\s*"([^"]*)"\s*,\s*Content:\s*`([^`]*)`/);
    if (!m) return null;

    const header = (m[1] ?? m[2] ?? "").trim();
    const date = (m[3] ?? "").trim();
    const lines = (m[4] ?? "")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
    if (!header || !date || lines.length === 0) return null;

    return { header, date, lines };
}

/** Renders an entry as the Discord announcement, truncating to the 2000-char message limit. */
export function formatUpdateMessage(entry: UpdateEntry, pingRoleId: string): string {
    const quoted = entry.lines.map((line) => `> ${line}`);
    const wrap = (bullets: string[]) =>
        [`# Update ${entry.date} "${entry.header}"`, ...bullets, "", `|| <@&${pingRoleId}> ||`].join("\n");

    let kept = quoted.length;
    let message = wrap(quoted);
    while (message.length > 2000 && kept > 0) {
        kept--;
        message = wrap([...quoted.slice(0, kept), "> …"]);
    }
    return message;
}
