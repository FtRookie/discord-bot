import { Config, Env } from "../Config.ts";
import { UserError } from "./Roblox.ts";

/**
 * Bot → Backend: the database server's bot API, reached over loopback on the same box. Its routes exist only
 * where the database has an `Access Tokens/BOT_TOKEN`, which must equal BACKEND_TOKEN here.
 */
export async function BackendRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
	let res: Response;
	try {
		res = await fetch(`${Config.backend.baseUrl}/bot${path}`, {
			method,
			headers: {
				Authorization: `Bearer ${Env("BACKEND_TOKEN")}`,
				...(body === undefined ? {} : { "Content-Type": "application/json" }),
			},
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(Config.backend.timeoutMs),
		});
	} catch (err) {
		throw new UserError(`Could not reach the database: ${err instanceof Error ? err.message : err}`);
	}

	if (res.status === 401)
		throw new UserError("The database rejected the bot's token — BACKEND_TOKEN must equal its BOT_TOKEN.");
	// routes are only mounted with a BOT_TOKEN, so a 404 on any of them means the integration is off
	if (res.status === 404) throw new UserError("The database has no bot API enabled — give it a BOT_TOKEN.");
	if (res.status === 422) throw new UserError("The database refused that input as malformed.");

	const parsed = (await res.json().catch(() => undefined)) as (T & { error?: string }) | undefined;
	if (!res.ok || parsed === undefined || parsed.error !== undefined) {
		throw new UserError(
			`Database responded ${res.status}${parsed?.error ? `: ${parsed.error.slice(0, 300)}` : ""}`,
		);
	}

	return parsed;
}
