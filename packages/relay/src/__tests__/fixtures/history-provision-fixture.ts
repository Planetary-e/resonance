import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { createHistoryContinuationRoot } from '@resonance/core/history-continuation';
import { createHistoryProvisionRequest } from '@resonance/core/history-provision';
import { historyAgreementFixture, AGREEMENT_TEST_TIME } from './history-agreement-fixture.js';

export function historyProvisionFixture(tail: Parameters<typeof historyAgreementFixture>[0] = 'none') {
  const n = historyAgreementFixture(tail), reports = n.promise(1), frames = n.frames('prepare', 1, n.a, reports);
  const prepared = n.certificate(frames.slice(0, 4).map((f, i) => n.roles[i].exchange(f)));
  const certificate = n.certificate(n.frames('confirm', 1, n.a, prepared).slice(0, 4).map((f, i) => n.roles[i].exchange(f)), 'confirmed');
  const root = createHistoryContinuationRoot(n.a, certificate, n.context);
  const request = (i = 0, now = AGREEMENT_TEST_TIME) => createHistoryProvisionRequest({ root, replica: n.context.members[i],
    challenge: randomBytes(32).toString('base64url'), issuedAt: now, expiresAt: now + 30_000 }, n.context, n.owner);
  const provisionOptions = (i = 0) => ({ directory: join(n.directory, `provision-${i}`), context: n.context,
    localKey: n.localKey, signingKey: n.memberKeys[i], parent: n.stores[i], now: () => AGREEMENT_TEST_TIME });
  return { ...n, continuation: root, request, provisionOptions };
}
