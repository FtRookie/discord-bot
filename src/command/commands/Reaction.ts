import { Reactions } from "../../helpers/Reactions.ts";
import { KeywordCommand } from "../KeywordCommand.ts";

export const Reaction = KeywordCommand({
	name: "reaction",
	noun: "reaction",
	plural: "reactions",
	description: "Manage keyword emoji reactions",
	addDescription: "React with an emoji when a keyword appears in a message",
	store: Reactions,
	value: { name: "emoji", description: "Emoji to react with" },
	added: (match, emoji) => `Reacting with ${emoji} to "${match}"`,
	format: (entry) => `${entry.value} ← "${entry.match}"`,
});
