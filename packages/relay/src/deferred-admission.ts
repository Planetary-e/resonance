/** A transport may listen while admission state is opening, without accepting a
 * credential, queuing user work or reviving admission after shutdown. */
import type { AdmissionCapabilityVerifierV2 } from './admission.js';
import type { AdmissionWitness } from './admission-witness.js';

type ReadyVerifier = AdmissionCapabilityVerifierV2 & { close(): void; witness?: AdmissionWitness };
export function createDeferredAdmission() {
  let target: ReadyVerifier | undefined, closed = false;
  function current() {
    if (closed || !target) throw new Error('Protected admission is not ready');
    return target;
  }
  const verifier: AdmissionCapabilityVerifierV2 = {
    isReady: () => !closed && target !== undefined,
    verifyAndSpend(capability, context) { return current().verifyAndSpend(capability, context); },
  };
  const witness: AdmissionWitness = {
    vote(request, acceptNew) {
      const role = current().witness;
      if (!role) throw new Error('Protected admission witness is not configured');
      return role.vote(request, acceptNew);
    },
    close,
  };
  function close() {
    if (closed) return; closed = true; const active = target; target = undefined; active?.close();
  }
  return { verifier, witness, close,
    install(ready: ReadyVerifier) {
      if (closed || target) {
        if (target !== ready) ready.close();
        throw new Error('Admission activation is closed or already complete');
      }
      if (ready.isReady?.() === false) { ready.close(); throw new Error('Admission activation requires ready state'); }
      target = ready;
    },
  };
}
