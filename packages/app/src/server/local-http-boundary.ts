import type { IncomingMessage } from 'node:http';

const FRONTEND_ORIGINS = new Set([
  'http://127.0.0.1', 'http://localhost',
  'http://localhost:5173', 'http://localhost:3000',
  'http://127.0.0.1:5173', 'http://127.0.0.1:3000',
  'tauri://localhost', 'https://tauri.localhost',
]);

/** Local binding alone does not stop DNS rebinding or cross-origin form requests. */
export function localHttpBoundary(req: IncomingMessage): { allowed: boolean; origin: string } {
  const host = req.headers.host, match = typeof host === 'string' ? /^(localhost|127\.0\.0\.1)(?::([0-9]{1,5}))?$/i.exec(host) : null;
  if (!match || Number(match[2] ?? 80) !== req.socket.localPort) return { allowed: false, origin: '' };
  const origin = req.headers.origin;
  if (origin === undefined) return { allowed: req.headers['sec-fetch-site'] !== 'cross-site', origin: '' };
  const samePortOrigin = [`http://127.0.0.1:${req.socket.localPort}`, `http://localhost:${req.socket.localPort}`];
  const allowed = FRONTEND_ORIGINS.has(origin) || samePortOrigin.includes(origin);
  return { allowed, origin: allowed ? origin : '' };
}
