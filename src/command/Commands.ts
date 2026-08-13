import type { Command } from "./Command.ts";
import { Announce } from "./commands/moderation/Announce.ts";
import { Ban } from "./commands/moderation/Ban.ts";
import { Banlog } from "./commands/moderation/Banlog.ts";
import { Blocks } from "./commands/moderation/Blocks.ts";
import { Kick } from "./commands/moderation/Kick.ts";
import { Lua } from "./commands/moderation/Lua.ts";
import { Players } from "./commands/moderation/Players.ts";
import { Servers } from "./commands/moderation/Servers.ts";
import { Unban } from "./commands/moderation/Unban.ts";
import { PhraseResponse } from "./commands/PhraseResponse.ts";
import { Reaction } from "./commands/Reaction.ts";
import { Reply } from "./commands/Reply.ts";
import { Pixerialize } from "./commands/tools/Pixerialize.ts";
import { Reminder } from "./commands/tools/Reminder.ts";
import { Render } from "./commands/tools/Render.ts";
import { Userid } from "./commands/tools/UserID.ts";

export const Commands = [
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
] satisfies Command[];
