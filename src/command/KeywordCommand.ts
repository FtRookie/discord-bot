import { InteractionContextType, MessageFlags } from "discord.js";
import type { Keyword, KeywordStore } from "../helpers/KeywordStore.ts";
import { Perms } from "../helpers/Permissions.ts";
import { Command } from "./Command.ts";

/**
 * /reaction and /reply are the same command over different stores: add, remove and list a keyword binding.
 * Only the wording and the value option differ, so those are the arguments and everything else is derived —
 * `noun` and `plural` are separate because "replies" is not "replys".
 */
export function KeywordCommand(args: {
	name: string;
	noun: string;
	plural: string;
	description: string;
	addDescription: string;
	store: KeywordStore;
	value: { name: string; description: string; maxLength?: number };
	/** The confirmation for a new binding, and how one is rendered in the list. */
	added: (match: string, value: string) => string;
	format: (entry: Keyword) => string;
}): Command {
	const { store, noun, plural, value } = args;

	return new Command({
		name: args.name,
		description: args.description,
		permissions: Perms.Configure,
		contexts: InteractionContextType.Guild,
		subcommands: {
			add: {
				description: args.addDescription,
				options: {
					match: { string: { description: "Substring to match, case-insensitive", required: true } },
					[value.name]: {
						string: { description: value.description, required: true, maxLength: value.maxLength },
					},
				},
			},
			remove: {
				description: `Remove a keyword ${noun}`,
				options: { match: { string: { description: "Keyword to remove", required: true } } },
			},
			list: { description: `List keyword ${plural}` },
		},
		async execute(interaction) {
			let reply: string;
			switch (interaction.options.getSubcommand()) {
				case "add": {
					const match = interaction.options.getString("match", true);
					const bound = interaction.options.getString(value.name, true);
					store.add(match, bound);
					reply = args.added(match.toLowerCase(), bound);
					break;
				}
				case "remove": {
					const match = interaction.options.getString("match", true);
					reply = store.remove(match)
						? `Removed "${match.toLowerCase()}"`
						: `No ${noun} bound to "${match.toLowerCase()}"`;
					break;
				}
				default:
					reply = store.items.map(args.format).join("\n") || `No ${plural} bound.`;
			}

			await interaction.reply({ content: reply, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
		},
	});
}
