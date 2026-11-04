import { openSelectedRelayStorageOwner } from './selected-relay-storage.js';
import { runAdmissionHistoryCommand, type AdmissionHistoryCommandOptions } from './admission-history-command.js';

/** Retain selected storage ownership until deferred volunteer service shutdown. */
export async function runSelectedAdmissionHistoryCommand(file: string, command: string, args: readonly string[], options: AdmissionHistoryCommandOptions = {}) {
  options.signal?.throwIfAborted();
  options = { ...options }; const selectedArgs = [...args];
  const owner = await openSelectedRelayStorageOwner(file, { purpose: 'maintenance', signal: options.signal });
  try {
    const outcome = await owner.run(() => runAdmissionHistoryCommand(command, selectedArgs, options));
    if (!outcome.stop) { owner.close(); return outcome; }
    const stop = outcome.stop;
    let stopped: Promise<void> | undefined;
    return { result: outcome.result, stop() {
      return stopped ??= (async () => { try { await owner.run(stop); } finally { owner.close(); } })();
    } };
  } catch (error) { owner.close(); throw error; }
}
