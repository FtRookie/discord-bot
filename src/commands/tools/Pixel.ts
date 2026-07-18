import { AttachmentBuilder, InteractionContextType, MessageFlags } from "discord.js";
import { config } from "../../Config.ts";
import { Image } from "../../helpers/Image.ts";
import { UserError } from "../../helpers/Roblox.ts";
import { Command } from "../Command.ts";

// Per-user render timestamps, split by output mode. Entries are pruned lazily.
const history = new Map<string, { visible: number[]; ephemeral: number[] }>();

export const pixel = new Command({
	name: "pixel",
	description: "Render a hex pixel grid as an image (384 chars → 8x8, 1536 chars → 16x16)",
	contexts: InteractionContextType.Guild,
	ownerOnly: false,
	// biome-ignore format: hand-aligned builder for readability
	options: (data) => data
		.addStringOption((o) => o
			.setName("hex")
			.setDescription("RRGGBB per pixel, left-to-right then top-to-bottom. 384 chars → 8x8, 1536 → 16x16")
			.setRequired(true)
			.setMaxLength(6000))
		.addBooleanOption((o) => o
			.setName("share")
			.setDescription(`Post in the channel (${config.pixel.maxVisible}/min) vs. only to you (${config.pixel.maxEphemeral}/min). Default: on`)),
	async execute(interaction) {
		const { side, rgba } = parseGrid(interaction.options.getString("hex", true));
		const share = interaction.options.getBoolean("share") ?? true;
		if (interaction.user.id !== config.discord.ownerId) pixelRateLimit(interaction.user.id, share);

		const scale = Math.max(1, Math.floor(config.pixel.targetSize / side));
		const { data, size } = Image.upscale(rgba, side, scale);
		const png = Image.encodePng(data, size, size);

		await interaction.deferReply(share ? {} : { flags: MessageFlags.Ephemeral });
		await interaction.editReply({ files: [new AttachmentBuilder(png, { name: "pixel.png" })] });
	},
});

/** Parse concatenated RRGGBB colors into a square RGBA grid. Whitespace and '#' are ignored. */
function parseGrid(input: string): { side: number; rgba: Uint8Array } {
	const hex = input.replace(/[\s#]/g, "");
	if (!/^[0-9a-fA-F]*$/.test(hex)) throw new UserError("Only hex characters (0-9, a-f) are allowed.");
	if (hex.length !== 384 && hex.length !== 1536) {
		throw new UserError(`Expected 384 characters (8x8) or 1536 characters (16x16); got ${hex.length}.`);
	}
	const count = hex.length / 6;
	const side = Math.sqrt(count); // 8 or 16
	const rgba = new Uint8Array(count * 4);
	for (let i = 0; i < count; i++) {
		rgba[i * 4] = parseInt(hex.slice(i * 6, i * 6 + 2), 16);
		rgba[i * 4 + 1] = parseInt(hex.slice(i * 6 + 2, i * 6 + 4), 16);
		rgba[i * 4 + 2] = parseInt(hex.slice(i * 6 + 4, i * 6 + 6), 16);
		rgba[i * 4 + 3] = 255;
	}
	return { side, rgba };
}

/** Throw if the user has exceeded their per-minute allowance for the chosen mode. Shared with /unpixel. */
export function pixelRateLimit(userId: string, visible: boolean): void {
	const now = Date.now();
	const cutoff = now - config.pixel.windowMs;
	const entry = history.get(userId) ?? { visible: [], ephemeral: [] };
	const key = visible ? "visible" : "ephemeral";
	const max = visible ? config.pixel.maxVisible : config.pixel.maxEphemeral;
	const recent = entry[key].filter((t) => t > cutoff);
	if (recent.length >= max) {
		const oldest = recent[0] ?? now;
		const wait = Math.ceil((oldest + config.pixel.windowMs - now) / 1000);
		throw new UserError(
			`Slow down — ${max} ${visible ? "public" : "private"} image${max === 1 ? "" : "s"} per minute. Try again in ${wait}s.`,
		);
	}
	recent.push(now);
	entry[key] = recent;
	history.set(userId, entry);
}
