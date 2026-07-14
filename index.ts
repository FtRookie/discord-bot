import { Client, Events, GatewayIntentBits, MessageFlags } from "discord.js";
import { ban } from "./commands/ban.ts";
import { banlog } from "./commands/banlog.ts";
import type { Command } from "./commands/command.ts";
import { reaction } from "./commands/reaction.ts";
import { unban } from "./commands/unban.ts";
import { config, env } from "./config.ts";
import { reactions } from "./reactions.ts";
import { UserError } from "./roblox.ts";
import { startWatchers } from "./watchers.ts";

const commands: Command[] = [reaction, ban, unban, banlog];

const client = new Client({
	intents: [
		GatewayIntentBits.Guilds,
		GatewayIntentBits.GuildMessages,
		GatewayIntentBits.MessageContent
	],
});

client.once(Events.ClientReady, async (c) => {
	console.log(`Logged in as ${c.user.tag}`);
	startWatchers(client);

	// Clear stale guild-scoped commands from old implementations; all commands are global.
	await Promise.all(c.guilds.cache.map((g) => (g.id === config.discord.guildId ? g.commands.set([]) : g.leave())));
	await c.application.commands.set(commands.map((command) => command.data.toJSON()));
});

client.on(Events.GuildCreate, async (guild) => {
	if (guild.id !== config.discord.guildId) await guild.leave().catch(() => { });
});

client.on(Events.InteractionCreate, async (interaction) => {
	if (!interaction.isChatInputCommand()) return;
	const command = commands.find((cmd) => cmd.data.name === interaction.commandName);
	if (!command) return;
	try {
		// Defense in depth: builders set the guild-only context, but member
		// permissions are unenforceable outside guilds.
		if (!interaction.inGuild()) throw new UserError("This command only works in a server.");
		if (interaction.user.id !== config.discord.ownerId) throw new UserError("Only the bot owner can use this.");
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

// Message responses
client.on(Events.MessageCreate, async (message) => {
	if (message.author.bot || !client.user) return;

	// Reactions
	const content = message.content.toLowerCase();
	for (const { match, emoji } of reactions) {
		if (content.includes(match)) await message.react(emoji).catch(() => { });
	}

	// Responds with game link upon @
	if (message.mentions.users.has(client.user.id)) {
		const now = Date.now();
		const recent = (pings.get(message.author.id) ?? []).filter((t) => now - t < config.mention.windowMs);
		recent.push(now);
		pings.set(message.author.id, recent);

		if (recent.length > config.mention.maxPings) {
			pings.delete(message.author.id);
			await message.member?.timeout(config.mention.timeoutMs, "Spamming bot pings").catch(() => { });
			await message.reply("Shut up, bye").catch(() => { });
			return;
		}

		await message.reply("Game [here](https://www.roblox.com/games/86822363308738/Underengineered)");
	}
});

await client.login(env("DISCORD_TOKEN"));
