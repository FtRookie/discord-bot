import { InteractionContextType } from "discord.js";
import { Jimp } from "jimp";
import { config } from "../config.ts";
import { UserError } from "../roblox.ts";
import { Command } from "./command.ts";
import { pixelRateLimit } from "./pixel.ts";

export const unpixel = new Command({
	name: "unpixel",
	description: "Downscale an image to an 8×8 or 16×16 hex grid you can feed back into /pixel",
	contexts: InteractionContextType.Guild,
	ownerOnly: false,
	ephemeral: true,
	options: (data) =>
		data
			.addAttachmentOption((o) =>
				o.setName("image").setDescription("The image to reduce to pixels (PNG, JPEG, WebP, …)").setRequired(true),
			)
			.addIntegerOption((o) =>
				o
					.setName("size")
					.setDescription("Grid edge length. Default: 16")
					.addChoices({ name: "8×8", value: 8 }, { name: "16×16", value: 16 }),
			),
	async execute(interaction) {
		if (interaction.user.id !== config.discord.ownerId) pixelRateLimit(interaction.user.id, false);

		const image = interaction.options.getAttachment("image", true);
		const side = interaction.options.getInteger("size") ?? 16;

		if (!image.contentType?.startsWith("image/")) throw new UserError("That attachment isn't an image.");
		if (image.size > config.pixel.maxUploadBytes) {
			throw new UserError(`That image is too large (max ${Math.floor(config.pixel.maxUploadBytes / 1024 / 1024)} MB).`);
		}

		const res = await fetch(image.url);
		if (!res.ok) throw new UserError("Couldn't download the image from Discord — try again.");
		const bytes = Buffer.from(await res.arrayBuffer());

		const decoded = await Jimp.read(bytes).catch(() => {
			throw new UserError("Couldn't read that image — is it a valid PNG/JPEG/WebP/GIF?");
		});
		const { data, width, height } = decoded.bitmap; // data: tightly packed RGBA
		if (width * height > config.pixel.maxSourcePixels) throw new UserError("That image has too many pixels to process.");

		const rgb = downsample(data, width, height, side);
		const hex = Buffer.from(rgb).toString("hex");

		await interaction.editReply({
			content: `${side}×${side} · ${hex.length} chars — paste into \`/pixel\`:\n\`\`\`\n${hex}\n\`\`\``,
			allowedMentions: { parse: [] },
		});
	},
});

/**
 * Box-average an RGBA image down to a side×side grid, dropping alpha to RRGGBB.
 * Averaging every source pixel in each cell (not point-sampling) keeps the
 * reduction faithful and round-trips /pixel's own output exactly. It's
 * alpha-weighted so transparent regions don't bleed toward black; fully
 * transparent cells resolve to black, matching /pixel's opaque grids.
 */
function downsample(rgba: Uint8Array, width: number, height: number, side: number): Uint8Array {
	const out = new Uint8Array(side * side * 3);
	for (let gy = 0; gy < side; gy++) {
		const y0 = Math.floor((gy * height) / side);
		const y1 = Math.max(y0 + 1, Math.floor(((gy + 1) * height) / side));
		for (let gx = 0; gx < side; gx++) {
			const x0 = Math.floor((gx * width) / side);
			const x1 = Math.max(x0 + 1, Math.floor(((gx + 1) * width) / side));
			let r = 0, g = 0, b = 0, aw = 0;
			for (let y = y0; y < y1; y++) {
				for (let x = x0; x < x1; x++) {
					const o = (y * width + x) * 4;
					const a = rgba[o + 3] ?? 0;
					r += (rgba[o] ?? 0) * a;
					g += (rgba[o + 1] ?? 0) * a;
					b += (rgba[o + 2] ?? 0) * a;
					aw += a;
				}
			}
			const o = (gy * side + gx) * 3;
			if (aw > 0) {
				out[o] = Math.round(r / aw);
				out[o + 1] = Math.round(g / aw);
				out[o + 2] = Math.round(b / aw);
			}
		}
	}
	return out;
}
