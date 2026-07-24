import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ApplicationCommandPermissionType, type Guild } from "discord.js";
import { config, env } from "../Config.ts";
import type { Command } from "../commands/Command.ts";
import { Perms } from "./Permissions.ts";

// Runtime token store at the repo root (gitignored), two levels up from src/helpers/.
const tokenFile = join(import.meta.dirname, "..", "..", config.oauth.tokenPath);
const TOKEN_URL = "https://discord.com/api/oauth2/token";

/**
 * Trade the stored refresh token for a fresh access token, persisting the rotated refresh token Discord
 * hands back (it invalidates the old one). Returns null when unauthorized or on failure, so the caller
 * degrades to no-op rather than throwing.
 */
async function accessToken(clientId: string): Promise<string | null> {
	let refresh: string;
	try {
		refresh = (JSON.parse(readFileSync(tokenFile, "utf8")) as { refresh_token: string }).refresh_token;
	} catch {
		return null; // never authorized — the bot just skips setting command permissions
	}

	const res = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: clientId,
			client_secret: env("DISCORD_CLIENT_SECRET"),
			grant_type: "refresh_token",
			refresh_token: refresh,
		}),
	}).catch(() => null);

	if (!res?.ok) {
		console.error(`[oauth] token refresh failed: ${res?.status ?? "network error"} ${(await res?.text()) ?? ""}`);
		return null;
	}
	const data = (await res.json()) as { access_token: string; refresh_token: string };
	writeFileSync(tokenFile, `${JSON.stringify({ refresh_token: data.refresh_token }, null, 4)}\n`);
	return data.access_token;
}

/**
 * Grant each gated command's managed role(s) visibility in the guild, so a non-admin holding the role can
 * see and run it — the same overrides you'd otherwise set by hand in Server Settings → Integrations. A role
 * is granted whenever its bit is part of the command's requirement; can() still enforces the full set on
 * invocation, so this only ever widens visibility, never access. No-op until `bun run authorize` has stored
 * a token. Visibility is permissive by design: for a multi-bit command, any qualifying role can see it.
 */
export async function syncCommandPermissions(
	guild: Guild,
	commands: Command[],
	roleForBit: Map<number, string>,
): Promise<void> {
	const app = guild.client.application;
	if (!app) return;
	const token = await accessToken(app.id);
	if (!token) return;

	const registered = await app.commands.fetch();
	const idByName = new Map(registered.map((command) => [command.name, command.id]));

	for (const command of commands) {
		if (command.permissions === Perms.None) continue;
		const commandId = idByName.get(command.data.name);
		if (!commandId) continue;

		const permissions = [...roleForBit]
			.filter(([bit]) => (command.permissions & bit) === bit)
			.map(([, roleId]) => ({ id: roleId, type: ApplicationCommandPermissionType.Role, permission: true }));
		if (permissions.length === 0) continue;

		await guild.commands.permissions
			.set({ command: commandId, token, permissions })
			.catch((err: unknown) => console.error(`[oauth] /${command.data.name} permissions failed:`, err));
	}
}
