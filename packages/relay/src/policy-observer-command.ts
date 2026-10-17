/** Callable local operations for an explicitly configured existing observer. */
import { ADMISSION_POLICY_ADVANCE_MAX_BYTES } from '@resonance/core/admission-policy-advance';
import { readOperatorFile } from './admission-operator-files.js';
import { openConfiguredPolicyObserver, readPolicyObserverConfigurationFile, serveConfiguredPolicyObserver } from './policy-observer-config.js';
import { runPolicyObserverRecoveryCommand } from './policy-observer-recovery-command.js';

export async function runPolicyObserverCommand(command: string, args: readonly string[], signal?: AbortSignal) {
  if (command.startsWith('recovery-')) return { ...await runPolicyObserverRecoveryCommand(command, args, signal), close: undefined };
  if (!['status', 'ready', 'advance', 'serve'].includes(command) || args.length !== (command === 'advance' ? 2 : 1)
    || args.some(arg => typeof arg !== 'string' || !arg.length || arg.startsWith('--'))) throw new Error('Invalid policy observer command');
  if (signal?.aborted) throw new Error('Policy observer command cancelled');
  const config = readPolicyObserverConfigurationFile(args[0]);
  if (command === 'serve') {
    const service = await serveConfiguredPolicyObserver(config, { signal });
    return { result: { result: 'policy-observer-listening', endpoint: service.endpoint, status: service.status() }, close: service.close };
  }
  const observer = await openConfiguredPolicyObserver(config);
  const cancel = () => observer.close(); signal?.addEventListener('abort', cancel, { once: true });
  try {
    if (signal?.aborted) throw new Error('Policy observer command cancelled');
    if (command === 'ready') await observer.ready();
    else if (command === 'advance') {
      const bytes = readOperatorFile(args[1], ADMISSION_POLICY_ADVANCE_MAX_BYTES);
      let value: unknown;
      try { value = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes)); }
      catch { throw new Error('Policy advance must be valid UTF-8 JSON'); }
      finally { bytes.fill(0); }
      await observer.advance(value);
    }
    return { result: { result: `policy-observer-${command}`, status: observer.status(), readiness: command === 'status' ? 'unverified' : 'confirmed' } };
  } finally { signal?.removeEventListener('abort', cancel); observer.close(); }
}
