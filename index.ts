import { Client, Events, GatewayIntentBits } from "discord.js";
import { env } from "./config.ts";
import { startWatchers } from "./watchers.ts";

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, (c) => {
    console.log(`Logged in as ${c.user.tag}`);
    startWatchers(client);
});

await client.login(env("DISCORD_TOKEN"));
