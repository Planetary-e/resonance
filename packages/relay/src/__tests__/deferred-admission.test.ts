import { expect, it, vi } from 'vitest';
import { createDeferredAdmission } from '../deferred-admission.js';
import type { AdmissionCapabilityVerifierV2 } from '../admission.js';
import type { AdmissionWitness } from '../admission-witness.js';

it('does not spend or vote before readiness and closes a late activation after shutdown', async () => {
  const gate = createDeferredAdmission(), verifyAndSpend = vi.fn(() => ({ status: 'accepted' as const }));
  const vote = vi.fn(), close = vi.fn();
  const args = [{}, {}] as Parameters<AdmissionCapabilityVerifierV2['verifyAndSpend']>;
  expect(gate.verifier.isReady!()).toBe(false);
  expect(() => gate.verifier.verifyAndSpend(...args)).toThrow('not ready');
  expect(() => gate.witness.vote({} as Parameters<AdmissionWitness['vote']>[0])).toThrow('not ready');
  expect(verifyAndSpend).not.toHaveBeenCalled(); expect(vote).not.toHaveBeenCalled();
  const ready = { verifyAndSpend, witness: { vote, close: vi.fn() }, close };
  gate.install(ready); expect(gate.verifier.isReady!()).toBe(true);
  expect(await gate.verifier.verifyAndSpend(...args)).toEqual({ status: 'accepted' });
  gate.witness.vote({} as Parameters<AdmissionWitness['vote']>[0]); expect(vote).toHaveBeenCalledOnce();
  expect(() => gate.install(ready)).toThrow('already complete'); expect(close).not.toHaveBeenCalled();
  const rejectedClose = vi.fn();
  expect(() => gate.install({ verifyAndSpend, close: rejectedClose })).toThrow('already complete'); expect(rejectedClose).toHaveBeenCalledOnce();
  gate.close(); gate.witness.close(); expect(close).toHaveBeenCalledOnce(); expect(gate.verifier.isReady!()).toBe(false);
  expect(() => gate.verifier.verifyAndSpend(...args)).toThrow('not ready');
  const lateClose = vi.fn(); expect(() => gate.install({ verifyAndSpend, close: lateClose })).toThrow('closed');
  expect(lateClose).toHaveBeenCalledOnce(); expect(verifyAndSpend).toHaveBeenCalledOnce();
});

it('refuses an unready target and does not expose an unconfigured witness', () => {
  const gate = createDeferredAdmission(), close = vi.fn(), verifyAndSpend = vi.fn();
  expect(() => gate.install({ isReady: () => false, verifyAndSpend, close })).toThrow('requires ready');
  expect(close).toHaveBeenCalledOnce(); expect(gate.verifier.isReady!()).toBe(false);
  gate.install({ verifyAndSpend, close });
  expect(() => gate.witness.vote({} as Parameters<AdmissionWitness['vote']>[0])).toThrow('not configured'); gate.close();
});
