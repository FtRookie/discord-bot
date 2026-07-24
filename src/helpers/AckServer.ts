import { timingSafeEqual } from "node:crypto";
import { Elysia, t } from "elysia";
import { config, env } from "../Config.ts";
import { commandsSince } from "./Commands.ts";

/**
 * Game-side derivation: `PrivateServerId == ""` → public; otherwise `PrivateServerOwnerId ~= 0` → private
 * (a player's VIP server), else reserved (created via `TeleportService:ReserveServer`).
 */
export type ServerKind = "public" | "private" | "reserved";

/**
 * What a server did with a command, ordered executing → no-op. `Success | Refused | Fail` are the engaged
 * tier — that server was the one to act on it; `Nothing | Unsupported` mean it wasn't (not applicable here,
 * or no such handler — a stale build). Whether a server answered *at all* is a separate axis, resolved
 * against the roster, never a value here.
 */
export type Outcome = "Success" | "Refused" | "Fail" | "Nothing" | "Unsupported";

export type CommandAck = {
	jobId: string;
	outcome: Outcome;
	response?: string;
	/**
	 * What kind of server answered. Optional on purpose: a required field would 422 every acknowledgement
	 * from a game build that predates it, so the rollout order stops mattering. Only ever known for servers
	 * that answered directly — `roster` carries jobIds alone, so peer-attested entries have no kind.
	 */
	kind?: ServerKind;
	/** jobIds this server currently believes are alive, after its own last-seen expiry. */
	roster: string[];
};

const RANK: Record<Outcome, number> = { Success: 0, Refused: 1, Fail: 2, Nothing: 3, Unsupported: 4 };
/** The engaged tier: this server was the one to act on the command (Success, Refused, or Fail). */
export const acted = (o: Outcome): boolean => RANK[o] <= RANK.Fail;

export type TargetedVerdict =
	| { readonly kind: "acted"; readonly ack: CommandAck; readonly outcome: Outcome }
	| { readonly kind: "unconfirmed"; readonly stale: CommandAck[] }
	| { readonly kind: "absent"; readonly answered: number }
	| { readonly kind: "silent" };

/**
 * Collapses a targeted command's acknowledgements — at most one server can act — into a verdict: the actor
 * if one answered; else "unconfirmed" if any server was too stale to check (so "absent" can't be proven);
 * else "absent" if every answer was Nothing; else "silent" if nobody answered.
 */
export function targetedVerdict(acks: CommandAck[]): TargetedVerdict {
	const actor = acks.find((ack) => acted(ack.outcome));
	if (actor) return { kind: "acted", ack: actor, outcome: actor.outcome };

	const stale = acks.filter((ack) => ack.outcome === "Unsupported");
	if (stale.length > 0) return { kind: "unconfirmed", stale };

	if (acks.length > 0) return { kind: "absent", answered: acks.length };
	return { kind: "silent" };
}

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
	outcome: t.Union([
		t.Literal("Success"),
		t.Literal("Refused"),
		t.Literal("Fail"),
		t.Literal("Nothing"),
		t.Literal("Unsupported"),
	]),
	response: t.Optional(t.String({ maxLength: 2000 })),
	kind: t.Optional(t.Union([t.Literal("public"), t.Literal("private"), t.Literal("reserved")])),
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
				console.log(`[game] ack ${params.id} from ${body.jobId} ${body.outcome}`);
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
