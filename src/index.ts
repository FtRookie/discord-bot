import { Client, Events, GatewayIntentBits, type Message, MessageFlags } from "discord.js";
import { Config, Env } from "./Config.ts";
import { Commands } from "./command/Commands.ts";
import { StartGameChannel } from "./helpers/AckServer.ts";
import { SyncCommandPermissions } from "./helpers/CommandPerms.ts";
import { Can, EnsureRole, SyncPermissionRoles } from "./helpers/Permissions.ts";
import type { PhraseRule } from "./helpers/PhraseResponses.ts";
import {
	MatchPhrase,
	MentionRule,
	OnCooldown,
	SeedBuiltinRules,
	ShouldTimeout,
	StartCooldown,
} from "./helpers/PhraseResponses.ts";
import { Reactions } from "./helpers/Reactions.ts";
import { StartReminders } from "./helpers/Reminders.ts";
import { Replies } from "./helpers/Replies.ts";
import { RespondToReplyPhrase } from "./helpers/ReplyResponders.ts";
import { UserError } from "./helpers/Roblox.ts";
import { Matches, MatchPreset } from "./helpers/StringMatch.ts";
import { StartWatchers } from "./helpers/Watchers.ts";

const client = new Client({
	intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

client.once(Events.ClientReady, async (c) => {
	console.log(`Logged in as ${c.user.tag}`);
	StartWatchers(client);
	StartGameChannel();
	StartReminders(client);
	SeedBuiltinRules();

	// old implementations registered per-guild; everything is global now
	await Promise.all(c.guilds.cache.map((g) => (g.id === Config.discord.guildId ? g.commands.set([]) : g.leave())));
	await c.application.commands.set(Commands.map((command) => command.data.toJSON()));

	const guild = c.guilds.cache.get(Config.discord.guildId);
	if (guild) {
		// before the permission sync: a deny for a role that doesn't exist yet is silently skipped
		for (const command of Commands) {
			if (command.hiddenFromRole) await EnsureRole(guild, command.hiddenFromRole);
		}

		const roleForBit = await SyncPermissionRoles(guild);
		await SyncCommandPermissions(guild, Commands, roleForBit);
	}
});

client.on(Events.GuildCreate, async (guild) => {
	if (guild.id !== Config.discord.guildId) await guild.leave().catch(() => {});
});

client.on(Events.InteractionCreate, async (interaction) => {
	if (!interaction.isChatInputCommand()) return;
	const command = Commands.find((cmd) => cmd.data.name === interaction.commandName);
	if (!command) return;
	try {
		// the builders set a guild-only context, but member permissions are unenforceable outside guilds
		if (!interaction.inGuild()) throw new UserError("This command only works in a server.");
		if (!Can(interaction.user.id, command.permissions))
			throw new UserError("You don't have permission to use this.");
		await command.execute(interaction);
	} catch (err) {
		let content: string;
		if (err instanceof UserError) {
			content = err.message.slice(0, 1900);
		} else {
			console.error(`[/${interaction.commandName}] failed:`, err);
			content = "Something went wrong — check the bot logs.";
		}
		// best-effort: the interaction may already be dead
		const respond =
			interaction.deferred || interaction.replied
				? interaction.editReply({ content, allowedMentions: { parse: [] } })
				: interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
		await respond.catch((replyErr) => console.error(`[/${interaction.commandName}] error reply failed:`, replyErr));
	}
});

// parse: [] so nothing in the text can ping a role or @everyone; repliedUser so the person still gets the
// notification the bare message.reply() used to give them
const REPLY_MENTIONS = { parse: [], repliedUser: true } as const;

/**
 * Discord refuses a timeout for reasons the bot cannot fix at runtime — the target owns the guild, holds
 * Administrator, or outranks the bot, or the bot was never given Moderate Members. `moderatable` reports all
 * of them at once. Logged rather than swallowed: a punishment that silently does nothing looks identical to
 * one that was never triggered.
 */
async function timeout(message: Message, reason: string): Promise<void> {
	const member = message.member;
	if (!member) {
		console.warn(`[phrase] no member on the message from ${message.author.tag}, so no timeout`);
		return;
	}
	if (!member.moderatable) {
		console.warn(
			`[phrase] cannot time out ${message.author.tag}: they own the guild, are an admin, outrank the bot, ` +
				"or the bot is missing Moderate Members",
		);
		return;
	}
	await member
		.timeout(Config.phrase.timeoutMs, reason)
		.catch((err) => console.error(`[phrase] timing out ${message.author.tag} failed:`, err));
}

client.on(Events.MessageCreate, async (message) => {
	if (message.author.bot || !client.user) return;

	if (await RespondToReplyPhrase(message)) return; // e.g. "Jarvis, enhance", answered from the replied-to message

	// reactions are not a response, so they stack with whatever replies below
	// soft = case- and punctuation-insensitive substring, so ",.?-!" don't block a hit
	for (const { match, value: emoji } of Reactions.items) {
		if (Matches(message.content, match, MatchPreset.soft).hits > 0) await message.react(emoji).catch(() => {});
	}

	const respond = async (rule: PhraseRule) => {
		// a matched-but-quiet rule still consumes the message: falling through would answer the same question
		// with something else halfway through the cooldown
		if (OnCooldown(rule, message.author.id)) return;

		if (ShouldTimeout(rule, message.author.id)) {
			if (rule.timeout === false) return; // rate limited, but this rule only goes quiet about it
			await timeout(message, rule.timeoutReason ?? "Spamming a phrase-response");
			if (rule.timeoutResponse) {
				await message.reply({ content: rule.timeoutResponse, allowedMentions: REPLY_MENTIONS }).catch(() => {});
			}
			return;
		}

		await message.reply({ content: rule.response, allowedMentions: REPLY_MENTIONS }).catch(() => {});
		StartCooldown(rule, message.author.id);
	};

	// A direct ping outranks anything the text happens to match — it is addressed to the bot on purpose, and
	// the ping is what the rate limit counts. has() counts @everyone/@here and role pings by default, so all
	// three ignores are needed (the third being the reply auto-mention).
	if (message.mentions.has(client.user, { ignoreRoles: true, ignoreEveryone: true, ignoreRepliedUser: true })) {
		const mention = MentionRule();
		if (mention) return await respond(mention);
	}

	const rule = MatchPhrase(message.content); // /phrase-response rules, plus the seeded game link
	if (rule) return await respond(rule);

	// one response per message, however many rules match
	const hit = Replies.items.find((r) => Matches(message.content, r.match, MatchPreset.soft).hits > 0);
	if (hit) await message.reply({ content: hit.value, allowedMentions: REPLY_MENTIONS }).catch(() => {});
});

// otherwise one stray rejection takes the whole bot down
process.on("unhandledRejection", (reason) => console.error("Unhandled promise rejection:", reason));

// clean gateway logout on systemctl restart/stop, rather than an abrupt disconnect
for (const signal of ["SIGTERM", "SIGINT"] as const) {
	process.on(signal, () => {
		client.destroy();
		process.exit(0);
	});
}

await client.login(Env("DISCORD_TOKEN"));
