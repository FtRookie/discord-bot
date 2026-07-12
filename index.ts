import {
    Client,
    Events,
    GatewayIntentBits,
    MessageFlags,
    PermissionFlagsBits,
    SlashCommandBuilder,
} from "discord.js";
import { config, env } from "./config.ts";
import { addReaction, reactions, removeReaction } from "./reactions.ts";
import { startWatchers } from "./watchers.ts";

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
});

client.once(Events.ClientReady, async (c) => {
    console.log(`Logged in as ${c.user.tag}`);
    startWatchers(client);

    // Clear stale guild-scoped commands from old implementations; /reaction is global.
    await Promise.all(c.guilds.cache.map((g) => g.commands.set([])));
    await c.application.commands.set([
        new SlashCommandBuilder()
            .setName("reaction")
            .setDescription("Manage keyword emoji reactions")
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
            .addSubcommand((s) => s
                .setName("add")
                .setDescription("React with an emoji when a keyword appears in a message")
                .addStringOption((o) => o.setName("match").setDescription("Substring to match, case-insensitive").setRequired(true))
                .addStringOption((o) => o.setName("emoji").setDescription("Emoji to react with").setRequired(true)))
            .addSubcommand((s) => s
                .setName("remove")
                .setDescription("Remove a keyword reaction")
                .addStringOption((o) => o.setName("match").setDescription("Keyword to remove").setRequired(true)))
            .addSubcommand((s) => s
                .setName("list")
                .setDescription("List keyword reactions")),
    ]);
});

client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand() || interaction.commandName !== "reaction") return;

    let reply: string;
    const sub = interaction.options.getSubcommand();
    if (sub === "add") {
        const match = interaction.options.getString("match", true);
        const emoji = interaction.options.getString("emoji", true);
        addReaction(match, emoji);
        reply = `Reacting with ${emoji} to "${match.toLowerCase()}"`;
    } else if (sub === "remove") {
        const match = interaction.options.getString("match", true);
        reply = removeReaction(match)
            ? `Removed "${match.toLowerCase()}"`
            : `No reaction bound to "${match.toLowerCase()}"`;
    } else {
        reply = reactions.map((r) => `${r.emoji} ← "${r.match}"`).join("\n") || "No reactions bound.";
    }
    await interaction.reply({ content: reply, flags: MessageFlags.Ephemeral });
});

const pings = new Map<string, number[]>();

/**Responds with game link upon @ */
client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot || !client.user) return;

    const content = message.content.toLowerCase();
    for (const { match, emoji } of reactions) {
        if (content.includes(match)) await message.react(emoji).catch(() => { });
    }

    if (message.mentions.users.has(client.user.id)) {
        const now = Date.now();
        const recent = (pings.get(message.author.id) ?? []).filter(
            (t) => now - t < config.mention.windowMs,
        );
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
