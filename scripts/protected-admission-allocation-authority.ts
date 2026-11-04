/** Explicit protected allocation-authority command dispatcher. */
import { runProtectedAllocationAuthorityCommand } from '../packages/node/src/admission-allocation-authority-command.js';
const controller = new AbortController(), cancel = () => controller.abort();
process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
try {
  const [command, ...raw] = process.argv.slice(2);
  const { result } = await runProtectedAllocationAuthorityCommand(command, raw, controller.signal, { transportFile: process.env.RESONANCE_HISTORY_OPERATOR_TRANSPORT_FILE });
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Protected allocation authority operation failed');
  console.error('Usage: node --import tsx scripts/protected-admission-allocation-authority.ts <command>');
  console.error('  config --approve owner-private.json authority.pub members.json config.json');
  console.error('  Common arguments: config.json authority.pub authority-private.json owner.json');
  console.error('  init --approve <common> original-enrollment.json');
  console.error('  enrollment <common> new-enrollment.json');
  console.error('  status|ready <common>');
  console.error('  review <common> plan.json');
  console.error('  sign --approve <digest> <common> plan.json signed.json');
  console.error('  reexport <common> epoch signed.json');
  console.error('  assignment-review <common> private-request.json');
  console.error('  assign --approve <digest> <common> private-request.json assignment.json');
  console.error('  assignment-reexport <common> private-request.json assignment.json');
  console.error('  recovery-plan <common> original-enrollment.json workspace available|unavailable view');
  console.error('  recovery-start --approve <digest> <common> original-enrollment.json workspace available|unavailable view');
  console.error('  recovery-status|recovery-step <common> original-enrollment.json workspace');
  console.error('  recovery-review|recovery-resume-plan <common> original-enrollment.json workspace destination-owner.json');
  console.error('  recovery-restore|recovery-resume --approve <digest> <common> original-enrollment.json workspace destination-owner.json');
  console.error('  Writer: <owner.json>.history. Optional pinned transport: RESONANCE_HISTORY_OPERATOR_TRANSPORT_FILE.');
  process.exitCode = 1;
} finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
