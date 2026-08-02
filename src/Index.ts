import { Client, Events, GatewayIntentBits, MessageFlags } from "discord.js";
import { Config, Env } from "./Config.ts";
import { Announce } from "./commands/Announce.ts";
import { Blocks } from "./commands/Blocks.ts";
import type { Command } from "./commands/Command.ts";
import { Lua } from "./commands/Lua.ts";
import { Ban } from "./commands/moderation/Ban.ts";
import { Banlog } from "./commands/moderation/Banlog.ts";
import { Kick } from "./commands/moderation/Kick.ts";
import { Unban } from "./commands/moderation/Unban.ts";
import { Players } from "./commands/Players.ts";
import { Reaction } from "./commands/Reaction.ts";
import { Reminder } from "./commands/Reminder.ts";
import { Reply } from "./commands/Reply.ts";
import { Servers } from "./commands/Servers.ts";
import { Pixerialize } from "./commands/tools/Pixerialize.ts";
import { Render } from "./commands/tools/Render.ts";
import { Userid } from "./commands/tools/UserID.ts";
import { StartGameChannel } from "./helpers/AckServer.ts";
import { SyncCommandPermissions } from "./helpers/CommandPerms.ts";
import { Can, EnsureRole, SyncPermissionRoles } from "./helpers/Permissions.ts";
import { Reactions } from "./helpers/Reactions.ts";
import { StartReminders } from "./helpers/Reminders.ts";
import { Replies } from "./helpers/Replies.ts";
import { RespondToReplyPhrase } from "./helpers/ReplyResponders.ts";
import { UserError } from "./helpers/Roblox.ts";
import { StartWatchers } from "./helpers/Watchers.ts";

const commands: Command[] = [
	Reaction,
	Reply,
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

	// Clear stale guild-scoped commands from old implementations; all commands are global.
	await Promise.all(c.guilds.cache.map((g) => (g.id === Config.discord.guildId ? g.commands.set([]) : g.leave())));
	await c.application.commands.set(commands.map((command) => command.data.toJSON()));

	const guild = c.guilds.cache.get(Config.discord.guildId);
	if (guild) {
		// Before the permission sync, or a deny for a role that does not exist yet is silently skipped.
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
		// Defense in depth: builders set the guild-only context, but member
		// permissions are unenforceable outside guilds.
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
		// The error response is best-effort: the interaction may already be dead.
		const respond =
			interaction.deferred || interaction.replied
				? interaction.editReply({ content, allowedMentions: { parse: [] } })
				: interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
		await respond.catch((replyErr) => console.error(`[/${interaction.commandName}] error reply failed:`, replyErr));
	}
});

// Track users for timeout
const pings = new Map<string, number[]>();

// Strip punctuation (",.?-!" etc., the Unicode punctuation class) so keyword matches ignore it.
const ignorePunctuation = (text: string) => text.replace(/\p{P}/gu, "");

// Message responses
client.on(Events.MessageCreate, async (message) => {
	if (message.author.bot || !client.user) return;

	// A reply carrying a trigger phrase (e.g. "Jarvis, enhance") responds using the replied-to message.
	if (await RespondToReplyPhrase(message)) return;

	// Reactions and keyword replies match a punctuation-stripped copy, so ",.?-!" etc. don't block a hit.
	const content = ignorePunctuation(message.content.toLowerCase());
	for (const { match, emoji } of Reactions) {
		if (content.includes(ignorePunctuation(match))) await message.react(emoji).catch(() => {});
	}

	// First match only, so a message can't trigger a flood of replies.
	const hit = Replies.find((r) => content.includes(ignorePunctuation(r.match)));
	if (hit) await message.reply({ content: hit.text, allowedMentions: { parse: [] } }).catch(() => {});

	// Responds with game link upon @ (ignores the auto-mention from replies)
	if (message.mentions.has(client.user, { ignoreRepliedUser: true })) {
		const now = Date.now();
		const recent = (pings.get(message.author.id) ?? []).filter((t) => now - t < Config.mention.windowMs);
		recent.push(now);
		pings.set(message.author.id, recent);

		if (recent.length > Config.mention.maxPings) {
			pings.delete(message.author.id);
			await message.member?.timeout(Config.mention.timeoutMs, "Spamming bot pings").catch(() => {});
			await message.reply("Shut up, bye").catch(() => {});
			return;
		}

		await message.reply("Game [here](https://www.roblox.com/games/86822363308738/Underengineered)");
	}
});

// Log stray promise rejections instead of letting one crash the whole bot.
process.on("unhandledRejection", (reason) => console.error("Unhandled promise rejection:", reason));

// Clean gateway logout on `systemctl restart`/stop instead of an abrupt disconnect.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
	process.on(signal, () => {
		client.destroy();
		process.exit(0);
	});
}

await client.login(Env("DISCORD_TOKEN"));
