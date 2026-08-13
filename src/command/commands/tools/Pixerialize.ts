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
import { Config } from "../../../Config.ts";
import { Image } from "../../../helpers/Image.ts";
import { Can, Perms } from "../../../helpers/Permissions.ts";
import { UserError } from "../../../helpers/Roblox.ts";
import { Command } from "../../Command.ts";
import { PixelRateLimit } from "./Render.ts";

export const Pixerialize = new Command({
	name: "pixerialize",
	description: "Generate a 384 or 1536 character hex string from an image (attachment or link)",
	contexts: InteractionContextType.Guild,
	permissions: Perms.None,
	ephemeral: true,
	options: {
		image: { attachment: { description: "The image to convert (PNG, JPEG, WebP, …)" } },
		url: { string: { description: "…or a direct link to an image" } },
		size: { integer: { description: "Grid edge length. Default: 16", choices: { "8x8": 8, "16x16": 16 } } },
	},
	async execute(interaction) {
		if (!Can(interaction.user.id, Perms.Unlimited)) PixelRateLimit(interaction.user.id, false);

		const attachment = interaction.options.getAttachment("image");
		const link = interaction.options.getString("url");
		const side = interaction.options.getInteger("size") ?? 16;

		const source = attachment?.url ?? link;
		if (!source || (attachment && link)) throw new UserError("Provide exactly one of `image` or `url`.");

		if (attachment) {
			if (!attachment.contentType?.startsWith("image/")) throw new UserError("That attachment isn't an image.");
			if (attachment.size > Config.pixel.maxUploadBytes) throw new UserError(tooLargeMessage());
		}

		const bytes = await download(source);

		// checked from the header *before* decoding, so an over-large image never gets to allocate
		const declared = imageDimensions(bytes);
		if (declared.width * declared.height > Config.pixel.maxSourcePixels)
			throw new UserError("That image has too many pixels to process.");

		const { data, width, height } = await decodeToRgba(bytes);
		if (width * height > Config.pixel.maxSourcePixels)
			throw new UserError("That image has too many pixels to process.");

		const rgb = Image.downsample(data, width, height, side);
		const hex = Buffer.from(rgb).toString("hex");

		await interaction.editReply({
			content: `${side}x${side} · ${hex.length} chars — paste into \`/render\`:\n\`\`\`\n${hex}\n\`\`\``,
			allowedMentions: { parse: [] },
		});
	},
});

function tooLargeMessage(): string {
	return `That image is too large (max ${Math.floor(Config.pixel.maxUploadBytes / 1024 / 1024)} MB).`;
}

/** Width/height from the header only — no full decode, so nothing large is allocated to find them. */
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

/** Jimp can't decode WebP, so a RIFF/WEBP container is routed to the wasm decoder instead. */
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
 * Rejects a host resolving to any non-public address, and pins the socket to a validated IP. Used as
 * node:http(s)'s `lookup`, so the check runs at connect time on every request including each redirect hop:
 * the IP validated is the one connected to, leaving no DNS-rebinding window between checking and fetching.
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

/** Scheme check only; the IP-level SSRF filtering happens in pinnedLookup. */
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

/** Capped as it streams, so a lying Content-Length can't run the process out of memory. */
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
 * http(s) only, with every hop IP-filtered and pinned at connect time by pinnedLookup. Redirects are followed
 * manually so the scheme is re-checked on each, every request has a timeout, and the body is capped.
 */
async function download(rawUrl: string): Promise<Buffer> {
	const cap = Config.pixel.maxUploadBytes;
	let url = requireHttpUrl(rawUrl);

	for (let hop = 0; hop <= 4; hop++) {
		const res = await requestOnce(url);
		const status = res.statusCode ?? 0;
		const location = res.headers.location;

		if (status >= 300 && status < 400 && location) {
			res.resume(); // drained and discarded before the next hop
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
