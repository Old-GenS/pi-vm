/**
 * The one way out of a hive VM: an HTTP/HTTPS proxy bound to the host's loopback.
 *
 * pasta runs without --config-net and forwards a single port (-T <port>) from the VM to this
 * proxy, so the VM's only network path is the proxy. The proxy resolves every destination itself
 * and refuses any address that is not public, then connects to the vetted address (never to the
 * hostname), so a DNS answer that changes between the check and the connect cannot get around it.
 * Non-HTTP traffic (raw TCP, UDP, SSH) has no way out, which is intended.
 *
 * Node built-ins only: this file must be importable from tests without a built image or libkrun.
 */
import { createServer, request as httpRequest } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { BlockList, connect, isIP, isIPv4, isIPv6 } from "node:net";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { lookup as dnsLookup } from "node:dns";
import { randomBytes } from "node:crypto";

/**
 * IPv4 ranges that are not public: "this network", private, carrier-grade NAT, loopback,
 * link-local, documentation, benchmarking, multicast and reserved/broadcast space.
 */
const NON_PUBLIC_V4: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

/**
 * IPv6 ranges that are not public. The IPv4-mapped (::ffff:0:0/96) and NAT64 (64:ff9b::/96,
 * 64:ff9b:1::/48) prefixes are handled separately: their embedded IPv4 address is checked against
 * the IPv4 list instead of blocking the whole prefix.
 */
const NON_PUBLIC_V6: ReadonlyArray<readonly [string, number]> = [
  ["::", 128],
  ["::1", 128],
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
];

const blockedV4 = new BlockList();
for (const [net, prefix] of NON_PUBLIC_V4) blockedV4.addSubnet(net, prefix, "ipv4");

const blockedV6 = new BlockList();
for (const [net, prefix] of NON_PUBLIC_V6) blockedV6.addSubnet(net, prefix, "ipv6");

/** The 16 bytes of an IPv6 address in network order, or undefined when it is not an IPv6 literal. */
function ipv6Bytes(ip: string): number[] | undefined {
  if (!isIPv6(ip)) return undefined;
  let text = ip;
  // An embedded dotted-quad tail (::ffff:192.168.1.1) becomes two hextets.
  const lastColon = text.lastIndexOf(":");
  const tail = text.slice(lastColon + 1);
  if (tail.includes(".")) {
    const octets = tail.split(".").map((part) => Number(part));
    if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return undefined;
    text = `${text.slice(0, lastColon + 1)}${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const [head, rest] = text.includes("::") ? text.split("::") : [text, undefined];
  const headGroups = head ? head.split(":") : [];
  const restGroups = rest ? rest.split(":") : [];
  const missing = 8 - headGroups.length - restGroups.length;
  if (missing < 0) return undefined;
  const groups = [...headGroups, ...Array<string>(missing).fill("0"), ...restGroups];
  if (groups.length !== 8) return undefined;
  const bytes: number[] = [];
  for (const group of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return undefined;
    const n = Number.parseInt(group, 16);
    bytes.push((n >> 8) & 0xff, n & 0xff);
  }
  return bytes;
}

function v4BytesToText(bytes: number[]): string {
  return bytes.join(".");
}

function isZeroRange(bytes: number[], from: number, to: number): boolean {
  for (let i = from; i < to; i += 1) if (bytes[i] !== 0) return false;
  return true;
}

/** Whether a dotted-quad (as bytes) is public. */
function isPublicV4(bytes: number[]): boolean {
  return !blockedV4.check(v4BytesToText(bytes), "ipv4");
}

/**
 * Whether `ip` is a syntactically valid IP address that is public (routable) space. False for
 * anything invalid and for every non-public range: this computer (loopback/link-local), the
 * local network, multicast, documentation and reserved space.
 */
export function isPublicAddress(ip: string): boolean {
  if (isIPv4(ip)) return isPublicV4(ip.split(".").map((part) => Number(part)));
  const bytes = ipv6Bytes(ip);
  if (bytes === undefined) return false;
  // ::ffff:0:0/96: an IPv4-mapped address, judged as its embedded IPv4 address.
  if (isZeroRange(bytes, 0, 10) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return isPublicV4(bytes.slice(12, 16));
  }
  // 64:ff9b::/96 (well-known NAT64 prefix): judge the embedded IPv4 in the last 32 bits.
  if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b && isZeroRange(bytes, 4, 12)) {
    return isPublicV4(bytes.slice(12, 16));
  }
  // 64:ff9b:1::/48 (local-use NAT64 prefix): judge the embedded IPv4 in the last 32 bits.
  if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b && bytes[4] === 0x00 && bytes[5] === 0x01) {
    return isPublicV4(bytes.slice(12, 16));
  }
  return !blockedV6.check(ip, "ipv6");
}

/** One host's worth of addresses for a single lookup. */
export type EgressLookup = (host: string) => Promise<string[]>;

export interface EgressProxy {
  /** The ephemeral port the proxy listens on, on 127.0.0.1. */
  port: number;
  /** The URL to hand to tools (http://127.0.0.1:<port>). */
  url: string;
  /** The standard proxy variables for the VM's environment. */
  env: Record<string, string>;
  close(): Promise<void>;
}

export interface EgressProxyOptions {
  /** Resolve a hostname to addresses. Defaults to dns.promises.lookup(all: true). */
  lookup?: EgressLookup;
  /** Whether an address is allowed. Defaults to isPublicAddress. */
  allow?: (ip: string) => boolean;
  /** A line for every refused destination. Defaults to dropping the line. */
  log?: (line: string) => void;
  /**
   * The port to listen on. Defaults to 0, letting the kernel pick an ephemeral port; an explicit
   * port is for tests in sandboxes where a connect() to a bind(0)-chosen port is refused.
   */
  port?: number;
}

/** `host:port` or `[v6]:port` → host and port, or undefined when either is missing or malformed. */
function parseAuthority(authority: string): { host: string; port: number } | undefined {
  if (!authority) return undefined;
  let host: string;
  let portText: string | undefined;
  if (authority.startsWith("[")) {
    const end = authority.indexOf("]");
    if (end < 0) return undefined;
    host = authority.slice(1, end);
    const rest = authority.slice(end + 1);
    if (rest !== "") {
      if (!rest.startsWith(":")) return undefined;
      portText = rest.slice(1);
    }
  } else {
    const colon = authority.lastIndexOf(":");
    if (colon >= 0) {
      host = authority.slice(0, colon);
      portText = authority.slice(colon + 1);
    } else {
      host = authority;
    }
  }
  if (!host) return undefined;
  if (portText === undefined) return undefined;
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  return { host, port };
}

/**
 * A `lookup` for net/http that answers only with addresses already vetted: Node then tries them in
 * turn (autoSelectFamily, "happy eyeballs"), so a host with broken IPv6 falls back to IPv4, and it
 * can never connect anywhere the check didn't approve.
 */
function vettedLookup(addresses: string[]) {
  const entries = addresses.map((address) => ({ address, family: isIP(address) }));
  return (_host: string, options: { all?: boolean }, cb: (...args: any[]) => void): void => {
    if (options?.all) cb(null, entries);
    else cb(null, entries[0].address, entries[0].family);
  };
}

/**
 * Start the egress proxy on an ephemeral 127.0.0.1 port. It takes no password: headless Chromium
 * can't send proxy credentials, and the proxy only reaches public internet addresses, which any
 * local program can reach directly anyway, so it gives nothing on this computer new reach. (A web
 * page can't use it either: browsers send no absolute-form or CONNECT requests from page script.)
 */
export async function startEgressProxy(o: EgressProxyOptions = {}): Promise<EgressProxy> {
  const lookup: EgressLookup = o.lookup ?? (async (host) => (await new Promise<string[]>((resolve, reject) => {
    dnsLookup(host, { all: true, verbatim: true }, (err, addresses) => {
      if (err) reject(err);
      else resolve(addresses.map((a) => a.address));
    });
  })));
  const allow = o.allow ?? isPublicAddress;
  const log = o.log ?? (() => undefined);

  const sockets = new Set<Duplex>();

  const track = (socket: Duplex) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
  };


  const status = (res: ServerResponse, code: number) => {
    res.writeHead(code, { "Content-Length": "0" });
    res.end();
  };

  const writeSocketStatus = (socket: Duplex, line: string, headers = "") => {
    socket.end(`HTTP/1.1 ${line}\r\n${headers}Content-Length: 0\r\n\r\n`);
  };

  /** Resolve and vet `host`: its addresses, or undefined when it does not resolve. */
  const vet = async (host: string): Promise<string[] | undefined> => {
    let addresses: string[];
    if (isIP(host) !== 0) {
      addresses = [host];
    } else {
      try {
        addresses = await lookup(host);
      } catch {
        return undefined;
      }
    }
    if (addresses.length === 0) return undefined;
    return addresses;
  };

  const server = createServer();

  // Plain HTTP: absolute-form request targets only. https and everything else goes through
  // CONNECT, so a non-absolute request is a client bug, answered with 400.
  server.on("request", (req, res) => {
    let target: URL;
    try {
      target = new URL(req.url ?? "");
    } catch {
      status(res, 400);
      return;
    }
    if (target.protocol !== "http:" || !target.hostname) {
      status(res, 400);
      return;
    }
    const host = target.hostname.replace(/^\[(.*)\]$/, "$1");
    const port = target.port ? Number(target.port) : 80;
    void vet(host).then((addresses) => {
      if (addresses === undefined || addresses.length === 0) {
        status(res, 502);
        return;
      }
      const denied = addresses.find((address) => !allow(address));
      if (denied !== undefined) {
        log(`denied ${host}:${port} (${denied})`);
        status(res, 403);
        return;
      }
      const headers: Record<string, string | string[] | undefined> = {};
      for (const [name, value] of Object.entries(req.headers)) {
        if (name === "proxy-authorization" || name === "proxy-connection") continue;
        headers[name] = value;
      }
      headers.host = target.host;
      const upstream = httpRequest(
        {
          host: target.host,
          port,
          // Node 20+ tries each address the lookup returns (autoSelectFamily is on by default).
          lookup: vettedLookup(addresses) as any,
          method: req.method,
          path: `${target.pathname || "/"}${target.search}`,
          headers,
        },
        (upstreamRes) => {
          res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
          upstreamRes.on("error", () => res.destroy());
          upstreamRes.pipe(res);
        },
      );
      upstream.on("error", () => {
        if (!res.headersSent) status(res, 502);
        else res.destroy();
      });
      req.on("error", () => upstream.destroy());
      req.pipe(upstream);
    }).catch(() => {
      if (!res.headersSent) status(res, 502);
      else res.destroy();
    });
  });

  // CONNECT host:port (HTTPS, and any other TLS): open a raw tunnel to the vetted address.
  server.on("connect", (req, clientSocket, head) => {
    track(clientSocket);
    const target = parseAuthority(req.url ?? "");
    if (!target) {
      writeSocketStatus(clientSocket, "400 Bad Request");
      return;
    }
    void vet(target.host).then((addresses) => {
      if (clientSocket.destroyed) return;
      if (addresses === undefined || addresses.length === 0) {
        writeSocketStatus(clientSocket, "502 Bad Gateway");
        return;
      }
      const denied = addresses.find((address) => !allow(address));
      if (denied !== undefined) {
        log(`denied ${target.host}:${target.port} (${denied})`);
        writeSocketStatus(clientSocket, "403 Forbidden");
        return;
      }
      const upstream = connect({
        host: target.host,
        port: target.port,
        lookup: vettedLookup(addresses) as any,
        autoSelectFamily: true,
      });
      track(upstream);
      upstream.once("error", () => {
        upstream.destroy();
        clientSocket.destroy();
      });
      clientSocket.once("error", () => clientSocket.destroy());
      clientSocket.once("close", () => upstream.destroy());
      upstream.once("connect", () => {
        if (clientSocket.destroyed) {
          upstream.destroy();
          return;
        }
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length > 0) upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
    }).catch(() => {
      if (clientSocket.destroyed) return;
      writeSocketStatus(clientSocket, "502 Bad Gateway");
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    server.once("error", onError);
    server.listen(o.port ?? 0, "127.0.0.1", () => {
      server.removeListener("error", onError);
      resolve();
    });
  });
  // Never keep the process alive on the proxy's account (the shared proxy starts on first use).
  server.unref();

  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;
  const env = proxyEnv(url);

  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closing !== undefined) return closing;
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    closing = new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    return closing;
  };

  return { port, url, env, close };
}

/**
 * The proxy variables every tool in a VM gets, for a proxy at `url`. On Linux that is the host's
 * own port (pasta forwards exactly that one); on macOS it is the guest's side of the vsock bridge
 * (hive-netd listens on 127.0.0.1:3128 inside the VM).
 */
export function proxyEnv(url: string): Record<string, string> {
  const noProxy = "localhost,127.0.0.1,::1";
  return {
    HTTP_PROXY: url,
    HTTPS_PROXY: url,
    http_proxy: url,
    https_proxy: url,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
    // Node 24's fetch and http honour the proxy variables only with this set; pi runs on Node 24.
    NODE_USE_ENV_PROXY: "1",
  };
}

let shared: Promise<EgressProxy> | undefined;

/**
 * The process-wide proxy, started on first use. One proxy serves every VM: it is reached through
 * pasta over the host's loopback.
 */
export function sharedEgressProxy(): Promise<EgressProxy> {
  if (shared === undefined) {
    const debug = process.env.HIVE_EGRESS_DEBUG === "1";
    shared = startEgressProxy({ log: debug ? (line: string) => console.error(line) : undefined });
  }
  return shared;
}