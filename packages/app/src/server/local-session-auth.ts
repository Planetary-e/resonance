import { randomBytes, timingSafeEqual } from 'node:crypto';

export let sessionToken: string | null = null;
const listeners = new Set<() => void>();
function changed() { for (const listener of listeners) { try { listener(); } catch { /* Every event also checks its current token. */ } } }
export function issueSessionToken(): string {
  sessionToken = randomBytes(32).toString('hex'); changed(); return sessionToken;
}
export function revokeSessionToken(): void { sessionToken = null; changed(); }
export function matchesSessionToken(value: unknown): boolean {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) && !!sessionToken
    && timingSafeEqual(Buffer.from(value, 'hex'), Buffer.from(sessionToken, 'hex'));
}
export function onSessionTokenChange(listener: () => void): () => void {
  listeners.add(listener); return () => { listeners.delete(listener); };
}
