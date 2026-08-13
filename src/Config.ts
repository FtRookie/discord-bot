/** Bun loads .env automatically. */
export function Env(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`Missing required env var: ${name}`);
	return value;
}

export const Config = {
	pollMs: 60_000, // for roblox and github watcher
	armWindowMs: 2 * 60 * 60 * 1000, // how long after a publish an unposted changelog entry may still be announced
	roblox: {
		universeId: "10112329226",
		placeId: "86822363308738",
	},
	// auto-restart of live servers after a new update is announced
	restart: {
		warnMs: 60 * 1000, // warn players in-game, then restart outdated servers this long afterward
		statePath: "pending-restart.json", // relative to WorkingDirectory; gitignored
	},
	// inbound acknowledgements from live game servers. The client hits bot.ftrookie.com on 443; a Cloudflare
	// Origin Rule rewrites the port to nginx's 4434, which terminates TLS and reverse-proxies to the port below.
	ack: {
		hostname: "127.0.0.1", // loopback only, so Bun is never internet-facing and needs no firewall rule
		port: 1368, // arbitrary as long as nginx points here and nothing else on the box uses it (1367 is dbrelay's)
		path: "/ack", // acks go to `${path}/<commandId>`, leaving /command and friends free to split out later
		maxBodyBytes: 256 * 1024, // bounds the resource, not the server count: no real roster comes close
	},
	probe: {
		windowMs: 3000, // push is ~1s and acks return over HTTP, so a few seconds covers a healthy server
	},
	github: {
		owner: "FtRookie",
		repo: "overengineered",
		filePath: "src/client/UpdateLogs.ts",
	},
	mention: {
		rate: 3, // game-link replies per minute before the user is timed out
	},
	phrase: {
		timeoutMs: 5 * 60 * 1000, // timeout length for exceeding a per-minute rate (@-mention or phrase-response)
	},
	pixel: {
		targetSize: 256, // output edge length the source grid is nearest-neighbor upscaled toward
		windowMs: 60 * 1000, // per-user cooldown
		maxVisible: 1, // renders per window: fewer when posted publicly, more when kept ephemeral
		maxEphemeral: 5,
		maxUploadBytes: 8 * 1024 * 1024, // /pixerialize: bounds download and decode work
		maxSourcePixels: 4096 * 4096, // /pixerialize: guards decode memory
	},
	userid: {
		windowMs: 60 * 1000, // rolling window for per-user lookup rate limiting
		maxLookups: 5, // per window; the owner is exempt
	},
	discord: {
		guildId: "1504937260590829679", // the only guild the bot stays in; automatically leaves others
		testMode: false, // posts to testChannelId and renders the mention without notifying anyone
		channelId: "1504938210336178357",
		testChannelId: "1504994514719342743",
		pingRoleId: "1504937731745386496",
	},
	// One-time setup so the bot can set per-role command visibility itself, instead of by hand in Server
	// Settings → Integrations. That edit needs a *user* access token — a bot token is rejected — so
	// `bun run authorize` runs the consent flow once and stores the refresh token, which the bot refreshes on
	// startup. Needs DISCORD_CLIENT_ID/DISCORD_CLIENT_SECRET and the redirect URI registered in the portal.
	oauth: {
		redirectUri: "http://127.0.0.1:53134/callback",
		scope: "applications.commands.permissions.update",
		tokenPath: "oauth.json", // refresh-token store at the repo root; gitignored (it grants permission edits)
	},
};
