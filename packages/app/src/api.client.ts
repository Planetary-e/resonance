/**
 * Browser-side API client for the Resonance web UI.
 * Talks to the local HTTP server at the same origin.
 */

const API_BASE = 'http://localhost:3000';

// ============================================================================
// Types
// ============================================================================

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
  epsilon: number;
  status: string;
  createdAt: string;
}

export interface Match {
  id: string;
  itemId: string;
  partnerDID: string;
  similarity: number;
}

export interface Channel {
  id: string;
  matchId: string;
  partnerDID: string;
  state: 'pending' | 'open' | 'accepted' | 'rejected' | 'closed';
  similarity?: number;
  createdAt?: string;
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
    connectedNodes?: number;
    indexedItems?: number;
  } | null;
}

export interface AppEvent {
  type: 'match' | 'channel_ready' | 'confirm_result' | 'disclosure' | 'accept' | 'reject' | 'close';
  [key: string]: unknown;
}

// ============================================================================
// Helpers
// ============================================================================

async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T & { error?: string }> {
  const opts: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body !== undefined) {
    opts.body = JSON.stringify(body);
  }
  try {
    const res = await fetch(API_BASE + path, opts);
    return await res.json();
  } catch (err) {
    return { error: (err as Error).message } as T & { error: string };
  }
}

// ============================================================================
// Session
// ============================================================================

export async function getStatus(): Promise<StatusResponse & { error?: string }> {
  return api<StatusResponse>('GET', '/api/status');
}

export async function initIdentity(password: string): Promise<{ did: string; error?: string }> {
  return api('POST', '/api/init', { password });
}

export async function unlock(password: string): Promise<{ did: string; token?: string; error?: string }> {
  return api('POST', '/api/unlock', { password });
}

export async function lock(): Promise<{ locked: boolean; error?: string }> {
  return api('POST', '/api/lock');
}

// ============================================================================
// Items
// ============================================================================

export async function getItems(): Promise<Item[]> {
  const data = await api<Item[]>('GET', '/api/items');
  if ((data as any).error || !Array.isArray(data)) return [];
  return data;
}

export async function publishItem(
  text: string,
  type: 'need' | 'offer',
  privacy: 'low' | 'medium' | 'high',
): Promise<PublishResult & { error?: string }> {
  return api('POST', '/api/items', { text, type, privacy });
}

export async function withdrawItem(id: string): Promise<{ withdrawn: boolean; error?: string }> {
  return api('DELETE', `/api/items/${id}`);
}

// ============================================================================
// Matches
// ============================================================================

export async function getMatches(): Promise<Match[]> {
  const data = await api<Match[]>('GET', '/api/matches');
  if ((data as any).error || !Array.isArray(data)) return [];
  return data;
}

// ============================================================================
// Search
// ============================================================================

export async function search(
  text: string,
  type: 'need' | 'offer',
): Promise<{ results: SearchResult[]; error?: string }> {
  return api('POST', '/api/search', { text, type });
}

// ============================================================================
// Channels
// ============================================================================

export async function getChannels(): Promise<Channel[]> {
  const data = await api<Channel[]>('GET', '/api/channels');
  if ((data as any).error || !Array.isArray(data)) return [];
  return data;
}

export async function initiateChannel(matchId: string): Promise<{ channelId: string; error?: string }> {
  return api('POST', '/api/channels', { matchId });
}

export async function getChannel(channelId: string): Promise<Channel & { error?: string }> {
  return api<Channel>('GET', `/api/channels/${channelId}`);
}

export async function sendDisclosure(
  channelId: string,
  text: string,
  level: string,
): Promise<{ sent: boolean; error?: string }> {
  return api('POST', `/api/channels/${channelId}/disclose`, { text, level });
}

export async function acceptChannel(
  channelId: string,
  message?: string,
): Promise<{ accepted: boolean; error?: string }> {
  return api('POST', `/api/channels/${channelId}/accept`, { message });
}

export async function rejectChannel(
  channelId: string,
  reason?: string,
): Promise<{ rejected: boolean; error?: string }> {
  return api('POST', `/api/channels/${channelId}/reject`, { reason });
}

export async function closeChannel(channelId: string): Promise<{ closed: boolean; error?: string }> {
  return api('DELETE', `/api/channels/${channelId}`);
}

// ============================================================================
// Relay
// ============================================================================

export async function getRelayStatus(): Promise<RelayStatus & { error?: string }> {
  return api<RelayStatus>('GET', '/api/relay/status');
}

export async function startRelay(port?: number): Promise<{ port: number; error?: string }> {
  return api('POST', '/api/relay/start', port ? { port } : {});
}

export async function stopRelay(): Promise<{ stopped: boolean; error?: string }> {
  return api('POST', '/api/relay/stop');
}

// ============================================================================
// WebSocket Events
// ============================================================================

export function connectEvents(
  token: string,
  onEvent: (event: AppEvent) => void,
  onClose?: () => void,
): WebSocket {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = window.location.host;
  const ws = new WebSocket(`${protocol}//${host}/api/events?token=${token}`);

  ws.onmessage = (e) => {
    try {
      const event = JSON.parse(e.data) as AppEvent;
      onEvent(event);
    } catch {
      // Ignore malformed events
    }
  };

  ws.onclose = () => {
    onClose?.();
  };

  ws.onerror = () => {
    // Will trigger onclose
  };

  return ws;
}
