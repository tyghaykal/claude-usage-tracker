import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { TtlCache } from '../src/cache.js';
import {
  attachRealtime,
  broadcastTo,
  createBroadcaster,
  issueWsTicket,
} from '../src/realtime.js';
import { buildApp, makeUserAndLogin } from './helpers.js';

describe('POST /api/ws-ticket', () => {
  const { app } = buildApp();

  it('requires authentication', async () => {
    expect((await request(app).post('/api/ws-ticket')).status).toBe(401);
  });

  it('issues a fresh ticket per call for any signed-in user', async () => {
    const { auth } = await makeUserAndLogin(app, { role: 'user' });
    const first = await request(app).post('/api/ws-ticket').set('Authorization', auth);
    const second = await request(app).post('/api/ws-ticket').set('Authorization', auth);

    expect(first.status).toBe(200);
    expect(first.body.ticket).toMatch(/^[0-9a-f]{48}$/);
    expect(second.body.ticket).not.toBe(first.body.ticket);
  });
});

describe('createBroadcaster', () => {
  it('delivers an emitted event to every subscriber', () => {
    const broadcaster = createBroadcaster();
    const a = vi.fn();
    const b = vi.fn();
    broadcaster.subscribe(a);
    broadcaster.subscribe(b);

    broadcaster.emit({ type: 'data-changed' });

    expect(a).toHaveBeenCalledWith({ type: 'data-changed' });
    expect(b).toHaveBeenCalledWith({ type: 'data-changed' });
  });

  it('stops delivering once unsubscribed', () => {
    const broadcaster = createBroadcaster();
    const listener = vi.fn();
    const unsubscribe = broadcaster.subscribe(listener);
    unsubscribe();

    broadcaster.emit({ type: 'data-changed' });

    expect(listener).not.toHaveBeenCalled();
  });

  it('is a no-op with no subscribers', () => {
    expect(() => createBroadcaster().emit({ type: 'data-changed' })).not.toThrow();
  });
});

describe('issueWsTicket', () => {
  it('issues a ticket the cache holds under a namespaced key', () => {
    const cache = new TtlCache();
    const ticket = issueWsTicket(cache);
    expect(ticket).toMatch(/^[0-9a-f]{48}$/);
    expect(cache.get(`ws-ticket:${ticket}`)).toBe(true);
  });

  it('issues a different ticket each call', () => {
    const cache = new TtlCache();
    expect(issueWsTicket(cache)).not.toBe(issueWsTicket(cache));
  });
});

describe('broadcastTo', () => {
  it('sends the event only to clients whose socket is open', () => {
    const open = { readyState: WebSocket.OPEN, send: vi.fn() };
    const connecting = { readyState: WebSocket.CONNECTING, send: vi.fn() };
    broadcastTo([open, connecting], { type: 'data-changed' });

    expect(open.send).toHaveBeenCalledWith(JSON.stringify({ type: 'data-changed' }));
    expect(connecting.send).not.toHaveBeenCalled();
  });
});

describe('attachRealtime', () => {
  async function withServer<T>(run: (opts: { url: string; cache: TtlCache }) => Promise<T>) {
    const httpServer: Server = createServer();
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const port = (httpServer.address() as AddressInfo).port;
    const cache = new TtlCache();
    const broadcaster = createBroadcaster();
    const realtime = attachRealtime(httpServer, cache, broadcaster);
    try {
      return await run({ url: `ws://127.0.0.1:${port}/api/ws`, cache });
    } finally {
      realtime.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  }

  it('accepts a connection presenting a valid ticket', async () => {
    await withServer(async ({ url, cache }) => {
      const ticket = issueWsTicket(cache);
      const socket = new WebSocket(`${url}?ticket=${ticket}`);
      await expect(
        new Promise<void>((resolve, reject) => {
          socket.once('open', () => resolve());
          socket.once('error', reject);
        }),
      ).resolves.toBeUndefined();
      socket.close();
    });
  });

  it('rejects a connection with an invalid ticket', async () => {
    await withServer(async ({ url }) => {
      const socket = new WebSocket(`${url}?ticket=not-a-real-ticket`);
      const closeCode = await new Promise<number>((resolve) => {
        socket.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
        socket.once('close', (code) => resolve(code));
        socket.once('error', () => resolve(-1));
      });
      expect(closeCode).not.toBe(1000);
    });
  });

  it('rejects a connection with no ticket query param at all', async () => {
    await withServer(async ({ url }) => {
      const socket = new WebSocket(url); // no `?ticket=...`
      const closeCode = await new Promise<number>((resolve) => {
        socket.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
        socket.once('close', (code) => resolve(code));
        socket.once('error', () => resolve(-1));
      });
      expect(closeCode).not.toBe(1000);
    });
  });

  it('rejects an upgrade to any path other than /api/ws', async () => {
    await withServer(async ({ url }) => {
      const socket = new WebSocket(url.replace('/api/ws', '/not-ws'));
      const failed = await new Promise<boolean>((resolve) => {
        socket.once('open', () => resolve(false));
        socket.once('error', () => resolve(true));
        socket.once('close', () => resolve(true));
      });
      expect(failed).toBe(true);
    });
  });

  it('consumes the ticket so it cannot be reused for a second connection', async () => {
    await withServer(async ({ url, cache }) => {
      const ticket = issueWsTicket(cache);
      const first = new WebSocket(`${url}?ticket=${ticket}`);
      await new Promise<void>((resolve, reject) => {
        first.once('open', () => resolve());
        first.once('error', reject);
      });
      first.close();

      const second = new WebSocket(`${url}?ticket=${ticket}`);
      const rejected = await new Promise<boolean>((resolve) => {
        second.once('open', () => resolve(false));
        second.once('error', () => resolve(true));
        second.once('close', () => resolve(true));
      });
      expect(rejected).toBe(true);
    });
  });

  it('delivers a broadcast event to a connected client', async () => {
    const httpServer: Server = createServer();
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const port = (httpServer.address() as AddressInfo).port;
    const cache = new TtlCache();
    const broadcaster = createBroadcaster();
    const realtime = attachRealtime(httpServer, cache, broadcaster);

    try {
      const ticket = issueWsTicket(cache);
      const socket = new WebSocket(`ws://127.0.0.1:${port}/api/ws?ticket=${ticket}`);
      await new Promise<void>((resolve, reject) => {
        socket.once('open', () => resolve());
        socket.once('error', reject);
      });

      const received = new Promise((resolve) => {
        socket.once('message', (data) => resolve(JSON.parse(data.toString())));
      });
      broadcaster.emit({ type: 'data-changed' });

      await expect(received).resolves.toEqual({ type: 'data-changed' });
      socket.close();
    } finally {
      realtime.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  });

  it('close() drops open connections and stops handling future upgrades', async () => {
    const httpServer: Server = createServer();
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const port = (httpServer.address() as AddressInfo).port;
    const cache = new TtlCache();
    const broadcaster = createBroadcaster();
    const realtime = attachRealtime(httpServer, cache, broadcaster);

    const ticket = issueWsTicket(cache);
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/ws?ticket=${ticket}`);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });

    const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
    realtime.close();
    await closed;

    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });
});
