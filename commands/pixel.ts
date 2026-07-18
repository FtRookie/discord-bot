import { AttachmentBuilder, InteractionContextType, MessageFlags } from "discord.js";
import { deflateSync } from "node:zlib";
import { config } from "../config.ts";
import { UserError } from "../roblox.ts";
import { Command } from "./command.ts";

// Per-user render timestamps, split by output mode. Entries are pruned lazily.
const history = new Map<string, { visible: number[]; ephemeral: number[] }>();

export const pixel = new Command({
	name: "pixel",
	description: "Render a hex pixel grid as an image (384 chars → 8×8, 1536 chars → 16×16)",
	contexts: InteractionContextType.Guild,
	ownerOnly: false,
	options: (data) =>
		data
			.addStringOption((o) =>
				o
					.setName("hex")
					.setDescription("RRGGBB per pixel, left-to-right then top-to-bottom. 384 chars → 8×8, 1536 → 16×16")
					.setRequired(true)
					.setMaxLength(6000),
			)
			.addBooleanOption((o) =>
				o
					.setName("share")
					.setDescription(`Post in the channel (${config.pixel.maxVisible}/min) vs. only to you (${config.pixel.maxEphemeral}/min). Default: on`),
			),
	async execute(interaction) {
		const { side, rgba } = parseGrid(interaction.options.getString("hex", true));
		const share = interaction.options.getBoolean("share") ?? true;
		if (interaction.user.id !== config.discord.ownerId) rateLimit(interaction.user.id, share);

		const scale = Math.max(1, Math.floor(config.pixel.targetSize / side));
		const { data, size } = upscale(rgba, side, scale);
		const png = encodePng(data, size, size);

		await interaction.deferReply(share ? {} : { flags: MessageFlags.Ephemeral });
		await interaction.editReply({ files: [new AttachmentBuilder(png, { name: "pixel.png" })] });
	},
});

/** Parse concatenated RRGGBB colors into a square RGBA grid. Whitespace and '#' are ignored. */
function parseGrid(input: string): { side: number; rgba: Uint8Array } {
	const hex = input.replace(/[\s#]/g, "");
	if (!/^[0-9a-fA-F]*$/.test(hex)) throw new UserError("Only hex characters (0-9, a-f) are allowed.");
	if (hex.length !== 384 && hex.length !== 1536) {
		throw new UserError(`Expected 384 characters (8×8) or 1536 characters (16×16); got ${hex.length}.`);
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

/** Throw if the user has exceeded their per-minute allowance for the chosen mode. */
function rateLimit(userId: string, visible: boolean): void {
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

/** Nearest-neighbor upscale so pixels stay crisp instead of blurring. */
function upscale(rgba: Uint8Array, side: number, scale: number): { data: Uint8Array; size: number } {
	const size = side * scale;
	const data = new Uint8Array(size * size * 4);
	for (let y = 0; y < size; y++) {
		const sy = (y / scale) | 0;
		for (let x = 0; x < size; x++) {
			const s = (sy * side + ((x / scale) | 0)) * 4;
			data.set(rgba.subarray(s, s + 4), (y * size + x) * 4);
		}
	}
	return { data, size };
}

// --- Minimal PNG encoder (8-bit RGBA), using only node:zlib. ---

const crcTable = Array.from({ length: 256 }, (_, n) => {
	let c = n;
	for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	return c >>> 0;
});

function crc32(buf: Buffer): number {
	let c = 0xffffffff;
	for (const b of buf) c = (crcTable[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
	const out = Buffer.alloc(data.length + 12);
	out.writeUInt32BE(data.length, 0);
	out.write(type, 4, "ascii");
	data.copy(out, 8);
	out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
	return out;
}

function encodePng(rgba: Uint8Array, width: number, height: number): Buffer {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 6; // color type: RGBA (10-12 stay 0: default compression/filter/interlace)

	// Prefix each scanline with a filter-type byte (0 = none).
	const stride = width * 4;
	const raw = Buffer.alloc((stride + 1) * height);
	for (let y = 0; y < height; y++) {
		Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
	}

	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(raw)),
		chunk("IEND", Buffer.alloc(0)),
	]);
}
