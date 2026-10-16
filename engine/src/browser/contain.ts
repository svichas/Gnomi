import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { BrowserContext } from 'playwright-core';
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

/** How an observe-only refusal reads in the action that caused it: a write it tried, or a page robots.txt disallows. */
export type ActionRefusal = 'submit_blocked' | 'robots_disallowed';

const READS = new Set(['GET', 'HEAD']);
// A form post or a script saving something; a beacon or ping is not something the persona did.
const ACTION_WRITES = new Set(['document', 'xhr', 'fetch']);

// Hostnames and bracketed IPv6 literals only: anything else could read as a wildcard, scheme or port in Chromium's bypass-rule syntax.
const BYPASSABLE = /^(?:[a-z0-9_-]+(?:\.[a-z0-9_-]+)*|\[[0-9a-f:.]+\])$/;

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
 * shortcut: no WebRTC or other non-HTTP traffic is covered, and the listed hosts are reached directly, bypassing any system proxy;
 * upgrade to chain this proxy to the system one if a team can only reach staging through it.
 */
export async function startContainment(allowedHosts: string[], blockedDomains: string[], onBlocked: PageOptions['onBlockedRequest'], observe?: PageOptions['observe']): Promise<Containment> {
  const allows = hostRule(allowedHosts, blockedDomains);
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
  proxy.on('connect', (req, socket) => {
    socket.on('error', () => {}); // a reset after the refusal must not become an uncaught exception
    try {
      report(new URL(`https://${req.url}`), 'CONNECT', false); // all that is known: the target of a TLS or WebSocket tunnel
    } catch {}
    socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
  });
  proxy.on('clientError', (_error, socket) => socket.destroy());
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const { port } = proxy.address() as AddressInfo;

  const direct = [...new Set(allowedHosts.map((host) => host.toLowerCase()))].filter((host) => allows(host) && BYPASSABLE.test(host));
  const close = () => {
    proxy.close();
    proxy.closeAllConnections();
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
          const reason: BlockReason | null = !allows(url.hostname) ? 'host' : !observe ? null : write ? 'observe_only' : navigation && !observe.robots(url) ? 'robots' : null;
          if (!reason) return (observe && navigation ? pace() : Promise.resolve()).then(() => route.continue()).catch(() => {});
          const aborted = route.abort('blockedbyclient').catch(() => {});
          report(url, request.method(), navigation, reason);
          if (reason === 'robots') refused.push('robots_disallowed');
          if (reason === 'observe_only' && (navigation || ACTION_WRITES.has(request.resourceType()))) refused.push('submit_blocked');
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
