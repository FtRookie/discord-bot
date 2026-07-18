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
	pixel: {
		/** Target output edge length; the source grid is nearest-neighbor upscaled toward this. */
		targetSize: 256,
		/** Rolling window for per-user render rate limiting. */
		windowMs: 60 * 1000,
		/** Renders allowed per window: fewer when posted publicly, more when kept ephemeral. */
		maxVisible: 1,
		maxEphemeral: 5,
		/** /unpixel: reject uploads larger than this to bound download and decode work. */
		maxUploadBytes: 8 * 1024 * 1024,
		/** /unpixel: reject source images with more pixels than this (guards decode memory). */
		maxSourcePixels: 1024 * 1024,
	},
	discord: {
		/** The only guild the bot stays in; it leaves any other. */
		guildId: "1504937260590829679",
		/** The only user allowed to run commands. */
		ownerId: "484529511468236802",
		/** Test mode posts to testChannelId and renders the mention without notifying anyone. */
		testMode: false,
		channelId: "1504938210336178357",
		testChannelId: "1504994514719342743",
		/** Updates ping role */
		pingRoleId: "1504937731745386496",
	},
};
