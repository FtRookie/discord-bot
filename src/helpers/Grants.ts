import { Config } from "../Config.ts";
import { KnownServers, TargetedVerdict } from "./AckServer.ts";
import { CreateCommand, PublishAndCollect } from "./GameCommands.ts";
import { UserError } from "./Roblox.ts";

export type GrantOutcome = {
	readonly verdict: TargetedVerdict;
	readonly jobId: string; // the server aimed at, for the reply and for diagnosing a silent verdict
};

/**
 * Set a player's per-block limit, online or not; an omitted `limit` removes the override. This writes
 * persistent data rather than acting on a session, so unlike /kick it cannot wait for the player to be
 * present. Any server can do the write, so one is picked and targeted — broadcasting would have every server
 * write the same datastore key.
 *
 * fixme: the server is arbitrary, so a grant issued while the player is online on a different one is written
 * from a row loaded before it, and lost when that server saves on disconnect. The write belongs upstream of
 * the game servers rather than in whichever one happened to be chosen.
 */
export async function GrantBlock(userId: number, blockId: string, limit?: number): Promise<GrantOutcome> {
	const servers = [...KnownServers(await PublishAndCollect(CreateCommand("ping")))];

	if (servers.length === 0) {
		throw new UserError(
			`No server answered within ${Config.probe.windowMs / 1000}s, so there is nowhere to run this. ` +
				"Either none are up, or the live build predates `grant`.",
		);
	}

	const jobId = servers[Math.floor(Math.random() * servers.length)] as string;
	const command = CreateCommand("grant", { userId, blockId, limit }, jobId);
	return { verdict: TargetedVerdict(await PublishAndCollect(command)), jobId };
}

/** Why a grant did not apply, phrased for whoever ran the command. Undefined means it succeeded. */
export function GrantFailure({ verdict, jobId }: GrantOutcome): string | undefined {
	switch (verdict.kind) {
		case "acted":
			if (verdict.outcome === "Success") return undefined;
			if (verdict.outcome === "Refused") return `Refused: ${verdict.ack.response ?? "policy"}.`;
			return `Errored on \`${verdict.ack.jobId}\`: ${verdict.ack.response ?? "unknown error"}.`;
		case "unconfirmed":
			return `\`${jobId}\` is on an old build with no \`grant\` handler. Retry once it has updated.`;
		case "absent":
			return `\`${jobId}\` answered but declined to act — it may have shut down mid-flight. Retry.`;
		case "silent":
			return (
				`Nothing answered within ${Config.probe.windowMs / 1000}s of targeting \`${jobId}\`. It may still ` +
				"land via catch-up — re-check before reissuing."
			);
	}
}
