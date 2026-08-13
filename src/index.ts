import { Client, Events, GatewayIntentBits, MessageFlags } from "discord.js";
import { Config, Env } from "./Config.ts";
import type { Command } from "./command/Command.ts";
import { Announce } from "./command/commands/moderation/Announce.ts";
import { Ban } from "./command/commands/moderation/Ban.ts";
import { Banlog } from "./command/commands/moderation/Banlog.ts";
import { Blocks } from "./command/commands/moderation/Blocks.ts";
import { Kick } from "./command/commands/moderation/Kick.ts";
import { Lua } from "./command/commands/moderation/Lua.ts";
import { Players } from "./command/commands/moderation/Players.ts";
import { Servers } from "./command/commands/moderation/Servers.ts";
import { Unban } from "./command/commands/moderation/Unban.ts";
import { PhraseResponse } from "./command/commands/PhraseResponse.ts";
import { Reaction } from "./command/commands/Reaction.ts";
import { Reply } from "./command/commands/Reply.ts";
import { Pixerialize } from "./command/commands/tools/Pixerialize.ts";
import { Reminder } from "./command/commands/tools/Reminder.ts";
import { Render } from "./command/commands/tools/Render.ts";
import { Userid } from "./command/commands/tools/UserID.ts";
import { StartGameChannel } from "./helpers/AckServer.ts";
import { SyncCommandPermissions } from "./helpers/CommandPerms.ts";
import { Can, EnsureRole, SyncPermissionRoles } from "./helpers/Permissions.ts";
import { MatchPhrase, ShouldTimeout } from "./helpers/PhraseResponses.ts";
import { Reactions } from "./helpers/Reactions.ts";
import { StartReminders } from "./helpers/Reminders.ts";
import { Replies } from "./helpers/Replies.ts";
import { RespondToReplyPhrase } from "./helpers/ReplyResponders.ts";
import { UserError } from "./helpers/Roblox.ts";
import { CountMatches, Matches, MatchPreset } from "./helpers/StringMatch.ts";
import { StartWatchers } from "./helpers/Watchers.ts";

const commands: Command[] = [
	Reaction,
	Reply,
	PhraseResponse,
	Announce,
	Ban,
	Kick,
	Unban,
	Banlog,
	Render,
	Pixerialize,
	Userid,
	Reminder,
	Servers,
	Players,
	Blocks,
	Lua,
];

const client = new Client({
	intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

client.once(Events.ClientReady, async (c) => {
	console.log(`Logged in as ${c.user.tag}`);
	StartWatchers(client);
	StartGameChannel();
	StartReminders(client);

	// old implementations registered per-guild; everything is global now
	await Promise.all(c.guilds.cache.map((g) => (g.id === Config.discord.guildId ? g.commands.set([]) : g.leave())));
	await c.application.commands.set(commands.map((command) => command.data.toJSON()));

	const guild = c.guilds.cache.get(Config.discord.guildId);
	if (guild) {
		// before the permission sync: a deny for a role that doesn't exist yet is silently skipped
		for (const command of commands) {
			if (command.hiddenFromRole) await EnsureRole(guild, command.hiddenFromRole);
		}

		const roleForBit = await SyncPermissionRoles(guild);
		await SyncCommandPermissions(guild, commands, roleForBit);
	}
});

client.on(Events.GuildCreate, async (guild) => {
	if (guild.id !== Config.discord.guildId) await guild.leave().catch(() => {});
});

client.on(Events.InteractionCreate, async (interaction) => {
	if (!interaction.isChatInputCommand()) return;
	const command = commands.find((cmd) => cmd.data.name === interaction.commandName);
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

const pings = new Map<string, number[]>(); // userId → recent @-mention times

const GAME_LINK = "Game [here](https://www.roblox.com/games/86822363308738/Underengineered)";

client.on(Events.MessageCreate, async (message) => {
	if (message.author.bot || !client.user) return;

	if (await RespondToReplyPhrase(message)) return; // e.g. "Jarvis, enhance", answered from the replied-to message

	// soft = case- and punctuation-insensitive substring, so ",.?-!" don't block a hit
	for (const { match, emoji } of Reactions) {
		if (Matches(message.content, match, MatchPreset.soft).hits > 0) await message.react(emoji).catch(() => {});
	}

	// "game" + "where" in any arrangement. Stem folds plurals and dropped apostrophes ("wheres" → where), and
	// the match is whole-word, so "somewhere" / "endgame" don't fire it.
	if (CountMatches(message.content, ["game", "where"], MatchPreset.stem) >= 2) {
		await message.reply(GAME_LINK).catch(() => {});
		return;
	}

	const rule = MatchPhrase(message.content); // user-defined, via /phrase-response
	if (rule) {
		if (ShouldTimeout(rule, message.author.id)) {
			await message.member?.timeout(Config.phrase.timeoutMs, "Spamming a phrase-response").catch(() => {});
		} else {
			await message.reply({ content: rule.response, allowedMentions: { parse: [] } }).catch(() => {});
		}
		return;
	}

	// one reply per message, however many rules match
	const hit = Replies.find((r) => Matches(message.content, r.match, MatchPreset.soft).hits > 0);
	if (hit) await message.reply({ content: hit.text, allowedMentions: { parse: [] } }).catch(() => {});

	// has() counts @everyone/@here and role pings by default, so a direct mention needs all three ignores
	// (the third being the reply auto-mention); past Config.mention.rate/min → timeout
	if (message.mentions.has(client.user, { ignoreRoles: true, ignoreEveryone: true, ignoreRepliedUser: true })) {
		const now = Date.now();
		const recent = (pings.get(message.author.id) ?? []).filter((t) => now - t < 60_000);
		recent.push(now);
		pings.set(message.author.id, recent);

		if (recent.length > Config.mention.rate) {
			pings.delete(message.author.id);
			await message.member?.timeout(Config.phrase.timeoutMs, "Spamming bot pings").catch(() => {});
			await message.reply("Shut up, bye").catch(() => {});
			return;
		}

		await message.reply(GAME_LINK);
	}
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
