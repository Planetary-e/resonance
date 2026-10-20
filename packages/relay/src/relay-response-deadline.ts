/** Local acceptance deadlines supplement signed response timestamps. A delayed
 * timer callback must never extend the original caller's response budget. */
export interface RelayResponseDeadline {
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly monotonicExpiresAt: number;
}
export function relayResponseDeadline(request: { createdAt: number; expiresAt: number }, timeoutMs: number,
  began = performance.now()): RelayResponseDeadline {
  return { createdAt: request.createdAt, expiresAt: request.expiresAt, monotonicExpiresAt: began + Math.min(timeoutMs, request.expiresAt - request.createdAt) };
}
export function isRelayResponseLive(deadline: RelayResponseDeadline, now = Date.now()): boolean {
  return now >= deadline.createdAt && now < deadline.expiresAt && performance.now() < deadline.monotonicExpiresAt;
}
