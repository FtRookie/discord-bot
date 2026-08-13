import { Client, Events, GatewayIntentBits, MessageFlags } from "discord.js";
import { Config, Env } from "./Config.ts";
import { Commands } from "./command/Commands.ts";
import { StartGameChannel } from "./helpers/AckServer.ts";
import { SyncCommandPermissions } from "./helpers/CommandPerms.ts";
import { Can, EnsureRole, SyncPermissionRoles } from "./helpers/Permissions.ts";
import { MatchPhrase, ShouldTimeout } from "./helpers/PhraseResponses.ts";
import { RateWindow } from "./helpers/RateLimit.ts";
import { Reactions } from "./helpers/Reactions.ts";
import { StartReminders } from "./helpers/Reminders.ts";
import { Replies } from "./helpers/Replies.ts";
import { RespondToReplyPhrase } from "./helpers/ReplyResponders.ts";
import { UserError } from "./helpers/Roblox.ts";
import { CountMatches, Matches, MatchPreset } from "./helpers/StringMatch.ts";
import { StartWatchers } from "./helpers/Watchers.ts";

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

const pings = new RateWindow(60_000);

const GAME_LINK = "Game [here](https://www.roblox.com/games/86822363308738/Underengineered)";

client.on(Events.MessageCreate, async (message) => {
	if (message.author.bot || !client.user) return;

	if (await RespondToReplyPhrase(message)) return; // e.g. "Jarvis, enhance", answered from the replied-to message

	// soft = case- and punctuation-insensitive substring, so ",.?-!" don't block a hit
	for (const { match, value: emoji } of Reactions.items) {
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
	const hit = Replies.items.find((r) => Matches(message.content, r.match, MatchPreset.soft).hits > 0);
	if (hit) await message.reply({ content: hit.value, allowedMentions: { parse: [] } }).catch(() => {});

	// has() counts @everyone/@here and role pings by default, so a direct mention needs all three ignores
	// (the third being the reply auto-mention); past Config.mention.rate/min → timeout
	if (message.mentions.has(client.user, { ignoreRoles: true, ignoreEveryone: true, ignoreRepliedUser: true })) {
		if (pings.hit(message.author.id).count > Config.mention.rate) {
			pings.clear(message.author.id); // the timeout is the punishment; don't also make them wait it out
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
