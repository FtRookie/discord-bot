import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { AddressInfo } from "node:net";
import * as net from "node:net";
import * as tls from "node:tls";
import { Config } from "../Config.ts";
import { WarpConnect, WarpRequest, WarpTargetFailed, WarpTooLarge, WarpUnavailable } from "./Warp.ts";

// Test-only self-signed certificate for "pix.test", valid until 2126. Trusted solely through the `ca` option.
const CERT = `-----BEGIN CERTIFICATE-----
MIIBkjCCATigAwIBAgIUAJM6WJEbE7C2RZOechZgtOjPLDIwCgYIKoZIzj0EAwIw
EzERMA8GA1UEAwwIcGl4LnRlc3QwIBcNMjYxMTI1MTg0MTA0WhgPMjEyNjExMDEx
ODQxMDRaMBMxETAPBgNVBAMMCHBpeC50ZXN0MFkwEwYHKoZIzj0CAQYIKoZIzj0D
AQcDQgAE4dfqEY+/J44j5VjJRJW2b5Vq+PBRvLOAg0roNz5e+CEIdIvmZYRjWbYm
33Z84q9ERUF+ySjUbVwtgmq/KyoTWKNoMGYwHQYDVR0OBBYEFMhJDEQiaqKt3h1F
/77Oi7h56VVvMB8GA1UdIwQYMBaAFMhJDEQiaqKt3h1F/77Oi7h56VVvMA8GA1Ud
EwEB/wQFMAMBAf8wEwYDVR0RBAwwCoIIcGl4LnRlc3QwCgYIKoZIzj0EAwIDSAAw
RQIgXEkB98/dVtVfwtnLO34w/VIx14qsMdgYN19tH1oH2VkCIQDTEu/qHMm5UQj5
OrWKQXON8VNvaagk685OSltKpQYOfQ==
-----END CERTIFICATE-----`;
const KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgs/OaN/iuzpLyP+Xm
YZvgCPcsKIFo4vAzrPzoVq5hlb2hRANCAATh1+oRj78njiPlWMlElbZvlWr48FG8
s4CDSug3Pl74IQh0i+ZlhGNZtibfdnzir0RFQX7JKNRtXC2Car8rKhNY
-----END PRIVATE KEY-----`;

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
	const originalPort = Config.warp.port;
	afterAll(() => {
		Config.warp.port = originalPort;
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
		await expect(WarpConnect("127.0.0.1", 9)).rejects.toBeInstanceOf(WarpUnavailable);
	});
});

/** Answers every connection with `response` verbatim, after recording the request head it was sent. */
function origin(response: string, secure = false) {
	const heads: string[] = [];
	const handle = (socket: net.Socket) => {
		let head = "";
		socket.on("data", (chunk) => {
			head += chunk;
			if (!head.includes("\r\n\r\n")) return;
			heads.push(head);
			socket.end(response);
		});
		socket.on("error", () => {});
	};
	const server = secure ? tls.createServer({ cert: CERT, key: KEY }, handle) : net.createServer(handle);
	return { server, heads };
}

describe("WarpRequest", () => {
	const originalPort = Config.warp.port;
	let warp: ReturnType<typeof fakeWarp>;
	const servers: net.Server[] = [];

	beforeAll(async () => {
		warp = fakeWarp();
		Config.warp.port = await listen(warp.server);
	});
	afterEach(() => {
		for (const server of servers.splice(0)) server.close();
		warp.requested.length = 0;
	});
	afterAll(() => {
		warp.server.close();
		Config.warp.port = originalPort;
	});

	const serve = async (response: string, secure = false) => {
		const o = origin(response, secure);
		servers.push(o.server);
		return { port: await listen(o.server), heads: o.heads };
	};

	test("the request rides the tunnel to the vetted IP, never resolving the hostname itself", async () => {
		const { port, heads } = await serve("HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello");
		const res = await WarpRequest(new URL(`http://example.invalid:${port}/a.png?x=1`), "127.0.0.1");
		expect(res.status).toBe(200);
		expect((await res.body(100)).toString()).toBe("hello");
		expect(warp.requested).toEqual([`127.0.0.1:${port}`]);
		expect(heads[0]).toStartWith(`GET /a.png?x=1 HTTP/1.1\r\nHost: example.invalid:${port}\r\n`);
	});

	test("chunked bodies are decoded", async () => {
		const { port } = await serve(
			"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n7;ext=1\r\n, world\r\n0\r\n\r\n",
		);
		const res = await WarpRequest(new URL(`http://a.test:${port}/`), "127.0.0.1");
		expect((await res.body(100)).toString()).toBe("hello, world");
	});

	test("a body without a length reads to the close", async () => {
		const { port } = await serve("HTTP/1.1 200 OK\r\nContent-Type: image/png\r\n\r\nraw bytes");
		const res = await WarpRequest(new URL(`http://a.test:${port}/`), "127.0.0.1");
		expect(res.headers.get("content-type")).toBe("image/png");
		expect((await res.body(100)).toString()).toBe("raw bytes");
	});

	test("redirects are reported, not followed", async () => {
		const { port } = await serve("HTTP/1.1 302 Found\r\nLocation: /next\r\nContent-Length: 0\r\n\r\n");
		const res = await WarpRequest(new URL(`http://a.test:${port}/`), "127.0.0.1");
		expect(res.status).toBe(302);
		expect(res.headers.get("location")).toBe("/next");
		res.close();
	});

	test("the cap holds whether or not the server declares a length", async () => {
		const declared = await serve("HTTP/1.1 200 OK\r\nContent-Length: 11\r\n\r\nhello world");
		const undeclared = await serve("HTTP/1.1 200 OK\r\n\r\nhello world");
		for (const { port } of [declared, undeclared]) {
			const res = await WarpRequest(new URL(`http://a.test:${port}/`), "127.0.0.1");
			await expect(res.body(5)).rejects.toBeInstanceOf(WarpTooLarge);
		}
	});

	test("https runs TLS inside the tunnel, verified against the URL's hostname", async () => {
		const { port, heads } = await serve("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok", true);
		const res = await WarpRequest(new URL(`https://pix.test:${port}/`), "127.0.0.1", { ca: CERT });
		expect((await res.body(100)).toString()).toBe("ok");
		expect(heads[0]).toContain(`Host: pix.test:${port}\r\n`);
		expect(warp.requested).toEqual([`127.0.0.1:${port}`]);
	});

	test("a certificate for another name is refused", async () => {
		const { port } = await serve("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok", true);
		await expect(
			WarpRequest(new URL(`https://evil.test:${port}/`), "127.0.0.1", { ca: CERT }),
		).rejects.toBeInstanceOf(WarpTargetFailed);
	});

	test("an untrusted certificate is refused", async () => {
		const { port } = await serve("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok", true);
		await expect(WarpRequest(new URL(`https://pix.test:${port}/`), "127.0.0.1")).rejects.toBeInstanceOf(
			WarpTargetFailed,
		);
	});

	test("a response that isn't HTTP is the target's failure", async () => {
		const { port } = await serve("SSH-2.0-OpenSSH\r\n");
		await expect(WarpRequest(new URL(`http://a.test:${port}/`), "127.0.0.1")).rejects.toBeInstanceOf(
			WarpTargetFailed,
		);
	});
});
