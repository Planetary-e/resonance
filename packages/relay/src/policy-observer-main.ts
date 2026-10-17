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
      + 'Only opens existing protected state. Enrollment and recovery require separate explicit preparation.\n');
  } else {
    const operation = await runPolicyObserverCommand(command, args, controller.signal);
    process.stdout.write(JSON.stringify(operation.result) + '\n');
    if (operation.close) {
      if (!controller.signal.aborted) await new Promise<void>(resolve => controller.signal.addEventListener('abort', () => resolve(), { once: true }));
      await operation.close();
    }
  }
} catch (error) { process.stderr.write(`${error instanceof Error ? error.message : 'Policy observer command failed'}\n`); process.exitCode = 1; }
finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
