/** Private operation-local ownership, never semantic validation or hash trust. */
import { AsyncLocalStorage } from 'node:async_hooks';
interface Scope { active: boolean; owned: WeakSet<object>; retained: number; entries: number; charge(bytes: number): void; check(): void }
const current = new AsyncLocalStorage<Scope>();
export function isOwnedAdmissionReplayValue(value: unknown): boolean {
  const s = current.getStore(); s?.check();
  return !!s?.active && !!value && typeof value === 'object' && s.owned.has(value);
}
export function ownAdmissionReplayValue<T>(value: T): T {
  const s = current.getStore(); if (!s) return value;
  s.check(); if (!s.active) throw new Error('Admission replay value owner released');
  function visit(v: unknown): void {
    if (!v || typeof v !== 'object' || s!.owned.has(v)) return;
    // Count reachable containers, references, keys and string storage conservatively.
    let bytes = 128;
    for (const [key, child] of Object.entries(v)) bytes += 32 + 2 * key.length + (typeof child === 'string' ? 2 * child.length : 16);
    if (++s!.entries > 1000000 || (s!.retained += bytes) > 256 * 1024 * 1024) throw new Error('Admission replay retained values exceed existing capacity');
    s!.owned.add(v); for (const child of Object.values(v)) visit(child); Object.freeze(v);
    if (s!.entries % 128 === 0) s!.check();
  }
  visit(value); return value;
}
/** Read-only parser input snapshot. Only this active owner can elide its copy. */
export function snapshotAdmissionReplayValue<T>(value: T): T {
  if (isOwnedAdmissionReplayValue(value)) return value;
  const s = current.getStore();
  if (s) { s.check(); if (!s.active) throw new Error('Admission replay value owner released'); s.charge(Buffer.byteLength(JSON.stringify(value))); }
  return ownAdmissionReplayValue(structuredClone(value));
}
export async function withAdmissionReplayValues<T>(options: { charge(bytes: number): void; check(): void }, body: () => Promise<T>): Promise<T> {
  const s: Scope = { ...options, active: true, owned: new WeakSet(), retained: 0, entries: 0 };
  try { return await current.run(s, body); }
  finally { s.active = false; s.owned = new WeakSet(); s.retained = 0; s.entries = 0; }
}

export function chargeAdmissionReplayCopy(bytes: number): void { const s = current.getStore(); if (s) { s.check(); if (!s.active) throw new Error('Admission replay value owner released'); s.charge(bytes); } }

/** Preserve mutable-result APIs while accounting for every actual full copy. */
export function copyAdmissionReplayValue<T>(value: T): T { if (current.getStore()) chargeAdmissionReplayCopy(Buffer.byteLength(JSON.stringify(value))); return structuredClone(value); }
