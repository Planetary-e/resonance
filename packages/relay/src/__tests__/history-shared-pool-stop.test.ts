/** Contract regressions for the rejected v2 candidate; original red manifest/logs remain retained.
 * Repair assertions preserve original acknowledged heads, safe early refusal and exact idempotent retry. */
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, writeSync, renameSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { historyCheckpointEnvelopeId, sealHistoryCheckpoint, createHistoryFreeze } from '@resonance/core/history-checkpoint';
import { historyContinuationRootId } from '@resonance/core/history-continuation';
import { createHistoryAgreementRequest, parseHistoryAgreementFrame, type HistoryAgreementFrame } from '@resonance/core/history-agreement';
import { createHistoryAgreementDataFrame, parseHistoryAgreementDataFrame } from '@resonance/core/history-agreement-data';
import { openSharedHistoryPool, type SharedHistoryPool } from '../history-shared-pool.js';
import { openHistoryCheckpointStore } from '../history-checkpoint-store.js';
import { openHistoryGenerationProvisioner } from '../history-generation-provisioner.js';
import { historyCheckpointFixture } from './fixtures/history-checkpoint-fixture.js';
import { historyProvisionFixture } from './fixtures/history-provision-fixture.js';
import { historyAgreementFixture, AGREEMENT_TEST_TIME } from './fixtures/history-agreement-fixture.js';
import { createHistoryAgreementReplica } from '../history-checkpoint-agreement.js';
vi.mock('node:fs', async original => { const fs = await original<typeof import('node:fs')>(); return { ...fs, writeSync: vi.fn(fs.writeSync), renameSync: vi.fn(fs.renameSync) }; });
const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');
const cleanup: Array<() => void> = [];
afterEach(() => { vi.mocked(writeSync).mockReset().mockImplementation(actualFs.writeSync); vi.mocked(renameSync).mockReset().mockImplementation(actualFs.renameSync); cleanup.splice(0).reverse().forEach(close => close()); });
function retainedFixture(tail: Parameters<typeof historyProvisionFixture>[0] = 'none') {
  const n = historyProvisionFixture(tail);
  // Retain the generated encrypted evidence directories; close every owner and replica.
  cleanup.push(() => { n.roles.forEach(r => r.close()); n.stores.forEach(s => s.close()); });
  return n;
}
function enrolled(n: ReturnType<typeof historyProvisionFixture>, directory: string, maxBytes?: number, maxBlocks?: number) {
  const poolOptions = { directory, localKey: n.localKey, context: n.context, replica: n.context.members[0], genesisId: n.options.rootId, maxBytes, maxBlocks };
  const pool = openSharedHistoryPool({ ...poolOptions, initialize: true }); cleanup.push(pool.close);
  const parentOptions = { directory: pool.directory, localKey: n.localKey, context: n.context, replica: n.context.members[0], generation: 0, rootId: n.options.rootId, sharedPool: pool };
  const parent = openHistoryCheckpointStore({ ...parentOptions, initialize: n.root }); cleanup.push(parent.close);
  for (const block of n.preparation.envelopes.slice(1)) parent.append(block);
  parent.freeze(n.stores[0].describe().freeze!);
  const provisionOptions = { directory: pool.directory, localKey: n.localKey, context: n.context, signingKey: n.memberKeys[0], parent, sharedPool: pool, now: () => 10000 };
  const provision = openHistoryGenerationProvisioner({ ...provisionOptions, initialize: true }); cleanup.push(provision.close);
  return { pool, poolOptions, parent, parentOptions, provision, provisionOptions };
}
it('preflights the entire child publication including its empty successor journal before committing ready', () => {
  const n = retainedFixture(), calibration = enrolled(n, join(n.directory, 'funded-complete-publication'));
  calibration.provision.provision(n.request());
  expect(calibration.provision.read().phase).toBe('ready');
  const child = calibration.provision.child()!;
  const successor = openHistoryGenerationProvisioner({ ...calibration.provisionOptions, parent: child }); cleanup.push(successor.close);
  expect(successor.read().phase).toBe('empty'); successor.close();
  const readyBytes = calibration.pool.usage().bytes, limit = readyBytes + calibration.pool.usage().controlPeakBytes;
  expect(calibration.pool.heldMutation()).toBeNull();
  calibration.provision.close(); calibration.parent.close(); calibration.pool.close();
  const actual = enrolled(n, join(n.directory, 'insufficient-whole-publication-capacity'), limit);
  const before = actual.parent.describe(), beforeBytes = actual.pool.usage().bytes;
  expect(() => actual.provision.provision(n.request())).toThrow('capacity');
  expect(actual.parent.activatedContinuation()).toBeNull(); expect(actual.parent.describe()).toEqual(before);
  expect(actual.provision.read().phase).toBe('empty'); expect(actual.pool.usage().bytes).toBe(beforeBytes);
  actual.provision.close(); actual.parent.close(); actual.pool.close();
  const pool = openSharedHistoryPool(actual.poolOptions); cleanup.push(pool.close);
  const parent = openHistoryCheckpointStore({ ...actual.parentOptions, sharedPool: pool }); cleanup.push(parent.close);
  const provision = openHistoryGenerationProvisioner({ ...actual.provisionOptions, parent, sharedPool: pool }); cleanup.push(provision.close);
  expect(provision.read().phase).toBe('empty'); expect(parent.activatedContinuation()).toBeNull();
  expect(() => provision.provision(n.request())).toThrow('capacity'); expect(parent.describe()).toEqual(before);
  writeFileSync('/tmp/resonance-pool-repair-publication.json', JSON.stringify({ directory: n.directory, limit, readyBytes, originalHead: before, durablePhase: provision.read().phase, publicationSafelyRefused: true }, null, 2));
});
it('retries the exact unacknowledged ciphertext after interruption between pool catalog and store manifest', () => {
  const n = historyCheckpointFixture(), directory = mkdtempSync(join(tmpdir(), 'pool-stop-orphan-'));
  const options = { directory, localKey: n.localKey, context: n.context, replica: n.context.members[0], genesisId: n.options.rootId };
  let pool = openSharedHistoryPool({ ...options, initialize: true }); cleanup.push(() => pool.close());
  let interrupt = false; const open = pool.openRecord;
  pool.openRecord = ((spec: any) => { const record = open(spec);
    if (spec.kind === 'manifest') { const write = record.write; record.write = ((value: unknown) => { if (interrupt) { interrupt = false; throw new Error('controlled interruption before store manifest'); } write(value); }) as typeof record.write; }
    return record;
  }) as typeof pool.openRecord;
  const storeOptions = { directory: pool.directory, localKey: n.localKey, context: n.context, replica: n.context.members[0], rootId: n.options.rootId, generation: 0 };
  let store = openHistoryCheckpointStore({ ...storeOptions, sharedPool: pool, initialize: n.root }); cleanup.push(() => store.close());
  const original = store.describe(), block = n.next(n.root), blockId = historyCheckpointEnvelopeId(block); interrupt = true;
  expect(() => store.append(block)).toThrow('controlled interruption'); store.close(); pool.close();
  const errors: Array<string | null> = []; let afterRetry: ReturnType<typeof pool.usage> | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    pool = openSharedHistoryPool(options); store = openHistoryCheckpointStore({ ...storeOptions, sharedPool: pool });
    if (attempt === 0) expect(store.describe()).toEqual(original);
    else expect(store.describe()).toMatchObject({ sequence: 1, envelopeId: blockId });
    expect(pool.hasBlock(blockId)).toBe(true);
    if (attempt === 0) {
      expect(() => store.freeze(createHistoryFreeze(n.context, 0, 1, Buffer.alloc(32, 5).toString('base64url'), n.owner))).toThrow('held append target');
      expect(store.describe()).toEqual(original);
    }
    try { store.append(block); errors.push(null); } catch (error) { errors.push((error as Error).message); }
    expect(pool.usage().blocks).toBe(2);
    if (afterRetry) expect(pool.usage().bytes).toBe(afterRetry.bytes); else afterRetry = pool.usage();
    store.close(); pool.close();
  }
  writeFileSync('/tmp/resonance-pool-repair-orphan.json', JSON.stringify({ directory, originalHead: original, unacknowledgedCiphertext: blockId, errors }, null, 2));
  expect(errors).toEqual([null, null]); // Exact retries commit once and remain idempotent after reopen.
});
it('preserves the aggregate future-checkpoint slot before acknowledging a delta in the fourth block slot', () => {
  const n = retainedFixture('missing'), actual = enrolled(n, join(n.directory, 'aggregate-checkpoint-slot'), undefined, 4);
  actual.provision.provision(n.request()); const child = actual.provision.child()!, original = child.describe();
  expect(actual.pool.usage().blocks).toBe(3); // Two accepted ancestor blocks plus the continuation root.
  const delta = sealHistoryCheckpoint({ context: n.context, header: { kind: 'delta', generation: 1, sequence: 1,
    previous: historyContinuationRootId(n.continuation), checkpointReserveBytes: 4096 }, plaintext: Buffer.from('retained delta needing a future full checkpoint'), encryptionKey: n.key, signingKey: n.owner });
  let accepted = false, refusal: string | null = null;
  try { child.append(delta); accepted = true; } catch (error) { refusal = (error as Error).message; }
  const after = child.describe();
  const checkpoint = sealHistoryCheckpoint({ context: n.context, header: { kind: 'checkpoint', generation: 1, sequence: 2, previous: historyCheckpointEnvelopeId(delta) }, plaintext: Buffer.from('the obligated checkpoint'), encryptionKey: n.key, signingKey: n.owner });
  let future: string | null = null; try { child.append(checkpoint); } catch (error) { future = (error as Error).message; }
  writeFileSync('/tmp/resonance-pool-repair-checkpoint.json', JSON.stringify({ directory: n.directory, originalHead: original, accepted, refusal, acknowledgedHead: after, retainedBlocks: actual.pool.usage().blocks, futureCheckpointRefusal: future }, null, 2));
  expect(accepted).toBe(false); expect(after).toEqual(original); // Refuse before acknowledgement while preserving the original head.
});

it('retains the whole-publication hold after SIGKILL before activation and accepts a fresh request for the same continuation', async () => {
  const { fork } = await import('node:child_process'), { once } = await import('node:events');
  const n = retainedFixture(), actual = enrolled(n, join(n.directory, 'early-publication-hold'));
  const before = actual.parent.describe(); actual.provision.close(); actual.parent.close(); actual.pool.close();
  const child = fork(new URL('./fixtures/history-original-pool-crash.ts', import.meta.url), [], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const exited = once(child, 'exit'); cleanup.push(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  await once(child, 'message');
  child.send({ options: actual.poolOptions, localKey: n.localKey.toString('hex'), member: { publicKey: Buffer.from(n.memberKeys[0].publicKey).toString('hex'), secretKey: Buffer.from(n.memberKeys[0].secretKey).toString('hex') }, request: n.request(), boundary: 'after-hold' });
  await exited; expect(child.signalCode).toBe('SIGKILL');
  const pool = openSharedHistoryPool(actual.poolOptions); cleanup.push(pool.close);
  expect(pool.heldMutation()).toMatchObject({ kind: 'publication', rootId: n.options.rootId, childRootId: historyContinuationRootId(n.continuation) });
  const held = pool.usage(); expect(held.heldBytes).toBeGreaterThan(0); expect(held.heldBlocks).toBe(1);
  const parent = openHistoryCheckpointStore({ ...actual.parentOptions, sharedPool: pool }); cleanup.push(parent.close);
  expect(parent.describe()).toEqual(before); expect(parent.activatedContinuation()).toBeNull();
  expect(() => pool.writeBlock(n.next(n.root))).toThrow('held shared ciphertext');
  expect(() => pool.openRecord({ rootId: `sha256:${'b'.repeat(64)}`, generation: 4, kind: 'manifest', initial: {}, initialize: true, maxBytes: 65536, validate: (v): v is object => !!v && typeof v === 'object' })).toThrow('unrelated writes');
  expect(pool.usage().bytes).toBe(held.bytes); expect(pool.usage().heldBytes).toBe(held.heldBytes);
  const provision = openHistoryGenerationProvisioner({ ...actual.provisionOptions, parent, sharedPool: pool }); cleanup.push(provision.close);
  const fresh = n.request(); provision.provision(fresh); expect(provision.read().phase).toBe('ready'); expect(pool.heldMutation()).toBeNull();
  const successor = openHistoryGenerationProvisioner({ ...actual.provisionOptions, parent: provision.child()!, sharedPool: pool }); cleanup.push(successor.close);
  expect(successor.read().phase).toBe('empty');
}, 30000);

it('keeps a checkpoint slot and its metadata funded across reopen and fulfills it without double charging', () => {
  const n = retainedFixture('missing'), actual = enrolled(n, join(n.directory, 'checkpoint-promise-reopen'), 20 * 1024 * 1024, 5);
  actual.provision.provision(n.request());
  const delta = sealHistoryCheckpoint({ context: n.context, header: { kind: 'delta', generation: 1, sequence: 1, previous: historyContinuationRootId(n.continuation), checkpointReserveBytes: 4096 }, plaintext: Buffer.from('delta with retained checkpoint promise'), encryptionKey: n.key, signingKey: n.owner });
  actual.provision.child()!.append(delta); expect(actual.pool.usage()).toMatchObject({ blocks: 4, heldBlocks: 1 });
  const held = actual.pool.usage().heldBytes; expect(held).toBeGreaterThan(4096);
  actual.provision.close(); actual.parent.close(); actual.pool.close();
  const pool = openSharedHistoryPool(actual.poolOptions); cleanup.push(pool.close); expect(pool.usage().heldBytes).toBe(held);
  const parent = openHistoryCheckpointStore({ ...actual.parentOptions, sharedPool: pool }); cleanup.push(parent.close);
  const provision = openHistoryGenerationProvisioner({ ...actual.provisionOptions, parent, sharedPool: pool }); cleanup.push(provision.close);
  const child = provision.child()!, before = child.describe();
  const other = sealHistoryCheckpoint({ context: n.context, header: { kind: 'checkpoint', generation: 1, sequence: 2, previous: historyCheckpointEnvelopeId(delta) }, plaintext: Buffer.from('an unrelated candidate'), encryptionKey: n.key, signingKey: n.owner });
  expect(() => pool.writeBlock(other)).toThrow('capacity'); expect(child.describe()).toEqual(before);
  const checkpoint = sealHistoryCheckpoint({ context: n.context, header: { kind: 'checkpoint', generation: 1, sequence: 2, previous: historyCheckpointEnvelopeId(delta) }, plaintext: Buffer.from('the obligated full checkpoint'), encryptionKey: n.key, signingKey: n.owner });
  expect(child.append(checkpoint)).toBe(historyCheckpointEnvelopeId(checkpoint));
  expect(pool.usage()).toMatchObject({ blocks: 5, heldBlocks: 0, heldBytes: 0 });
  expect(child.append(checkpoint)).toBe(historyCheckpointEnvelopeId(checkpoint)); expect(pool.usage().blocks).toBe(5);
});

it('refuses a delta when ciphertext fits but aggregate checkpoint publication metadata cannot fit', () => {
  const n = retainedFixture(), actual = enrolled(n, join(n.directory, 'checkpoint-metadata-capacity'));
  actual.provision.provision(n.request()); const before = actual.provision.child()!.describe(), usage = actual.pool.usage();
  actual.provision.close(); actual.parent.close(); actual.pool.close();
  const pool = openSharedHistoryPool({ ...actual.poolOptions, maxBytes: usage.bytes + usage.controlPeakBytes + 8192 }); cleanup.push(pool.close);
  const parent = openHistoryCheckpointStore({ ...actual.parentOptions, sharedPool: pool }); cleanup.push(parent.close);
  const provision = openHistoryGenerationProvisioner({ ...actual.provisionOptions, parent, sharedPool: pool }); cleanup.push(provision.close);
  const delta = sealHistoryCheckpoint({ context: n.context, header: { kind: 'delta', generation: 1, sequence: 1, previous: historyContinuationRootId(n.continuation), checkpointReserveBytes: 4096 }, plaintext: Buffer.from('this ciphertext and4096 bytes fit without metadata'), encryptionKey: n.key, signingKey: n.owner });
  expect(Buffer.byteLength(JSON.stringify(delta)) + 4096).toBeLessThan(8192);
  expect(() => provision.child()!.append(delta)).toThrow('capacity'); expect(provision.child()!.describe()).toEqual(before);
  expect(pool.usage().bytes).toBe(usage.bytes); expect(pool.usage().heldBytes).toBe(0);
});

it('cancels a provably unstarted append hold after reopen without requiring the lost caller payload', () => {
  const n = historyCheckpointFixture(), directory = mkdtempSync(join(tmpdir(), 'pool-early-append-'));
  const options = { directory, localKey: n.localKey, context: n.context, replica: n.context.members[0], genesisId: n.options.rootId };
  let pool = openSharedHistoryPool({ ...options, initialize: true }); cleanup.push(() => pool.close());
  const storeOptions = { directory: pool.directory, localKey: n.localKey, context: n.context, replica: n.context.members[0], rootId: n.options.rootId, generation: 0 };
  let store = openHistoryCheckpointStore({ ...storeOptions, sharedPool: pool, initialize: n.root }); cleanup.push(() => store.close());
  const original = store.describe(), omitted = n.next(n.root); const prepare = pool.prepareAppend;
  pool.prepareAppend = (...args) => { prepare(...args); throw new Error('interrupted immediately after durable append hold'); };
  expect(() => store.append(omitted)).toThrow('immediately after durable'); expect(pool.heldMutation()?.kind).toBe('append');
  store.close(); pool.close(); pool = openSharedHistoryPool(options); expect(pool.heldMutation()).toBeNull();
  store = openHistoryCheckpointStore({ ...storeOptions, sharedPool: pool }); expect(store.describe()).toEqual(original);
  const fresh = n.next(n.root); expect(store.append(fresh)).toBe(historyCheckpointEnvelopeId(fresh)); expect(pool.usage().blocks).toBe(2);
});

it.each(['partial', 'catalog'])('resumes exact append metadata after %s interruption without accumulating retry output', boundary => {
  const n = historyCheckpointFixture(), directory = mkdtempSync(join(tmpdir(), 'pool-append-metadata-'));
  const options = { directory, localKey: n.localKey, context: n.context, replica: n.context.members[0], genesisId: n.options.rootId };
  let pool = openSharedHistoryPool({ ...options, initialize: true }); cleanup.push(() => pool.close());
  const storeOptions = { directory: pool.directory, localKey: n.localKey, context: n.context, replica: n.context.members[0], rootId: n.options.rootId, generation: 0 };
  let store = openHistoryCheckpointStore({ ...storeOptions, sharedPool: pool, initialize: n.root }); cleanup.push(() => store.close());
  const before = store.describe(), block = n.next(n.root); let fault = true, metadata = 0;
  if (boundary === 'partial') vi.mocked(writeSync).mockImplementation(((fd: number, bytes: Uint8Array, ...args: unknown[]) => {
    if (fault && Buffer.from(bytes).subarray(0, 12).toString() === '{"version":2') { fault = false; actualFs.writeSync(fd, bytes, 0, 17, 0); throw new Error('controlled partial metadata'); }
    return (actualFs.writeSync as any)(fd, bytes, ...args);
  }) as unknown as typeof writeSync);
  else vi.mocked(renameSync).mockImplementation(((source: string, target: string) => {
    if (target.endsWith('.object')) metadata++;
    if (fault && metadata >= 2 && target.endsWith('history-original-pool-v2.json')) { fault = false; throw new Error('controlled metadata catalog failure'); }
    actualFs.renameSync(source, target);
  }) as typeof renameSync);
  expect(() => store.append(block)).toThrow(/controlled/); store.close(); pool.close();
  vi.mocked(writeSync).mockImplementation(actualFs.writeSync); vi.mocked(renameSync).mockImplementation(actualFs.renameSync);
  pool = openSharedHistoryPool(options); store = openHistoryCheckpointStore({ ...storeOptions, sharedPool: pool });
  expect(store.describe()).toEqual(before); expect(pool.heldMutation()?.kind).toBe('append');
  expect(store.append(block)).toBe(historyCheckpointEnvelopeId(block)); expect(pool.usage().blocks).toBe(2);
  const complete = pool.usage(); expect(readdirSync(directory).filter(name => name.endsWith('.pending'))).toEqual([]);
  expect(store.append(block)).toBe(historyCheckpointEnvelopeId(block)); expect(pool.usage().bytes).toBe(complete.bytes);
  store.close(); pool.close(); pool = openSharedHistoryPool(options); store = openHistoryCheckpointStore({ ...storeOptions, sharedPool: pool });
  expect(store.describe()).toMatchObject({ sequence: 1, envelopeId: historyCheckpointEnvelopeId(block) }); expect(pool.heldMutation()).toBeNull(); expect(pool.usage().bytes).toBe(complete.bytes);
});


// Selected-transfer stop1 regressions retained from the rejected candidate.
function selectedTransferStopFixture(interruptManifest = false, length = 3) {
  const n = historyAgreementFixture('sparse', length);
  cleanup.push(() => { n.roles.forEach(role => role.close()); n.stores.forEach(store => store.close()); });
  const freeze = n.stores[4].describe().freeze!;
  n.roles[4].close(); n.stores[4].close();
  const poolOptions = { directory: join(n.directory, 'selected-pool'), localKey: n.localKey,
    context: n.context, replica: n.context.members[4], genesisId: n.options.rootId };
  let pool = openSharedHistoryPool({ ...poolOptions, initialize: true }); cleanup.push(() => pool.close());
  let interrupt = false;
  if (interruptManifest) {
    const open = pool.openRecord;
    pool.openRecord = ((spec: any) => {
      const record = open(spec);
      if (spec.kind === 'manifest') {
        const write = record.write;
        record.write = ((value: unknown) => {
          if (interrupt) { interrupt = false; throw new Error('selected transfer interrupted before staging manifest'); }
          write(value);
        }) as typeof record.write;
      }
      return record;
    }) as typeof pool.openRecord;
  }
  const storeOptions = { ...n.options, replica: n.context.members[4], directory: pool.directory };
  n.stores[4] = openHistoryCheckpointStore({ ...storeOptions, sharedPool: pool, initialize: n.root });
  n.stores[4].freeze(freeze);
  let now = AGREEMENT_TEST_TIME;
  n.roles[4] = createHistoryAgreementReplica({ context: n.context, store: n.stores[4], signingKey: n.memberKeys[4], now: () => now });
  const reports = n.promise(1, [0, 1, 2, 4]), authorization = n.frames('prepare', 1, n.a, reports)[4];
  const frame = (sequence: number, auth = authorization) => createHistoryAgreementDataFrame({ action: 'stage', authorization: auth,
    sequence, envelopeId: historyCheckpointEnvelopeId(n.blocks[sequence]), envelope: n.blocks[sequence] }, n.context, n.owner);
  const reopen = () => {
    n.roles[4].close(); n.stores[4].close(); pool.close();
    pool = openSharedHistoryPool(poolOptions);
    n.stores[4] = openHistoryCheckpointStore({ ...storeOptions, sharedPool: pool });
    n.roles[4] = createHistoryAgreementReplica({ context: n.context, store: n.stores[4], signingKey: n.memberKeys[4], now: () => now });
  };
  return { n, authorization, frame, reopen, pool: () => pool, interrupt: () => { interrupt = true; }, time: (value: number) => { now = value; } };
}

it('selected-transfer stop1 installs the final descending predecessor into the accepted index', () => {
  const f = selectedTransferStopFixture(), { n } = f, original = n.stores[4].describe();
  expect(n.roles[4].transfer(f.frame(3)).pending?.sequence).toBe(2);
  expect(n.roles[4].transfer(f.frame(2)).pending?.sequence).toBe(1);
  expect(n.stores[4].read().envelopes).toEqual([n.root]);
  const usage = f.pool().usage(); let refusal: string | null = null;
  try { n.roles[4].transfer(f.frame(1)); } catch (error) { refusal = (error as Error).message; }
  f.reopen();
  if (refusal) {
    expect(n.stores[4].describe()).toEqual(original); expect(f.pool().usage().blocks).toBe(usage.blocks);
  }
  expect(n.stores[4].agreementState()!.prepared).toBeNull();
  writeFileSync('/tmp/resonance-pool-selected-repair-predecessor.json', JSON.stringify({ directory: n.directory,
    selectedSequence: n.a.sequence, descendingStaged: [3, 2], originalHead: original, reopenedHead: n.stores[4].describe(),
    finalPredecessor: historyCheckpointEnvelopeId(n.blocks[1]), refusal, retainedUsage: f.pool().usage() }, null, 2));
  expect(refusal).toBeNull(); // A valid final predecessor must complete the selected chain.
  expect(n.stores[4].read().envelopes).toEqual(n.blocks);
});

it.each(['ciphertext', 'partial', 'catalog'])('selected-transfer stop1 retries with fresh equivalent authorization after %s interruption and expiry', boundary => {
  const f = selectedTransferStopFixture(boundary === 'ciphertext'), { n } = f, original = n.stores[4].describe(), originalFrame = f.frame(3);
  parseHistoryAgreementDataFrame(originalFrame, n.context, AGREEMENT_TEST_TIME);
  let fault = true, metadata = 0;
  if (boundary === 'ciphertext') f.interrupt();
  else if (boundary === 'partial') vi.mocked(writeSync).mockImplementation(((fd: number, bytes: Uint8Array, ...args: unknown[]) => {
    if (fault && Buffer.from(bytes).subarray(0, 12).toString() === '{"version":2') {
      fault = false; actualFs.writeSync(fd, bytes, 0, 17, 0); throw new Error('selected transfer interrupted during metadata');
    }
    return (actualFs.writeSync as any)(fd, bytes, ...args);
  }) as unknown as typeof writeSync);
  else vi.mocked(renameSync).mockImplementation(((source: string, target: string) => {
    if (target.endsWith('.object')) metadata++;
    if (fault && metadata >= 2 && target.endsWith('history-original-pool-v2.json')) {
      fault = false; throw new Error('selected transfer interrupted before metadata catalog');
    }
    actualFs.renameSync(source, target);
  }) as typeof renameSync);
  expect(() => n.roles[4].transfer(originalFrame)).toThrow('selected transfer interrupted');
  vi.mocked(writeSync).mockImplementation(actualFs.writeSync); vi.mocked(renameSync).mockImplementation(actualFs.renameSync);
  f.reopen();
  expect(n.stores[4].describe()).toEqual(original); expect(n.stores[4].read().envelopes).toEqual([n.root]);
  expect(f.pool().hasBlock(historyCheckpointEnvelopeId(n.blocks[3]))).toBe(true);
  expect(f.pool().heldMutation()).toMatchObject({ kind: 'append', blockId: historyCheckpointEnvelopeId(n.blocks[3]) });
  const usage = f.pool().usage(), held = f.pool().heldMutation()!, output = readdirSync(f.pool().directory), now = AGREEMENT_TEST_TIME + 30_001; f.time(now);
  expect(held.transferAuthorization).toEqual(f.authorization);
  if (boundary !== 'ciphertext') expect(held.stage).not.toBeNull();
  expect(() => n.roles[4].transfer(originalFrame)).toThrow('expired');
  const request = f.authorization.request, fresh = renewSelectedAuthorization(f.authorization, now, n);
  const freshFrame = f.frame(3, fresh);
  expect(parseHistoryAgreementDataFrame(freshFrame, n.context, now).envelopeId).toBe(originalFrame.envelopeId);
  expect(fresh.proposal).toEqual(f.authorization.proposal); expect(fresh.viewCertificate).toEqual(f.authorization.viewCertificate);
  let refusal: string | null = null;
  try { n.roles[4].transfer(freshFrame); } catch (error) { refusal = (error as Error).message; }
  f.reopen();
  expect(n.stores[4].describe()).toEqual(original); expect(n.stores[4].agreementState()!.prepared).toBeNull();
  if (refusal) { expect(f.pool().usage()).toEqual(usage); expect(f.pool().heldMutation()?.kind).toBe('append'); }
  else { expect(f.pool().usage().blocks).toBe(usage.blocks); expect(f.pool().heldMutation()).toBeNull(); }
  if (!refusal) {
    const afterOutput = readdirSync(f.pool().directory);
    for (const name of output.filter(name => name.endsWith('.object'))) expect(afterOutput).toContain(name);
    expect(afterOutput.filter(name => name.endsWith('.pending'))).toEqual([]);
    expect(f.pool().usage().objects).toBe(held.baseObjects + 2);
    if (boundary === 'catalog') expect(afterOutput).toEqual(output);
  }
  writeFileSync(`/tmp/resonance-pool-selected-repair-expiry-${boundary}.json`, JSON.stringify({ directory: n.directory, originalHead: original,
    reopenedHead: n.stores[4].describe(), blockId: originalFrame.envelopeId, oldExpiresAt: request.expiresAt,
    freshIssuedAt: now, freshFrameValidated: true, sameProposal: true, refusal, retainedUsage: f.pool().usage(), hold: f.pool().heldMutation() }, null, 2));
  expect(refusal).toBeNull(); // Fresh authenticated retry must publish the original missing reference.
  expect(n.roles[4].transfer(f.frame(3, fresh)).pending?.sequence).toBe(2);
  expect(n.roles[4].transfer(f.frame(2, fresh)).pending?.sequence).toBe(1);
  expect(n.roles[4].transfer(f.frame(1, fresh)).pending).toBeNull();
  f.reopen(); expect(n.stores[4].read().envelopes).toEqual(n.blocks); expect(f.pool().heldMutation()).toBeNull();
});

function renewSelectedAuthorization(auth: HistoryAgreementFrame, now: number, n: ReturnType<typeof historyAgreementFixture>,
  changes: Partial<HistoryAgreementFrame['request']> = {}): HistoryAgreementFrame {
  const request = auth.request;
  return { ...auth, request: createHistoryAgreementRequest({ action: request.action, rootId: request.rootId,
    generation: request.generation, nextGeneration: request.nextGeneration, replica: request.replica, view: request.view,
    proposalId: request.proposalId, evidenceId: request.evidenceId, challenge: Buffer.alloc(32, 9).toString('base64url'),
    issuedAt: now, expiresAt: now + 30_000, ...changes }, n.context, n.owner) };
}

it('selected-transfer renewal rejects changed pins, selection, target and view without consuming the retained hold', () => {
  const f = selectedTransferStopFixture(true), { n } = f, now = AGREEMENT_TEST_TIME + 30_001;
  f.interrupt(); expect(() => n.roles[4].transfer(f.frame(3))).toThrow('selected transfer interrupted');
  f.reopen(); f.time(now);
  const before = f.pool().usage(), held = f.pool().heldMutation(), original = n.stores[4].describe();
  const fresh = renewSelectedAuthorization(f.authorization, now, n);
  const otherProposal = renewSelectedAuthorization(n.frames('prepare', 1, n.b, f.authorization.viewCertificate)[4], now, n);
  const otherReplica = renewSelectedAuthorization(f.authorization, now, n, { replica: n.context.members[0] });
  const reports = n.promise(2, [0, 1, 2, 3]);
  const otherView = renewSelectedAuthorization(n.frames('prepare', 2, n.a, reports)[4], now, n);
  for (const auth of [otherProposal, otherReplica, otherView]) {
    parseHistoryAgreementFrame(auth, n.context, now); // Every alternative is validly signed and proved.
    expect(() => f.pool().retainedTransferAuthorization(n.options.rootId, n.blocks[3], auth, now)).toThrow('Wrong held transfer authorization');
    expect(() => n.roles[4].transfer(f.frame(3, auth))).toThrow();
  }
  parseHistoryAgreementDataFrame(f.frame(2, fresh), n.context, now);
  expect(() => f.pool().retainedTransferAuthorization(n.options.rootId, n.blocks[2], fresh, now)).toThrow('Wrong held transfer operation');
  expect(() => n.roles[4].transfer(f.frame(2, fresh))).toThrow('selected head');
  expect(() => f.pool().retainedTransferAuthorization(historyCheckpointEnvelopeId(n.blocks[1]), n.blocks[3], fresh, now)).toThrow('Wrong held transfer operation');
  expect(() => f.pool().retainedTransferAuthorization(n.options.rootId, n.blocks[3], f.authorization, now)).toThrow('expired');
  expect(f.pool().heldMutation()).toEqual(held); expect(f.pool().usage()).toEqual(before); expect(n.stores[4].describe()).toEqual(original);
  expect(n.roles[4].transfer(f.frame(3, fresh)).pending?.sequence).toBe(2);
  expect(f.pool().heldMutation()).toBeNull(); expect(f.pool().usage().blocks).toBe(before.blocks);
});


it('retains exact selected authorization when an interrupted final commit has no staging transfer', () => {
  const f = selectedTransferStopFixture(true, 1), { n } = f, original = n.stores[4].describe(), now = AGREEMENT_TEST_TIME + 30_001;
  f.interrupt(); expect(() => n.roles[4].transfer(f.frame(1))).toThrow('selected transfer interrupted');
  f.reopen(); f.time(now);
  const hold = f.pool().heldMutation(), usage = f.pool().usage(); expect(hold!.transferAuthorization).toEqual(f.authorization);
  const otherProposal = renewSelectedAuthorization(n.frames('prepare', 1, n.b, f.authorization.viewCertificate)[4], now, n);
  parseHistoryAgreementDataFrame(f.frame(1, otherProposal), n.context, now);
  expect(() => n.roles[4].transfer(f.frame(1, otherProposal))).toThrow('Wrong held transfer authorization');
  expect(n.stores[4].describe()).toEqual(original); expect(f.pool().heldMutation()).toEqual(hold); expect(f.pool().usage()).toEqual(usage);
  const fresh = renewSelectedAuthorization(f.authorization, now, n);
  expect(n.roles[4].transfer(f.frame(1, fresh)).pending).toBeNull(); expect(f.pool().heldMutation()).toBeNull();
  expect(f.pool().usage().blocks).toBe(usage.blocks);
  f.reopen(); expect(n.stores[4].read().envelopes).toEqual(n.blocks);
});
