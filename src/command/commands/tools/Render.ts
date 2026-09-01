import { AttachmentBuilder, InteractionContextType, MessageFlags } from "discord.js";
import { Config } from "../../../Config.ts";
import { Image } from "../../../helpers/Image.ts";
import { Can, Perms } from "../../../helpers/Permissions.ts";
import { RateWindow } from "../../../helpers/RateLimit.ts";
import { UserError } from "../../../helpers/Roblox.ts";
import { Command } from "../../Command.ts";

// keyed per user AND mode, so the public and private allowances drain independently
const renders = new RateWindow(Config.pixel.windowMs);

export const Render = new Command({
	name: "render",
	description: "Render a hex pixel grid as an image (384 chars = 8x8, 1536 chars = 16x16)",
	contexts: InteractionContextType.Guild,
	permissions: Perms.None,
	options: {
		hex: {
			string: {
				description: "RRGGBB per serial pixel. 384 chars = 8x8, 1536 = 16x16",
				required: true,
				maxLength: 6000,
			},
		},
		share: {
			bool: {
				description: `Post in the channel (${Config.pixel.maxVisible}/min) vs. only to you (${Config.pixel.maxEphemeral}/min). Default: on`,
			},
		},
	},
	async execute(interaction) {
		const { side, rgba } = parseGrid(interaction.options.getString("hex", true));
		const share = interaction.options.getBoolean("share") ?? true;
		if (!Can(interaction.user.id, Perms.Unlimited)) PixelRateLimit(interaction.user.id, share);

		const scale = Math.max(1, Math.floor(Config.pixel.targetSize / side));
		const { data, size } = Image.upscale(rgba, side, scale);
		const png = Image.encodePng(data, size, size);

		await interaction.deferReply(share ? {} : { flags: MessageFlags.Ephemeral });
		await interaction.editReply({ files: [new AttachmentBuilder(png, { name: "pixel.png" })] });
	},
});

/** Concatenated RRGGBB colors as a square RGBA grid. Whitespace and '#' are ignored. */
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

/** Throws past the per-minute allowance for the chosen mode. Shared with /pixerialize. */
export function PixelRateLimit(userId: string, visible: boolean): void {
	const key = `${userId}:${visible ? "visible" : "ephemeral"}`;
	const max = visible ? Config.pixel.maxVisible : Config.pixel.maxEphemeral;
	const { count, retryAfterMs } = renders.peek(key);
	if (count >= max) {
		const wait = Math.ceil(retryAfterMs / 1000);
		throw new UserError(
			`Slow down — ${max} ${visible ? "public" : "private"} image${max === 1 ? "" : "s"} per minute. Try again in ${wait}s.`,
		);
	}
	renders.hit(key);
}
