# discord-bot

A small, single-purpose Discord bot for one private server. It watches a Roblox
game and a GitHub changelog file, and posts a formatted announcement when the
game is updated — plus a handful of slash commands and chat reactions.

It's **not meant to be reused as-is** (it's wired to one specific server, game,
and repo), but it's public as a reference for anyone building a lean Discord bot
on Bun.

## What it does

- **Update announcer** — a game publish *arms* the bot; while armed, it posts an
  announcement built from the newest entry in a watched changelog file on
  GitHub, with a spoilered role ping. Polling, no webhooks.
- **Slash commands**
  - `/pixel` — render a hex string as a pixel-grid PNG
  - `/unpixel` — the inverse: downscale an image back to a hex string
  - `/ban` · `/unban` · `/banlog` — Roblox moderation via the Open Cloud API
  - `/reaction add|remove|list` — manage keyword→emoji auto-reactions
- **Chat responses** — keyword reactions, and a game link when the bot is
  @-mentioned (with an anti-spam timeout).

## Stack

- [Bun](https://bun.sh) — runtime; runs the TypeScript directly, no build step
- [discord.js](https://discord.js.org)
- [jimp](https://github.com/jimp-dev/jimp) — image decoding for `/unpixel`
- [Biome](https://biomejs.dev) — formatting + linting

Deliberately dependency-light and wrapper-free — e.g. the PNG encoder in
`src/helpers/Image.ts` is hand-rolled on `node:zlib`.

## Layout

```
src/
  Index.ts       entry: client + event handlers
  Config.ts      non-secret config (channel/guild/game IDs, poll intervals)
  commands/      slash commands — Command.ts base, moderation/, tools/
  helpers/       Roblox API, GitHub/Roblox watchers, image, reactions
```

## Running it

```sh
bun install
cp .env.example .env   # then fill in the three secrets
bun start
```

Required environment variables (see [.env.example](.env.example)):

| Variable         | Purpose                                          |
| ---------------- | ------------------------------------------------ |
| `DISCORD_TOKEN`  | Discord bot token                                |
| `ROBLOX_API_KEY` | Roblox Open Cloud API key (moderation)           |
| `GITHUB_TOKEN`   | GitHub token for polling the changelog file      |

## Scripts

| Command             | Does                                                       |
| ------------------- | ---------------------------------------------------------- |
| `bun start`         | Run the bot                                                |
| `bun run build`     | Full check: typecheck + Biome + bundle-resolve (no output) |
| `bun run format`    | Apply Biome formatting                                     |
| `bun run check`     | Biome lint + format check                                  |
| `bun run typecheck` | `tsc --noEmit`                                             |

## Deployment

Runs on Linux under systemd ([discord-bot.service](discord-bot.service)). A
self-hosted GitHub Actions runner pulls, installs, runs `bun run build`, and
restarts the service on every push to `main`.

## License

[Apache-2.0](LICENSE)
