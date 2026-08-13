import {
	type ChatInputCommandInteraction,
	type InteractionContextType,
	MessageFlags,
	SlashCommandBuilder,
	type SlashCommandSubcommandBuilder,
} from "discord.js";
import { Perms } from "../helpers/Permissions.ts";

type OptionBase = {
	description: string;
	required?: boolean;
};

type StringOption = OptionBase & { minLength?: number; maxLength?: number; choices?: Record<string, string> };
type IntegerOption = OptionBase & { min?: number; max?: number; choices?: Record<string, number> };

type Option =
	| { string: StringOption; integer?: never; bool?: never; attachment?: never }
	| { integer: IntegerOption; string?: never; bool?: never; attachment?: never }
	| { bool: OptionBase; string?: never; integer?: never; attachment?: never }
	| { attachment: OptionBase; string?: never; integer?: never; bool?: never };

/** Option name → its shape. */
export type Options = { readonly [name in string]: Option };

/** Subcommand name → its description and its own options. */
export type Subcommands = { readonly [name in string]: { description: string; options?: Options } };

// Discord filters command names
const NAME = /^[\p{Ll}\p{Lm}\p{Lo}\p{N}\p{sc=Devanagari}\p{sc=Thai}_-]+$/u;

function validName(kind: string, name: string): string {
	if (!NAME.test(name)) {
		throw new Error(`Invalid ${kind} name "${name}": lowercase letters, digits, underscore and hyphen only`);
	}
	return name;
}

const asChoices = <T extends string | number>(choices: Record<string, T>) =>
	Object.entries(choices).map(([name, value]) => ({ name, value }));

/**
 * Discord rejects a required option declared after an optional one, so this is the only order it accepts. The
 * sort is stable, which leaves the declared order intact within each group.
 */
function addOptions(builder: SlashCommandBuilder | SlashCommandSubcommandBuilder, options: Options): void {
	const required = (option: Option) =>
		option.string?.required ??
		option.integer?.required ??
		option.bool?.required ??
		option.attachment?.required ??
		false;
	const byRequired = Object.entries(options).sort(([, a], [, b]) => Number(required(b)) - Number(required(a)));

	for (const [rawName, option] of byRequired) {
		const name = validName("option", rawName);

		if (option.string) {
			const spec = option.string;
			builder.addStringOption((o) => {
				o.setName(name)
					.setDescription(spec.description)
					.setRequired(spec.required ?? false);
				if (spec.minLength !== undefined) o.setMinLength(spec.minLength);
				if (spec.maxLength !== undefined) o.setMaxLength(spec.maxLength);
				if (spec.choices) o.addChoices(...asChoices(spec.choices));
				return o;
			});
		} else if (option.integer) {
			const spec = option.integer;
			builder.addIntegerOption((o) => {
				o.setName(name)
					.setDescription(spec.description)
					.setRequired(spec.required ?? false);
				if (spec.min !== undefined) o.setMinValue(spec.min);
				if (spec.max !== undefined) o.setMaxValue(spec.max);
				if (spec.choices) o.addChoices(...asChoices(spec.choices));
				return o;
			});
		} else if (option.bool) {
			const spec = option.bool;
			builder.addBooleanOption((o) =>
				o
					.setName(name)
					.setDescription(spec.description)
					.setRequired(spec.required ?? false),
			);
		} else if (option.attachment) {
			const spec = option.attachment;
			builder.addAttachmentOption((o) =>
				o
					.setName(name)
					.setDescription(spec.description)
					.setRequired(spec.required ?? false),
			);
		}
	}
}

// Discord allows one or the other on a command, never both.
type Shape = { options?: Options; subcommands?: never } | { subcommands?: Subcommands; options?: never };

type Args = {
	name: string;
	description: string;
	contexts?: InteractionContextType;
	permissions?: number;
	ephemeral?: boolean;
	timeout?: number; // delete the reply after this many seconds, unless it ended up ephemeral
	hiddenFromRole?: string;
	execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
} & Shape;

/** One slash command: its registration data and its handler. */
export class Command {
	readonly data: SlashCommandBuilder;
	readonly permissions: number; // every bit must be held; defaults to Perms.Owner, so a new command is locked
	readonly execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
	readonly hiddenFromRole?: string; // role denied visibility, for a one-shot command that grants it

	constructor(args: Args) {
		const data = new SlashCommandBuilder()
			.setName(validName("command", args.name))
			.setDescription(args.description);
		if (args.contexts !== undefined) data.setContexts(args.contexts);

		if (args.options) addOptions(data, args.options);
		for (const [rawName, sub] of Object.entries(args.subcommands ?? {})) {
			const name = validName("subcommand", rawName);
			data.addSubcommand((s) => {
				s.setName(name).setDescription(sub.description);
				addOptions(s, sub.options ?? {});
				return s;
			});
		}

		this.permissions = args.permissions ?? Perms.Owner;
		// hides gated commands from non-admins in the client only — the Perms table still decides who may run
		// them, and per-role visibility is granted in Server Settings → Integrations
		if (this.permissions !== Perms.None) data.setDefaultMemberPermissions(0n);
		this.data = data;
		this.hiddenFromRole = args.hiddenFromRole;
		this.execute =
			args.ephemeral || args.timeout
				? async (interaction) => {
						if (args.ephemeral) await interaction.deferReply({ flags: MessageFlags.Ephemeral });
						await args.execute(interaction);
						if (args.timeout && interaction.ephemeral !== true) {
							setTimeout(() => interaction.deleteReply().catch(() => {}), args.timeout * 1000);
						}
					}
				: args.execute;
	}
}

/**
 * Who ran a moderation command, for Roblox-side audit trails: every ban goes through one API key, so the
 * caller is otherwise unrecoverable. The immutable user ID is included because usernames can change.
 */
export function AuditTag(interaction: ChatInputCommandInteraction): string {
	return `@${interaction.user.username} (${interaction.user.id}) via Discord`;
}
