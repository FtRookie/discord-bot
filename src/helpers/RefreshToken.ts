import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Deliberately not in data.db: this is a credential, and the database is copied, backed up and poked at as
// ordinary data. Repo root (gitignored), two levels up from src/helpers/.
const file = join(import.meta.dirname, "..", "..", "oauth.json");

/**
 * DISCORD_REFRESH_TOKEN seeds a deploy that has no stored token yet, and cannot be the permanent home:
 * Discord rotates the refresh token on every exchange and rejects the spent one with invalid_grant, so the
 * env value is dead after one startup and only the rewritten file survives.
 */
export function GetRefreshToken(): string | undefined {
	try {
		return (JSON.parse(readFileSync(file, "utf8")) as { refresh_token: string }).refresh_token;
	} catch {
		return process.env.DISCORD_REFRESH_TOKEN;
	}
}

export function SetRefreshToken(token: string): void {
	writeFileSync(file, `${JSON.stringify({ refresh_token: token }, null, 4)}\n`, { mode: 0o600 });
	chmodSync(file, 0o600); // writeFileSync's mode applies only when it creates the file
}
