import { CloseCommand } from "./AckServer.ts";
import { BackendRequest } from "./Backend.ts";
import { CreateCommand, PublishCommand } from "./GameCommands.ts";

export type BlockLimits = { readonly [blockId: string]: number };

type LimitsResponse = { readonly playerID: string; readonly blocks: BlockLimits };

/**
 * Set a player's per-block limit, online or not; an omitted `limit` removes the override. Written straight to
 * the database, which holds it as a pending change until the game pushes the row back carrying it, so no game
 * server's mirror can lose the write.
 *
 * The game's block list cannot be checked from here or from the database, so an id that is no block is stored
 * as given. Returns every limit the player holds afterwards.
 */
export async function GrantBlock(userId: number, blockId: string, limit?: number): Promise<BlockLimits> {
	const path = `/player/${userId}/blocks/${encodeURIComponent(blockId)}`;
	const result =
		limit === undefined
			? await BackendRequest<LimitsResponse>("DELETE", path)
			: await BackendRequest<LimitsResponse>("PUT", path, { limit });
	return result.blocks;
}

export async function GetBlockGrants(userId: number): Promise<BlockLimits> {
	return (await BackendRequest<LimitsResponse>("GET", `/player/${userId}/blocks`)).blocks;
}

/**
 * Broadcast so whichever server holds the player pulls the change now rather than on their next join. Nothing
 * waits for acks: a failed push stays in the command log, and the game's catch-up poll delivers it late.
 */
export async function RefreshPlayer(userId: number): Promise<void> {
	const command = CreateCommand("refreshPlayer", { userId });
	await PublishCommand(command).catch(() => {});
	CloseCommand(command.id);
}
