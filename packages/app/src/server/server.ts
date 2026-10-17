/**
 * HTTP + WebSocket server for the Resonance web UI.
 * Serves static files from ui/ and REST API from /api/*.
 */

import { createServer, type Server } from 'node:http';
import { createReadStream } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import type { Socket } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { handleApi } from './api.js';
import { isUnlocked, setSessionEvents } from './session.js';
import { localHttpBoundary } from './local-http-boundary.js';
import { localUiFile } from './local-ui-files.js';
import { matchesSessionToken, onSessionTokenChange } from './local-session-auth.js';
import { LocalJsonBodyError } from './local-json-body.js';

// Resolve UI directory: works in tsx (ESM), esbuild CJS, and pkg snapshot
function resolveUiDir(): string {
  // In pkg binary: look for ui/ next to the executable
  if ((process as any).pkg) {
    return join(dirname(process.execPath), 'ui');
  }
  try {
    // ESM mode (tsx)
    const dir = dirname(new URL(import.meta.url).pathname);
    return join(dir, 'ui');
  } catch {
    // CJS mode (esbuild bundle)
    return join(__dirname, 'ui');
  }
}

const UI_DIR = resolveUiDir();

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

export interface AppServerConfig {
  port: number;
  relayUrl: string;
  /** Explicit local asset root; omitted by ordinary desktop startup. */
  uiDirectory?: string;
}

export interface AppServer {
  start(): Promise<number>;  // returns actual port
  stop(): Promise<void>;
}

export function createAppServer(config: AppServerConfig): AppServer {
  const { port, relayUrl } = config;
  let httpServer: Server;
  let wss: WebSocketServer;
  const wsClients = new Map<WebSocket, string>();
  const rawSockets = new Set<Socket>();
  let unsubscribeToken: (() => void) | undefined;

  // Broadcast events to all connected WebSocket clients
  function broadcast(event: Record<string, unknown>): void {
    const data = JSON.stringify(event);
    for (const [ws, token] of wsClients) {
      if (!isUnlocked() || !matchesSessionToken(token) || ws.bufferedAmount + Buffer.byteLength(data) > 1024 * 1024) {
        ws.terminate(); continue;
      }
      if (ws.readyState === 1) ws.send(data, error => { if (error) ws.terminate(); });
    }
  }

  // Wire session events to WebSocket broadcast
  setSessionEvents({
    onMatch(matchId, partnerDID, similarity, yourItemId) {
      broadcast({ type: 'match', matchId, partnerDID, similarity, yourItemId });
    },
    onChannelReady(channelId, matchId) {
      broadcast({ type: 'channel_ready', channelId, matchId });
    },
    onConfirmResult(channelId, similarity, confirmed) {
      broadcast({ type: 'confirm_result', channelId, similarity, confirmed });
    },
    onDisclosure(channelId, text, level) {
      broadcast({ type: 'disclosure', channelId, text, level });
    },
    onAccept(channelId, message) {
      broadcast({ type: 'accept', channelId, message });
    },
    onReject(channelId, reason) {
      broadcast({ type: 'reject', channelId, reason });
    },
    onClose(channelId) {
      broadcast({ type: 'close', channelId });
    },
  });

  return {
    async start(): Promise<number> {
      httpServer = createServer({ maxHeaderSize: 8192, headersTimeout: 10000, requestTimeout: 10000, connectionsCheckingInterval: 1000 }, async (req, res) => {
        if (!localHttpBoundary(req).allowed) { res.writeHead(403); res.end('Forbidden'); return; }
        const url = req.url ?? '/';
        if (!url.startsWith('/') || url.startsWith('//')) { res.writeHead(400); res.end('Bad request'); return; }

        // API routes
        if (url.startsWith('/api/')) {
          try {
            const handled = await handleApi(req, res, relayUrl);
            if (!handled) {
              res.writeHead(404, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Not found' }));
            }
          } catch (error) {
            if (error instanceof LocalJsonBodyError) {
              if (!res.headersSent) res.writeHead(error.statusCode, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
                'Access-Control-Allow-Origin': localHttpBoundary(req).origin, 'Access-Control-Allow-Credentials': 'true', 'Vary': 'Origin' });
              res.end(JSON.stringify({ error: error.message })); return;
            }
            // A failed durable-state read must close this request, not crash the
            // desktop process or leave the browser waiting indefinitely.
            if (!res.headersSent) {
              res.writeHead(503, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Local state is unavailable. Lock and unlock to inspect saved delivery state.' }));
            } else res.end();
          }
          return;
        }

        if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
        const file = localUiFile(config.uiDirectory ?? UI_DIR, url);
        if (!file) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': MIME_TYPES[extname(file.path)] || 'application/octet-stream',
          'Content-Length': String(file.size), 'X-Content-Type-Options': 'nosniff' });
        if (req.method === 'HEAD') { res.end(); return; }
        const stream = createReadStream(file.path);
        stream.on('error', () => res.destroy()); res.on('close', () => stream.destroy()); stream.pipe(res);
      });
      httpServer.maxConnections = 128;
      httpServer.setTimeout(10000, socket => socket.destroy());
      httpServer.on('connection', socket => { rawSockets.add(socket); socket.once('close', () => rawSockets.delete(socket)); });

      wss = new WebSocketServer({ noServer: true, maxPayload: 1024, perMessageDeflate: false });
      httpServer.on('upgrade', (req, socket, head) => {
        const deny = (status: number) => socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
        if (!localHttpBoundary(req).allowed) { deny(403); return; }
        if (!req.url?.startsWith('/api/events?')) { deny(401); return; }
        let url: URL;
        try { url = new URL(req.url, 'http://localhost'); } catch { deny(400); return; }
        const token = url.searchParams.get('token');
        if (url.pathname !== '/api/events'
          || [...url.searchParams.keys()].join(',') !== 'token' || !isUnlocked() || !matchesSessionToken(token)) { deny(401); return; }
        if (wsClients.size >= 16) { deny(503); return; }
        wss.handleUpgrade(req, socket, head, ws => {
          wsClients.set(ws, token!);
          ws.on('error', () => {}); ws.on('message', () => ws.terminate());
          ws.on('close', () => wsClients.delete(ws));
        });
      });
      unsubscribeToken = onSessionTokenChange(() => { for (const ws of wsClients.keys()) ws.terminate(); wsClients.clear(); });

      await new Promise<void>((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(port, '127.0.0.1', () => { httpServer.removeListener('error', reject); resolve(); });
      }).catch(error => { unsubscribeToken?.(); wss.close(); throw error; });

      const addr = httpServer.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : port;
      return actualPort;
    },

    async stop(): Promise<void> {
      unsubscribeToken?.(); unsubscribeToken = undefined;
      for (const ws of wsClients.keys()) ws.terminate();
      wsClients.clear();
      wss?.close();
      for (const socket of rawSockets) socket.destroy();
      await new Promise<void>((resolve) => {
        httpServer?.close(() => resolve());
      });
    },
  };
}
