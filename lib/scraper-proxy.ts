// Chromium follows redirects below Playwright's route handlers. Put the
// address gate at the connection boundary, and dial the IP that we checked
// instead of letting a second DNS lookup choose a different destination.
import { lookup } from "node:dns/promises";
import { createServer, request, type IncomingHttpHeaders } from "node:http";
import { createConnection, isIP, type Socket } from "node:net";
import { isPublicAddress, UnsafeUrlError } from "./net-address";

type Address = { address: string; family: number };
type Resolver = (hostname: string) => Promise<Address[]>;
interface ProxyDependencies {
  resolve?: Resolver;
  connect?: (address: Address, port: number) => Socket;
}
export interface ScraperProxy {
  server: string;
  close(): Promise<void>;
}

const resolveAll: Resolver = (hostname) => lookup(hostname, { all: true });
const CONNECT_MS = 10_000;
const IDLE_MS = 30_000;

export async function resolveProxyAddress(hostname: string, resolve: Resolver = resolveAll): Promise<Address> {
  const host = hostname.replace(/^\[|\]$/g, "");
  const family = isIP(host);
  const addresses = family ? [{ address: host, family }] : await resolve(host);
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new UnsafeUrlError("proxy destination must resolve only to public addresses");
  }
  // Use the address's actual family rather than trusting a resolver's label.
  return { address: addresses[0].address, family: isIP(addresses[0].address) };
}

function headersWithoutHopByHop(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const out = { ...headers };
  const connection = headers.connection?.split(",").map((s) => s.trim().toLowerCase()) ?? [];
  for (const name of [...connection, "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade"]) {
    delete out[name];
  }
  return out;
}

function destination(raw: string, tunnel: boolean): URL {
  if (tunnel && !/^(?:\[[\da-f:.]+\]|[^:/?#@\\\s]+):(80|443)$/i.test(raw)) {
    throw new UnsafeUrlError("invalid CONNECT authority");
  }
  let url: URL;
  try { url = new URL(tunnel ? `http://${raw}` : raw); }
  catch { throw new UnsafeUrlError("invalid proxy URL"); }
  if (url.protocol !== "http:" || url.username || url.password || url.hash ||
      (tunnel ? url.pathname !== "/" || !!url.search : !!url.port && url.port !== "80")) {
    throw new UnsafeUrlError("proxy accepts only web destinations on 80/443");
  }
  return url;
}

/** An ephemeral loopback-only proxy. Dependencies are for local tests, never URL/env input. */
export async function startScraperProxy(deps: ProxyDependencies = {}): Promise<ScraperProxy> {
  const sockets = new Set<Socket>();
  const pending = new Set<() => void>();
  let closed = false;
  let closing: Promise<void> | undefined;
  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
    socket.setTimeout(IDLE_MS, () => socket.destroy());
    return socket;
  };

  const dial = async (url: URL, port: number): Promise<Socket> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let socket: Socket | undefined;
    let cancelled = false;
    let cancel!: () => void;
    try {
      return await Promise.race([
        (async () => {
          const address = await resolveProxyAddress(url.hostname, deps.resolve);
          if (closed || cancelled) throw new Error("proxy closed or timed out");
          socket = track(deps.connect ? deps.connect(address, port) : createConnection({ host: address.address, family: address.family, port }));
          await new Promise<void>((resolve, reject) => {
            socket!.once("error", reject);
            socket!.once("connect", resolve);
            socket!.once("close", () => reject(new Error("proxy connection closed")));
          });
          if (closed) throw new Error("proxy closed");
          return socket;
        })(),
        new Promise<never>((_, reject) => {
          cancel = () => reject(new Error("proxy closed"));
          pending.add(cancel);
          timer = setTimeout(() => reject(new Error("proxy connection timed out")), CONNECT_MS);
          timer.unref();
        }),
      ]);
    } catch (e) {
      cancelled = true;
      socket?.destroy();
      throw e;
    } finally {
      clearTimeout(timer);
      pending.delete(cancel);
    }
  };

  const server = createServer({ headersTimeout: CONNECT_MS, requestTimeout: IDLE_MS }, (req, res) => {
    void (async () => {
      const url = destination(req.url ?? "", false);
      const socket = await dial(url, 80);
      if (req.destroyed || res.destroyed) { socket.destroy(); return; }
      const upstream = request({
        hostname: url.hostname,
        port: 80,
        path: url.pathname + url.search,
        method: req.method,
        headers: { ...headersWithoutHopByHop(req.headers), host: url.host, connection: "close" },
        createConnection: () => socket,
      }, (answer) => {
        answer.on("error", () => res.destroy());
        // This callback runs after the surrounding async function has ended;
        // its exceptions cannot reach that function's .catch. An upstream can
        // send e.g. 099, accepted by the client parser but refused by writeHead.
        try {
          const status = answer.statusCode ?? 0;
          if (!Number.isInteger(status) || status < 100 || status > 999) throw new Error("invalid upstream status");
          res.writeHead(status, headersWithoutHopByHop(answer.headers));
          answer.pipe(res);
        } catch {
          answer.destroy();
          try {
            if (!res.headersSent) res.writeHead(502);
            res.end();
          } catch { res.destroy(); }
        }
      });
      upstream.on("error", () => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      req.on("aborted", () => upstream.destroy());
      res.on("close", () => upstream.destroy());
      req.pipe(upstream);
    })().catch((e) => {
      if (!res.headersSent) res.writeHead(e instanceof UnsafeUrlError ? 403 : 502);
      res.end();
    });
  });
  server.on("connection", track);
  server.on("connect", (req, client, head) => {
    void (async () => {
      const url = destination(req.url ?? "", true);
      const upstream = await dial(url, Number(url.port || 80));
      if (client.destroyed) { upstream.destroy(); return; }
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      client.pipe(upstream);
      upstream.pipe(client);
      client.once("close", () => upstream.destroy());
      upstream.once("close", () => client.destroy());
    })().catch((e) => {
      client.end(`HTTP/1.1 ${e instanceof UnsafeUrlError ? 403 : 502} Proxy Refused\r\nConnection: close\r\n\r\n`);
    });
  });
  server.on("upgrade", (_req, socket) => socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"));
  server.on("clientError", (_error, socket) => socket.destroy());

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
  } catch (e) {
    server.close();
    throw e;
  }
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("proxy did not bind TCP");
  return {
    server: `http://127.0.0.1:${address.port}`,
    close() {
      if (!closing) {
        closed = true;
        for (const cancel of pending) cancel();
        closing = new Promise<void>((resolve) => {
          server.close(() => resolve());
          for (const socket of sockets) socket.destroy();
        });
      }
      return closing;
    },
  };
}
