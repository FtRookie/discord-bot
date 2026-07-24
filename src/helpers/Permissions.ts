import type { Guild } from "discord.js";

/**
 * Who may run what. This table is the sole authority: can() checks it before any handler runs (Index.ts).
 * Discord's own default-member gate is used only to HIDE gated commands from non-admins in the client
 * (Command.ts sets it to 0 for anything past Perms.None); it never decides who may actually run them.
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

/**
 * Discord user ID → the bits they hold. The source of truth for every grant. Absent IDs hold nothing, so
 * an unlisted user's whole reach is the commands that require Perms.None.
 */
const userGrants: Record<string, number> = {
	"484529511468236802": ALL_PERMS, // FtRookie
	"384696699576123393": Perms.Moderate | Perms.Announce | Perms.Inspect | Perms.Unlimited, // Samlovebutter
};

export function permsOf(userId: string): number {
	return userGrants[userId] ?? 0;
}

/** True when the user holds *every* bit in `required`. Perms.None is held by everyone. */
export function can(userId: string, required: number): boolean {
	return (permsOf(userId) & required) === required;
}

/** Grantable flags get a Discord role; None means "no role" and Owner is the admin-only sentinel. */
const ROLE_FLAGS = Object.entries(Perms).filter(([name, bit]) => bit !== Perms.None && name !== "Owner");

/**
 * Mirror the userGrants table onto Discord roles: one role per grantable flag, assigned to each listed
 * user to match their bits. The table stays authoritative — can() reads it, not the roles. The roles
 * exist so command visibility can be granted per role in Server Settings → Integrations, and so grants
 * are visible in-server. Idempotent: roles are matched by name and reused across restarts. Needs the
 * Manage Roles permission, with the bot's own role positioned above these.
 *
 * Removal is synced only for users still listed; a user dropped from the table entirely isn't visited,
 * because sweeping every member for a stray managed role needs the privileged Guild Members intent.
 */
export async function syncPermissionRoles(guild: Guild): Promise<Map<number, string>> {
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
