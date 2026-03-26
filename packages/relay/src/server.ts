/**
 * Relay server: WebSocket + HTTP admin API.
 * Accepts publish/search/consent/withdraw from authenticated nodes.
 */

import { createServer, type Server } from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  MessageTypes,
  parseMessage,
  verifyMessage,
  createMessage,
  serializeMessage,
  generateIdentity,
  type AckPayload,
  type MatchPayload,
  type Identity,
  type PublishPayload,
  type SearchPayload,
  type ConsentPayload,
  type WithdrawPayload,
} from '@resonance/core';
import { HNSW_DEFAULTS, PROTOCOL_DEFAULTS } from '@resonance/core';
import { MatchingEngine } from './matching-engine.js';
import { RateLimiter } from './rate-limiter.js';
import { log } from './logger.js';
import {
  handlePublish,
  handleSearch,
  handleConsent,
  handleWithdraw,
  handleChannelMessage,
  type ClientState,
  type HandlerContext,
} from './handler.js';

export interface RelayConfig {
  port: number;
  host: string;
  persistDir: string;
  persistIntervalMs: number;
  matchThreshold: number;
  matchK: number;
  matchExpiryMs: number;
  maxPublishesPerMin: number;
  maxSearchesPerMin: number;
  authWindowMs: number;
  adminApiKey: string | null;
  maxAuthAttemptsPerMin: number;
}

export interface RelayStats {
  indexed_embeddings: number;
  connected_nodes: number;
  matches_today: number;
  uptime: number;
}

export interface RelayServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  getStats(): RelayStats;
}

const DEFAULT_CONFIG: RelayConfig = {
  port: 9090,
  host: '0.0.0.0',
  persistDir: './data',
  persistIntervalMs: 60_000,
  matchThreshold: PROTOCOL_DEFAULTS.relayThreshold,
  matchK: 10,
  matchExpiryMs: 7 * 24 * 60 * 60 * 1000,
  maxPublishesPerMin: 10,
  maxSearchesPerMin: 30,
  authWindowMs: 30_000,
  adminApiKey: null,
  maxAuthAttemptsPerMin: 5,
};

export function createRelayServer(config?: Partial<RelayConfig>): RelayServer {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  const engine = new MatchingEngine({ matchExpiryMs: cfg.matchExpiryMs });
  engine.initialize();

  const rateLimiter = new RateLimiter({
    maxPublishesPerMin: cfg.maxPublishesPerMin,
    maxSearchesPerMin: cfg.maxSearchesPerMin,
  });

  // VULN-12: Persist relay identity
  const identityPath = join(cfg.persistDir, 'relay-identity.json');
  let relayIdentity: Identity;
  mkdirSync(cfg.persistDir, { recursive: true });
  if (existsSync(identityPath)) {
    const data = JSON.parse(readFileSync(identityPath, 'utf-8'));
    relayIdentity = {
      publicKey: Uint8Array.from(Object.values(data.publicKey)),
      secretKey: Uint8Array.from(Object.values(data.secretKey)),
      did: data.did,
    };
  } else {
    relayIdentity = generateIdentity();
    writeFileSync(identityPath, JSON.stringify({
      publicKey: Array.from(relayIdentity.publicKey),
      secretKey: Array.from(relayIdentity.secretKey),
      did: relayIdentity.did,
    }));
  }

  const clients = new Map<string, ClientState>();
  const matchRegistry = new Map<string, { publisherDID: string; matchedDID: string; createdAt: number }>();

  // VULN-13: Auth attempt rate limiting by IP
  const authAttempts = new Map<string, { count: number; start: number }>();

  const ctx: HandlerContext = {
    engine,
    rateLimiter,
    clients,
    relayIdentity,
    matchThreshold: cfg.matchThreshold,
    matchK: cfg.matchK,
    matchExpiryMs: cfg.matchExpiryMs,
    matchRegistry,
  };

  let httpServer: Server;
  let wss: WebSocketServer;
  let persistTimer: ReturnType<typeof setInterval> | null = null;
  let cleanupTimer: ReturnType<typeof setInterval> | null = null;
  const startTime = Date.now();

  function persist(): void {
    try {
      engine.save(cfg.persistDir);
      log('info', 'persist', { dir: cfg.persistDir });
    } catch (err) {
      log('error', 'persist_failed', { error: String(err) });
    }
  }

  function handleHttpRequest(req: { url?: string; method?: string }, res: {
    writeHead: (code: number, headers?: Record<string, string>) => void;
    end: (body?: string) => void;
  }): void {
    if (req.url === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    if (req.url?.startsWith('/stats') && req.method === 'GET') {
      // VULN-07: Require API key if configured
      if (cfg.adminApiKey) {
        const url = new URL(req.url, 'http://localhost');
        if (url.searchParams.get('key') !== cfg.adminApiKey) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'unauthorized' }));
          return;
        }
      }
      const stats = engine.getStats();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        indexed_embeddings: stats.total,
        connected_nodes: clients.size,
        matches_today: stats.matchesToday,
        uptime: Math.floor((Date.now() - startTime) / 1000),
      }));
      return;
    }
    res.writeHead(404);
    res.end();
  }

  function handleConnection(ws: WebSocket, req: any): void {
    let clientState: ClientState | null = null;

    // VULN-13: Rate limit auth attempts by IP
    const ip = req?.socket?.remoteAddress ?? 'unknown';
    const now = Date.now();
    let attempts = authAttempts.get(ip);
    if (!attempts || now - attempts.start > 60_000) {
      attempts = { count: 0, start: now };
      authAttempts.set(ip, attempts);
    }
    attempts.count++;
    if (attempts.count > cfg.maxAuthAttemptsPerMin) {
      ws.close(4029, 'too_many_auth_attempts');
      return;
    }

    const authTimeout = setTimeout(() => {
      if (!clientState?.authenticated) {
        ws.close(4001, 'auth_timeout');
      }
    }, 10_000);

    ws.on('message', (data: Buffer) => {
      let raw: string;
      try {
        raw = data.toString('utf-8');
      } catch {
        ws.close(4000, 'invalid_encoding');
        return;
      }

      let msg;
      try {
        msg = parseMessage(raw);
      } catch {
        ws.close(4000, 'invalid_message');
        return;
      }

      // Verify signature
      if (!verifyMessage(msg)) {
        ws.close(4002, 'invalid_signature');
        return;
      }

      // Handle auth
      if (msg.type === MessageTypes.AUTH) {
        clearTimeout(authTimeout);

        // Check timestamp freshness
        const age = Math.abs(Date.now() - msg.timestamp);
        if (age > cfg.authWindowMs) {
          const ack = createMessage<AckPayload>(MessageTypes.ACK, {
            ref: 'auth', status: 'error', message: 'stale_timestamp',
          }, relayIdentity);
          ws.send(serializeMessage(ack));
          ws.close(4003, 'stale_timestamp');
          return;
        }

        clientState = { did: msg.from, ws, authenticated: true };
        clients.set(msg.from, clientState);

        const ack = createMessage<AckPayload>(MessageTypes.ACK, {
          ref: 'auth', status: 'ok',
        }, relayIdentity);
        ws.send(serializeMessage(ack));

        // Deliver pending notifications for this DID
        const pending = engine.getPendingForDID(msg.from);
        for (const n of pending) {
          const isPublisher = n.publisherDID === msg.from;
          const matchMsg = createMessage<MatchPayload>(MessageTypes.MATCH, {
            matchId: n.matchId,
            partnerDID: isPublisher ? n.matchedDID : n.publisherDID,
            similarity: n.similarity,
            yourItemId: isPublisher ? n.publisherItemId : n.matchedItemId,
            partnerItemType: isPublisher ? n.matchedItemType : n.publisherItemType,
            expiry: n.expiry,
          }, relayIdentity);
          ws.send(serializeMessage(matchMsg));
          engine.removeNotification(n.matchId, msg.from);
        }
        if (pending.length > 0) {
          log('info', 'delivered_pending', { did: msg.from, count: pending.length });
        }

        log('info', 'auth', { did: msg.from });
        return;
      }

      // All other messages require authentication
      if (!clientState?.authenticated) {
        ws.close(4001, 'not_authenticated');
        return;
      }

      // Verify DID matches authenticated client
      if (msg.from !== clientState.did) {
        ws.close(4002, 'did_mismatch');
        return;
      }

      // Route to handler
      switch (msg.type) {
        case MessageTypes.PUBLISH:
          handlePublish(ctx, clientState, msg as any);
          break;
        case MessageTypes.SEARCH:
          handleSearch(ctx, clientState, msg as any);
          break;
        case MessageTypes.CONSENT:
          handleConsent(ctx, clientState, msg as any);
          break;
        case MessageTypes.WITHDRAW:
          handleWithdraw(ctx, clientState, msg as any);
          break;
        case MessageTypes.CHANNEL_MESSAGE:
          handleChannelMessage(ctx, clientState, msg as any);
          break;
        default: {
          const ack = createMessage<AckPayload>(MessageTypes.ACK, {
            ref: msg.type, status: 'error', message: 'unknown_message_type',
          }, relayIdentity);
          ws.send(serializeMessage(ack));
        }
      }
    });

    ws.on('close', () => {
      clearTimeout(authTimeout);
      if (clientState) {
        clients.delete(clientState.did);
        log('info', 'disconnect', { did: clientState.did });
      }
    });

    ws.on('error', (err) => {
      log('error', 'ws_error', { error: String(err), did: clientState?.did });
    });
  }

  return {
    async start(): Promise<void> {
      // Try loading persisted state
      try {
        engine.load(cfg.persistDir);
        log('info', 'loaded', { dir: cfg.persistDir });
      } catch {
        log('info', 'fresh_start', { dir: cfg.persistDir });
      }

      httpServer = createServer(handleHttpRequest);
      wss = new WebSocketServer({ server: httpServer });
      wss.on('connection', handleConnection);

      await new Promise<void>((resolve) => {
        httpServer.listen(cfg.port, cfg.host, () => {
          log('info', 'started', { port: cfg.port, host: cfg.host, did: relayIdentity.did });
          resolve();
        });
      });

      // Periodic persistence
      persistTimer = setInterval(persist, cfg.persistIntervalMs);
      // Periodic rate limiter cleanup
      cleanupTimer = setInterval(() => {
        rateLimiter.cleanup();
        // VULN-10: Expire old matchRegistry entries
        const cutoff = Date.now() - cfg.matchExpiryMs;
        for (const [id, entry] of matchRegistry) {
          if (entry.createdAt < cutoff) matchRegistry.delete(id);
        }
        // VULN-13: Clean old auth attempt records
        const authCutoff = Date.now() - 60_000;
        for (const [ip, att] of authAttempts) {
          if (att.start < authCutoff) authAttempts.delete(ip);
        }
      }, 5 * 60_000);
    },

    async stop(): Promise<void> {
      if (persistTimer) clearInterval(persistTimer);
      if (cleanupTimer) clearInterval(cleanupTimer);

      // Final save
      persist();

      // Close all connections
      for (const [, client] of clients) {
        client.ws.close(1001, 'server_shutdown');
      }
      clients.clear();

      wss?.close();
      await new Promise<void>((resolve) => {
        httpServer?.close(() => resolve());
      });

      log('info', 'stopped');
    },

    getStats(): RelayStats {
      const stats = engine.getStats();
      return {
        indexed_embeddings: stats.total,
        connected_nodes: clients.size,
        matches_today: stats.matchesToday,
        uptime: Math.floor((Date.now() - startTime) / 1000),
      };
    },
  };
}
