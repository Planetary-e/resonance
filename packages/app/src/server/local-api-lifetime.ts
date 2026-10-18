import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { performance } from 'node:perf_hooks';
import { LocalJsonBodyError } from './local-json-body.js';
import { localHttpBoundary } from './local-http-boundary.js';

export const LOCAL_API_INPUT_MS = 10000;
export const LOCAL_API_OPERATION_MS = 90000;
export const LOCAL_API_HISTORY_MS = 6 * 60000;
export const LOCAL_API_MAX_ACTIVE = 16;

interface Lifetime {
  signal: AbortSignal;
  admit(milliseconds: number, current?: () => boolean, subscribe?: (changed: () => void) => () => void): void;
  assertCurrent(): void;
  close(): void;
}
const lifetimes = new WeakMap<IncomingMessage, Lifetime>();
export function localApiLifetime(req: IncomingMessage): Lifetime {
  const value = lifetimes.get(req);
  if (!value) throw new Error('Local API lifetime is missing');
  return value;
}

/** Deadlines belong to requests, not shared keep-alive socket activity. A handler
 * that ignores cancellation keeps its slot until it settles. */
export function createLocalApiLifetimes(maximum = LOCAL_API_MAX_ACTIVE, inputMs = LOCAL_API_INPUT_MS) {
  let active = 0;
  const processing = new WeakMap<Socket, number>();
  return {
    isProcessing(socket: Socket) { return (processing.get(socket) ?? 0) > 0; },
    open(req: IncomingMessage, res: ServerResponse): Lifetime | null {
      if (active >= maximum) {
        res.writeHead(503, { 'Content-Type': 'application/json', 'Connection': 'close', 'Cache-Control': 'no-store',
          'Access-Control-Allow-Origin': localHttpBoundary(req).origin, 'Access-Control-Allow-Credentials': 'true', 'Vary': 'Origin' });
        res.end(JSON.stringify({ error: 'Too many active local operations; wait for existing work to finish' })); return null;
      }
      active++;
      const controller = new AbortController();
      let closed = false, admitted = false, check: (() => boolean) | undefined, unsubscribe: (() => void) | undefined;
      let deadline = performance.now() + inputMs;
      const fail = (message: string, status: number) => {
        if (closed || controller.signal.aborted) return;
        controller.abort(new LocalJsonBodyError(message, status));
        if (!res.destroyed && !res.writableEnded) {
          if (!res.headersSent) res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Connection': 'close',
            'Access-Control-Allow-Origin': localHttpBoundary(req).origin, 'Access-Control-Allow-Credentials': 'true', 'Vary': 'Origin' });
          res.end(JSON.stringify({ error: message }));
        }
      };
      let timer = setTimeout(() => fail('Local operation timed out; inspect retained status before retrying', 504), inputMs);
      const inputTimer = setTimeout(() => {
        if (!req.complete) fail('Request body was not received within 10 seconds', 408);
      }, inputMs);
      const disconnect = () => { if (!res.writableEnded) controller.abort(new Error('Local request disconnected')); };
      res.once('close', disconnect);
      const value: Lifetime = {
        signal: controller.signal,
        admit(milliseconds, current, subscribe) {
          value.assertCurrent();
          if (admitted) return; // No retry, traffic or repeated authentication renews a deadline.
          if (!Number.isSafeInteger(milliseconds) || milliseconds < 1 || milliseconds > LOCAL_API_HISTORY_MS) throw new Error('Invalid local operation deadline');
          admitted = true; check = current;
          processing.set(req.socket, (processing.get(req.socket) ?? 0) + 1);
          deadline = performance.now() + milliseconds;
          clearTimeout(timer);
          timer = setTimeout(() => fail('Local operation timed out; inspect retained status before retrying', 504), milliseconds);
          // Header/body deadlines remain independent, including a body sent in tiny chunks.
          req.socket.setTimeout(0);
          if (subscribe) unsubscribe = subscribe(() => {
            if (check && !check()) fail('Desktop session changed; submit a new request after unlocking', 401);
          });
          value.assertCurrent();
        },
        assertCurrent() {
          if (performance.now() >= deadline) fail('Local operation timed out; inspect retained status before retrying', 504);
          if (check && !check()) fail('Desktop session changed; submit a new request after unlocking', 401);
          controller.signal.throwIfAborted();
        },
        close() {
          if (closed) return; closed = true; active--;
          clearTimeout(timer); clearTimeout(inputTimer); unsubscribe?.();
          res.removeListener('close', disconnect); lifetimes.delete(req);
          if (admitted) processing.set(req.socket, (processing.get(req.socket) ?? 1) - 1);
          // Returning a response must not leave an idle keep-alive socket unbounded.
          // Nor may a finished pipelined request shorten its neighbour's deadline.
          if (!req.socket.destroyed && !processing.get(req.socket)) req.socket.setTimeout(inputMs);
        },
      };
      lifetimes.set(req, value); return value;
    },
  };
}
