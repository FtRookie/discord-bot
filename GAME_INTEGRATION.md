# Game ↔ Bot Integration

How the Discord bot, the Roblox game, and the database backend talk to each other — the constraints that
shaped it, the contract, and the alternatives that were considered and rejected.

Companion doc: `docs/GAME_INTEGRATION.md` in the `overengineered` repo. The theory is shared, the code map differs.

---

## 1. The shape

Three nodes, six directed channels:

| Channel | Transport | Status |
|---|---|---|
| **Bot → Game** | Open Cloud `publishMessage` → MessagingService | ✅ built (commands) |
| **Game → Bot** | game's outbound HTTP → Cloudflare → nginx → Elysia | ✅ built (acknowledgements) |
| **Game → Backend** | game's outbound HTTP | ✅ pre-existing (saves) |
| Backend → Game | game polls, or Open Cloud | ⬜ not built |
| Bot → Backend | HTTP | ⬜ not built |
| Backend → Bot | HTTP, or bot polls | ⬜ not built |

### The constraint everything follows from

**A Roblox game server has no inbound HTTP.** It can only make outbound requests, or receive via
MessagingService. The bot and the backend are ordinary HTTP servers and can be called at any time.

So the six channels collapse into three mechanism classes:

- **Into the game** — MessagingService push, or the game polling. No other option exists.
- **Out of the game** — plain outbound HTTP. Trivial.
- **Between bot and backend** — HTTP either way.

There is no unicast: **`publishMessage` reaches every subscriber of a topic**, never one chosen server.
Open Cloud is publish-only — there is no way to *subscribe* to a topic from outside Roblox, which is why the
return path is HTTP rather than symmetric messaging.

---

## 2. Transport: Game → Bot

```
game server ──HTTPS──► Cloudflare ──HTTPS──► nginx :4434 ──HTTP──► Bun 127.0.0.1:1368
              (Full strict)   │ origin rule    │ SNI: bot.ftrookie.com     Elysia
                              │ port → 4434    │ Cloudflare origin cert
```

Layered so each control does one job:

| Layer | Role |
|---|---|
| Cloudflare (Full strict) | public TLS, DDoS, hides the origin |
| ufw (4434 ← Cloudflare ranges only) | origin unreachable except through the edge |
| nginx (`sites-enabled/bot.ftrookie.com.conf`) | TLS termination, SNI vhost routing, reverse proxy |
| Bun bound to `127.0.0.1` | never internet-facing, even if the firewall lapsed |
| `Authorization: Bearer` | constant-time compare against `GAME_SHARED_SECRET` |
| Elysia schema | rejects malformed payloads at the boundary |

Secrets live in `/etc/discord-bot.env` (root-owned `0600`), injected by systemd's `EnvironmentFile=` before it
drops to `User=ftrookie` — the process never needs read access to the file, and nothing sensitive sits in the
deploy directory where `git pull` could touch it.

**Ack-only by design.** The endpoint accepts acknowledgements and nothing else. If the secret leaks, the worst
outcome is a forged acknowledgement — never a triggerable action. Keep it that way.

Known gap: ufw allows Cloudflare's **IPv4** ranges on 4434 but not IPv6. Fine while the origin has no AAAA
record; add the v6 ranges before adding one.

---

## 3. The contract

### Command (bot → game, `COMMAND` topic)

Three commands exist today, all issued from this repo:

```jsonc
{ "id": "<uuid>", "name": "restart",  "issuedAt": 1784850639123, "args": { "ttl": 60, "text": "…" } }
{ "id": "<uuid>", "name": "announce", "issuedAt": 1784850639123, "args": { "text": "…", "display": "both", "ttl": 60 } }
{ "id": "<uuid>", "name": "ping",     "issuedAt": 1784850639123 }
```

- `id` — `crypto.randomUUID()`; the bot is the sole issuer, so uniqueness needs no coordination.
- `issuedAt` — **bot-stamped**, so the game's poll watermark never compares clocks across machines.
- `args` — **nested, not flat.** Per-command payload; each game-side handler narrows its own.
- The game **ignores unknown `name`s** — mid-rollout, old servers receive commands this bot has just learned
  to send. Adding a command is therefore backward-safe.
- Payload must stay under **1 KiB** (`publishMessage` enforces it, measured in *bytes* — an em-dash is 3).

`ttl` means the same in both: **how long the game keeps replaying the message to players who join late.** It
carries no implication of a countdown — the game decides that separately, and only for `restart`. Nothing this
bot sends can make an announcement claim the servers are restarting.

`ping` takes no args and does nothing in game — the **acknowledgement is the entire point**. It exists because
liveness cannot be queried: there is no unicast and no way to subscribe to `SERVERS` from outside Roblox, so
"who is alive" can only be sampled by publishing and listening. Each probe mints a fresh id, so the
acknowledgements it collects are current *by construction* — unlike the `roster` field they carry, which is
peer-attested and expires only after three intervals. Never merge the two into one count.

### Acknowledgement (game → bot, `POST /ack/<commandId>`)

```jsonc
{ "jobId": "…", "ok": true, "response": "Warned 7 player(s)", "kind": "public", "roster": ["jobId", …] }
```

Uniform for **every** command, which is why it needs no discriminated union while the command does. This is
the **only** side with a runtime schema, because it is the only place bytes from outside cross into the bot.

`kind` is `public` | `private` | `reserved`, derived game-side from `PrivateServerId` / `PrivateServerOwnerId`.
It is **optional**: a required field would 422 every acknowledgement from a game build that predates it, so
rollout order stops mattering. It is known only for servers that answered *directly* — `roster` carries jobIds
alone, so a peer-attested entry can never have one.

Responses are game-authored text and may reach Discord — render them with
`allowedMentions: { parse: [] }`, as the rest of the bot already does.

### Roster (`SERVERS` topic, game-side only)

Servers publish only their own jobId, on boot and every 45s; receivers stamp arrival locally and expire
entries after three intervals. The bot never publishes here — it only consumes the `roster` field of
acknowledgements.

---

## 4. Delivery guarantees

MessagingService is explicitly best-effort. Three mechanisms compensate, in order of cost:

1. **Push** — normal path, ~1s.
2. **Catch-up poll** — the game polls `GET /commands?since=<newest issuedAt it holds>` every 30s. The command
   is appended to the log **before** the push is attempted, so even a total push failure is delivered late
   rather than lost. The log is a delivery buffer, not a history: trimmed to 10 minutes.
3. **Reissue** — halfway through the window the bot compares acknowledgements against the union of reported
   rosters and re-pushes **the same envelope** once if short.

Two properties make reissue safe and useful:

- **The game dedupes execution, not acknowledgement** — a repeat id re-sends the cached result, so a reissue
  repairs a *lost acknowledgement* as well as a lost command. That's the more common failure.
- **Exactly one reissue.** A wedged or departed server must never block every future command.

Retries re-push the **same envelope**; minting a fresh id per attempt would make servers treat each retry as a
distinct command and warn players repeatedly.

### Restart survives a bot restart

A scheduled restart is persisted to `pending-restart.json` and resumed on boot:

- still within the window → reschedule for the remaining time;
- overdue → **re-warn with a fresh window**, never restart immediately, since players have joined since and
  the original countdown is meaningless to them.

Without this, a deploy mid-window leaves players warned about a restart that silently never happens — and the
publish poll re-seeds on boot, so it would never be re-detected.

---

## 5. Decisions, and what was rejected

| Rejected | Why |
|---|---|
| **One topic for roster + commands** | Violates separation of interests and concentrates rate-limit pressure. |
| **Ring / "check your partner" polling** | No unicast — a targeted ping is still a broadcast, so a ring costs **2N** publishes against **N** for plain self-announce, and needs agreement on ordering, which is the very roster being built. |
| **Gossiping full rosters** | One stale view infects every map and expiry stops working. Also the one place the 1 KiB cap genuinely binds. |
| **Intersection for the head count** | Breaks on *legitimate* asymmetry before any attacker: a server that started seconds ago reports `[self]`, collapsing the denominator to 1. Union over-counts at worst, costing one wasted reissue; under-counting silently skips a live server. |
| **Registering servers from who polls** | Any token holder or malformed jobId would mint phantom servers, inflating the denominator forever. Existence is attested by **peers**; delivery is pulled by the server. The poll is therefore stateless — it records nothing about the caller. |
| **Flat command fields** | Byte savings were ~9 against 1024 — a non-argument. Nested `args` has no collision surface with envelope fields and lets the envelope be parsed without knowing any command. |
| **Deferring the restart when the push fails** | The command is already in the log, so servers execute it via poll regardless — deferring would warn players about a restart that never comes. Proceeding is the consistent choice. |
| **`maxItems` on the roster array** | A cliff, not a slope: crossing it makes *every* acknowledgement 422. Bounded by `maxRequestBodySize` instead — caps the resource without limiting how many servers you may run. |

---

## 6. Where the code lives (this repo)

| File | Role |
|---|---|
| `src/helpers/AckServer.ts` | Elysia server: `POST /ack/:id` (token guard, schema, ack store), `GET /commands` catch-up, `knownServers()` union |
| `src/helpers/Commands.ts` | Command envelope, id minting, the delivery log, `createCommand` / `publishCommand`, `probeServers` |
| `src/commands/Servers.ts` | `/servers` → `ping` probe, reporting confirmed-live and peer-attested separately |
| `src/helpers/Watchers.ts` | Publish detection → `restart` command → reissue check → `restartServers()`, plus pending-restart persistence and boot resume |
| `src/commands/Announce.ts` | `/announce` → `announce` command (text, display, and a `duration` option feeding `ttl`) |
| `src/helpers/Roblox.ts` | `publishMessage` (1 KiB byte guard), `restartServers`, moderation via Open Cloud |
| `src/Config.ts` | `ack` (bind, port, path, body cap), `restart` (warn window, state path) |
| `discord-bot.service` | `EnvironmentFile`, `NoNewPrivileges`, `PrivateTmp` |

Responses on the endpoint: `401` bad token, `422` malformed body, `409` unknown command id (so probing cannot
grow memory), `204` accepted.

---

## 7. Not built

- **Group C commands** — player-data operations (wipe, migrate, `updateMeta`) belong on Bot → Backend
  directly; routing them through a live game server is wrong, since the player need not be online. Bans
  already go through Open Cloud and need no game hop.
- **Targeted commands** — the envelope supports them; no handler uses it yet. Expect exactly one
  acknowledgement, or none if the player is offline — indistinguishable from delivery failure.
- **Retiring the `announcement` topic.** `/announce` is now an `announce` command, but the topic remains in
  use for the game's own admin panel fanout (`adminAnnounce` → peer servers). That is game→game traffic and
  deliberately stays off the command channel: a game-minted command id would be unknown to this bot, so every
  acknowledgement would come back `409`.
- **Any way to exercise this channel from Studio.** The game reads `BOTTOKEN` from `ConfigService`, which has
  no value in Studio, and its `CommandController` returns early under `RunService.IsStudio()` anyway so it
  never joins the production roster. Consequence for this repo: **commands and acknowledgements cannot be
  tested against Studio at all** — the first real exercise is a live server, and `curl` against `/ack/:id` is
  the only pre-flight check available.
- **Bot ↔ Backend**, and the logging/telemetry channel that will route through the database backend.
- **`pending` cleanup** — if the bot dies between `openCommand` and `closeCommand`, that entry leaks. Bounded
  in practice (commands are short-lived, the process restarts clean); a TTL sweep would close it.
