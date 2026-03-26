/**
 * REST API route handlers for the web UI.
 */

import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  getSession,
  isUnlocked,
  isInitialized,
  initSession,
  unlockSession,
  lockSession,
  publishItem,
  searchRelay,
  initiateChannel,
} from './session.js';

type Req = IncomingMessage;
type Res = ServerResponse;

const ALLOWED_ORIGIN = 'http://127.0.0.1';
const MAX_BODY_SIZE = 1024 * 1024; // 1 MiB

// Session token for WebSocket authentication (set on unlock)
export let sessionToken: string | null = null;

function json(res: Res, data: unknown, status = 200): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  });
  res.end(JSON.stringify(data));
}

function error(res: Res, message: string, status = 400): void {
  json(res, { error: message }, status);
}

async function readBody(req: Req): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        req.destroy();
        reject(new Error('Body too large'));
        return;
      }
      body += chunk.toString();
    });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); } catch { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

function requireSession(res: Res): boolean {
  if (!isUnlocked()) {
    error(res, 'Session locked. POST /api/unlock first.', 401);
    return false;
  }
  return true;
}

export async function handleApi(req: Req, res: Res, relayUrl: string): Promise<boolean> {
  const url = req.url ?? '';
  const method = req.method ?? 'GET';

  // CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return true;
  }

  // --- Session ---

  if (url === '/api/status' && method === 'GET') {
    const initialized = isInitialized();
    const unlocked = isUnlocked();
    const s = getSession();
    json(res, {
      initialized,
      unlocked,
      did: s?.identity.did ?? null,
      relayConnected: s?.relayClient.isConnected() ?? false,
      items: s ? s.store.listItems().length : 0,
      matches: s ? s.store.listMatches().length : 0,
    });
    return true;
  }

  if (url === '/api/init' && method === 'POST') {
    if (isInitialized()) { error(res, 'Already initialized'); return true; }
    const body = await readBody(req);
    const password = body.password as string;
    if (!password) { error(res, 'Password required'); return true; }
    try {
      const result = await initSession(password);
      json(res, result);
    } catch (err) {
      error(res, 'Internal error', 500);
    }
    return true;
  }

  if (url === '/api/unlock' && method === 'POST') {
    if (!isInitialized()) { error(res, 'Not initialized. POST /api/init first.'); return true; }
    const body = await readBody(req);
    const password = body.password as string;
    if (!password) { error(res, 'Password required'); return true; }
    try {
      const result = await unlockSession(password, relayUrl);
      sessionToken = randomBytes(32).toString('hex');
      json(res, { ...result, token: sessionToken });
    } catch (err) {
      error(res, 'Wrong password or corrupted identity', 401);
    }
    return true;
  }

  if (url === '/api/lock' && method === 'POST') {
    lockSession();
    json(res, { locked: true });
    return true;
  }

  // --- Items ---

  if (url === '/api/items' && method === 'GET') {
    if (!requireSession(res)) return true;
    const items = getSession()!.store.listItems();
    json(res, items.map(i => ({
      id: i.id, type: i.type, rawText: i.rawText, privacyLevel: i.privacyLevel,
      epsilon: i.epsilon, status: i.status, createdAt: i.createdAt,
    })));
    return true;
  }

  if (url === '/api/items' && method === 'POST') {
    if (!requireSession(res)) return true;
    const body = await readBody(req);
    const text = body.text as string;
    const type = (body.type ?? 'need') as string;
    const privacy = (body.privacy ?? 'medium') as string;
    if (!text) { error(res, 'Text required'); return true; }
    if (!['need', 'offer'].includes(type)) { error(res, 'Type must be need or offer'); return true; }
    if (!['low', 'medium', 'high'].includes(privacy)) { error(res, 'Privacy must be low, medium, or high'); return true; }
    try {
      const result = await publishItem(text, type as any, privacy as any);
      json(res, result);
    } catch (err) {
      error(res, 'Internal error', 500);
    }
    return true;
  }

  if (url.startsWith('/api/items/') && method === 'DELETE') {
    if (!requireSession(res)) return true;
    const id = url.slice('/api/items/'.length);
    const s = getSession()!;
    s.store.updateItemStatus(id, 'withdrawn');
    if (s.relayClient.isConnected()) {
      try { await s.relayClient.withdraw({ itemId: id }); } catch { /* ignore */ }
    }
    json(res, { withdrawn: true });
    return true;
  }

  // --- Matches ---

  if (url === '/api/matches' && method === 'GET') {
    if (!requireSession(res)) return true;
    const matches = getSession()!.store.listMatches();
    json(res, matches);
    return true;
  }

  // --- Search ---

  if (url === '/api/search' && method === 'POST') {
    if (!requireSession(res)) return true;
    const body = await readBody(req);
    const text = body.text as string;
    const type = (body.type ?? 'need') as string;
    if (!text) { error(res, 'Text required'); return true; }
    try {
      const results = await searchRelay(text, type as any);
      json(res, { results });
    } catch (err) {
      error(res, 'Internal error', 500);
    }
    return true;
  }

  // --- Channels ---

  if (url === '/api/channels' && method === 'GET') {
    if (!requireSession(res)) return true;
    const channels = getSession()!.channelMgr.listChannels();
    json(res, channels);
    return true;
  }

  if (url === '/api/channels' && method === 'POST') {
    if (!requireSession(res)) return true;
    const body = await readBody(req);
    const matchId = body.matchId as string;
    if (!matchId) { error(res, 'matchId required'); return true; }
    try {
      const result = await initiateChannel(matchId);
      json(res, result);
    } catch (err) {
      error(res, 'Internal error', 500);
    }
    return true;
  }

  // Channel actions: /api/channels/:id/disclose, /accept, /reject, /close
  const channelMatch = url.match(/^\/api\/channels\/([^/]+)\/(\w+)$/);
  if (channelMatch && method === 'POST') {
    if (!requireSession(res)) return true;
    const [, channelId, action] = channelMatch;
    const s = getSession()!;
    const body = await readBody(req);

    try {
      switch (action) {
        case 'disclose':
          await s.channelMgr.sendDisclosure(channelId, body.text as string, body.level as any);
          json(res, { sent: true });
          break;
        case 'accept':
          await s.channelMgr.sendAccept(channelId, body.message as string | undefined);
          json(res, { accepted: true });
          break;
        case 'reject':
          await s.channelMgr.sendReject(channelId, body.reason as string | undefined);
          json(res, { rejected: true });
          break;
        default:
          error(res, 'Unknown action', 404);
      }
    } catch (err) {
      error(res, 'Internal error', 500);
    }
    return true;
  }

  if (url.match(/^\/api\/channels\/[^/]+$/) && method === 'DELETE') {
    if (!requireSession(res)) return true;
    const channelId = url.slice('/api/channels/'.length);
    try {
      await getSession()!.channelMgr.sendClose(channelId);
      json(res, { closed: true });
    } catch (err) {
      error(res, 'Internal error', 500);
    }
    return true;
  }

  if (url.match(/^\/api\/channels\/[^/]+$/) && method === 'GET') {
    if (!requireSession(res)) return true;
    const channelId = url.slice('/api/channels/'.length);
    const channel = getSession()!.channelMgr.getChannel(channelId);
    if (!channel) { error(res, 'Channel not found', 404); return true; }
    json(res, channel);
    return true;
  }

  return false; // Not an API route
}
