import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ApplicationCommandPermissionType, type Guild } from "discord.js";
import { Config, Env } from "../Config.ts";
import type { Command } from "../commands/Command.ts";
import { Perms } from "./Permissions.ts";

// Runtime token store at the repo root (gitignored), two levels up from src/helpers/.
const tokenFile = join(import.meta.dirname, "..", "..", Config.oauth.tokenPath);
const TOKEN_URL = "https://discord.com/api/oauth2/token";

/**
 * Discord rotates the refresh token on every exchange and invalidates the old one, so the new one is
 * persisted here. Null on failure or when unauthorized, so the caller degrades to a no-op rather than throws.
 */
async function accessToken(clientId: string): Promise<string | null> {
	let refresh: string;
	try {
		refresh = (JSON.parse(readFileSync(tokenFile, "utf8")) as { refresh_token: string }).refresh_token;
	} catch {
		return null; // never authorized, so the bot skips setting command permissions
	}

	const res = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: clientId,
			client_secret: Env("DISCORD_CLIENT_SECRET"),
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
 * Give each gated command's managed roles visibility, the same overrides you'd otherwise set by hand in
 * Server Settings → Integrations. A role is granted whenever its bit is part of the command's requirement,
 * so for a multi-bit command any one qualifying role can see it — Can() still enforces the full set on
 * invocation, which keeps this widening visibility only, never access. No-op until `bun run authorize` has
 * stored a token.
 */
export async function SyncCommandPermissions(
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
		const commandId = idByName.get(command.data.name);
		if (!commandId) continue;

		const permissions =
			command.permissions === Perms.None
				? []
				: [...roleForBit]
						.filter(([bit]) => (command.permissions & bit) === bit)
						.map(([, roleId]) => ({
							id: roleId,
							type: ApplicationCommandPermissionType.Role,
							permission: true,
						}));

		// a one-shot command hides behind the role it hands out, so holders stop seeing it entirely
		if (command.hiddenFromRole) {
			const role = guild.roles.cache.find((r) => r.name === command.hiddenFromRole);
			if (role) {
				permissions.push({ id: role.id, type: ApplicationCommandPermissionType.Role, permission: false });
			}
		}

		if (permissions.length === 0) continue;

		await guild.commands.permissions
			.set({ command: commandId, token, permissions })
			.catch((err: unknown) => console.error(`[oauth] /${command.data.name} permissions failed:`, err));
	}
}
