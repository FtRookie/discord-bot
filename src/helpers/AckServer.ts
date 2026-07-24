import { timingSafeEqual } from "node:crypto";
import { Elysia, t } from "elysia";
import { config, env } from "../Config.ts";
import { commandsSince } from "./Commands.ts";

export type CommandAck = {
	jobId: string;
	ok: boolean;
	response?: string;
	/** jobIds this server currently believes are alive, after its own last-seen expiry. */
	roster: string[];
};

/** commandId -> jobId -> ack. Only ids the bot issued are ever inserted, so this cannot be grown remotely. */
const pending = new Map<string, Map<string, CommandAck>>();

/** Call before publishing a command, so its acknowledgements have somewhere to land. */
export function openCommand(id: string) {
	pending.set(id, new Map());
}

export function peekAcks(id: string): CommandAck[] {
	return [...(pending.get(id)?.values() ?? [])];
}

export function closeCommand(id: string): CommandAck[] {
	const acks = peekAcks(id);
	pending.delete(id);
	return acks;
}

/**
 * Every server anyone reported, unioned across acknowledgements.
 *
 * Views legitimately disagree — a server that started seconds ago isn't in everyone's map yet, a dying one
 * expires at slightly different moments, and the occasional announce is dropped. Union deliberately errs
 * toward believing a server exists, because the two mistakes are not symmetric: over-counting costs one
 * wasted reissue (servers that already ran the command ignore the repeat by id), while under-counting means
 * a live server silently never receives it.
 */
export function knownServers(acks: CommandAck[]): Set<string> {
	const all = new Set<string>();
	for (const ack of acks) {
		all.add(ack.jobId);
		for (const jobId of ack.roster) all.add(jobId);
	}
	return all;
}

const equals = (a: string, b: string) => {
	const left = Buffer.from(a);
	const right = Buffer.from(b);
	return left.length === right.length && timingSafeEqual(left, right);
};

/**
 * Acknowledgements are uniform across every command — status plus a human-readable result — so unlike the
 * command envelope this has one fixed shape, and it is the only side that needs runtime validation: it is
 * where bytes from outside cross into the bot.
 */
const AckBody = t.Object({
	jobId: t.String({ minLength: 1, maxLength: 64 }),
	ok: t.Boolean(),
	response: t.Optional(t.String({ maxLength: 2000 })),
	// Deliberately uncapped in length: how many servers exist is not ours to limit, and a maxItems ceiling
	// would reject every acknowledgement the day it were crossed. Runaway payloads are bounded by
	// maxRequestBodySize instead, which caps the resource without inventing a server-count limit.
	roster: t.Array(t.String({ minLength: 1, maxLength: 64 })),
});

/**
 * The bot's inbound half of the game↔bot pipe: live game servers POST here to acknowledge a command they
 * were issued. Ack-only by design — a leaked secret forges an acknowledgement, never triggers an action.
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
			`${config.ack.path}/:id`,
			({ params, body }) => {
				const acks = pending.get(params.id);
				// An unrecognised id is a server answering a command that already concluded, or someone
				// probing. Either way it must not allocate.
				if (!acks) return new Response("Unknown command", { status: 409 });

				acks.set(body.jobId, body);
				console.log(`[game] ack ${params.id} from ${body.jobId} ok=${body.ok}`);
				return new Response(null, { status: 204 });
			},
			{ params: t.Object({ id: t.String({ minLength: 1, maxLength: 64 }) }), body: AckBody },
		)
		// Catch-up: whatever MessagingService dropped. Servers poll with the newest issuedAt they hold, so a
		// dropped push costs latency rather than a missed command.
		.get("/commands", ({ query }) => commandsSince(Number(query.since ?? 0)), {
			query: t.Object({ since: t.Optional(t.String()) }),
		})
		.listen({
			hostname: config.ack.hostname,
			port: config.ack.port,
			maxRequestBodySize: config.ack.maxBodyBytes,
		});

	console.log(`[game] channel listening on ${config.ack.hostname}:${config.ack.port}`);
}
