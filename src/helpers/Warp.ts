import * as net from "node:net";
import * as ipaddr from "ipaddr.js";
import { Config } from "../Config.ts";

/** WARP's local proxy itself is down or misbehaving — an operator problem, not the user's link. */
export class WarpUnavailable extends Error {}

/** WARP reached, but it couldn't connect onward to the target (refused, unreachable, …). */
export class WarpTargetFailed extends Error {}

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
