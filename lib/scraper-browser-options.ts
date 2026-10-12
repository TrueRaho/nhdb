// Shared by launchWarm and real-Chromium integration checks. HTTP(S) goes
// through the filtering proxy, including loopback; WebRTC must not send UDP
// outside it. These flags are not a sandbox for every browser protocol.
export const SCRAPER_BROWSER_NETWORK_ARGS = [
  "--proxy-bypass-list=<-loopback>",
  "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
] as const;
