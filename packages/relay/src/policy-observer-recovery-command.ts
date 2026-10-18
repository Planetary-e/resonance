/** Explicit recovery commands. Configuration export does not start an observer. */
import { resolve, join } from 'node:path';
import { readOperatorSigningKey, readOperatorStorageKey, writeOperatorJsonNew } from './admission-operator-files.js';
import { POLICY_OBSERVER_CONFIGURATION_MAX_BYTES, openConfiguredPolicyObserver, readPolicyObserverConfigurationFile } from './policy-observer-config.js';
import { openPolicyObserverRecovery, preparePolicyObserverRecovery } from './policy-observer-recovery.js';
import { openProtectedPolicyObserver } from './protected-policy-observer.js';
import { createPinnedHistoryOperatorTransport } from './history-operator-transport.js';

export async function runPolicyObserverRecoveryCommand(command: string, raw: readonly string[], signal?: AbortSignal, commandOptions: { transportFile?: string } = {}) {
  const commands = ['recovery-plan', 'recovery-start', 'recovery-status', 'recovery-step', 'recovery-review', 'recovery-restore', 'recovery-export', 'recovery-resume-plan', 'recovery-resume'];
  const applying = command === 'recovery-start' || command === 'recovery-restore' || command === 'recovery-resume';
  const approved = applying && raw[0] === '--approve' ? raw[1] : undefined, args = approved ? raw.slice(2) : raw;
  const planning = command === 'recovery-plan' || command === 'recovery-start';
  const resuming = command === 'recovery-resume-plan' || command === 'recovery-resume';
  const length = planning || command === 'recovery-export' ? 4 : command === 'recovery-review' || command === 'recovery-restore' || resuming ? 3 : 2;
  if (!commands.includes(command) || applying && !approved || args.length !== length
    || args.some(arg => typeof arg !== 'string' || !arg.length || arg.startsWith('--'))) throw new Error('Invalid policy recovery command or missing approval');
  const cancelled = () => { if (signal?.aborted) throw new Error('Policy recovery command cancelled; preserve pending work'); };
  cancelled();
  const config = readPolicyObserverConfigurationFile(args[0]), signingKey = readOperatorSigningKey(config.signingKeyFile);
  let encryptionKey: Buffer | undefined;
  let source: Awaited<ReturnType<typeof openConfiguredPolicyObserver>> | undefined;
  let recovery: Awaited<ReturnType<typeof openPolicyObserverRecovery>> | undefined;
  let restored: Awaited<ReturnType<typeof openProtectedPolicyObserver>> | undefined;
  let resumption: { close(): void } | undefined;
  let transport: ReturnType<typeof createPinnedHistoryOperatorTransport> | undefined;
  const cancel = () => { source?.close(); recovery?.close(); restored?.close(); resumption?.close(); transport?.close(); };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    encryptionKey = readOperatorStorageKey(config.storageKeyFile); cancelled();
    transport = createPinnedHistoryOperatorTransport({ context: config.historyContext }, commandOptions.transportFile, signal);
    // Explicit recovery provisions durable generations and can include cold
    // connections. It is not a personal policy-freshness observation: use the
    // bounded maintenance allowance, without changing observation deadlines.
    const timeoutMs = transport.maintenanceTimeoutMs ?? 30000;
    const options = { directory: resolve(args[1]), context: config.context, historyContext: config.historyContext,
      genesis: config.genesis, members: config.members, signingKey, encryptionKey, timeoutMs, transport: transport.protection.transport,
      agreementTransport: transport.agreementTransport, dataTransport: transport.dataTransport, provisionTransport: transport.provisionTransport };
    if (planning) {
      if (!['available', 'unavailable'].includes(args[2]) || !/^[1-9][0-9]*$/.test(args[3])) throw new Error('Choose an explicit policy source availability and positive view');
      if (args[2] === 'available') source = await openConfiguredPolicyObserver(config, { transport: transport.protection.transport, timeoutMs });
      cancelled();
      const review = await preparePolicyObserverRecovery({ ...options, source: source ? source.reviewRecoverySource() : 'unavailable', view: Number(args[3]), signal });
      cancelled(); if (command === 'recovery-plan') return { result: review };
      recovery = await openPolicyObserverRecovery({ ...options, initialize: { review, approvedDigest: approved! } }); cancelled();
      return { result: { result: 'policy-recovery-created', ...recovery.status() } };
    }
    recovery = await openPolicyObserverRecovery(options); cancelled();
    if (command === 'recovery-status') return { result: recovery.status() };
    if (command === 'recovery-step') return { result: await recovery.advance({ signal }) };
    const destination = resolve(args[2]);
    if (resuming) {
      const handle = await recovery.reviewResumption(destination, { maxArchiveBytes: config.limits.archiveBytes, maxArchiveBlocks: config.limits.archiveBlocks, signal });
      resumption = handle; cancelled();
      return { result: command === 'recovery-resume-plan' ? handle.review() : await handle.apply(approved!) };
    }
    if (command === 'recovery-export') {
      const inspected = await recovery.inspectRestored(destination, signal); cancelled();
      const output = resolve(args[3]);
      writeOperatorJsonNew(output, { ...config, directory: destination, root: inspected.continuation,
        archiveDirectory: join(options.directory, 'download') }, POLICY_OBSERVER_CONFIGURATION_MAX_BYTES);
      return { result: { result: 'policy-restoration-configuration-exported', output, status: inspected.status, readiness: 'unverified', startsService: false } };
    }
    const { preparation, continuation } = await recovery.reviewRestore(destination, signal); cancelled();
    if (command === 'recovery-review') return { result: preparation.review };
    restored = await openProtectedPolicyObserver({ directory: destination, encryptionKey, signingKey, context: config.context,
      historyContext: config.historyContext, genesis: config.genesis, root: continuation, members: config.members, mode: 'create-new',
      maxArchiveBlocks: config.limits.archiveBlocks, maxArchiveBytes: config.limits.archiveBytes,
      restore: { preparation, approvedDigest: approved! } }); cancelled();
    return { result: { result: 'policy-history-restored', directory: destination, status: restored.status(), readiness: 'unverified', startsService: false } };
  } catch (error) { throw transport ? transport.failure(error) : error; }
  finally { signal?.removeEventListener('abort', cancel); cancel(); encryptionKey?.fill(0); signingKey.secretKey.fill(0); }
}
