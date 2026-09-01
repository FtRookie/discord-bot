import { Replies } from "../../helpers/Replies.ts";
import { KeywordCommand } from "../KeywordCommand.ts";

export const Reply = KeywordCommand({
	name: "reply",
	noun: "reply",
	plural: "replies",
	description: "Manage keyword text replies",
	addDescription: "Reply with a sentence when a keyword appears in a message",
	store: Replies,
	value: { name: "text", description: "Sentence to reply with", maxLength: 2000 },
	added: (match, text) => `Replying with "${text}" to "${match}"`,
	format: (entry) => `"${entry.match}" → ${entry.value}`,
});
