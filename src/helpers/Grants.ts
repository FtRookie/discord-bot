import { config } from "../Config.ts";
import type { TargetedVerdict } from "./AckServer.ts";
import { closeCommand, knownServers, targetedVerdict } from "./AckServer.ts";
import { createCommand, publishCommand } from "./Commands.ts";
import { UserError } from "./Roblox.ts";

export type GrantOutcome = {
	readonly verdict: TargetedVerdict;
	/** The server the grant was aimed at, for the reply and for diagnosing a silent verdict. */
	readonly jobId: string;
};

/**
 * Set a player's per-block limit, whether or not they are online. An omitted `limit` removes the override.
 *
 * Unlike /kick this writes persistent data rather than acting on a session, so it cannot wait for the player
 * to be present. Any server can perform the write, so one is picked and targeted: broadcasting would have
 * every server run the same write against one datastore key.
 *
 * fixme: the server is arbitrary, so a grant issued while the player is online on a different one is written
 * from a row loaded before it and lost when that server saves on disconnect. Temporary — the write belongs
 * upstream of the game servers rather than in whichever one happened to be chosen.
 */
export async function grantBlock(userId: number, blockId: string, limit?: number): Promise<GrantOutcome> {
	const probe = createCommand("ping");
	let servers: string[];
	try {
		await publishCommand(probe);
		await new Promise((resolve) => setTimeout(resolve, config.probe.windowMs));
		servers = [...knownServers(closeCommand(probe.id))];
	} catch (err) {
		closeCommand(probe.id); // a failed publish must not leak the pending entry
		throw err;
	}

	if (servers.length === 0) {
		throw new UserError(
			`No server answered within ${config.probe.windowMs / 1000}s, so there is nowhere to run this. ` +
				"Either none are up, or the live build predates `grant`.",
		);
	}

	const jobId = servers[Math.floor(Math.random() * servers.length)] as string;
	const command = createCommand("grant", { userId, blockId, limit }, jobId);
	try {
		await publishCommand(command);
		await new Promise((resolve) => setTimeout(resolve, config.probe.windowMs));
	} catch (err) {
		closeCommand(command.id);
		throw err;
	}

	return { verdict: targetedVerdict(closeCommand(command.id)), jobId };
}

/** Why a grant did not apply, phrased for the person who ran the command. Undefined means it succeeded. */
export function grantFailure({ verdict, jobId }: GrantOutcome): string | undefined {
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
				`Nothing answered within ${config.probe.windowMs / 1000}s of targeting \`${jobId}\`. It may still ` +
				"land via catch-up — re-check before reissuing."
			);
	}
}
