// Small, dependency-light pixel-grid helpers shared by /pixel and /unpixel.
// Grouped under the `Image` namespace, used as `import { Image } from "../image.ts"` → `Image.upscale(...)`.

import { deflateSync } from "node:zlib";

export namespace Image {
	/** Nearest-neighbor upscale so pixels stay crisp instead of blurring. */
	export function upscale(rgba: Uint8Array, side: number, scale: number): { data: Uint8Array; size: number } {
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

	/**
	 * Box-average an RGBA image down to a side×side grid, dropping alpha to RRGGBB.
	 *
	 * Averaging every source pixel in each cell (not point-sampling) keeps the reduction faithful and round-trips upscale()'s output exactly.
	 *
	 * It's alpha-weighted so transparent regions don't bleed toward black; fully transparent cells resolve to black, matching /pixel's opaque grids.
	 */
	export function downsample(rgba: Uint8Array, width: number, height: number, side: number): Uint8Array {
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

	export function encodePng(rgba: Uint8Array, width: number, height: number): Buffer {
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
}
