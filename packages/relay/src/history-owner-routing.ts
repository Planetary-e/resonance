/** One bounded router can serve several owner histories only when the exact
 * member-to-infrastructure mapping agrees. Never union independent quorums. */
import type { HistoryRelayMemberRoute } from './history-relay-bridge.js';

export function shareHistoryOwnerRoutes(...roles: Array<readonly HistoryRelayMemberRoute[] | undefined>): HistoryRelayMemberRoute[] | undefined {
  const configured = roles.filter((role): role is readonly HistoryRelayMemberRoute[] => role !== undefined);
  if (!configured.length) return undefined;
  const canonical = (role: readonly HistoryRelayMemberRoute[]) => JSON.stringify(role.map(member =>
    [member.publicKey, member.relayId, member.viaRelayId ?? null]).sort((a, b) => a[0]!.localeCompare(b[0]!)));
  const expected = canonical(configured[0]);
  if (configured.some(role => canonical(role) !== expected)) throw new Error('Co-hosted history owners require identical pinned relay routes');
  return configured[0].map(member => ({ ...member }));
}
