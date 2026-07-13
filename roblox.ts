import { config, env } from "./config.ts";

// Roblox Open Cloud v2 user-restrictions (game bans):
// https://create.roblox.com/docs/cloud/reference/features/bans-and-blocks

export type GameJoinRestriction = {
    active?: boolean;
    startTime?: string;
    /** Seconds with an "s" suffix, e.g. "86400s". Absent means permanent. */
    duration?: string;
    privateReason?: string;
    displayReason?: string;
    excludeAltAccounts?: boolean;
    inherited?: boolean;
};

export type UserRestriction = {
    path?: string;
    updateTime?: string;
    user?: string;
    gameJoinRestriction?: GameJoinRestriction;
};

export type BanLogEntry = {
    /** "users/123" */
    user?: string;
    /** Set only when the change was made at place level, e.g. "places/456". */
    place?: string;
    moderator?: { robloxUser?: string; gameServerScript?: unknown };
    createTime?: string;
    active?: boolean;
    startTime?: string;
    duration?: string;
    privateReason?: string;
    displayReason?: string;
    excludeAltAccounts?: boolean;
};

/** Expected failures (bad input, missing user, rate limits) shown to the moderator as-is. */
export class UserError extends Error {}

class HttpError extends Error {
    constructor(readonly status: number, message: string) {
        super(message);
    }
}

/** Keeps echoed user input short enough for Discord's message limit. */
const shown = (input: string) => (input.length > 60 ? `${input.slice(0, 60)}…` : input);

const restrictionsUrl = `https://apis.roblox.com/cloud/v2/universes/${config.roblox.universeId}/user-restrictions`;

async function cloudFetch<T>(url: string, init?: RequestInit): Promise<T> {
    const res = await fetch(url, {
        ...init,
        headers: {
            "x-api-key": env("ROBLOX_API_KEY"),
            ...(init?.body ? { "Content-Type": "application/json" } : {}),
        },
        signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 401 || res.status === 403) {
        throw new UserError(
            `Roblox rejected the request (${res.status}) — make sure the API key has read and write ` +
            "permissions for user-restrictions on this universe.",
        );
    }
    if (res.status === 429) {
        throw new UserError(
            "Rate limited by Roblox — try again shortly. (Ban updates are capped at 2 per minute per user.)",
        );
    }
    if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new HttpError(res.status, `Roblox API responded ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`);
    }
    return (await res.json()) as T;
}

export async function getRestriction(userId: number): Promise<UserRestriction | undefined> {
    try {
        return await cloudFetch<UserRestriction>(`${restrictionsUrl}/${userId}`);
    } catch (err) {
        if (err instanceof HttpError && err.status === 404) return undefined; // never restricted
        throw err;
    }
}

/** The restriction is replaced atomically, so every field to keep must be sent. */
export function updateRestriction(userId: number, gameJoinRestriction: GameJoinRestriction): Promise<UserRestriction> {
    return cloudFetch<UserRestriction>(`${restrictionsUrl}/${userId}?updateMask=gameJoinRestriction`, {
        method: "PATCH",
        body: JSON.stringify({ gameJoinRestriction }),
    });
}

export function listBanLogs(userId?: number): Promise<{ logs?: BanLogEntry[] }> {
    const params = new URLSearchParams({ maxPageSize: "10" });
    if (userId !== undefined) params.set("filter", `user == 'users/${userId}'`);
    return cloudFetch(`${restrictionsUrl}:listLogs?${params}`);
}

export type RobloxUser = { id: number; name: string; displayName: string };

async function usersFetch<T>(url: string, body?: unknown): Promise<T> {
    const res = await fetch(url, {
        method: body === undefined ? "GET" : "POST",
        headers: body === undefined ? undefined : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new HttpError(res.status, `Roblox users API responded ${res.status}`);
    return (await res.json()) as T;
}

/** Accepts a numeric user ID or a username (leading @ tolerated). */
export async function resolveUser(input: string): Promise<RobloxUser> {
    const query = input.trim().replace(/^@/, "");
    if (/^\d+$/.test(query)) {
        try {
            return await usersFetch<RobloxUser>(`https://users.roblox.com/v1/users/${query}`);
        } catch (err) {
            // Only a definite 404 means the account doesn't exist; a 429/5xx/timeout must
            // surface as a failure, not convince the moderator the ID is wrong.
            if (err instanceof HttpError && err.status === 404) {
                throw new UserError(`No Roblox user with ID ${shown(query)}.`);
            }
            throw err;
        }
    }
    const { data } = await usersFetch<{ data: RobloxUser[] }>(
        "https://users.roblox.com/v1/usernames/users",
        { usernames: [query], excludeBannedUsers: false },
    );
    const user = data[0];
    if (!user) throw new UserError(`No Roblox user named "${shown(query)}".`);
    return user;
}

/** Usernames in the log are cosmetic; on lookup failure fall back to raw IDs. */
export async function lookupNames(ids: number[]): Promise<Map<number, string>> {
    if (ids.length === 0) return new Map();
    try {
        const { data } = await usersFetch<{ data: RobloxUser[] }>(
            "https://users.roblox.com/v1/users",
            { userIds: ids, excludeBannedUsers: false },
        );
        return new Map(data.map((u) => [u.id, u.name]));
    } catch {
        return new Map();
    }
}

const UNIT_SECONDS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 };
/** API bound: 1 second to 315,576,000,000 seconds (10,000 years). */
const MAX_DURATION_SECONDS = 315_576_000_000;

export function parseDurationSeconds(input: string): number {
    const compact = input.trim().toLowerCase().replace(/\s+/g, "");
    if (!/^(\d+[smhdw])+$/.test(compact)) {
        throw new UserError(
            `Invalid duration "${shown(input)}" — use forms like \`30m\`, \`12h\`, \`7d\`, \`1w2d\`, or omit it for a permanent ban.`,
        );
    }
    let seconds = 0;
    for (const [, count, unit] of compact.matchAll(/(\d+)([smhdw])/g)) {
        seconds += Number(count) * (UNIT_SECONDS[unit ?? ""] ?? 0);
    }
    if (seconds < 1 || seconds > MAX_DURATION_SECONDS) {
        throw new UserError("Duration must be between 1 second and 10,000 years.");
    }
    return seconds;
}

export function formatDuration(apiDuration: string | undefined): string {
    const total = Number(apiDuration?.replace(/s$/, ""));
    if (!apiDuration || !Number.isFinite(total) || total <= 0) return "permanent";
    const parts: string[] = [];
    let rest = Math.round(total);
    for (const [unit, size] of [["w", 604800], ["d", 86400], ["h", 3600], ["m", 60], ["s", 1]] as const) {
        const n = Math.floor(rest / size);
        if (n > 0) {
            parts.push(`${n}${unit}`);
            rest -= n * size;
        }
    }
    return parts.join(" ") || "0s";
}

/** "<t:…:R>" Discord timestamp for when a timed ban ends, if computable. */
export function expiryTimestamp(r: GameJoinRestriction): string | undefined {
    if (!r.duration) return undefined;
    const start = Date.parse(r.startTime ?? "");
    const seconds = Number(r.duration.replace(/s$/, ""));
    if (Number.isNaN(start) || !Number.isFinite(seconds)) return undefined;
    return `<t:${Math.floor(start / 1000) + Math.round(seconds)}:R>`;
}

export function relativeTime(iso: string | undefined): string {
    const ms = Date.parse(iso ?? "");
    return Number.isNaN(ms) ? "" : `<t:${Math.floor(ms / 1000)}:R>`;
}
