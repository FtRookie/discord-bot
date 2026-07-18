import * as dns from "node:dns";
import type { IncomingMessage } from "node:http";
import * as http from "node:http";
import * as https from "node:https";
import type { LookupFunction } from "node:net";
import { decode as decodeWebp } from "@jsquash/webp";
import { InteractionContextType } from "discord.js";
import { imageSize } from "image-size";
import * as ipaddr from "ipaddr.js";
import { Jimp } from "jimp";
import { config } from "../../Config.ts";
import { Image } from "../../helpers/Image.ts";
import { UserError } from "../../helpers/Roblox.ts";
import { Command } from "../Command.ts";
import { pixelRateLimit } from "./Pixel.ts";

export const unpixel = new Command({
	name: "unpixel",
	description: "Generate a 384 or 1536 character hex string from an image (attachment or link)",
	contexts: InteractionContextType.Guild,
	ownerOnly: false,
	ephemeral: true,
	// biome-ignore format: hand-aligned builder for readability
	options: (data) => data
		.addAttachmentOption((o) => o
			.setName("image")
			.setDescription("The image to convert (PNG, JPEG, WebP, …)"))
		.addStringOption((o) => o
			.setName("url")
			.setDescription("…or a direct link to an image"))
		.addIntegerOption((o) => o
			.setName("size")
			.setDescription("Grid edge length. Default: 16")
			.addChoices({ name: "8x8", value: 8 }, { name: "16x16", value: 16 })),
	async execute(interaction) {
		if (interaction.user.id !== config.discord.ownerId) pixelRateLimit(interaction.user.id, false);

		const attachment = interaction.options.getAttachment("image");
		const link = interaction.options.getString("url");
		const side = interaction.options.getInteger("size") ?? 16;

		const source = attachment?.url ?? link;
		if (!source || (attachment && link)) throw new UserError("Provide exactly one of `image` or `url`.");

		if (attachment) {
			if (!attachment.contentType?.startsWith("image/")) throw new UserError("That attachment isn't an image.");
			if (attachment.size > config.pixel.maxUploadBytes) throw new UserError(tooLargeMessage());
		}

		const bytes = await download(source);

		// Reject oversized images from the header *before* decoding, so a decompression bomb can't allocate first.
		const declared = imageDimensions(bytes);
		if (declared.width * declared.height > config.pixel.maxSourcePixels)
			throw new UserError("That image has too many pixels to process.");

		const { data, width, height } = await decodeToRgba(bytes);
		if (width * height > config.pixel.maxSourcePixels)
			throw new UserError("That image has too many pixels to process.");

		const rgb = Image.downsample(data, width, height, side);
		const hex = Buffer.from(rgb).toString("hex");

		await interaction.editReply({
			content: `${side}x${side} · ${hex.length} chars — paste into \`/pixel\`:\n\`\`\`\n${hex}\n\`\`\``,
			allowedMentions: { parse: [] },
		});
	},
});

function tooLargeMessage(): string {
	return `That image is too large (max ${Math.floor(config.pixel.maxUploadBytes / 1024 / 1024)} MB).`;
}

/** Read width/height from an image header (no full decode) so oversized inputs are rejected before allocating. */
function imageDimensions(bytes: Buffer): { width: number; height: number } {
	let width: number | undefined;
	let height: number | undefined;
	try {
		({ width, height } = imageSize(bytes));
	} catch {
		throw new UserError("Couldn't read that image — is it a valid PNG, JPEG, GIF, BMP, TIFF, or WebP?");
	}
	if (!width || !height) throw new UserError("Couldn't read that image's dimensions.");
	return { width, height };
}

/** A RIFF/WEBP container? Jimp can't decode WebP, so it's routed to the wasm decoder. */
function isWebp(bytes: Buffer): boolean {
	return bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
}

/** Decode any supported image to tightly packed RGBA — WebP via @jsquash (wasm), everything else via Jimp. */
async function decodeToRgba(bytes: Buffer): Promise<{ data: Uint8Array; width: number; height: number }> {
	if (isWebp(bytes)) {
		const tight = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
		const image = await decodeWebp(tight).catch(() => {
			throw new UserError("Couldn't read that WebP image.");
		});
		return {
			data: new Uint8Array(image.data.buffer, image.data.byteOffset, image.data.byteLength),
			width: image.width,
			height: image.height,
		};
	}
	const decoded = await Jimp.read(bytes).catch(() => {
		throw new UserError("Couldn't read that image — is it a valid PNG, JPEG, GIF, BMP, TIFF, or WebP?");
	});
	return decoded.bitmap;
}

/**
 * DNS lookup that resolves a host, rejects if any address is non-public, and pins the socket to a
 * validated IP. Used as node:http(s)'s `lookup` so the SSRF check happens at connect time on every
 * request (including each redirect hop) — the exact IP validated is the one connected to, so there is
 * no DNS-rebinding window between checking and fetching.
 */
const pinnedLookup: LookupFunction = (hostname, options, callback) => {
	dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
		if (err) return callback(err, "", 0);
		const blocked = addresses.find((a) => ipaddr.process(a.address).range() !== "unicast");
		if (blocked) return callback(new Error(`Blocked non-public address: ${blocked.address}`), "", 0);
		if (options.all) return callback(null, addresses);
		const first = addresses[0];
		if (!first) return callback(new Error("Host did not resolve."), "", 0);
		callback(null, first.address, first.family);
	});
};

/** Parse a user URL and require an http(s) scheme (IP-level SSRF filtering happens in pinnedLookup). */
function requireHttpUrl(raw: string): URL {
	let url: URL;
	try {
		url = new URL(raw.trim());
	} catch {
		throw new UserError("That doesn't look like a valid URL.");
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw new UserError("Image links must start with http:// or https://.");
	}
	return url;
}

/** Issue one request through the SSRF-pinned lookup, with a connect/response timeout. */
function requestOnce(url: URL): Promise<IncomingMessage> {
	return new Promise((resolve, reject) => {
		const options = { lookup: pinnedLookup, signal: AbortSignal.timeout(10_000) };
		const req =
			url.protocol === "https:" ? https.request(url, options, resolve) : http.request(url, options, resolve);
		req.on("error", () =>
			reject(
				new UserError("Couldn't fetch that link — it timed out, was unreachable, or points to a blocked host."),
			),
		);
		req.end();
	});
}

/** Read a response body into a Buffer, aborting if it exceeds the cap (so a lying length can't OOM). */
function readCapped(res: IncomingMessage, cap: number): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let total = 0;
		res.on("data", (chunk: Buffer) => {
			total += chunk.length;
			if (total > cap) {
				res.destroy();
				reject(new UserError(tooLargeMessage()));
				return;
			}
			chunks.push(chunk);
		});
		res.on("end", () => resolve(Buffer.concat(chunks)));
		res.on("error", () => reject(new UserError("The image download failed midway.")));
	});
}

/**
 * Fetch an image URL into a Buffer. http(s) only; every hop is IP-filtered and pinned at connect time by
 * pinnedLookup; redirects are followed manually so the scheme is re-checked; each request has a timeout;
 * and the body is capped at config.pixel.maxUploadBytes.
 */
async function download(rawUrl: string): Promise<Buffer> {
	const cap = config.pixel.maxUploadBytes;
	let url = requireHttpUrl(rawUrl);

	for (let hop = 0; hop <= 4; hop++) {
		const res = await requestOnce(url);
		const status = res.statusCode ?? 0;
		const location = res.headers.location;

		if (status >= 300 && status < 400 && location) {
			res.resume(); // drain and discard before the next hop
			url = requireHttpUrl(new URL(location, url).toString());
			continue;
		}
		if (status !== 200) {
			res.resume();
			throw new UserError(`Couldn't fetch that link (HTTP ${status}).`);
		}
		const type = res.headers["content-type"];
		if (type && !/^\s*image\//i.test(type)) {
			res.resume();
			throw new UserError("That link isn't an image.");
		}
		return await readCapped(res, cap);
	}
	throw new UserError("That link redirects too many times.");
}
