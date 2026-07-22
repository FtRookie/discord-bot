import { Client, Events, GatewayIntentBits, MessageFlags } from "discord.js";
import { config, env } from "./Config.ts";
import { announce } from "./commands/Announce.ts";
import type { Command } from "./commands/Command.ts";
import { ban } from "./commands/moderation/Ban.ts";
import { banlog } from "./commands/moderation/Banlog.ts";
import { kick } from "./commands/moderation/Kick.ts";
import { unban } from "./commands/moderation/Unban.ts";
import { reaction } from "./commands/Reaction.ts";
import { reply } from "./commands/Reply.ts";
import { pixerialize } from "./commands/tools/Pixerialize.ts";
import { render } from "./commands/tools/Render.ts";
import { userid } from "./commands/tools/UserID.ts";
import { reactions } from "./helpers/Reactions.ts";
import { replies } from "./helpers/Replies.ts";
import { UserError } from "./helpers/Roblox.ts";
import { startWatchers } from "./helpers/Watchers.ts";

const commands: Command[] = [reaction, reply, announce, ban, kick, unban, banlog, render, pixerialize, userid];

const client = new Client({
	intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

client.once(Events.ClientReady, async (c) => {
	console.log(`Logged in as ${c.user.tag}`);
	startWatchers(client);

	// Clear stale guild-scoped commands from old implementations; all commands are global.
	await Promise.all(c.guilds.cache.map((g) => (g.id === config.discord.guildId ? g.commands.set([]) : g.leave())));
	await c.application.commands.set(commands.map((command) => command.data.toJSON()));
});

client.on(Events.GuildCreate, async (guild) => {
	if (guild.id !== config.discord.guildId) await guild.leave().catch(() => {});
});

client.on(Events.InteractionCreate, async (interaction) => {
	if (!interaction.isChatInputCommand()) return;
	const command = commands.find((cmd) => cmd.data.name === interaction.commandName);
	if (!command) return;
	try {
		// Defense in depth: builders set the guild-only context, but member
		// permissions are unenforceable outside guilds.
		if (!interaction.inGuild()) throw new UserError("This command only works in a server.");
		if (command.ownerOnly && interaction.user.id !== config.discord.ownerId)
			throw new UserError("Only the bot owner can use this.");
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

	// Reactions and keyword replies match a punctuation-stripped copy, so ",.?-!" etc. don't block a hit.
	const content = ignorePunctuation(message.content.toLowerCase());
	for (const { match, emoji } of reactions) {
		if (content.includes(ignorePunctuation(match))) await message.react(emoji).catch(() => {});
	}

	// First match only, so a message can't trigger a flood of replies.
	const hit = replies.find((r) => content.includes(ignorePunctuation(r.match)));
	if (hit) await message.reply({ content: hit.text, allowedMentions: { parse: [] } }).catch(() => {});

	// Responds with game link upon @ (ignores the auto-mention from replies)
	if (message.mentions.has(client.user, { ignoreRepliedUser: true })) {
		const now = Date.now();
		const recent = (pings.get(message.author.id) ?? []).filter((t) => now - t < config.mention.windowMs);
		recent.push(now);
		pings.set(message.author.id, recent);

		if (recent.length > config.mention.maxPings) {
			pings.delete(message.author.id);
			await message.member?.timeout(config.mention.timeoutMs, "Spamming bot pings").catch(() => {});
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

await client.login(env("DISCORD_TOKEN"));
