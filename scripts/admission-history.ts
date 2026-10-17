/** Reviewed history operations. Shared implementation also serves the desktop. */
import { runAdmissionHistoryCommand } from '../packages/relay/src/admission-history-command.js';

const controller = new AbortController();
const cancel = () => { controller.abort(); process.exitCode = 1; };
process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
let stop: (() => Promise<void>) | undefined;
try {
  const [command, ...args] = process.argv.slice(2);
  const operation = await runAdmissionHistoryCommand(command ?? '', args, {
    transportFile: process.env.RESONANCE_HISTORY_OPERATOR_TRANSPORT_FILE, signal: controller.signal,
  });
  stop = operation.stop; console.log(JSON.stringify(operation.result));
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Admission history operation failed');
  console.error('Usage: node --import tsx scripts/admission-history.ts');
  console.error('  Optional pinned outbound transport: RESONANCE_HISTORY_OPERATOR_TRANSPORT_FILE=operator-transport.json');
  console.error('  owner-config owner-private.json authority.pub policy.json members.json owner-config.json');
  console.error('  owner-config-plan owner-private.json authority.pub policy.json members.json owner-config.json [history-id]');
  console.error('  owner-config-create --approve <digest> owner-private.json authority.pub policy.json members.json owner-config.json <history-id>');
  console.error('  owner-setup-plan|owner-setup-apply [--approve <digest>] <new|resume|export> owner-config.json policy.json owner-storage.hex owner-directory enrollment.json');
  console.error('  owner-prepare|owner-export|owner-resume-setup owner-config.json policy.json owner-storage.hex owner-directory enrollment.json');
  console.error('  owner-inspect owner-config.json enrollment.json');
  console.error('  owner-ready owner-config.json policy.json owner-storage.hex owner-directory');
  console.error('  owner-initial-readiness-plan|owner-initial-ready [--approve <digest>] owner-config.json enrollment.json policy.json owner-storage.hex owner-directory');
  console.error('  owner-retirement-plan|owner-retire [--approve <digest>] owner-config.json policy.json owner-storage.hex owner-directory <issuer-key-fingerprint>');
  console.error('  owner-legacy-plan|owner-legacy-recover [--approve <digest>] owner-config.json policy.json owner-storage.hex owner-directory proofs.json');
  console.error('  owner-recovery-plan|owner-recovery-start [--approve <digest>] owner-config.json enrollment.json owner-storage.hex recovery-directory <view>');
  console.error('  owner-recovery-status|owner-recovery-step owner-config.json enrollment.json owner-storage.hex recovery-directory');
  console.error('  owner-recovery-review|owner-recovery-restore [--approve <digest>] owner-config.json enrollment.json owner-storage.hex recovery-directory policy.json new-owner-directory');
  console.error('  owner-recovery-readiness-plan|owner-recovery-ready [--approve <digest>] owner-config.json enrollment.json owner-storage.hex recovery-directory policy.json retained-owner-directory');
  console.error('  replica-plan enrollment.json member-private.json member-storage.hex replica-directory');
  console.error('  replica-enroll --approve <digest> enrollment.json member-private.json member-storage.hex replica-directory');
  console.error('  replica-resume-plan|replica-resume [--approve <digest>] enrollment.json member-private.json member-storage.hex replica-directory');
  console.error('  replica-serve enrollment.json member-private.json member-storage.hex replica-directory <port>');
  process.exitCode = 1;
} finally {
  process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
}
if (stop) {
  const close = stop; let stopping = false;
  const shutdown = async () => {
    if (stopping) return; stopping = true;
    try { await close(); process.exitCode = 0; } catch { process.exitCode = 1; }
  };
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
}
