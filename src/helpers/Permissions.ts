/**
 * Who may run what. Independent of a command's `userPermissions`, which only sets Discord's own
 * default-member gate: that hides a command in the client, but the client is not a security boundary.
 * This table is the one that actually decides, checked in Index.ts before any handler runs.
 *
 * Bits rather than a rank ladder, so capabilities compose without implying each other — a moderator
 * can hold Moderate without also inheriting Configure the way a numeric level would force.
 */
export const Perms = {
	None: 0,
	Unlimited: 1 << 0, // Exemption from rate-limiting (/render, /pixerialize, /userid)
	Moderate: 1 << 1, // /ban /kick /unban /banlog
	Announce: 1 << 2, // /announce
	Configure: 1 << 3, // /reaction, /reply
	Inspect: 1 << 4, // /servers, /players
	Owner: 1 << 5, // Only applies to owner or co-owners
} as const;

export const ALL_PERMS = Object.values(Perms).reduce((all, bit) => all | bit, 0);

const grants: Record<string, number> = {
	"484529511468236802": ALL_PERMS, // FtRookie
	"384696699576123393": Perms.Moderate | Perms.Announce, // Samlovebutter
};

export function permsOf(userId: string): number {
	return grants[userId] ?? 0;
}

/** True when the user holds *every* bit in `required`. Perms.None is held by everyone. */
export function can(userId: string, required: number): boolean {
	return (permsOf(userId) & required) === required;
}
