import { InteractionContextType } from "discord.js";
import { Jimp } from "jimp";
import { config } from "../../Config.ts";
import { Image } from "../../helpers/Image.ts";
import { UserError } from "../../helpers/Roblox.ts";
import { Command } from "../Command.ts";
import { pixelRateLimit } from "./Pixel.ts";

export const unpixel = new Command({
	name: "unpixel",
	description: "Generate a 384 or 1536 character hex string from an image",
	contexts: InteractionContextType.Guild,
	ownerOnly: false,
	ephemeral: true,
	// biome-ignore format: hand-aligned builder for readability
	options: (data) => data
		.addAttachmentOption((o) => o
			.setName("image")
			.setDescription("The image to convert (PNG, JPEG, WebP, …)")
			.setRequired(true))
		.addIntegerOption((o) => o
			.setName("size")
			.setDescription("Grid edge length. Default: 16")
			.addChoices({ name: "8x8", value: 8 }, { name: "16x16", value: 16 })),
	async execute(interaction) {
		if (interaction.user.id !== config.discord.ownerId) pixelRateLimit(interaction.user.id, false);

		const image = interaction.options.getAttachment("image", true);
		const side = interaction.options.getInteger("size") ?? 16;

		if (!image.contentType?.startsWith("image/")) throw new UserError("That attachment isn't an image.");
		if (image.size > config.pixel.maxUploadBytes) {
			throw new UserError(
				`That image is too large (max ${Math.floor(config.pixel.maxUploadBytes / 1024 / 1024)} MB).`,
			);
		}

		const res = await fetch(image.url);
		if (!res.ok) throw new UserError("Couldn't download the image from Discord — try again.");
		const bytes = Buffer.from(await res.arrayBuffer());

		const decoded = await Jimp.read(bytes).catch(() => {
			throw new UserError("Couldn't read that image — is it a valid PNG/JPEG/WebP/GIF?");
		});
		const { data, width, height } = decoded.bitmap; // data: tightly packed RGBA
		if (width * height > config.pixel.maxSourcePixels)
			throw new UserError("That image has too many pixels to process.");

		const rgb = Image.downsample(data, width, height, side);
		const hex = Buffer.from(rgb).toString("hex");

		await interaction.editReply({
			content: `${side}×${side} · ${hex.length} chars — paste into \`/pixel\`:\n\`\`\`\n${hex}\n\`\`\``,
			allowedMentions: { parse: [] },
		});
	},
});
