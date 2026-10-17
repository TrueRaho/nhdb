// Pin Node fetch connections to the DNS answers checked at the socket boundary.
// Keep this plain Node: the standalone scraper must not need Next's runtime.
import { lookup } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";
import { Agent, buildConnector } from "undici";
import { isPublicAddress, UnsafeUrlError } from "./net-address";

const publicLookup: LookupFunction = (hostname, options, callback) => {
  void lookup(hostname, { all: true }).then((addresses) => {
    if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
      throw new UnsafeUrlError("destination must resolve only to public addresses");
    }
    const checked = addresses.map(({ address }) => ({ address, family: isIP(address) }));
    if (options.all) callback(null, checked);
    else callback(null, checked[0].address, checked[0].family);
  }).catch((error: Error) => callback(error, "", 0));
};

// Leave hostname, Host, SNI and certificate verification to the standard
// connector; only its DNS lookup changes. IP literals bypass lookup in Node,
// so check those explicitly before letting the connector create a socket.
const connect = buildConnector({ lookup: publicLookup });
export const publicDispatcher = new Agent({
  connect(options, callback) {
    const host = options.hostname.replace(/^\[|\]$/g, "");
    if (isIP(host) && !isPublicAddress(host)) {
      callback(new UnsafeUrlError("That address is not routable from the server"), null);
      return;
    }
    connect(options, callback);
  },
});

// The only private destination allowed is an explicit local scraper in dev.
// Pin localhost to IPv4 loopback (the secretless server binds there), without
// trusting DNS or opening an exception for other names resolving to loopback.
const localDispatcher = new Agent({ connect: { lookup(hostname, options, callback) {
  if (hostname !== "localhost") {
    callback(new UnsafeUrlError("expected localhost"), "", 0);
  } else if (options.all) {
    callback(null, [{ address: "127.0.0.1", family: 4 }]);
  } else {
    callback(null, "127.0.0.1", 4);
  }
} } });

export function fetchPublic(url: string | URL, init: RequestInit, localScraper = false): Promise<Response> {
  const target = new URL(url);
  const local = localScraper && process.env.NODE_ENV !== "production" &&
    target.protocol === "http:" && target.hostname === "localhost";
  const options = { ...init, dispatcher: local ? localDispatcher : publicDispatcher };
  return fetch(url, options);
}
