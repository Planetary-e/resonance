/**
 * Resonance — Client-side API module.
 * Typed fetch wrappers for the local HTTP server and WebSocket event stream.
 */

const API_BASE = 'http://localhost:3000';

// ---------------------------------------------------------------------------
// Response Types
// ---------------------------------------------------------------------------

export interface StatusResponse {
  initialized: boolean;
  unlocked: boolean;
  did: string | null;
  relayConnected: boolean;
  relayMode: boolean;
  items: number;
  matches: number;
}

export interface Item {
  id: string;
  type: 'need' | 'offer';
  rawText: string;
  privacyLevel: 'low' | 'medium' | 'high';
  epsilon: number | null;
  status: 'local' | 'published' | 'withdrawn';
  createdAt: string;
}

export interface Match {
  id: string;
  itemId: string;
  partnerDID: string;
  similarity: number;
  relayId: string | null;
  status: 'pending' | 'consented' | 'confirmed' | 'rejected' | 'expired';
  createdAt: string;
}

export interface Channel {
  id: string;
  matchId: string;
  partnerDID: string;
  state: 'pending' | 'handshaking' | 'confirming' | 'active' | 'closed';
  similarity: number | null;
  confirmed: boolean | null;
}

export interface SearchResult {
  did: string;
  similarity: number;
  itemType: string;
}

export interface PublishResult {
  id: string;
  status: string;
  dims: number;
}

export interface RelayStatus {
  enabled: boolean;
  port: number | null;
  stats: {
    indexed_embeddings: number;
    connected_nodes: number;
    matches_today: number;
    uptime: number;
  } | null;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function request<T>(
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<T | null> {
  try {
    const opts: RequestInit = {
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    if (body !== undefined) {
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(`${API_BASE}${path}`, opts);
    if (!res.ok) return null;
    const text = await res.text();
    if (!text) return null;
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

async function requestVoid(
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<void> {
  try {
    const opts: RequestInit = {
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    if (body !== undefined) {
      opts.body = JSON.stringify(body);
    }
    await fetch(`${API_BASE}${path}`, opts);
  } catch {
    // swallow — caller does not need to know
  }
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export async function getStatus(): Promise<StatusResponse> {
  const data = await request<StatusResponse>('GET', '/api/status');
  return data ?? {
    initialized: false,
    unlocked: false,
    did: null,
    relayConnected: false,
    relayMode: false,
    items: 0,
    matches: 0,
  };
}

export async function initIdentity(
  password: string,
): Promise<{ did: string } | null> {
  return request<{ did: string }>('POST', '/api/init', { password });
}

export async function unlock(
  password: string,
): Promise<{ did: string; token: string } | null> {
  return request<{ did: string; token: string }>('POST', '/api/unlock', {
    password,
  });
}

export async function lock(): Promise<void> {
  await requestVoid('POST', '/api/lock');
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

export async function getItems(): Promise<Item[]> {
  const data = await request<Item[]>('GET', '/api/items');
  return data ?? [];
}

export async function publishItem(
  text: string,
  type: 'need' | 'offer',
  privacy: 'low' | 'medium' | 'high',
): Promise<PublishResult | null> {
  return request<PublishResult>('POST', '/api/items', { text, type, privacy });
}

export async function withdrawItem(id: string): Promise<void> {
  await requestVoid('DELETE', `/api/items/${encodeURIComponent(id)}`);
}

// ---------------------------------------------------------------------------
// Matches
// ---------------------------------------------------------------------------

export async function getMatches(): Promise<Match[]> {
  const data = await request<Match[]>('GET', '/api/matches');
  return data ?? [];
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export async function search(
  text: string,
  type: 'need' | 'offer',
): Promise<{ results: SearchResult[] }> {
  const data = await request<{ results: SearchResult[] }>('POST', '/api/search', {
    text,
    type,
  });
  return data ?? { results: [] };
}

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

export async function getChannels(): Promise<Channel[]> {
  const data = await request<Channel[]>('GET', '/api/channels');
  return data ?? [];
}

export async function initiateChannel(
  matchId: string,
): Promise<{ channelId: string } | null> {
  return request<{ channelId: string }>('POST', '/api/channels', { matchId });
}

export async function getChannel(id: string): Promise<Channel | null> {
  return request<Channel>('GET', `/api/channels/${encodeURIComponent(id)}`);
}

export async function sendDisclosure(
  channelId: string,
  text: string,
  level: 'category' | 'detail' | 'contact',
): Promise<void> {
  await requestVoid(
    'POST',
    `/api/channels/${encodeURIComponent(channelId)}/disclose`,
    { text, level },
  );
}

export async function acceptChannel(
  channelId: string,
  message?: string,
): Promise<void> {
  await requestVoid(
    'POST',
    `/api/channels/${encodeURIComponent(channelId)}/accept`,
    message !== undefined ? { message } : {},
  );
}

export async function rejectChannel(
  channelId: string,
  reason?: string,
): Promise<void> {
  await requestVoid(
    'POST',
    `/api/channels/${encodeURIComponent(channelId)}/reject`,
    reason !== undefined ? { reason } : {},
  );
}

export async function closeChannel(channelId: string): Promise<void> {
  await requestVoid(
    'DELETE',
    `/api/channels/${encodeURIComponent(channelId)}`,
  );
}

// ---------------------------------------------------------------------------
// Relay
// ---------------------------------------------------------------------------

export async function getRelayStatus(): Promise<RelayStatus> {
  const data = await request<RelayStatus>('GET', '/api/relay/status');
  return data ?? { enabled: false, port: null, stats: null };
}

export async function startRelay(
  port?: number,
): Promise<{ port: number } | null> {
  return request<{ port: number }>(
    'POST',
    '/api/relay/start',
    port !== undefined ? { port } : {},
  );
}

export async function stopRelay(): Promise<void> {
  await requestVoid('POST', '/api/relay/stop');
}

// ---------------------------------------------------------------------------
// WebSocket — live events
// ---------------------------------------------------------------------------

export type EventType =
  | 'match'
  | 'channel_ready'
  | 'confirm_result'
  | 'disclosure'
  | 'accept'
  | 'reject'
  | 'close';

export interface AppEvent {
  type: EventType;
  [key: string]: any;
}

/**
 * Connect to the server's WebSocket event stream.
 * Automatically reconnects on unexpected close (with exponential back-off
 * capped at 10 s). Returns the initial WebSocket instance; reconnected
 * sockets are created internally.
 */
export function connectEvents(
  token: string,
  onEvent: (event: AppEvent) => void,
): WebSocket {
  let attempt = 0;
  let closed = false;
  let ws: WebSocket;

  function connect(): WebSocket {
    const url = `ws://localhost:3000/api/events?token=${encodeURIComponent(token)}`;
    const socket = new WebSocket(url);

    socket.addEventListener('open', () => {
      attempt = 0;
    });

    socket.addEventListener('message', (e) => {
      try {
        const event: AppEvent = JSON.parse(
          typeof e.data === 'string' ? e.data : '',
        );
        onEvent(event);
      } catch {
        // ignore malformed events
      }
    });

    socket.addEventListener('close', () => {
      if (closed) return;
      const delay = Math.min(1000 * 2 ** attempt, 10_000);
      attempt++;
      setTimeout(() => {
        if (!closed) {
          ws = connect();
        }
      }, delay);
    });

    socket.addEventListener('error', () => {
      // The close handler will take care of reconnecting
    });

    return socket;
  }

  ws = connect();

  // Expose the initial socket. Callers can call ws.close() to permanently
  // tear down the connection (the `closed` flag prevents reconnect).
  const original = ws;
  const origClose = original.close.bind(original);
  (original as any).close = () => {
    closed = true;
    origClose();
  };

  return original;
}
