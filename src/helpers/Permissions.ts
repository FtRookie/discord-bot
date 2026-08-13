import type { Guild, Role } from "discord.js";

/**
 * Who may run what, and the sole authority on it: Can() checks this table before any handler runs (index.ts).
 * Discord's own default-member gate only HIDES gated commands from non-admins in the client (Command.ts sets
 * it to 0 for anything past Perms.None), and never decides who may actually run them.
 *
 * Bits rather than a rank ladder, so capabilities compose without implying each other — a moderator can hold
 * Moderate without also inheriting Configure the way a numeric level would force.
 */
export const Perms = {
	None: 0,
	Unlimited: 1 << 0, // exempt from rate limits (/render, /pixerialize, /userid)
	Moderate: 1 << 1, // /ban /kick /unban /banlog
	Announce: 1 << 2, // /announce
	Configure: 1 << 3, // /reaction, /reply
	Inspect: 1 << 4, // /servers, /players
	Owner: 1 << 5, // owner and co-owners; no role is created for it
} as const;

export const ALL_PERMS = Object.values(Perms).reduce((all, bit) => all | bit, 0);

// Discord user ID → the bits they hold. Absent IDs hold nothing, so an unlisted user's whole reach is the
// commands requiring Perms.None.
const userGrants: Record<string, number> = {
	"484529511468236802": ALL_PERMS, // FtRookie
	"384696699576123393": Perms.Moderate | Perms.Announce | Perms.Inspect | Perms.Unlimited, // Samlovebutter
};

export function PermsOf(userId: string): number {
	return userGrants[userId] ?? 0;
}

/** Holds *every* bit in `required`. Perms.None is held by everyone. */
export function Can(userId: string, required: number): boolean {
	return (PermsOf(userId) & required) === required;
}

/** Needs Manage Roles, with the bot's own role positioned above the one being created. */
export async function EnsureRole(guild: Guild, name: string): Promise<Role | undefined> {
	const existing = guild.roles.cache.find((role) => role.name === name);
	if (existing) return existing;
	return (await guild.roles.create({ name, mentionable: false }).catch(() => undefined)) ?? undefined;
}

// None means "no role" and Owner is the admin-only sentinel; every other flag gets a Discord role
const ROLE_FLAGS = Object.entries(Perms).filter(([name, bit]) => bit !== Perms.None && name !== "Owner");

/**
 * Mirror userGrants onto Discord roles, one per grantable flag. The table stays authoritative — Can() reads
 * it, not the roles, which exist so visibility can be granted per role in Server Settings → Integrations and
 * so grants are visible in-server. Idempotent: roles are matched by name and reused across restarts.
 *
 * Removal is synced only for users still listed. A user dropped from the table entirely isn't visited,
 * because sweeping every member for a stray managed role needs the privileged Guild Members intent.
 */
export async function SyncPermissionRoles(guild: Guild): Promise<Map<number, string>> {
	const roleForBit = new Map<number, string>(); // bit → roleId
	for (const [name, bit] of ROLE_FLAGS) {
		const existing = guild.roles.cache.find((role) => role.name === name);
		const role = existing ?? (await guild.roles.create({ name, mentionable: false }).catch(() => null));
		if (role) roleForBit.set(bit, role.id);
	}

	for (const [userId, bits] of Object.entries(userGrants)) {
		const member = await guild.members.fetch(userId).catch(() => null);
		if (!member) continue;
		for (const [bit, roleId] of roleForBit) {
			const shouldHave = (bits & bit) === bit;
			const has = member.roles.cache.has(roleId);
			if (shouldHave && !has) await member.roles.add(roleId).catch(() => {});
			else if (!shouldHave && has) await member.roles.remove(roleId).catch(() => {});
		}
	}

	return roleForBit;
}
