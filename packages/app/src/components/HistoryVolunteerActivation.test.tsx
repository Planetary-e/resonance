import { expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { HistoryVolunteerActivationReview } from './HistoryVolunteerActivation';
import type { RelayVolunteerActivationReview } from '../api.client';
vi.mock('../api.client', () => ({}));
it('shows retained storage and pinned outbound contacts without promising reachability or automatic startup', () => {
  const plan: RelayVolunteerActivationReview = { kind: 'history-volunteer-activation', contextId: 'context', genesisId: 'genesis', member: 'member', owner: 'owner', authority: 'authority',
    directory: '/retained', output: '/new-config.json', controllers: [{ relayId: 'owner-relay', endpoint: 'wss://owner.example/' }],
    health: { generations: 2, retainedBlocks: 3, reservedBytes: 8388608, maximumGenerationBytes: 67108864, maximumGenerationBlocks: 10001, maximumGenerations: 65 },
    readiness: 'unverified', startsService: false, approvalDigest: 'private-approval' };
  const html = renderToStaticMarkup(<HistoryVolunteerActivationReview plan={plan} busy={true} onApply={() => {}} />);
  for (const value of ['2 retained generations', '3 retained blocks', 'wss://owner.example/', 'cannot enroll a missing genesis', 'keeping the relay paused', 'does not establish live reachability', 'disabled']) expect(html).toContain(value);
  expect(html).not.toContain(plan.approvalDigest);
});
