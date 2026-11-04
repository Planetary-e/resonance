#!/usr/bin/env node
import { runPolicyObserverCommand } from './policy-observer-command.js';

const controller = new AbortController();
const stop = () => controller.abort();
process.once('SIGINT', stop); process.once('SIGTERM', stop);
try {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === '--help') {
    process.stdout.write('Usage: npm run policy-observer --workspace @resonance/relay -- <status|ready|serve> <config.json>\n'
      + '       npm run policy-observer --workspace @resonance/relay -- advance <config.json> <signed-advance.json>\n'
      + '       recovery-plan|recovery-start [--approve <digest>] <config.json> <workspace> <available|unavailable> <view>\n'
      + '       recovery-status|recovery-step <config.json> <workspace>\n'
      + '       recovery-review|recovery-restore [--approve <digest>] <config.json> <workspace> <destination>\n'
      + '       recovery-resume-plan|recovery-resume [--approve <digest>] <config.json> <workspace> <restored-directory>\n'
      + '       recovery-export <config.json> <workspace> <restored-directory> <new-config.json>\n'
      + '       setup-plan|setup-create [--approve <digest>] <setup.json> <new-config.json>\n'
      + '       setup-export <setup.json> <new-config.json>\n'
      + '       enrollment-export <config.json> <new-public-enrollment.json>\n'
      + '       initialize-plan|initialize [--approve <digest>] <config.json>\n'
      + '       replica-plan|replica-enroll|replica-resume-plan|replica-resume [--approve <digest>] <enrollment.json> <member-key.json> <storage.key> <directory>\n'
      + '       replica-serve <enrollment.json> <member-key.json> <storage.key> <directory> <port>\n'
      + 'Preparation and enrollment never start an observer. Existing operation requires separate fresh quorum readiness.\n');
  } else {
    const operation = await runPolicyObserverCommand(command, args, controller.signal, { transportFile: process.env.RESONANCE_HISTORY_OPERATOR_TRANSPORT_FILE,
      onHandlerFailure: diagnostic => { process.stderr.write(JSON.stringify({ event: 'policy-observer-handler-failure', ...diagnostic }) + '\n'); } });
    process.stdout.write(JSON.stringify(operation.result) + '\n');
    if (operation.close) {
      if (!controller.signal.aborted) await new Promise<void>(resolve => controller.signal.addEventListener('abort', () => resolve(), { once: true }));
      await operation.close();
    }
  }
} catch (error) { process.stderr.write(`${error instanceof Error ? error.message : 'Policy observer command failed'}\n`); process.exitCode = 1; }
finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
