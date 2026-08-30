import { randomBytes } from 'node:crypto';
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import type { TtlCache } from './cache.js';

const WS_PATH = '/api/ws';
const TICKET_TTL_MS = 20_000;
const TICKET_PREFIX = 'ws-ticket:';

/** Content-free — every listener just refetches its own data on receipt. */
export type RealtimeEvent = { type: 'data-changed' };

export interface Broadcaster {
  emit(event: RealtimeEvent): void;
  /** Returns an unsubscribe function. */
  subscribe(listener: (event: RealtimeEvent) => void): () => void;
}

/**
 * In-process pub-sub. Route handlers (ingest, pricing writes, recalculation)
 * call `emit` without knowing whether anything is listening; `attachRealtime`
 * is what turns those events into browser pushes. Keeping them separate means
 * a route test can assert "this fired an event" without a real socket.
 */
export function createBroadcaster(): Broadcaster {
  const listeners = new Set<(event: RealtimeEvent) => void>();
  return {
    emit(event) {
      for (const listener of listeners) listener(event);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/**
 * One-time, 20s-lived credential for the WS handshake. A browser cannot send
 * an Authorization header while opening a WebSocket, so this — not the
 * long-lived bearer access token — is what travels in the connection URL.
 */
export function issueWsTicket(cache: TtlCache): string {
  const ticket = randomBytes(24).toString('hex');
  cache.set(`${TICKET_PREFIX}${ticket}`, true, TICKET_TTL_MS);
  return ticket;
}

/** Single-use: consumed (deleted) the moment it is checked, valid or not. */
function consumeWsTicket(ticket: string, cache: TtlCache): boolean {
  const key = `${TICKET_PREFIX}${ticket}`;
  const valid = cache.get(key) === true;
  cache.delete(key);
  return valid;
}

export interface RealtimeServer {
  /** Drops every open connection and stops handling upgrades. Tests only. */
  close(): void;
}

interface Sendable {
  readyState: number;
  send(data: string): void;
}

/** Skips a client mid-handshake or mid-close — `send` would throw on either. */
export function broadcastTo(clients: Iterable<Sendable>, event: RealtimeEvent): void {
  const payload = JSON.stringify(event);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) client.send(payload);
  }
}

/**
 * Wires `broadcaster` events to real browser connections over a WebSocket
 * mounted at `/api/ws` — the same path prefix nginx (prod) and Vite (dev)
 * already proxy to the API, so no separate upgrade route is needed anywhere
 * else in the stack.
 */
export function attachRealtime(
  server: HttpServer,
  cache: TtlCache,
  broadcaster: Broadcaster,
): RealtimeServer {
  const wss = new WebSocketServer({ noServer: true });

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    // req.url is always populated on a real 'upgrade' event — Node only
    // leaves it undefined for a request object that never reached routing.
    const url = new URL(req.url as string, 'http://localhost');
    if (url.pathname !== WS_PATH) {
      socket.destroy();
      return;
    }
    const ticket = url.searchParams.get('ticket') ?? '';
    if (!consumeWsTicket(ticket, cache)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
  };
  server.on('upgrade', onUpgrade);

  const unsubscribe = broadcaster.subscribe((event) => broadcastTo(wss.clients, event));

  return {
    close() {
      server.off('upgrade', onUpgrade);
      unsubscribe();
      for (const client of wss.clients) client.terminate();
      wss.close();
    },
  };
}
