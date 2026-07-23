import { timingSafeEqual } from "node:crypto";
import { Elysia, t } from "elysia";
import { config, env } from "../Config.ts";

const equals = (a: string, b: string) => {
	const left = Buffer.from(a);
	const right = Buffer.from(b);
	return left.length === right.length && timingSafeEqual(left, right);
};

/**
 * The bot's inbound half of the game↔bot pipe. Minimal by intent: authenticate the caller, accept a JSON
 * body, log it. Command/ack semantics are layered on later — this exists only to establish that a live game
 * server can reach the bot through Cloudflare at all. Ack-only by design: a leaked secret forges a message,
 * never triggers an action.
 */
export function startGameChannel() {
	const expected = `Bearer ${env("GAME_SHARED_SECRET")}`;

	new Elysia()
		.onBeforeHandle(({ headers, set }) => {
			if (!equals(headers.authorization ?? "", expected)) {
				set.status = 401;
				return "Unauthorized";
			}
		})
		.post(
			config.ack.path,
			({ body }) => {
				console.log(`[game] received: ${JSON.stringify(body)}`);
				return { ok: true };
			},
			{ body: t.Unknown() },
		)
		.listen({ hostname: config.ack.hostname, port: config.ack.port });

	console.log(`[game] channel listening on ${config.ack.hostname}:${config.ack.port}${config.ack.path}`);
}
