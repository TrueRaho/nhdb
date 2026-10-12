import { describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveProxyAddress } from "./scraper-proxy";

describe("browser proxy address gate", () => {
  it("checks every DNS answer, including mixed public/private answers", async () => {
    for (const address of ["127.0.0.1", "10.1.2.3", "169.254.169.254", "::1", "fd00::1", "::ffff:127.0.0.1"]) {
      await expect(resolveProxyAddress("site.example", async () => [
        { address: "93.184.216.34", family: 4 }, { address, family: 6 },
      ])).rejects.toMatchObject({ name: "UnsafeUrlError" });
    }
  });

  it("refuses empty DNS results and propagates DNS failures", async () => {
    await expect(resolveProxyAddress("site.example", async () => [])).rejects.toMatchObject({ name: "UnsafeUrlError" });
    await expect(resolveProxyAddress("site.example", async () => { throw new Error("ENOTFOUND"); })).rejects.toThrow("ENOTFOUND");
  });

  it("checks IP literals without DNS, including IPv6 and unusual IPv4 URL forms", async () => {
    const resolve = vi.fn();
    for (const raw of ["http://127.1", "http://2130706433", "http://0x7f000001", "http://[::1]", "http://[::ffff:7f00:1]"]) {
      await expect(resolveProxyAddress(new URL(raw).hostname, resolve)).rejects.toMatchObject({ name: "UnsafeUrlError" });
    }
    await expect(resolveProxyAddress("[2606:4700:4700::1111]", resolve)).resolves.toEqual({ address: "2606:4700:4700::1111", family: 6 });
    expect(resolve).not.toHaveBeenCalled();
  });

  it("returns the checked IP and rechecks DNS on the next connection", async () => {
    const resolve = vi.fn()
      .mockResolvedValueOnce([{ address: "93.184.216.34", family: 6 }])
      .mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]);
    await expect(resolveProxyAddress("site.example", resolve)).resolves.toEqual({ address: "93.184.216.34", family: 4 });
    await expect(resolveProxyAddress("site.example", resolve)).rejects.toMatchObject({ name: "UnsafeUrlError" });
    expect(resolve).toHaveBeenCalledTimes(2);
  });
});

describe.skipIf(process.env.NHDB_TEST_BROWSER_PROXY !== "1")("upstream response isolation", () => {
  it.each(["099", "000"])("returns 502 for %s and still serves the next request", async (status) => {
    // A child makes a process crash a normal failing assertion rather than an
    // unhandled Vitest-worker error. It drives the real proxy with local TCP.
    const script = `
      import { createServer, createConnection } from 'node:net';
      import { request } from 'node:http';
      import { startScraperProxy } from './lib/scraper-proxy.ts';
      const sockets = new Set(); let calls = 0;
      const target = createServer(socket => {
        sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket));
        socket.once('data', () => socket.end('HTTP/1.1 ' + (++calls === 1 ? '${status} Weird' : '200 OK') + '\\r\\nContent-Length: 2\\r\\nConnection: close\\r\\n\\r\\nok'));
      });
      await new Promise(resolve => target.listen(0, '127.0.0.1', resolve));
      const proxy = await startScraperProxy({ resolve: async () => [{address:'93.184.216.34',family:4}], connect: () => createConnection({host:'127.0.0.1',port:target.address().port}) });
      try {
        const fetch = () => new Promise((resolve,reject) => {
          const req = request(proxy.server, {path:'http://public.example/x'}, res => {res.resume();res.on('end',()=>resolve(res.statusCode));});
          req.on('error',reject); req.end();
        });
        console.log(JSON.stringify([await fetch(), await fetch()]));
      } finally { await proxy.close(); for(const s of sockets)s.destroy(); await new Promise(resolve=>target.close(resolve)); }
    `;
    const result = await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { timeout: 10_000 });
    expect(JSON.parse(result.stdout.trim())).toEqual([502, 200]);
    expect(result.stderr).toBe("");
  });
});
