/**
 * WebSocket client for connecting a personal node to a relay server.
 */

import WebSocket from 'ws';
import {
  MessageTypes,
  createMessage,
  serializeMessage,
  parseMessage,
  verifyMessage,
  type Identity,
  type Message,
  type AckPayload,
  type PublishPayload,
  type SearchPayload,
  type SearchResultsPayload,
  type ConsentPayload,
  type WithdrawPayload,
  type MatchPayload,
  type ConsentForwardPayload,
  type ChannelMessagePayload,
  type ChannelForwardPayload,
} from '@resonance/core';

export interface RelayClientConfig {
  relayUrl: string;
  identity: Identity;
  /** Additional relay URLs to try if primary fails. */
  fallbackUrls?: string[];
  /** Enable auto-reconnect with exponential backoff. */
  autoReconnect?: boolean;
}

export interface RelayClientEvents {
  onMatch?: (payload: MatchPayload) => void;
  onConsentForward?: (payload: ConsentForwardPayload) => void;
  onChannelForward?: (payload: ChannelForwardPayload) => void;
  onDisconnect?: (reason: string) => void;
  onReconnect?: () => void;
}

export interface RelayClient {
  connect(): Promise<void>;
  disconnect(): void;
  publish(payload: PublishPayload): Promise<AckPayload>;
  search(payload: SearchPayload): Promise<SearchResultsPayload>;
  sendConsent(payload: ConsentPayload): Promise<AckPayload>;
  sendChannelMessage(payload: ChannelMessagePayload): void;
  withdraw(payload: WithdrawPayload): Promise<AckPayload>;
  isConnected(): boolean;
  on(events: Partial<RelayClientEvents>): void;
}

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (err: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export function createRelayClient(config: RelayClientConfig): RelayClient {
  let ws: WebSocket | null = null;
  let connected = false;
  let intentionalDisconnect = false;
  let reconnectDelay = 1000;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let currentUrl = config.relayUrl;
  const allUrls = [config.relayUrl, ...(config.fallbackUrls ?? [])];
  let urlIndex = 0;
  const events: Partial<RelayClientEvents> = {};
  const pending = new Map<string, PendingRequest>();
  let pendingSearchResolve: ((value: SearchResultsPayload) => void) | null = null;

  function scheduleReconnect(): void {
    if (!config.autoReconnect || intentionalDisconnect) return;
    reconnectTimer = setTimeout(async () => {
      // Try next URL in list
      urlIndex = (urlIndex + 1) % allUrls.length;
      currentUrl = allUrls[urlIndex];
      try {
        await doConnect(currentUrl);
        reconnectDelay = 1000; // Reset on success
        events.onReconnect?.();
      } catch {
        reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
        scheduleReconnect();
      }
    }, reconnectDelay);
  }

  function send<T>(type: string, payload: T): void {
    if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error('Not connected');
    const msg = createMessage(type, payload, config.identity);
    ws.send(serializeMessage(msg));
  }

  function waitForAck(ref: string, timeoutMs = 10_000): Promise<AckPayload> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(ref);
        reject(new Error(`Timeout waiting for ACK: ${ref}`));
      }, timeoutMs);
      pending.set(ref, { resolve, reject, timeout });
    });
  }

  function handleMessage(data: Buffer): void {
    let msg: Message;
    try {
      msg = parseMessage(data.toString('utf-8'));
    } catch {
      return;
    }

    switch (msg.type) {
      case MessageTypes.ACK: {
        const ack = msg.payload as AckPayload;
        const req = pending.get(ack.ref);
        if (req) {
          clearTimeout(req.timeout);
          pending.delete(ack.ref);
          req.resolve(ack);
        }
        break;
      }
      case MessageTypes.MATCH:
        events.onMatch?.(msg.payload as MatchPayload);
        break;
      case MessageTypes.CONSENT_FORWARD:
        events.onConsentForward?.(msg.payload as ConsentForwardPayload);
        break;
      case MessageTypes.CHANNEL_FORWARD:
        events.onChannelForward?.(msg.payload as ChannelForwardPayload);
        break;
      case MessageTypes.SEARCH_RESULTS:
        if (pendingSearchResolve) {
          pendingSearchResolve(msg.payload as SearchResultsPayload);
          pendingSearchResolve = null;
        }
        break;
    }
  }

  function doConnect(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      ws = new WebSocket(url);

      ws.on('open', () => {
        send(MessageTypes.AUTH, {});
      });

      ws.on('message', (data: Buffer) => {
        let msg: Message;
        try { msg = parseMessage(data.toString('utf-8')); } catch { return; }

        if (msg.type === MessageTypes.ACK && (msg.payload as AckPayload).ref === 'auth') {
          const ack = msg.payload as AckPayload;
          if (ack.status === 'ok') {
            connected = true;
            intentionalDisconnect = false;
            ws!.removeAllListeners('message');
            ws!.on('message', handleMessage);
            resolve();
          } else {
            reject(new Error(`Auth failed: ${ack.message}`));
          }
          return;
        }
      });

      ws.on('close', (code, reason) => {
        connected = false;
        events.onDisconnect?.(reason.toString() || `code:${code}`);
        scheduleReconnect();
      });

      ws.on('error', (err) => {
        if (!connected) reject(err);
      });

      setTimeout(() => {
        if (!connected) reject(new Error('Connection timeout'));
      }, 10_000);
    });
  }

  return {
    async connect(): Promise<void> {
      intentionalDisconnect = false;
      // Try all URLs in order
      for (let i = 0; i < allUrls.length; i++) {
        try {
          currentUrl = allUrls[i];
          await doConnect(currentUrl);
          urlIndex = i;
          return;
        } catch {
          // Try next
        }
      }
      throw new Error('All relay URLs failed');
    },

    disconnect(): void {
      intentionalDisconnect = true;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      if (ws) {
        ws.close();
        ws = null;
        connected = false;
      }
    },

    async publish(payload: PublishPayload): Promise<AckPayload> {
      send(MessageTypes.PUBLISH, payload);
      return waitForAck(payload.itemId);
    },

    search(payload: SearchPayload): Promise<SearchResultsPayload> {
      return new Promise((resolve, reject) => {
        pendingSearchResolve = resolve;
        send(MessageTypes.SEARCH, payload);
        // Also wait for the ACK
        waitForAck('search').catch(() => {});
        setTimeout(() => {
          if (pendingSearchResolve) {
            pendingSearchResolve = null;
            reject(new Error('Search timeout'));
          }
        }, 10_000);
      });
    },

    async sendConsent(payload: ConsentPayload): Promise<AckPayload> {
      send(MessageTypes.CONSENT, payload);
      return waitForAck(payload.matchId);
    },

    sendChannelMessage(payload: ChannelMessagePayload): void {
      send(MessageTypes.CHANNEL_MESSAGE, payload);
    },

    async withdraw(payload: WithdrawPayload): Promise<AckPayload> {
      send(MessageTypes.WITHDRAW, payload);
      return waitForAck(payload.itemId);
    },

    isConnected(): boolean {
      return connected;
    },

    on(newEvents: Partial<RelayClientEvents>): void {
      Object.assign(events, newEvents);
    },
  };
}
