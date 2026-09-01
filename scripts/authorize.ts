import { createServer } from "node:http";
import { Config, Env } from "../src/Config.ts";
import { SetRefreshToken } from "../src/helpers/RefreshToken.ts";

/**
 * One-time consent flow. Register `config.oauth.redirectUri` under the app's OAuth2 settings in the
 * Developer Portal, set DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET in the environment, then run
 * `bun run authorize`, open the printed URL, and approve. The refresh token lands in oauth.json, which the
 * bot reads on startup and rewrites on every rotation.
 */
const clientId = Env("DISCORD_CLIENT_ID");
const clientSecret = Env("DISCORD_CLIENT_SECRET");
const { redirectUri, scope } = Config.oauth;
const { port, pathname } = new URL(redirectUri);

const authUrl = `https://discord.com/oauth2/authorize?${new URLSearchParams({
	client_id: clientId,
	response_type: "code",
	redirect_uri: redirectUri,
	scope,
})}`;

console.log(`\n1. Open this URL in a browser and approve:\n\n${authUrl}\n`);

const server = createServer(async (req, res) => {
	const url = new URL(req.url ?? "/", redirectUri);
	if (url.pathname !== pathname) return void res.writeHead(404).end();

	const code = url.searchParams.get("code");
	if (!code) return void res.writeHead(400).end("Missing ?code — approve via the printed URL.");

	const token = await fetch("https://discord.com/api/oauth2/token", {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: clientId,
			client_secret: clientSecret,
			grant_type: "authorization_code",
			code,
			redirect_uri: redirectUri,
		}),
	});
	if (!token.ok) {
		console.error(`\nToken exchange failed: ${token.status}\n${await token.text()}`);
		res.writeHead(500).end("Token exchange failed — check the console.");
		server.close();
		process.exit(1);
	}

	const data = (await token.json()) as { refresh_token: string };
	SetRefreshToken(data.refresh_token);
	console.log("\n2. Saved the refresh token to oauth.json. Done — deploy that file and (re)start the bot.");

	res.writeHead(200).end("Authorized — you can close this tab.");
	server.close();
	setTimeout(() => process.exit(0), 100);
});

server.listen(Number(port), "127.0.0.1", () => console.log(`Waiting for the redirect on ${redirectUri} …`));
