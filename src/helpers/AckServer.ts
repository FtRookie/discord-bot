import { timingSafeEqual } from "node:crypto";
import { Elysia, t } from "elysia";
import { Config, Env } from "../Config.ts";
import { CommandsSince } from "./Commands.ts";

export type ServerKind = "public" | "private" | "reserved";

/**
 * Response code to a command the server replied with
 ** Success -> Successfully executed on this server
 ** Refused -> A condition was not met and the command could not be executed, includes Partial success
 ** Fail -> An argument was invalid or an unexpected error occured
 ** Nothing -> This server decided to not take action, or has already executed this command
 ** Unsupported -> This server does not understand the command, usually parity mismatch
 */
export type Outcome = "Success" | "Refused" | "Fail" | "Nothing" | "Unsupported";

export type CommandAck = {
	outcome: Outcome;
	response?: string;
	kind?: ServerKind;
	jobId: string; // the answering server's Roblox game.JobId
	roster: string[]; // jobIds it has seen announce themselves
};

const RANK: Record<Outcome, number> = {
	Success: 0,
	Refused: 1,
	Fail: 2,
	Nothing: 3,
	Unsupported: 4,
};

/** True when the server reached the command at all — anything but Nothing or Unsupported. */
export const Acted = (o: Outcome): boolean => RANK[o] <= RANK.Fail;

export type TargetedVerdict =
	| { readonly kind: "acted"; readonly ack: CommandAck; readonly outcome: Outcome }
	| { readonly kind: "unconfirmed"; readonly stale: CommandAck[] }
	| { readonly kind: "absent"; readonly answered: number }
	| { readonly kind: "silent" };

/**
 * At most one server can act on a targeted command, so its acknowledgements collapse to one verdict: the
 * actor if one answered, else "unconfirmed" when a server was too stale to check and "absent" therefore
 * can't be proven, else "absent" when every answer was Nothing, else "silent".
 */
export function TargetedVerdict(acks: CommandAck[]): TargetedVerdict {
	const actor = acks.find((ack) => Acted(ack.outcome));
	if (actor) return { kind: "acted", ack: actor, outcome: actor.outcome };

	const stale = acks.filter((ack) => ack.outcome === "Unsupported");
	if (stale.length > 0) return { kind: "unconfirmed", stale };

	if (acks.length > 0) return { kind: "absent", answered: acks.length };
	return { kind: "silent" };
}

// commandId → jobId → ack. Only ids the bot issued are ever inserted, so this cannot be grown remotely.
const pending = new Map<string, Map<string, CommandAck>>();

/** Call before publishing a command, so its acknowledgements have somewhere to land. */
export function OpenCommand(id: string) {
	pending.set(id, new Map());
}

export function PeekAcks(id: string): CommandAck[] {
	return [...(pending.get(id)?.values() ?? [])];
}

export function CloseCommand(id: string): CommandAck[] {
	const acks = PeekAcks(id);
	pending.delete(id);
	return acks;
}

/**
 * Every server anyone reported, unioned across acknowledgements. Views legitimately disagree — a server that
 * started seconds ago isn't in everyone's map yet, a dying one expires at slightly different moments, and the
 * occasional announce is dropped. Union errs toward believing a server exists because the two mistakes aren't
 * symmetric: over-counting costs one wasted reissue (already-run servers ignore the repeat by id), while
 * under-counting means a live server silently never receives the command.
 */
export function KnownServers(acks: CommandAck[]): Set<string> {
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

// Acknowledgements are uniform across every command, so unlike the envelope this has one fixed shape. It is
// also the only side needing runtime validation: it's where bytes from outside cross into the bot.
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
	// uncapped: a maxItems ceiling would reject every acknowledgement the day the roster crossed it.
	// maxRequestBodySize bounds runaway payloads instead, capping the resource without capping server count.
	roster: t.Array(t.String({ minLength: 1, maxLength: 64 })),
});

/**
 * The bot's inbound half of the game↔bot channel: live servers POST here to acknowledge a command they were
 * issued. Ack-only by design — a leaked secret forges an acknowledgement, and never triggers an action.
 */
export function StartGameChannel() {
	const expected = `Bearer ${Env("GAME_SHARED_SECRET")}`;

	new Elysia()
		.onBeforeHandle(({ headers, set }) => {
			if (!equals(headers.authorization ?? "", expected)) {
				set.status = 401;
				return "Unauthorized";
			}
		})
		.post(
			`${Config.ack.path}/:id`,
			({ params, body }) => {
				const acks = pending.get(params.id);
				// unrecognised id: a server answering a concluded command, or someone probing — must not allocate
				if (!acks) return new Response("Unknown command", { status: 409 });

				acks.set(body.jobId, body);
				console.log(`[game] ack ${params.id} from ${body.jobId} ${body.outcome}`);
				return new Response(null, { status: 204 });
			},
			{ params: t.Object({ id: t.String({ minLength: 1, maxLength: 64 }) }), body: AckBody },
		)
		// catch-up for whatever MessagingService dropped: servers poll with the newest issuedAt they hold, so
		// a dropped push costs latency rather than a missed command
		.get("/commands", ({ query }) => CommandsSince(Number(query.since ?? 0)), {
			query: t.Object({ since: t.Optional(t.String()) }),
		})
		.listen({
			hostname: Config.ack.hostname,
			port: Config.ack.port,
			maxRequestBodySize: Config.ack.maxBodyBytes,
		});

	console.log(`[game] channel listening on ${Config.ack.hostname}:${Config.ack.port}`);
}
