// Opt-in: actual local sockets and Chromium, with NO public network or DB.
import { execFileSync } from "node:child_process";
import { createSocket } from "node:dgram";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, request, type RequestListener, type Server } from "node:http";
import { createServer as createSecureServer } from "node:https";
import { createConnection, createServer as createTcpServer, type Server as TcpServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TLSSocket } from "node:tls";
import { afterEach, describe, expect, it, vi } from "vitest";
import { chromium } from "playwright";
import { startScraperProxy } from "./scraper-proxy";
import { SCRAPER_BROWSER_NETWORK_ARGS } from "./scraper-browser-options";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function listen(server: Server | TcpServer): Promise<number> {
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => { sockets.add(socket); socket.on("error", () => {}); socket.on("close", () => sockets.delete(socket)); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve) => { server.close(() => resolve()); for (const socket of sockets) socket.destroy(); }));
  return (server.address() as { port: number }).port;
}
function through(proxy: string, url: string, headers: Record<string, string> = {}, body?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(proxy, { path: url, method: body ? "POST" : "GET", headers }, (res) => {
      let text = "";
      res.on("data", (part) => { text += part; });
      res.on("end", () => resolve({ status: res.statusCode!, body: text }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(body);
  });
}
function wire(proxy: string, text: string, until?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port: Number(new URL(proxy).port) });
    let answer = "";
    socket.setTimeout(5000, () => socket.destroy(new Error("wire timeout")));
    socket.on("connect", () => socket.write(text));
    socket.on("data", (data) => { answer += data; if (until && answer.includes(until)) { resolve(answer); socket.destroy(); } });
    socket.on("end", () => resolve(answer));
    socket.on("error", reject);
  });
}
const publicDNS = async () => [{ address: "93.184.216.34", family: 4 }];

describe.skipIf(process.env.NHDB_TEST_BROWSER_PROXY !== "1")("browser proxy with real local sockets", () => {
  it("R3.6: a proxied page cannot send WebRTC STUN to loopback", async () => {
    const port = await listen(createServer((_req, res) => { res.setHeader("content-type", "text/html"); res.end("<h1>ICE test page</h1>"); }));
    const proxy = await startScraperProxy({ resolve: publicDNS, connect: () => createConnection({ host: "127.0.0.1", port }) }); cleanup.push(proxy.close);
    const probe = async (args: string[]) => {
      const udp = createSocket("udp4");
      let packets = 0;
      udp.on("message", (data) => { if (data.length >= 20 && data.readUInt32BE(4) === 0x2112a442) packets++; });
      await new Promise<void>((resolve) => udp.bind(0, "127.0.0.1", resolve));
      cleanup.push(() => new Promise<void>((resolve) => udp.close(() => resolve())));
      const browser = await chromium.launch({ headless: true, executablePath: process.env.NHDB_TEST_CHROMIUM_PATH, proxy: { server: proxy.server }, args }); cleanup.push(() => browser.close());
      const page = await browser.newPage();
      await page.goto("http://public.example/ice");
      await page.evaluate(async (udpPort) => {
        const pc = new RTCPeerConnection({ iceServers: [{ urls: `stun:127.0.0.1:${udpPort}` }] });
        try {
          pc.createDataChannel("test");
          await pc.setLocalDescription(await pc.createOffer());
          await new Promise((resolve) => setTimeout(resolve, 2000));
        } finally { pc.close(); }
      }, udp.address().port);
      return packets;
    };
    const control = await probe(SCRAPER_BROWSER_NETWORK_ARGS.filter((flag) => !flag.startsWith("--force-webrtc")));
    const protectedPackets = await probe([...SCRAPER_BROWSER_NETWORK_ARGS]);
    expect(control).toBeGreaterThan(0);
    expect(protectedPackets).toBe(0);
    console.log(`WebRTC STUN: control=${control}, protected=${protectedPackets}`);
  }, 20_000);
  it("pins HTTP to the checked IP, preserves Host/body, removes proxy headers, and refuses a DNS rebound", async () => {
    const received: { host?: string; auth?: string; hop?: string; body: string }[] = [];
    const port = await listen(createServer((req, res) => {
      let body = "";
      req.on("data", (part) => { body += part; });
      req.on("end", () => { received.push({ host: req.headers.host, auth: req.headers["proxy-authorization"] as string, hop: req.headers["x-hop"] as string, body }); res.end("fixture"); });
    }));
    const resolve = vi.fn().mockResolvedValueOnce(await publicDNS()).mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]);
    const connect = vi.fn((address) => { expect(address).toEqual({ address: "93.184.216.34", family: 4 }); return createConnection({ host: "127.0.0.1", port }); });
    const proxy = await startScraperProxy({ resolve, connect }); cleanup.push(proxy.close);
    await expect(through(proxy.server, "http://public.example/page?q=1", {
      host: "127.0.0.1", "proxy-authorization": "do-not-forward", connection: "x-hop", "x-hop": "do-not-forward",
    }, "payload")).resolves.toEqual({ status: 200, body: "fixture" });
    expect(received).toEqual([{ host: "public.example", auth: undefined, hop: undefined, body: "payload" }]);
    expect((await through(proxy.server, "http://public.example/page")).status).toBe(403);
    expect(connect).toHaveBeenCalledOnce();
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("rejects private HTTP/CONNECT targets, mixed DNS, non-web ports, and malformed authorities without dialing", async () => {
    const connect = vi.fn();
    const proxy = await startScraperProxy({ resolve: async () => [...await publicDNS(), { address: "10.0.0.1", family: 4 }], connect }); cleanup.push(proxy.close);
    for (const url of ["http://127.0.0.1/", "http://2130706433/", "http://[::ffff:7f00:1]/", "http://169.254.169.254/", "http://mixed.example/", "http://public.example:8080/", "http://user:pass@public.example/"]) {
      expect((await through(proxy.server, url)).status).toBe(403);
    }
    for (const authority of ["127.0.0.1:443", "[::1]:443", "mixed.example:443", "public.example:22", "user@public.example:443", "public.example:443/path"]) {
      expect(await wire(proxy.server, `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`)).toMatch(/^HTTP\/1.1 403/);
    }
    expect(connect).not.toHaveBeenCalled();
  });

  it("passes CONNECT head and tunnel bytes to the pinned IP and closes live tunnels", async () => {
    const port = await listen(createTcpServer((socket) => socket.pipe(socket)));
    const connect = vi.fn((address, requestedPort) => {
      expect(address.address).toBe("93.184.216.34"); expect(requestedPort).toBe(443);
      return createConnection({ host: "127.0.0.1", port });
    });
    const proxy = await startScraperProxy({ resolve: publicDNS, connect }); cleanup.push(proxy.close);
    expect(await wire(proxy.server, "CONNECT public.example:443 HTTP/1.1\r\nHost: public.example:443\r\n\r\nhello", "hello")).toMatch(/^HTTP\/1.1 200[\s\S]*hello/);
    const socket = createConnection({ host: "127.0.0.1", port: Number(new URL(proxy.server).port) });
    socket.on("error", () => {}); // closing a live tunnel may reset it
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    const ended = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    await proxy.close(); await proxy.close(); await ended;
    await expect(through(proxy.server, "http://public.example/")).rejects.toThrow();
  });

  it("does not open an upstream socket if DNS finishes after proxy shutdown", async () => {
    let finish!: (value: Awaited<ReturnType<typeof publicDNS>>) => void;
    let started!: () => void;
    const resolving = new Promise<void>((resolve) => { started = resolve; });
    const connect = vi.fn();
    const proxy = await startScraperProxy({ resolve: () => { started(); return new Promise((resolve) => { finish = resolve; }); }, connect }); cleanup.push(proxy.close);
    const pending = through(proxy.server, "http://public.example/").catch(() => null);
    await resolving; await proxy.close(); finish(await publicDNS()); await pending;
    await Promise.resolve(); expect(connect).not.toHaveBeenCalled();
  });

  it("does not dial a DNS result that arrives after its connection deadline", async () => {
    let finish!: (value: Awaited<ReturnType<typeof publicDNS>>) => void;
    let started!: () => void;
    const resolving = new Promise<void>((resolve) => { started = resolve; });
    const connect = vi.fn();
    const proxy = await startScraperProxy({ resolve: () => { started(); return new Promise((resolve) => { finish = resolve; }); }, connect }); cleanup.push(proxy.close);
    vi.useFakeTimers();
    try {
      const pending = through(proxy.server, "http://public.example/");
      await resolving; await vi.advanceTimersByTimeAsync(10_000);
      expect((await pending).status).toBe(502);
      finish(await publicDNS()); await Promise.resolve(); await Promise.resolve();
      expect(connect).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it("real Chromium uses HTTP and HTTPS/CONNECT but cannot reach a loopback redirect", async () => {
    let privateHits = 0;
    const privatePort = await listen(createServer((_req, res) => { privateHits++; res.end("private"); }));
    const dir = mkdtempSync(join(tmpdir(), "nhdb-proxy-cert-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"), "-days", "1", "-subj", "/CN=public.example"], { stdio: "ignore" });
    const serve: RequestListener = (req, res) => {
      expect(req.headers.host).toBe("public.example");
      if (req.socket instanceof TLSSocket) expect(req.socket.servername).toBe("public.example");
      if (req.url === "/redirect") res.writeHead(302, { location: `http://127.0.0.1:${privatePort}/private` });
      else if (req.url === "/dns-redirect") res.writeHead(302, { location: "http://rebound.example/private" });
      else { res.writeHead(200, { "content-type": "text/html" }); res.write("<h1>Public fixture</h1>"); }
      res.end();
    };
    const httpPort = await listen(createServer(serve));
    const httpsPort = await listen(createSecureServer({ key: readFileSync(join(dir, "key.pem")), cert: readFileSync(join(dir, "cert.pem")) }, serve));
    const dialed: number[] = [];
    const addresses: string[] = [];
    const proxy = await startScraperProxy({
      resolve: async (host) => host === "public.example" ? publicDNS() : host === "rebound.example" ? [{ address: "127.0.0.1", family: 4 }] : [],
      connect: (address, port) => { addresses.push(address.address); dialed.push(port); return createConnection({ host: "127.0.0.1", port: address.address !== "93.184.216.34" ? privatePort : port === 443 ? httpsPort : httpPort }); },
    }); cleanup.push(proxy.close);
    const browser = await chromium.launch({ headless: true, executablePath: process.env.NHDB_TEST_CHROMIUM_PATH, proxy: { server: proxy.server }, args: [...SCRAPER_BROWSER_NETWORK_ARGS] }); cleanup.push(() => browser.close());
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    for (const scheme of ["http", "https"]) {
      expect((await page.goto(`${scheme}://public.example/ok`))?.status()).toBe(200);
      expect(await page.textContent("h1")).toBe("Public fixture");
      for (const path of ["redirect", "dns-redirect"]) {
        const result = await page.goto(`${scheme}://public.example/${path}`).catch(() => null);
        if (result) expect(result.status()).toBe(403);
      }
    }
    expect(dialed).toEqual(expect.arrayContaining([80, 443]));
    expect(addresses.every((address) => address === "93.184.216.34")).toBe(true);
    expect(privateHits).toBe(0);
    console.log(`Chromium ${browser.version()}: HTTP/CONNECT succeeded, private redirect hits=${privateHits}`);
  }, 20_000);
});
