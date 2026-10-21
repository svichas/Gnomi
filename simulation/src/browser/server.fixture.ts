import http from 'node:http';
import type { AddressInfo } from 'node:net';

// The local HTTP servers of the browser tests.

/** Listens on a free port of 127.0.0.1, or of every interface (null) so `localhost` works over IPv4 and IPv6; resolves with the origin. */
export async function listen(server: http.Server, host: '127.0.0.1' | null = '127.0.0.1'): Promise<string> {
  await new Promise<void>((resolve) => (host ? server.listen(0, host, resolve) : server.listen(0, resolve)));
  return `http://${host ?? 'localhost'}:${(server.address() as AddressInfo).port}`;
}

/** Closes the servers without waiting for the browser's keep-alive connections. */
export function stop(...servers: http.Server[]): void {
  for (const server of servers) {
    server.closeAllConnections();
    server.close();
  }
}

/** An origin nothing listens on: a port that was just free. */
export async function deadOrigin(): Promise<string> {
  const server = http.createServer();
  const origin = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return origin;
}
