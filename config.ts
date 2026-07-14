/** Read a required environment variable (Bun loads .env automatically). */
export function env(name: string): string {
    const value = process.env[name];
    if (!value) throw new Error(`Missing required env var: ${name}`);
    return value;
}

export const config = {
    pollMs: 60_000,
    /** How long after a publish a not-yet-posted changelog entry may still be announced. */
    armWindowMs: 2 * 60 * 60 * 1000,
    roblox: {
        universeId: "10112329226",
        placeId: "86822363308738",
    },
    github: {
        owner: "FtRookie",
        repo: "overengineered",
        filePath: "src/client/UpdateLogs.ts",
    },
    mention: {
        /** Rolling window for counting bot pings per user. */
        windowMs: 5 * 60 * 1000,
        /** Pings allowed within the window; exceeding this triggers a timeout. */
        maxPings: 3,
        /** How long the offending user is timed out. */
        timeoutMs: 5 * 60 * 1000,
    },
    discord: {
        /** Test mode posts to testChannelId and renders the mention without notifying anyone. */
        testMode: false,
        channelId: "1504938210336178357",
        testChannelId: "1504994514719342743",
        pingRoleId: "1504937731745386496",
    },
};
