/**
 * HTTP + WebSocket server for the Resonance web UI.
 * Serves static files from ui/ and REST API from /api/*.
 */

import { createServer, type Server } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname, dirname, resolve } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { handleApi, sessionToken } from './api.js';
import { setSessionEvents } from './session.js';

// Resolve UI directory: Vite builds to dist/ in the app package root
function resolveUiDir(): string {
  try {
    // ESM mode (tsx) — server file is at src/server/server.ts, dist/ is at ../../dist/
    const dir = dirname(new URL(import.meta.url).pathname);
    const distDir = resolve(dir, '../../dist');
    if (existsSync(distDir)) return distDir;
    // Fallback: old ui/ directory
    return join(dir, '../ui');
  } catch {
    // CJS mode
    return join(__dirname, '../../dist');
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
}

export interface AppServer {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createAppServer(config: AppServerConfig): AppServer {
  const { port, relayUrl } = config;
  let httpServer: Server;
  let wss: WebSocketServer;
  const wsClients = new Set<WebSocket>();

  // Broadcast events to all connected WebSocket clients
  function broadcast(event: Record<string, unknown>): void {
    const data = JSON.stringify(event);
    for (const ws of wsClients) {
      if (ws.readyState === 1) ws.send(data);
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
    async start(): Promise<void> {
      httpServer = createServer(async (req, res) => {
        const url = req.url ?? '/';

        // API routes
        if (url.startsWith('/api/')) {
          const handled = await handleApi(req, res, relayUrl);
          if (!handled) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Not found' }));
          }
          return;
        }

        // Static file serving
        let filePath = url === '/' ? '/index.html' : url;
        const fullPath = resolve(join(UI_DIR, filePath));

        // Security: verify resolved path is within UI_DIR (prevent directory traversal)
        if (!fullPath.startsWith(resolve(UI_DIR)) || !existsSync(fullPath)) {
          // SPA fallback: serve index.html for unknown routes
          const indexPath = join(UI_DIR, 'index.html');
          if (existsSync(indexPath)) {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(readFileSync(indexPath));
          } else {
            res.writeHead(404);
            res.end('Not found');
          }
          return;
        }

        const ext = extname(fullPath);
        const mime = MIME_TYPES[ext] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': mime });
        res.end(readFileSync(fullPath));
      });

      // WebSocket for live events (requires session token)
      wss = new WebSocketServer({ server: httpServer, path: '/api/events' });
      wss.on('connection', (ws, req) => {
        // Verify session token from query parameter
        const url = new URL(req.url ?? '', `http://${req.headers.host}`);
        const token = url.searchParams.get('token');
        if (!sessionToken || token !== sessionToken) {
          ws.close(4001, 'unauthorized');
          return;
        }
        wsClients.add(ws);
        ws.on('close', () => wsClients.delete(ws));
      });

      await new Promise<void>((resolve) => {
        httpServer.listen(port, '127.0.0.1', () => resolve());
      });
    },

    async stop(): Promise<void> {
      for (const ws of wsClients) ws.close();
      wsClients.clear();
      wss?.close();
      await new Promise<void>((resolve) => {
        httpServer?.close(() => resolve());
      });
    },
  };
}
