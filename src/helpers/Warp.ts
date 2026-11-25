import * as net from "node:net";
import * as tls from "node:tls";
import * as ipaddr from "ipaddr.js";
import { Config } from "../Config.ts";

/** WARP's local proxy itself is down or misbehaving — an operator problem, not the user's link. */
export class WarpUnavailable extends Error {}

/** WARP reached, but the target failed: refused, unreachable, timed out, bad TLS or a malformed response. */
export class WarpTargetFailed extends Error {}

/** The response body ran past the caller's cap. */
export class WarpTooLarge extends Error {}

const SOCKS = 5;
const ATYP_IPV4 = 1;
const ATYP_DOMAIN = 3;
const ATYP_IPV6 = 4;

function connectRequest(ip: string, port: number): Buffer {
	const addr = ipaddr.parse(ip);
	const bytes = addr.toByteArray();
	return Buffer.from([
		SOCKS,
		1, // CONNECT
		0,
		addr.kind() === "ipv4" ? ATYP_IPV4 : ATYP_IPV6,
		...bytes,
		port >> 8,
		port & 0xff,
	]);
}

/**
 * A TCP connection to `ip:port` tunneled through Cloudflare WARP's local SOCKS5 proxy (`warp-cli mode proxy`),
 * so the far end sees a Cloudflare egress address instead of the host's. Takes an IP, never a hostname: the
 * caller resolves and vets it first, so what was checked is exactly what gets connected to. Never falls back
 * to a direct connection — if WARP is down, this fails.
 */
export function WarpConnect(ip: string, port: number, signal?: AbortSignal): Promise<net.Socket> {
	return new Promise((resolve, reject) => {
		const socket = net.connect(Config.warp.port, Config.warp.host);
		let buffered = Buffer.alloc(0);
		let stage: "greeting" | "connect" = "greeting";

		const cleanup = () => {
			socket.off("data", onData);
			socket.off("error", onError);
			socket.off("close", onClose);
			signal?.removeEventListener("abort", onAbort);
		};
		const fail = (err: Error) => {
			cleanup();
			socket.destroy();
			reject(err);
		};
		const onError = (err: Error) => fail(new WarpUnavailable(`WARP proxy connection failed: ${err.message}`));
		const onClose = () => fail(new WarpUnavailable("WARP proxy closed the connection mid-handshake."));
		const onAbort = () => fail(new WarpTargetFailed("Timed out connecting through WARP."));

		const onData = (chunk: Buffer) => {
			buffered = Buffer.concat([buffered, chunk]);
			if (stage === "greeting") {
				if (buffered.length < 2) return;
				if (buffered[0] !== SOCKS || buffered[1] !== 0)
					return fail(new WarpUnavailable("WARP proxy rejected the no-auth SOCKS5 greeting."));
				buffered = buffered.subarray(2);
				stage = "connect";
				socket.write(connectRequest(ip, port));
			}
			// reply: VER REP RSV ATYP BND.ADDR BND.PORT, where BND.ADDR's length depends on ATYP
			if (buffered.length < 5) return;
			if (buffered[0] !== SOCKS) return fail(new WarpUnavailable("WARP proxy sent a malformed SOCKS5 reply."));
			if (buffered[1] !== 0)
				return fail(new WarpTargetFailed(`WARP couldn't reach ${ip}:${port} (SOCKS5 reply ${buffered[1]}).`));
			const atyp = buffered[3];
			const addrLength =
				atyp === ATYP_IPV4 ? 4 : atyp === ATYP_IPV6 ? 16 : atyp === ATYP_DOMAIN ? 1 + (buffered[4] ?? 0) : -1;
			if (addrLength < 0) return fail(new WarpUnavailable("WARP proxy sent a malformed SOCKS5 reply."));
			const replyLength = 4 + addrLength + 2;
			if (buffered.length < replyLength) return;

			cleanup();
			socket.pause(); // handed over paused, so no tunneled byte is dropped before the caller's reader attaches
			if (buffered.length > replyLength) socket.unshift(buffered.subarray(replyLength));
			resolve(socket);
		};

		if (signal?.aborted) return onAbort();
		signal?.addEventListener("abort", onAbort);
		socket.on("data", onData);
		socket.on("error", onError);
		socket.on("close", onClose);
		socket.once("connect", () => socket.write(Buffer.from([SOCKS, 1, 0]))); // one method offered: no auth
	});
}

/** Buffered reads over a socket's async iterator: whole lines for the head, raw pieces for the body. */
class Reader {
	private buffered: Buffer = Buffer.alloc(0);
	constructor(private readonly chunks: AsyncIterator<Buffer>) {}

	private async more(): Promise<boolean> {
		const next = await this.chunks.next();
		if (next.done) return false;
		this.buffered = this.buffered.length ? Buffer.concat([this.buffered, next.value]) : next.value;
		return true;
	}

	/** One CRLF-terminated line, refused past `max` bytes so a server can't stream an endless header. */
	async line(max: number): Promise<string> {
		for (;;) {
			const end = this.buffered.indexOf("\r\n");
			if (end >= 0) {
				const line = this.buffered.subarray(0, end).toString("latin1");
				this.buffered = this.buffered.subarray(end + 2);
				return line;
			}
			if (this.buffered.length > max) throw new WarpTargetFailed("Response line too long.");
			if (!(await this.more())) throw new WarpTargetFailed("Connection closed mid-response.");
		}
	}

	/** Exactly `n` bytes, handed over piece by piece without re-concatenating them. */
	async exact(n: number, take: (piece: Buffer) => void): Promise<void> {
		while (n > 0) {
			if (!this.buffered.length && !(await this.more()))
				throw new WarpTargetFailed("Connection closed mid-response.");
			const piece = this.buffered.subarray(0, n);
			this.buffered = this.buffered.subarray(piece.length);
			n -= piece.length;
			take(piece);
		}
	}

	/** Everything until the server closes the connection. */
	async rest(take: (piece: Buffer) => void): Promise<void> {
		if (this.buffered.length) take(this.buffered);
		this.buffered = Buffer.alloc(0);
		for (;;) {
			const next = await this.chunks.next();
			if (next.done) return;
			take(next.value);
		}
	}
}

export type WarpResponse = {
	status: number;
	/** Lowercased names. */
	headers: Map<string, string>;
	/** The whole body, rejecting with WarpTooLarge past `cap` bytes. */
	body(cap: number): Promise<Buffer>;
	/** Done with it without reading the body. */
	close(): void;
};

/**
 * One HTTP/1.1 GET for `url`, sent to `ip` through WarpConnect, with TLS inside the tunnel verified against
 * the URL's hostname. HTTP is spoken here by hand rather than through node:http: Bun 1.3's http client ignores
 * `createConnection` and dials the host itself, which would bypass both WARP and the caller's IP vetting.
 * `ca` exists for tests, which serve a self-signed certificate.
 */
export async function WarpRequest(
	url: URL,
	ip: string,
	{ signal, ca }: { signal?: AbortSignal; ca?: string } = {},
): Promise<WarpResponse> {
	const https = url.protocol === "https:";
	const port = Number(url.port) || (https ? 443 : 80);
	const tunnel = await WarpConnect(ip, port, signal);

	let socket: net.Socket = tunnel;
	const onAbort = () => socket.destroy(new WarpTargetFailed("Timed out fetching through WARP."));
	signal?.addEventListener("abort", onAbort, { once: true });
	const close = () => {
		signal?.removeEventListener("abort", onAbort);
		socket.destroy();
	};

	try {
		if (https) {
			const hostname = url.hostname.replace(/^\[(.*)\]$/, "$1"); // IPv6 literals keep their brackets in URL
			const secure = tls.connect({
				socket: tunnel,
				servername: net.isIP(hostname) ? undefined : hostname,
				ca,
				ALPNProtocols: ["http/1.1"],
			});
			socket = secure;
			await new Promise<void>((resolve, reject) => {
				secure.once("secureConnect", resolve);
				secure.once("error", reject);
			});
		}

		// identity: the body is used as-is, so it must not arrive compressed
		socket.write(
			`GET ${url.pathname}${url.search} HTTP/1.1\r\nHost: ${url.host}\r\nAccept-Encoding: identity\r\n` +
				"Connection: close\r\n\r\n",
		);
		const reader = new Reader(socket[Symbol.asyncIterator]());

		const statusLine = await reader.line(8192);
		const status = /^HTTP\/1\.[01] (\d{3})/.exec(statusLine)?.[1];
		if (!status) throw new WarpTargetFailed("Not an HTTP response.");
		const headers = new Map<string, string>();
		for (let count = 0; ; count++) {
			const line = await reader.line(8192);
			if (!line) break;
			if (count >= 100) throw new WarpTargetFailed("Too many response headers.");
			const colon = line.indexOf(":");
			if (colon <= 0) continue;
			const name = line.slice(0, colon).trim().toLowerCase();
			const value = line.slice(colon + 1).trim();
			headers.set(name, headers.has(name) ? `${headers.get(name)}, ${value}` : value);
		}

		const body = async (cap: number): Promise<Buffer> => {
			const pieces: Buffer[] = [];
			let total = 0;
			const take = (piece: Buffer) => {
				total += piece.length;
				if (total > cap) throw new WarpTooLarge(`Body over ${cap} bytes.`);
				pieces.push(piece);
			};
			try {
				const length = headers.get("content-length");
				if (/\bchunked\b/i.test(headers.get("transfer-encoding") ?? "")) {
					for (;;) {
						const size = Number.parseInt(((await reader.line(1024)).split(";")[0] ?? "").trim(), 16);
						if (Number.isNaN(size) || size < 0) throw new WarpTargetFailed("Malformed chunked body.");
						if (size === 0) break; // trailers, if any, are ignored
						if (total + size > cap) throw new WarpTooLarge(`Body over ${cap} bytes.`);
						await reader.exact(size, take);
						await reader.line(2);
					}
				} else if (length !== undefined) {
					const n = Number(length);
					if (!Number.isSafeInteger(n) || n < 0) throw new WarpTargetFailed("Malformed Content-Length.");
					if (n > cap) throw new WarpTooLarge(`Body over ${cap} bytes.`);
					await reader.exact(n, take);
				} else {
					await reader.rest(take);
				}
				return Buffer.concat(pieces);
			} finally {
				close();
			}
		};
		return { status: Number(status), headers, body, close };
	} catch (err) {
		close();
		if (err instanceof WarpUnavailable || err instanceof WarpTargetFailed) throw err;
		throw new WarpTargetFailed(err instanceof Error ? err.message : String(err));
	}
}
