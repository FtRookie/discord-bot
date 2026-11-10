import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as net from "node:net";
import { Config } from "../Config.ts";
import { WarpConnect, WarpTargetFailed, WarpUnavailable } from "./Warp.ts";

/** Minimal no-auth SOCKS5 server standing in for warp-cli's proxy: records each CONNECT, then pipes. */
function fakeWarp(reply = 0) {
	const requested: string[] = [];
	const server = net.createServer((client) => {
		client.once("data", () => {
			client.write(Buffer.from([5, 0]));
			client.once("data", (req: Buffer) => {
				const ip = req[3] === 1 ? [...req.subarray(4, 8)].join(".") : "ipv6";
				const port = req.readUInt16BE(req.length - 2);
				requested.push(`${ip}:${port}`);
				// reply split across writes, to exercise the reassembly
				client.write(Buffer.from([5, reply, 0]));
				if (reply !== 0) return client.end(Buffer.from([1, 0, 0, 0, 0, 0, 0]));
				const upstream = net.connect(port, ip, () => {
					client.write(Buffer.from([1, 127, 0, 0, 1, 0, 0]));
					client.pipe(upstream).pipe(client);
				});
			});
		});
	});
	return { server, requested };
}

const listen = (server: net.Server) =>
	new Promise<number>((resolve) =>
		server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)),
	);

describe("WarpConnect", () => {
	const origin = http.createServer((_, res) => res.end("hello through warp"));
	let originPort: number;
	const originalPort = Config.warp.port;

	beforeAll(async () => {
		originPort = await listen(origin);
	});
	afterAll(() => {
		origin.close();
		Config.warp.port = originalPort;
	});

	test("an HTTP request rides the tunnel to the vetted IP", async () => {
		const warp = fakeWarp();
		Config.warp.port = await listen(warp.server);
		const socket = await WarpConnect("127.0.0.1", originPort);
		const body = await new Promise<string>((resolve, reject) => {
			const req = http.request(
				`http://example.invalid:${originPort}/`,
				{ createConnection: () => socket.resume() },
				(res) => {
					let data = "";
					res.on("data", (c) => {
						data += c;
					});
					res.on("end", () => resolve(data));
				},
			);
			req.on("error", reject);
			req.end();
		});
		expect(body).toBe("hello through warp");
		expect(warp.requested).toEqual([`127.0.0.1:${originPort}`]);
		warp.server.close();
	});

	test("a refused CONNECT is the target's failure, not WARP's", async () => {
		const warp = fakeWarp(5);
		Config.warp.port = await listen(warp.server);
		await expect(WarpConnect("127.0.0.1", 1)).rejects.toBeInstanceOf(WarpTargetFailed);
		warp.server.close();
	});

	test("no proxy listening fails closed as WarpUnavailable", async () => {
		const closed = net.createServer();
		Config.warp.port = await listen(closed);
		closed.close();
		await expect(WarpConnect("127.0.0.1", originPort)).rejects.toBeInstanceOf(WarpUnavailable);
	});
});
