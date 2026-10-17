import { expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { HistoryActivationReview } from './HistoryActivation.js';
import type { AdmissionHistoryActivationReview } from '../api.client.js';
vi.mock('../api.client', () => ({}));

it('shows retained evidence and consequences before approval without claiming current quorum or starting a service', () => {
  const plan: AdmissionHistoryActivationReview = { version: 1, kind: 'protected-owner-activation', runtimeDirectory: '/runtime', historyDirectory: '/recovered-history',
    contextId: 'sha256:' + 'a'.repeat(64), genesisId: 'sha256:' + 'b'.repeat(64), owner: 'owner', authority: 'authority', generation: 2, sequence: 4,
    headId: 'sha256:' + 'c'.repeat(64), policyDigest: 'd'.repeat(64), policyRevision: 3, previousPolicyDigest: null, previousContextId: null,
    policyAction: 'create', spends: 4, permanentDenials: 2, intentDigest: null, readiness: 'unverified', startsService: false,
    initializesWitnessState: false, approvalDigest: 'sha256:' + 'e'.repeat(64) };
  const render = (busy = false) => renderToStaticMarkup(<HistoryActivationReview plan={plan} busy={busy} onApply={() => {}} onCancel={() => {}} />);
  const html = render();
  for (const text of ['/recovered-history', '4 retained spends', '2 permanent denials', 'generation 2', 'Review is offline', 'require four current durable copies',
    'leaves the relay paused', 'does not initialize those roles', 'Approve and configure owner', 'Cancel review']) expect(html).toContain(text);
  expect(html).not.toContain(plan.approvalDigest); expect(html).not.toContain(plan.headId);
  expect(render(true).match(/disabled=""/g)).toHaveLength(2);
});
