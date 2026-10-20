import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { historyCheckpointContextId } from '@resonance/core/history-checkpoint';
import { parseHistoryExchangeResponse } from '@resonance/core/history-exchange';
import { openConfiguredHistoryVolunteerCollection, parseHistoryVolunteerCollection, readHistoryVolunteerCollectionFile, historyCollectionContext } from '../history-volunteer-collection.js';
import { readRelayHistoryHealth } from '../history-health.js';
import { historyVolunteerCollectionFixture } from './fixtures/history-volunteer-collection-fixture.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const fixture = () => historyVolunteerCollectionFixture(close => cleanup.push(close));

describe('enrolled collection', () => {
  let prepared: Awaited<ReturnType<typeof fixture>>;
  // Preparing five signed, flushed histories is maintenance, not a protocol
  // deadline. Keep setup outside each test's five-second assertion allowance.
  beforeEach(async () => { prepared = await fixture(); }, 30_000);

  it('opens five independent enrolled policy histories through one bounded router and exposes aggregate counts only', async () => {
    const n = prepared, role = openConfiguredHistoryVolunteerCollection(readHistoryVolunteerCollectionFile(n.paths[0])); cleanup.push(role.close);
    for (let i = 0; i < n.roots.length; i++) {
      const request = n.request(i), reply = role.handle('checkpoint', { request, envelope: null });
      expect(parseHistoryExchangeResponse(reply, request, n.roots[i].context).head).toMatchObject({ rootId: n.configs[0].histories[i].genesisId, sequence: 0 });
    }
    const health = role.health(); expect(health).toMatchObject({ histories: 5, retainedBlocks: 5, generations: 5, maximumGenerations: 40, maximumGenerationBlocks: 5000 });
    expect(role.router.health()).toMatchObject({ operations: 0, bufferBytes: 0 });
    const report = readRelayHistoryHealth({ ownerConfigured: false, volunteer: role.health, transport: () => role.router.health() });
    expect(report.volunteer).toMatchObject({ usage: { histories: 5 } });
    for (const h of n.roots) { expect(JSON.stringify(report)).not.toContain(historyCheckpointContextId(h.context)); expect(JSON.stringify(report)).not.toContain(h.context.owner); }
    role.close(); expect(() => role.handle('checkpoint', { request: n.request(0), envelope: null })).toThrow('closed');
  });

  it('refuses cross-history selector changes, unknown contexts, unsupported operations and oversized frames without altering any history', async () => {
    const n = prepared, role = openConfiguredHistoryVolunteerCollection(readHistoryVolunteerCollectionFile(n.paths[0])); cleanup.push(role.close);
    const before = role.health(), request = n.request(0);
    expect(() => role.handle('checkpoint', { request: { ...request, contextId: historyCheckpointContextId(n.roots[1].context) }, envelope: null })).toThrow();
    expect(() => role.handle('checkpoint', { request: { ...request, contextId: 'sha256:' + 'f'.repeat(64) }, envelope: null })).toThrow('not enrolled');
    expect(() => role.handle('close' as never, { request })).toThrow('Unknown');
    expect(() => role.handle('provision', { contextId: request.contextId, extra: ' '.repeat(1024 * 1024) })).toThrow('bound');
    expect(role.health()).toEqual(before);
    for (let i = 0; i < n.roots.length; i++) expect(() => role.handle('checkpoint', { request: n.request(i), envelope: null })).not.toThrow();
  });

  it('rejects duplicate contexts, per-history controller overrides, too many histories, malformed UTF-8 and oversized configuration', async () => {
    const n = prepared, raw = n.configs[0], history = raw.histories[0];
    for (const value of [{ ...raw, initialize: true }, { ...raw, histories: [] }, { ...raw, histories: [...raw.histories, history] },
      { ...raw, histories: Array.from({ length: 9 }, () => history) }, { ...raw, histories: [{ ...history, controllers: [] }] }, { ...raw, controllers: [] }]) {
      expect(() => parseHistoryVolunteerCollection(value, n.directory)).toThrow();
    }
    writeFileSync(n.paths[0], Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x30, 0x7d])); expect(() => readHistoryVolunteerCollectionFile(n.paths[0])).toThrow('UTF-8');
    writeFileSync(n.paths[0], ' '.repeat(512 * 1024 + 1)); expect(() => readHistoryVolunteerCollectionFile(n.paths[0])).toThrow('bounded');
  });

  it('closes every earlier opened store if a later history is missing and never creates its replacement', async () => {
    const n = prepared, config = readHistoryVolunteerCollectionFile(n.paths[0]);
    const last = config.histories[4].directory; renameSync(last, last + '.retained');
    expect(() => openConfiguredHistoryVolunteerCollection(config)).toThrow(); expect(existsSync(last)).toBe(false); renameSync(last + '.retained', last);
    const manifest = join(last, 'genesis', 'history-manifest.json'), original = readFileSync(manifest); writeFileSync(manifest, 'damaged');
    expect(() => openConfiguredHistoryVolunteerCollection(config)).toThrow(); writeFileSync(manifest, original);
    const role = openConfiguredHistoryVolunteerCollection(config); expect(role.health().histories).toBe(5); role.close();
  });

  it('refuses overlapping actual directories before taking any store ownership', async () => {
    const n = prepared, raw = structuredClone(n.configs[0]); raw.histories[1].directory = raw.histories[0].directory;
    expect(() => openConfiguredHistoryVolunteerCollection(parseHistoryVolunteerCollection(raw, n.directory))).toThrow('non-overlapping');
    const role = openConfiguredHistoryVolunteerCollection(readHistoryVolunteerCollectionFile(n.paths[0])); expect(role.health().histories).toBe(5); role.close();
  });
});

it('selects only the authenticated request context position for each supported protocol shape', () => {
  // Selection is syntactic; real signed routing is exercised by the enrolled-store tests.
  const contextId = 'sha256:' + 'a'.repeat(64);
  for (const method of ['checkpoint', 'agreement', 'compaction'] as const) expect(historyCollectionContext(method, { request: { contextId } })).toBe(contextId);
  expect(historyCollectionContext('transfer', { authorization: { request: { contextId } } })).toBe(contextId);
  expect(historyCollectionContext('provision', { contextId })).toBe(contextId);
  for (const kind of ['history-frontier-request', 'history-compaction-proposal']) expect(historyCollectionContext('compaction', { kind, contextId })).toBe(contextId);
  for (const frame of [{ contextId }, { authorization: { contextId } }, null, []]) expect(() => historyCollectionContext('transfer', frame)).toThrow();
});
