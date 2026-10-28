import dns from 'node:dns/promises';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import type { BrowserContext, Request } from 'playwright-core';
import type { BlockReason, PageOptions } from '../seams.ts';
import { OBSERVE_INTERVAL_MS, rateLimiter } from './observe.ts';

export type HostRule = (hostname: string) => boolean;

/** A hostname passes when it is listed and is neither a blocked domain nor a subdomain of one. */
export function hostRule(allowedHosts: string[], blockedDomains: string[]): HostRule {
  const allowed = new Set(allowedHosts.map((host) => host.toLowerCase()));
  const blocked = blockedDomains.map((domain) => domain.toLowerCase());
  return (hostname) => {
    const host = hostname.toLowerCase();
    return allowed.has(host) && !blocked.some((domain) => host === domain || host.endsWith(`.${domain}`));
  };
}

/**
 * How an observe-only refusal reads in the action that caused it: a page load or form post it tried, a script's write (the
 * driver blames the action only for a click inside a form), or a page robots.txt disallows.
 */
export type ActionRefusal = 'submit_blocked' | 'write_blocked' | 'robots_disallowed';

const READS = new Set(['GET', 'HEAD']);
// A form post or a script saving something; a beacon or ping is not something the persona did.
const ACTION_WRITES = new Set(['document', 'xhr', 'fetch']);

// Hostnames and bracketed IPv6 literals only: anything else could read as a wildcard, scheme or port in Chromium's bypass-rule syntax.
const BYPASSABLE = /^(?:[a-z0-9_-]+(?:\.[a-z0-9_-]+)*|\[[0-9a-f:.]+\])$/;

// Loopback, private, shared, link-local and multicast ranges: an observed site's tunnel never reaches the user's own network.
// BlockList also matches IPv4-mapped IPv6 addresses against the IPv4 ranges.
const PRIVATE = new net.BlockList();
for (const [address, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16], ['224.0.0.0', 3]] as const) PRIVATE.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [['::', 127], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]] as const) PRIVATE.addSubnet(address, prefix, 'ipv6');

/** Whether a request loads a tab's own page, not an embedded frame (a video, a form or a demo of a third party). */
function isTopFrame(request: Request): boolean {
  try {
    return !request.frame().parentFrame();
  } catch {
    return true; // no frame to tell by: treated as a page load, the stricter case
  }
}

/** The address to reach a host at when every address it resolves to is public, else null (a private one, or no answer). */
export async function publicAddress(hostname: string): Promise<string | null> {
  try {
    const found = await dns.lookup(hostname.replace(/^\[(.*)\]$/, '$1'), { all: true });
    return found.length > 0 && found.every((a) => !PRIVATE.check(a.address, a.family === 6 ? 'ipv6' : 'ipv4')) ? found[0].address : null;
  } catch {
    return null;
  }
}

export interface Containment {
  allows: HostRule;
  /** The context's own proxy. Pass it to newContext() with nothing else added: the order of the bypass rules is the policy. */
  proxy: { server: string; bypass: string };
  /** Adds the route and WebSocket gates to the context; the proxy closes with it. */
  install(context: BrowserContext): Promise<void>;
  /** Observe-only refusals the page's own requests ran into since the last call, for the page driver to tell the persona. */
  refusals(): ActionRefusal[];
  close(): void;
}

/**
 * Two gates that enforce one rule (tech.md §9.3, §4.13), both reporting each distinct refusal once.
 *  1. route()/routeWebSocket() refuse requests the page starts, with the method, path and navigation flag.
 *  2. A proxy of the context's own catches what route() cannot see: Playwright's Chromium backend never routes redirect hops.
 *     Chromium sends the listed hosts straight out (the bypass list) and everything else here, loopback included
 *     (`<-loopback>` must come first: later rules win, so the listed hosts come after it). Nothing legitimate ever arrives, so
 *     the proxy forwards nothing and never touches allowed traffic; it refuses, with a 403 or a failed CONNECT, and reports.
 * With `observe` (tech.md §9.3), route() also refuses every request on a listed host but GET and HEAD, every WebSocket (its
 * messages could write), and page loads robots.txt disallows; it lets page loads through one per OBSERVE_INTERVAL_MS. Redirect hops
 * never reach route(), so they are neither paced nor checked against robots.txt.
 * Observe-only also lets a page's reads that are not a tab's page load (stylesheets, fonts, images, scripts, a form script's GETs,
 * an embedded video or demo frame) reach any host but the blocked domains: route() passes them, and the proxy tunnels them to the
 * host when it resolves to public addresses only. A competitor's site needs its CDNs to render at all, and nothing but reads
 * leave, since route() refuses every write first. Page loads still stay on the listed hosts (a redirect hop that leaves them is
 * undone by the page driver).
 * shortcut: no WebRTC or other non-HTTP traffic is covered, and the listed hosts are reached directly, bypassing any system proxy;
 * upgrade to chain this proxy to the system one if a team can only reach staging through it. Observe-only tunnels https only:
 * an https page cannot load plain http assets anyway.
 */
export async function startContainment(allowedHosts: string[], blockedDomains: string[], onBlocked: PageOptions['onBlockedRequest'], observe?: PageOptions['observe'], resolve = publicAddress): Promise<Containment> {
  const allows = hostRule(allowedHosts, blockedDomains);
  const readable: HostRule = (hostname) => !!observe && hostRule([hostname], blockedDomains)(hostname); // any host but a blocked domain
  const tunnels = new Set<net.Socket>();
  const seen = new Set<string>();
  // The callback is the caller's code: it must never be able to stop a refusal or throw into Playwright's routing or the proxy.
  const report = (url: URL, method: string, navigation: boolean, reason: BlockReason = 'host') => {
    const key = `${method} ${url.hostname}${url.pathname}`;
    if (seen.has(key)) return;
    seen.add(key);
    try {
      onBlocked({ host: url.hostname, url: `${url.protocol}//${url.host}${url.pathname}`, method, navigation, reason }); // no query string: it can carry tokens
    } catch {}
  };
  const pace = rateLimiter(OBSERVE_INTERVAL_MS);
  let refused: ActionRefusal[] = [];

  const proxy = http.createServer((req, res) => {
    let url: URL;
    try {
      url = new URL(req.url!); // a proxy request is in absolute form; anything else is not the browser
    } catch {
      res.writeHead(400, { connection: 'close' }).end();
      return;
    }
    report(url, req.method!, req.headers['sec-fetch-mode'] === 'navigate'); // only sent to trustworthy origins, so false means "cannot tell"
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', connection: 'close' });
    res.end('Blocked: this address is outside the hosts this run may reach.');
  });
  proxy.on('connect', (req, socket, head) => {
    socket.on('error', () => {}); // a reset after the refusal must not become an uncaught exception
    let url: URL | null = null;
    try {
      url = new URL(`https://${req.url}`); // all that is known: the target of a TLS or WebSocket tunnel
    } catch {}
    const refuse = () => {
      if (url) report(url, 'CONNECT', false);
      socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
    };
    if (!url || !readable(url.hostname)) return refuse();
    const port = Number(url.port || 443);
    void resolve(url.hostname).then((address) => {
      if (!address) return refuse();
      if (socket.destroyed) return;
      const upstream = net.connect(port, address, () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        upstream.pipe(socket);
        socket.pipe(upstream);
      });
      tunnels.add(upstream);
      upstream.on('error', () => socket.destroy());
      upstream.on('close', () => {
        tunnels.delete(upstream);
        socket.destroy();
      });
      socket.on('close', () => upstream.destroy());
    });
  });
  proxy.on('clientError', (_error, socket) => socket.destroy());
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const { port } = proxy.address() as AddressInfo;

  const direct = [...new Set(allowedHosts.map((host) => host.toLowerCase()))].filter((host) => allows(host) && BYPASSABLE.test(host));
  const close = () => {
    proxy.close();
    proxy.closeAllConnections();
    for (const tunnel of tunnels) tunnel.destroy();
  };

  return {
    allows,
    proxy: { server: `http://127.0.0.1:${port}`, bypass: ['<-loopback>', ...direct].join(',') },
    close,
    refusals() {
      const drained = refused;
      refused = [];
      return drained;
    },
    async install(context) {
      context.once('close', close);
      // A route call rejects when the page closed under an in-flight request; there is nothing left to protect then.
      await context.route(
        () => true,
        (route, request) => {
          const url = new URL(request.url());
          const navigation = request.isNavigationRequest();
          const write = !READS.has(request.method());
          const outside = !allows(url.hostname) && (write || !readable(url.hostname) || (navigation && isTopFrame(request)));
          const reason: BlockReason | null = outside ? 'host' : !observe ? null : write ? 'observe_only' : navigation && !observe.robots(url) ? 'robots' : null;
          if (!reason) return (observe && navigation ? pace() : Promise.resolve()).then(() => route.continue()).catch(() => {});
          const aborted = route.abort('blockedbyclient').catch(() => {});
          report(url, request.method(), navigation, reason);
          if (reason === 'robots') refused.push('robots_disallowed');
          if (reason === 'observe_only' && navigation) refused.push('submit_blocked');
          else if (reason === 'observe_only' && ACTION_WRITES.has(request.resourceType())) refused.push('write_blocked');
          return aborted;
        },
      );
      await context.routeWebSocket(
        () => true,
        (ws) => {
          const url = new URL(ws.url());
          if (allows(url.hostname) && !observe) return ws.connectToServer();
          const closed = ws.close().catch(() => {});
          report(url, 'GET', false, allows(url.hostname) ? 'observe_only' : 'host');
          return closed;
        },
      );
    },
  };
}
