/** Explicit v2 original-evidence pool. No migration, compaction, deletion or reservation credit. */
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { openEncryptedLocalState, isLocalStateOwnershipName, inspectLocalStateOwnership } from '@resonance/core/local-state';
import { captureStorageReservationOperation, reserveManagedStorage } from '@resonance/core/storage-reservations';
import { exactWitnessFields } from '@resonance/core/admission-witness';
import { historyCheckpointContextId, historyCheckpointEnvelopeId, historyDigest, isHistoryDigest, parseHistoryCheckpointContext,
  parseHistoryCheckpointEnvelope, HISTORY_ENVELOPE_MAX_BYTES, type HistoryCheckpointContext, type HistoryCheckpointEnvelope } from '@resonance/core/history-checkpoint';
import { historyContinuationRootId, parseHistoryContinuationRoot, type HistoryContinuationRoot } from '@resonance/core/history-continuation';
import { parseHistoryAgreementFrame, type HistoryAgreementFrame } from '@resonance/core/history-agreement';
import { readHistorySequenceIndex } from './history-sequence-index.js';
import { HISTORY_ANCESTRY_GENERATIONS_PER_PAGE } from '@resonance/core/history-ancestry-pages';
export const HISTORY_SHARED_CATALOG = 'history-original-pool-v2.json';
const CATALOG_BYTES = 2 * 1024 * 1024, CONTROL_PEAK = 2 * CATALOG_BYTES + 8192, MAX_BYTES = 256 * 1024 * 1024;
type ObjectRef = { id: string; bytes: number };
type Generation = { rootId: string; generation: number; manifest: string | null; provision: string | null };
type Page = { version: 2; kind: 'page'; index: number; previousRootId: string | null; generations: Generation[] };
type RecordObject = { version: 2; kind: 'manifest' | 'provision'; rootId: string; generation: number; previous: string | null; value: unknown };
type PoolObject = Page | RecordObject;
type Stage = { digest: string; recordNonce: string; pageNonce: string };
type PromiseHold = { rootId: string; headId: string; bytes: number; blocks: number; objects: number };
type MutationHold = { kind: 'publication' | 'append'; rootId: string; childRootId: string | null; blockId: string | null; targetDigest: string | null; previousHeadId: string | null;
  baseFiles: number; baseBytes: number; baseBlocks: number; baseObjects: number; bytes: number; blocks: number; objects: number; previousPromises: PromiseHold[];
  root: HistoryContinuationRoot | null; stage: Stage | null; transferAuthorization?: HistoryAgreementFrame | null };
interface Catalog { version: 2; contextId: string; genesisId: string; replica: string; pages: string[]; objects: ObjectRef[]; blocks: ObjectRef[]; hold?: MutationHold | null; promises?: PromiseHold[]; looseStage?: Stage | null }
export type SharedHistoryPool = ReturnType<typeof openSharedHistoryPool>;
export function openSharedHistoryPool(options: { directory: string; localKey: Uint8Array; context: HistoryCheckpointContext; replica: string;
  genesisId: string; initialize?: boolean; maxBytes?: number; maxBlocks?: number }) {
  const run = captureStorageReservationOperation(), directory = resolve(options.directory), context = parseHistoryCheckpointContext(options.context);
  const contextId = historyCheckpointContextId(context), genesisId = options.genesisId, replica = options.replica;
  const maxBytes = options.maxBytes ?? MAX_BYTES, maxBlocks = options.maxBlocks ?? 10001;
  if (options.localKey.length !== 32 || !isHistoryDigest(genesisId) || !context.members.includes(replica)
    || !Number.isSafeInteger(maxBytes) || maxBytes <= CONTROL_PEAK || maxBytes > MAX_BYTES
    || !Number.isSafeInteger(maxBlocks) || maxBlocks < 1 || maxBlocks > 10001) throw new Error('Invalid shared history pool pins or bounds');
  const key = Buffer.from(options.localKey), aad = Buffer.from(`resonance:history-original-pool:v2\n${JSON.stringify([contextId, genesisId, replica])}`);
  // The authority charges the entire immutable/staging arena once, plus the exact catalog/ownership peak.
  // Every later object must fit inside this precommitted arena; old versions never become free space.
  const arena = reserveManagedStorage({ path: directory, component: 'history-original-evidence-v2', scope: 'directory', maximumBytes: maxBytes - CONTROL_PEAK });
  reserveManagedStorage({ path: join(directory, HISTORY_SHARED_CATALOG), component: 'encrypted-local-state', scope: 'file', maximumBytes: CONTROL_PEAK });
  const initial: Catalog = { version: 2, contextId, genesisId, replica, pages: [], objects: [], blocks: [] };
  function refs(value: unknown, maximum = CATALOG_BYTES): value is ObjectRef[] { return Array.isArray(value) && value.length <= 20000 && value.every(v => exactWitnessFields(v, ['id', 'bytes'])
    && isHistoryDigest(v.id) && typeof v.bytes === 'number' && Number.isSafeInteger(v.bytes) && v.bytes > 0 && v.bytes <= maximum)
    && new Set(value.map(v => v.id)).size === value.length; }
  function validStage(v: unknown): v is Stage { return exactWitnessFields(v, ['digest', 'recordNonce', 'pageNonce']) && isHistoryDigest(v.digest)
    && typeof v.recordNonce === 'string' && /^[A-Za-z0-9_-]{16}$/.test(v.recordNonce) && typeof v.pageNonce === 'string' && /^[A-Za-z0-9_-]{16}$/.test(v.pageNonce); }
  const count = (v: unknown, maximum: number): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= maximum;
  function validPromise(p: unknown): p is PromiseHold { return exactWitnessFields(p, ['rootId', 'headId', 'bytes', 'blocks', 'objects']) && isHistoryDigest(p.rootId) && isHistoryDigest(p.headId)
    && count(p.bytes, MAX_BYTES) && p.blocks === 1 && p.objects === 4; }
  function validHold(v: unknown): v is MutationHold {
    if (!exactWitnessFields(v, ['kind', 'rootId', 'childRootId', 'blockId', 'targetDigest', 'previousHeadId', 'baseFiles', 'baseBytes', 'baseBlocks', 'baseObjects', 'bytes', 'blocks', 'objects', 'previousPromises', 'root', 'stage', ...(!!v && typeof v === 'object' && Object.hasOwn(v, 'transferAuthorization') ? ['transferAuthorization'] : [])])
      || !['publication', 'append'].includes(v.kind as string) || !isHistoryDigest(v.rootId) || !(v.childRootId === null || isHistoryDigest(v.childRootId))
      || !(v.targetDigest === null || isHistoryDigest(v.targetDigest)) || !isHistoryDigest(v.blockId) || !(v.previousHeadId === null || isHistoryDigest(v.previousHeadId)) || !count(v.baseFiles, 100000) || !count(v.baseBytes, MAX_BYTES) || !count(v.bytes, MAX_BYTES)
      || !count(v.baseBlocks, maxBlocks) || !count(v.blocks, maxBlocks) || !count(v.baseObjects, 20000) || !count(v.objects, 20000)
      || !Array.isArray(v.previousPromises) || v.previousPromises.length > maxBlocks || !v.previousPromises.every(validPromise) || new Set(v.previousPromises.map(p => p.rootId)).size !== v.previousPromises.length || !(v.stage === null || validStage(v.stage))) return false;
    if (v.transferAuthorization !== undefined && v.transferAuthorization !== null) {
      try {
        const auth = parseHistoryAgreementFrame(v.transferAuthorization, context), r = auth.request;
        if (v.kind !== 'append' || r.action !== 'prepare' || r.rootId !== v.rootId || r.replica !== replica) return false;
      } catch { return false; }
    }
    if (v.kind !== 'publication') return v.root === null && v.childRootId === null && isHistoryDigest(v.targetDigest);
    try { const root = parseHistoryContinuationRoot(v.root, context); return root.proposal.rootId === v.rootId && historyContinuationRootId(root) === v.childRootId && v.childRootId === v.blockId; } catch { return false; }
  }
  function valid(value: unknown): value is Catalog {
    const optional = ['hold', 'promises', 'looseStage'].filter(k => !!value && typeof value === 'object' && Object.hasOwn(value, k));
    return exactWitnessFields(value, [...Object.keys(initial), ...optional]) && value.version === 2 && value.contextId === contextId && value.genesisId === genesisId && value.replica === replica
      && Array.isArray(value.pages) && value.pages.length <= Math.ceil(maxBlocks / HISTORY_ANCESTRY_GENERATIONS_PER_PAGE) && value.pages.every(isHistoryDigest)
      && new Set(value.pages).size === value.pages.length && refs(value.objects) && refs(value.blocks, HISTORY_ENVELOPE_MAX_BYTES) && value.blocks.length <= maxBlocks
      && value.pages.every(id => (value.objects as ObjectRef[]).some(o => o.id === id))
      && (value.promises === undefined || Array.isArray(value.promises) && value.promises.length <= maxBlocks && value.promises.every(validPromise) && new Set(value.promises.map(p => p.rootId)).size === value.promises.length)
      && (value.looseStage === undefined || value.looseStage === null || validStage(value.looseStage))
      && (value.hold === undefined || value.hold === null || validHold(value.hold));
  }
  let catalog: ReturnType<typeof openEncryptedLocalState<Catalog>>;
  let closed = false, failed = false, used = 0, peak = 0, arenaFiles = 0;
  const objects = new Map<string, { ref: ObjectRef; value: PoolObject }>(), blocks = new Map<string, ObjectRef>();
  let pages: Page[] = [], promises: PromiseHold[] = [], hold: MutationHold | null = null;
  let spending = false, looseStage: Stage | null = null;
  const PAGE_PEAK = 32 * 1024;
  const claims = new Set<string>();
  const objectPath = (id: string) => join(directory, `${id.slice(7)}.object`), blockPath = (id: string) => join(directory, `${id.slice(7)}.block`);
  function live() { if (closed || failed) throw new Error('Shared history pool closed or write failed; reopen'); arena?.assertWritable(); catalog.read(); }
  function encoded(value: PoolObject, selectedNonce?: string) {
    const plaintext = Buffer.from(JSON.stringify(value));
    try { const nonce = selectedNonce ? Buffer.from(selectedNonce, 'base64url') : randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce); cipher.setAAD(aad);
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const bytes = Buffer.from(JSON.stringify({ version: 2, nonce: nonce.toString('base64url'), ciphertext: ciphertext.toString('base64url'), tag: cipher.getAuthTag().toString('base64url') }));
      if (bytes.length > CATALOG_BYTES) throw new Error('Shared history object capacity exceeded'); return bytes;
    } finally { plaintext.fill(0); }
  }
  function decoded(bytes: Buffer): PoolObject {
    const r = JSON.parse(bytes.toString('utf8'));
    if (!exactWitnessFields(r, ['version', 'nonce', 'ciphertext', 'tag']) || r.version !== 2
      || ![r.nonce, r.ciphertext, r.tag].every(v => typeof v === 'string' && /^[A-Za-z0-9_-]+$/.test(v))) throw new Error('Invalid shared encrypted object');
    const nonce = Buffer.from(r.nonce as string, 'base64url'), tag = Buffer.from(r.tag as string, 'base64url');
    if (nonce.length !== 12 || tag.length !== 16) throw new Error('Invalid shared encryption header');
    const decipher = createDecipheriv('aes-256-gcm', key, nonce); decipher.setAAD(aad); decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(Buffer.from(r.ciphertext as string, 'base64url')), decipher.final()]);
    try { const v = JSON.parse(plaintext.toString('utf8'));
      if (!v || v.version !== 2 || !['page', 'manifest', 'provision'].includes(v.kind)) throw new Error('Invalid shared history object'); return v;
    } finally { plaintext.fill(0); }
  }
  function bytesAt(path: string, maximum = CATALOG_BYTES) { const stat = lstatSync(path); if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > maximum) throw new Error('Invalid shared history file');
    const bytes = readFileSync(path); if (bytes.length !== stat.size) throw new Error('Shared history file changed'); return bytes; }
  function remaining() { return hold ? { bytes: Math.max(0, hold.bytes - (used - hold.baseBytes)), blocks: Math.max(0, hold.blocks - (blocks.size - hold.baseBlocks)), objects: Math.max(0, hold.objects - (objects.size - hold.baseObjects)) } : { bytes: 0, blocks: 0, objects: 0 }; }
  function capacity(additional = 0, additionalBlocks = 0, additionalObjects = 0) {
    live(); const r = remaining();
    const promised = promises.reduce((sum, p) => ({ bytes: sum.bytes + p.bytes, blocks: sum.blocks + p.blocks, objects: sum.objects + p.objects }), { bytes: 0, blocks: 0, objects: 0 });
    if (used + (spending ? Math.max(additional, r.bytes) : additional + r.bytes) + promised.bytes + CONTROL_PEAK > maxBytes
      || blocks.size + (spending ? Math.max(additionalBlocks, r.blocks) : additionalBlocks + r.blocks) + promised.blocks > maxBlocks
      || objects.size + (spending ? Math.max(additionalObjects, r.objects) : additionalObjects + r.objects) + promised.objects > 20000) throw new Error('Shared history aggregate capacity exceeded');
    const slack = 4096 * promises.length + 512 * (r.objects + r.blocks + additionalObjects + additionalBlocks);
    if (Buffer.byteLength(JSON.stringify(nextCatalog(catalog.read().pages))) * 4 / 3 + slack + 1024 > CATALOG_BYTES) throw new Error('Shared history catalog capacity exceeded');
  }
  function latest(rootId: string, kind: 'manifest' | 'provision'): any { const id = locate(rootId)?.entry[kind]; return id ? (objects.get(id)!.value as RecordObject).value : undefined; }
  function startHold(next: MutationHold, nextPromises = promises) {
    const previous = hold, before = promises; hold = next; promises = structuredClone(nextPromises);
    try { capacity(); commit(catalog.read().pages); } catch (error) { hold = previous; promises = before; throw error; }
  }
  function newHold(kind: MutationHold['kind'], rootId: string, bytes: number, count: number, objectCount: number, blockId: string | null = null): MutationHold {
    return { kind, rootId, childRootId: null, blockId, targetDigest: null, previousHeadId: null, baseFiles: arenaFiles, baseBytes: used, baseBlocks: blocks.size, baseObjects: objects.size, bytes, blocks: count, objects: objectCount,
      previousPromises: structuredClone(promises), root: null, stage: null, transferAuthorization: null };
  }
  function enter(rootId: string) {
    if (hold && rootId !== hold.rootId && rootId !== hold.childRootId) throw new Error('Shared history publication is pending; unrelated writes cannot consume its hold');
    spending = !!hold;
  }
  function hasOnlyOriginalRoot(rootId: string) {
    const state = latest(rootId, 'manifest'); if (!state) return false;
    const ids = readHistorySequenceIndex(state.blocks, maxBlocks); return ids.count === 1 && ids.headSequence === 0 && ids.get(0) === rootId;
  }
  function authorizeRecord(rootId: string, kind: 'manifest' | 'provision', value: unknown) {
    if (!hold) return;
    if (hold.kind === 'append') {
      if (kind !== 'manifest' || rootId !== hold.rootId || historyDigest(JSON.stringify(value)) !== hold.targetDigest) throw new Error('Wrong held append target'); return;
    }
    const root = hold.root!, parent = latest(hold.rootId, 'manifest'), journal = latest(hold.rootId, 'provision');
    let allowed: unknown[] = [];
    if (rootId === hold.rootId && kind === 'manifest' && journal?.phase === 'empty') allowed = [{ ...parent, activation: root }];
    if (rootId === hold.rootId && kind === 'provision') {
      if (journal?.phase === 'empty' && parent?.activation && historyContinuationRootId(parent.activation) === hold.childRootId) allowed = [{ ...journal, phase: 'creating', root, location: 'shared-v2' }];
      if (journal?.phase === 'creating' && hasOnlyOriginalRoot(hold.childRootId!) && latest(hold.childRootId!, 'provision')?.phase === 'empty') allowed = [{ ...journal, phase: 'ready' }];
    }
    if (rootId === hold.childRootId && journal?.phase === 'creating') {
      const initial = { version: 1, contextId, replica, rootId, generation: root.generation, blocks: [], freeze: null, successor: null };
      if (kind === 'manifest') allowed = [initial, { ...initial, blocks: readHistorySequenceIndex([], maxBlocks).extend(0, rootId) }];
      if (kind === 'provision' && hasOnlyOriginalRoot(rootId)) allowed = [{ version: 4, contextId, replica, parentRootId: rootId, parentGeneration: root.generation, phase: 'empty', root: null, location: null }];
    }
    if (!allowed.some(v => JSON.stringify(v) === JSON.stringify(value))) throw new Error('Wrong held publication stage');
  }
  function authenticateExisting(block: HistoryCheckpointEnvelope) {
    const id = historyCheckpointEnvelopeId(block), expected = blocks.get(id); if (!expected) return null;
    const bytes = bytesAt(blockPath(id), HISTORY_ENVELOPE_MAX_BYTES), parsed = parseHistoryCheckpointEnvelope(JSON.parse(bytes.toString('utf8')), context);
    if (bytes.length !== expected.bytes || historyCheckpointEnvelopeId(parsed) !== id || JSON.stringify(parsed) !== JSON.stringify(block)) throw new Error('Retained shared ciphertext does not match the exact authenticated retry');
    return bytes.length;
  }
  function metadataCost(rootId: string, generation: number, value: unknown) {
    const selected = locate(rootId); if (!selected) throw new Error('Append needs its current generation descriptor');
    const record: RecordObject = { version: 2, kind: 'manifest', rootId, generation, previous: selected.entry.manifest, value };
    const page = structuredClone(pages[selected.index]); page.generations[selected.offset].manifest = historyDigest('held-manifest');
    const a = encoded(record).length, b = encoded(page).length;
    return { bytes: a + b, stage: Math.max(a, b) };
  }
  function namesBlock(value: any, block: HistoryCheckpointEnvelope) {
    const id = historyCheckpointEnvelopeId(block);
    return readHistorySequenceIndex(value.blocks, maxBlocks).get(block.sequence) === id || value.transfer?.blocks.includes(id);
  }
  // Renew only transport freshness. The selected proof, pins and target stay byte-for-byte identical.
  function authorizationOperation(auth: HistoryAgreementFrame) {
    const { challenge: _challenge, issuedAt: _issuedAt, expiresAt: _expiresAt, signature: _signature, ...request } = auth.request;
    return JSON.stringify({ ...auth, request });
  }
  function retainedTransferAuthorization(rootId: string, block: HistoryCheckpointEnvelope, value: HistoryAgreementFrame, now: number) {
    live(); const auth = parseHistoryAgreementFrame(value, context, now);
    if (!hold) return auth;
    block = parseHistoryCheckpointEnvelope(block, context);
    if (hold.kind !== 'append' || hold.rootId !== rootId || hold.blockId !== historyCheckpointEnvelopeId(block)) throw new Error('Wrong held transfer operation');
    // Older experimental holds did not retain authorization: their exact target digest remains mandatory.
    const retained = hold.transferAuthorization;
    if (!retained) return auth;
    if (authorizationOperation(auth) !== authorizationOperation(retained)) throw new Error('Wrong held transfer authorization');
    return structuredClone(retained);
  }
  function appendHold(rootId: string, block: HistoryCheckpointEnvelope, nextManifest: unknown, selectedTransfer = false, authorization?: HistoryAgreementFrame) {
    block = parseHistoryCheckpointEnvelope(block, context);
    const id = historyCheckpointEnvelopeId(block), selected = locate(rootId), before = latest(rootId, 'manifest');
    if (!selected || !before || block.generation !== selected.entry.generation) throw new Error('Append hold has wrong generation/root');
    const ids = readHistorySequenceIndex(before.blocks, maxBlocks);
    if (!selectedTransfer && (ids.count ? block.previous !== ids.headId || block.sequence !== ids.headSequence + 1 : id !== rootId || block.sequence !== 0 || block.previous !== null)) throw new Error('Append hold does not extend its exact retained head');
    if (selectedTransfer ? !namesBlock(nextManifest, block) : readHistorySequenceIndex((nextManifest as any).blocks, maxBlocks).headId !== id) throw new Error('Append hold omits its target reference');
    if (hold?.kind === 'publication') { if (hold.childRootId !== rootId || hold.blockId !== id) throw new Error('Wrong held continuation block'); return; }
    if (hold?.kind === 'append' && hold.rootId === rootId && hold.blockId === id) {
      const auth = authorization ?? (nextManifest as any).transfer?.authorization;
      if (hold.transferAuthorization && (!auth || authorizationOperation(parseHistoryAgreementFrame(auth, context)) !== authorizationOperation(hold.transferAuthorization))) throw new Error('Wrong held transfer authorization');
      if (hold.targetDigest !== historyDigest(JSON.stringify(nextManifest))) throw new Error('Wrong held append target'); return;
    }
    if (hold) throw new Error('Shared history mutation is pending');
    const retained = authenticateExisting(block), reserve = (nextManifest as any).freeze || block.kind === 'continuation' ? 0 : block.checkpointReserveBytes ?? 0;
    const nextPromises = promises.filter(p => p.rootId !== rootId);
    if (reserve) nextPromises.push({ rootId, headId: id, bytes: reserve + CATALOG_BYTES + PAGE_PEAK + Math.max(reserve, CATALOG_BYTES), blocks: 1, objects: 4 });
    const metadata = metadataCost(rootId, block.generation, nextManifest), data = retained === null ? Buffer.byteLength(JSON.stringify(block)) : 0;
    const budget = data + metadata.bytes + Math.max(data, metadata.stage);
    const next = newHold('append', rootId, budget, retained === null ? 1 : 0, 4, id); next.previousHeadId = ids.headId; next.targetDigest = historyDigest(JSON.stringify(nextManifest));
    const selectedAuthorization = authorization ?? (nextManifest as any).transfer?.authorization;
    if (selectedTransfer && selectedAuthorization) {
      const auth = parseHistoryAgreementFrame(selectedAuthorization, context), r = auth.request;
      if (r.action !== 'prepare' || r.rootId !== rootId || r.replica !== replica || r.generation !== block.generation) throw new Error('Wrong selected transfer authorization pins');
      next.transferAuthorization = auth;
    }
    startHold(next, nextPromises);
  }
  function outputRemaining(bytes: Buffer, path: string) {
    if (existsSync(path)) { if (!bytesAt(path, Math.max(CATALOG_BYTES, HISTORY_ENVELOPE_MAX_BYTES)).equals(bytes)) throw new Error('Retained immutable output differs'); return 0; }
    if (!existsSync(`${path}.pending`)) return bytes.length;
    const stat = lstatSync(`${path}.pending`); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > bytes.length || !readFileSync(`${path}.pending`).equals(bytes.subarray(0, stat.size))) throw new Error('Held staging bytes differ from exact retry');
    return bytes.length - stat.size;
  }
  function immutable(bytes: Buffer, path: string) {
    const temporary = `${path}.pending`;
    let prefix = 0;
    if (existsSync(path)) { const existing = bytesAt(path, Math.max(CATALOG_BYTES, HISTORY_ENVELOPE_MAX_BYTES)); if (!existing.equals(bytes)) throw new Error('Retained immutable output differs'); return; }
    if (existsSync(temporary)) { const stat = lstatSync(temporary); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > bytes.length) throw new Error('Invalid held staging output');
      prefix = stat.size; if (!readFileSync(temporary).equals(bytes.subarray(0, prefix))) throw new Error('Held staging bytes differ from exact retry'); }
    capacity(bytes.length - prefix);
    let fd: number | undefined;
    try { const existed = existsSync(temporary); fd = openSync(temporary, existed ? 'r+' : 'wx', 0o600); if (!existed) arenaFiles++;
      let offset = prefix; while (offset < bytes.length) { const n = writeSync(fd, bytes, offset, bytes.length - offset, offset); if (n <= 0) throw new Error('Incomplete shared object write'); offset += n; used += n; }
      peak = Math.max(peak, used + CONTROL_PEAK); fsyncSync(fd); closeSync(fd); fd = undefined; renameSync(temporary, path); flush(directory);
    } catch (error) { failed = true; throw error; } finally { if (fd !== undefined) closeSync(fd); }
  }
  function addObject(value: PoolObject, nonce?: string) { const bytes = encoded(value, nonce), id = historyDigest(bytes), ref = { id, bytes: bytes.length };
    immutable(bytes, objectPath(id)); objects.set(id, { ref, value: structuredClone(value) }); return id; }
  function nextCatalog(pageIds: string[]): Catalog { return { ...initial, pages: pageIds, objects: [...objects.values()].map(o => o.ref), blocks: [...blocks.values()], hold: structuredClone(hold), promises: structuredClone(promises), looseStage: structuredClone(looseStage) }; }
  function commit(pageIds: string[]) { const state = nextCatalog(pageIds);
    if (!valid(state) || Buffer.byteLength(JSON.stringify(state)) * 4 / 3 + 256 > CATALOG_BYTES) throw new Error('Shared history catalog capacity exceeded');
    try { catalog.write(state); } catch (error) { failed = true; throw error; }
  }
  function locate(rootId: string) { for (const [index, page] of pages.entries()) { const offset = page.generations.findIndex(g => g.rootId === rootId); if (offset >= 0) return { index, offset, entry: page.generations[offset] }; } return undefined; }
  function verifyPages() {
    let previous: Generation | undefined; const roots = new Set<string>();
    pages = catalog.read().pages.map((id, index) => {
      const value = objects.get(id)?.value;
      if (!value || value.kind !== 'page' || !exactWitnessFields(value, ['version', 'kind', 'index', 'previousRootId', 'generations']) || value.index !== index
        || value.previousRootId !== (previous?.rootId ?? null) || !Array.isArray(value.generations) || !value.generations.length || value.generations.length > HISTORY_ANCESTRY_GENERATIONS_PER_PAGE
        || index < catalog.read().pages.length - 1 && value.generations.length !== HISTORY_ANCESTRY_GENERATIONS_PER_PAGE) throw new Error('Missing, reordered or mismatched shared history page');
      for (const entry of value.generations) {
        if (!exactWitnessFields(entry, ['rootId', 'generation', 'manifest', 'provision']) || !isHistoryDigest(entry.rootId) || roots.has(entry.rootId)
          || !Number.isSafeInteger(entry.generation) || entry.generation < 0 || (previous ? entry.generation <= previous.generation : entry.generation !== 0 || entry.rootId !== genesisId)) throw new Error('Invalid shared generation reference');
        for (const kind of ['manifest', 'provision'] as const) if (entry[kind] !== null) {
          const r = objects.get(entry[kind]!)?.value;
          if (!r || r.kind !== kind || r.rootId !== entry.rootId || r.generation !== entry.generation) throw new Error('Mismatched shared generation record');
          let ancestor: RecordObject = r; const seen = new Set<string>();
          while (ancestor.previous !== null) { if (seen.has(ancestor.previous)) throw new Error('Cyclic shared record versions'); seen.add(ancestor.previous);
            const old = objects.get(ancestor.previous)?.value;
            if (!old || old.kind !== kind || old.rootId !== entry.rootId || old.generation !== entry.generation) throw new Error('Missing retained shared record version'); ancestor = old; }
        }
        roots.add(entry.rootId); previous = entry;
      }
      return structuredClone(value);
    });
  }
  try {
    if (options.initialize) { if (existsSync(directory) && readdirSync(directory).length) throw new Error('Shared history enrollment requires an empty directory');
      if (!existsSync(directory)) mkdirSync(directory, { mode: 0o700 }); flush(dirname(directory)); }
    if (!lstatSync(directory).isDirectory()) throw new Error('Shared history pool needs a real directory');
    catalog = openEncryptedLocalState({ path: join(directory, HISTORY_SHARED_CATALOG), key, domain: aad.toString('utf8'), maxBytes: CATALOG_BYTES,
      initial, validate: valid, mode: options.initialize ? 'create-new' : 'open-existing' });
    for (const name of readdirSync(directory)) {
      if (name === HISTORY_SHARED_CATALOG) continue;
      if (isLocalStateOwnershipName(HISTORY_SHARED_CATALOG, name)) { inspectLocalStateOwnership(join(directory, name)); continue; }
      if (/^\.object-[a-f0-9]{32}\.tmp$/.test(name) || /^[a-f0-9]{64}\.(?:object|block)\.pending$/.test(name)) { arenaFiles++; const stat = lstatSync(join(directory, name));
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > Math.max(CATALOG_BYTES, HISTORY_ENVELOPE_MAX_BYTES)) throw new Error('Invalid interrupted shared object');
        used += stat.size; continue; }
      const match = /^([a-f0-9]{64})\.(object|block)$/.exec(name); if (!match) throw new Error('Unregistered shared history contents');
      const id = `sha256:${match[1]}`, bytes = bytesAt(join(directory, name), match[2] === 'block' ? HISTORY_ENVELOPE_MAX_BYTES : CATALOG_BYTES);
      used += bytes.length; arenaFiles++;
      if (match[2] === 'object') { if (historyDigest(bytes) !== id) throw new Error('Shared history object digest mismatch'); objects.set(id, { ref: { id, bytes: bytes.length }, value: decoded(bytes) }); }
      else { if (historyCheckpointEnvelopeId(parseHistoryCheckpointEnvelope(JSON.parse(bytes.toString('utf8')), context)) !== id) throw new Error('Shared ciphertext digest mismatch'); blocks.set(id, { id, bytes: bytes.length }); }
    }
    for (const [kind, map] of [['objects', objects], ['blocks', blocks]] as const) for (const ref of catalog.read()[kind]) {
      const found = map.get(ref.id), bytes = found && ('ref' in found ? found.ref.bytes : found.bytes);
      if (!found || bytes !== ref.bytes) throw new Error('Missing retained shared history object');
    }
    promises = structuredClone(catalog.read().promises ?? []); hold = structuredClone(catalog.read().hold ?? null); looseStage = structuredClone(catalog.read().looseStage ?? null);
    // A committed hold with no physical output has no acknowledged effect and can be safely cancelled.
    if (hold && hold.kind !== 'publication' && arenaFiles === hold.baseFiles && used === hold.baseBytes && blocks.size === hold.baseBlocks && objects.size === hold.baseObjects) {
      promises = hold.previousPromises; hold = null; commit(catalog.read().pages);
    }
    capacity(); peak = used + CONTROL_PEAK; verifyPages();
    if (hold) {
      if (hold.baseBytes > used || hold.baseBlocks > blocks.size || hold.baseObjects > objects.size || hold.baseFiles > arenaFiles) throw new Error('Held resource baseline exceeds retained evidence');
      const parent = latest(hold.rootId, 'manifest'); if (!parent || readHistorySequenceIndex(parent.blocks, maxBlocks).headId !== hold.previousHeadId) throw new Error('Mutation hold lost its exact retained parent');
      if (hold.kind === 'publication' && hold.root!.proposal.generation !== parent.generation) throw new Error('Publication hold generation mismatch');
      if (hold.transferAuthorization) {
        const r = hold.transferAuthorization.request;
        if (r.generation !== parent.generation || r.nextGeneration !== parent.freeze?.nextGeneration || r.view !== parent.agreement?.report.request.view) throw new Error('Held transfer lost its exact frozen agreement');
      }
    }
    if (catalog.read().promises === undefined) {
      // Rejected experimental v2 catalogs without a ledger receive no unbacked checkpoint credit.
      for (const page of pages) for (const generation of page.generations) {
        const state = latest(generation.rootId, 'manifest'); if (!state || state.freeze) continue;
        const headId = readHistorySequenceIndex(state.blocks, maxBlocks).headId; if (!headId) continue;
        const head = parseHistoryCheckpointEnvelope(JSON.parse(bytesAt(blockPath(headId), HISTORY_ENVELOPE_MAX_BYTES).toString('utf8')), context);
        const reserve = head.kind === 'continuation' ? 0 : head.checkpointReserveBytes ?? 0;
        if (reserve) promises.push({ rootId: generation.rootId, headId, bytes: reserve + CATALOG_BYTES + PAGE_PEAK + Math.max(reserve, CATALOG_BYTES), blocks: 1, objects: 4 });
      }
      capacity();
    }
  } catch (error) { catalog!?.close(); key.fill(0); throw error; }
  return {
    directory, genesisId, contextId, replica,
    assertPins(c: HistoryCheckpointContext, member: string, genesis = genesisId) { live(); if (historyCheckpointContextId(c) !== contextId || member !== replica || genesis !== genesisId) throw new Error('Wrong independently pinned shared history pool'); },
    prepareAppend: appendHold,
    retainedTransferAuthorization,
    preparePublication(value: HistoryContinuationRoot) { return run(() => {
      live(); const root = parseHistoryContinuationRoot(value, context), childRootId = historyContinuationRootId(root), parentRootId = root.proposal.rootId;
      if (hold) { if (hold.kind === 'publication' && hold.childRootId === childRootId) return; throw new Error('Another shared mutation is pending'); }
      if (!latest(parentRootId, 'manifest') || !latest(parentRootId, 'provision')) throw new Error('Publication requires its retained parent and journal');
      // Full encrypted manifest/journal ceilings, six descriptor replacements and one interrupted-output peak.
      const bytes = 3 * CATALOG_BYTES + 3 * 65536 + 6 * PAGE_PEAK + Buffer.byteLength(JSON.stringify(root)) + CATALOG_BYTES;
      const next = newHold('publication', parentRootId, bytes, blocks.has(childRootId) ? 0 : 1, 16, childRootId);
      next.childRootId = childRootId; next.previousHeadId = root.proposal.envelopeId; next.root = structuredClone(root); startHold(next);
    }); },
    heldMutation() { live(); return hold ? structuredClone(hold) : null; },
    hasRecord(rootId: string, kind: 'manifest' | 'provision') { live(); return !!locate(rootId)?.entry[kind]; },
    openRecord<T>(o: { rootId: string; generation: number; kind: 'manifest' | 'provision'; initial: T; validate(v: unknown): v is T; initialize?: boolean; maxBytes: number }) {
      live(); const claim = `${o.kind}:${o.rootId}`; if (claims.has(claim)) throw new Error('Shared generation already has an owner');
      let selected = locate(o.rootId), id = selected?.entry[o.kind] ?? null;
      if (selected && selected.entry.generation !== o.generation || !o.initialize && !id || o.initialize && id) throw new Error('Shared generation record is missing or already exists');
      let state = id ? (objects.get(id)!.value as RecordObject).value : o.initial;
      if (id && !o.validate(state)) throw new Error('Invalid shared generation state');
      claims.add(claim); let ended = false;
      const ensure = () => { live(); if (ended) throw new Error('Shared generation handle closed'); };
      const write = (value: T) => run(() => {
        try {
        ensure(); enter(o.rootId); if (!o.validate(value)) throw new Error('Invalid outgoing shared generation state');
        if (id && JSON.stringify(state) === JSON.stringify(value)) return;
        authorizeRecord(o.rootId, o.kind, value);
        if (Buffer.byteLength(JSON.stringify(value)) * 4 / 3 + 512 > o.maxBytes) throw new Error('Shared generation record capacity exceeded');
        const record: RecordObject = { version: 2, kind: o.kind, rootId: o.rootId, generation: o.generation, previous: id, value };
        selected = locate(o.rootId);
        if (!selected) { const last = pages.at(-1)?.generations.at(-1);
          if (last ? o.generation <= last.generation : o.generation !== 0 || o.rootId !== genesisId) throw new Error('Shared generation creation has a gap or wrong genesis');
        }
        // Preflight the immutable record, replacement descriptor and enlarged catalog before creating anything.
        const newId = historyDigest('reserved-record'), copy = pages.map(p => structuredClone(p));
        let pageIndex = selected?.index ?? copy.length - 1;
        if (!selected && (!copy.length || copy.at(-1)!.generations.length === HISTORY_ANCESTRY_GENERATIONS_PER_PAGE)) { pageIndex = copy.length; copy.push({ version: 2, kind: 'page', index: pageIndex, previousRootId: copy.at(-1)?.generations.at(-1)!.rootId ?? null, generations: [] }); }
        const entry: Generation = selected ? { ...selected.entry } : { rootId: o.rootId, generation: o.generation, manifest: null, provision: null };
        entry[o.kind] = newId;
        if (selected) copy[pageIndex].generations[selected.offset] = entry; else copy[pageIndex].generations.push(entry);
        // Freeze metadata nonces in the durable hold before the first output. Exact partial retries resume one inode.
        const logical = historyDigest(JSON.stringify([record, copy[pageIndex]]));
        if (hold?.stage && hold.stage.digest !== logical) throw new Error('Another held metadata publication is incomplete');
        const stage = hold?.stage ?? (looseStage?.digest === logical ? looseStage : { digest: logical, recordNonce: randomBytes(12).toString('base64url'), pageNonce: randomBytes(12).toString('base64url') });
        const stagedRecord = encoded(record, stage.recordNonce), stagedId = historyDigest(stagedRecord); entry[o.kind] = stagedId;
        const stagedPage = encoded(copy[pageIndex], stage.pageNonce), stagedPageId = historyDigest(stagedPage);
        capacity(outputRemaining(stagedRecord, objectPath(stagedId)) + outputRemaining(stagedPage, objectPath(stagedPageId)), 0, Number(!objects.has(stagedId)) + Number(!objects.has(stagedPageId)));
        if (hold && !hold.stage) { hold.stage = stage; commit(catalog.read().pages); }
        if (!hold && looseStage !== stage) { looseStage = stage; commit(catalog.read().pages); }
        const inventoryPeak = Buffer.byteLength(JSON.stringify(nextCatalog(catalog.read().pages))) * 4 / 3 + 1024;
        if (inventoryPeak > CATALOG_BYTES || objects.size + 2 > 20000) throw new Error('Shared history catalog capacity exceeded');
        try { const nextId = addObject(record, stage.recordNonce); entry[o.kind] = nextId;
          const pageId = addObject(copy[pageIndex], stage.pageNonce), pageIds = [...catalog.read().pages]; pageIds[pageIndex] = pageId;
          if (hold) hold.stage = null; else looseStage = null;
          const raw = value as any;
          if (o.kind === 'manifest' && raw.freeze) promises = promises.filter(p => p.rootId !== o.rootId);
          if (hold?.kind === 'append' && o.kind === 'manifest' && o.rootId === hold.rootId) {
            const block = parseHistoryCheckpointEnvelope(JSON.parse(bytesAt(blockPath(hold.blockId!), HISTORY_ENVELOPE_MAX_BYTES).toString('utf8')), context);
            if (historyCheckpointEnvelopeId(block) !== hold.blockId || !namesBlock(raw, block)) throw new Error('Published append omits its exact target reference');
            hold = null;
          }
          if (hold?.kind === 'publication' && o.kind === 'provision' && o.rootId === hold.rootId && raw.phase === 'ready') {
            const child = latest(hold.childRootId!, 'manifest'), journal = latest(hold.childRootId!, 'provision');
            if (!child || !journal || journal.phase !== 'empty' || readHistorySequenceIndex(child.blocks, maxBlocks).get(0) !== hold.childRootId) throw new Error('Ready publication lacks its complete child and empty successor journal');
            hold = null;
          }
          commit(pageIds);
          pages = copy; id = nextId; state = structuredClone(value);
        } catch (error) { failed = true; throw error; } finally { spending = false; }
        } finally { spending = false; }
      });
      try { if (!id) write(o.initial); } catch (error) { claims.delete(claim); throw error; }
      return { read(): T { ensure(); return structuredClone(state) as T; }, write,
        close() { if (!ended) { ended = true; claims.delete(claim); } } };
    },
    hasBlock(id: string) { live(); return blocks.has(id); },
    readBlock(id: string) { live(); const expected = blocks.get(id); if (!expected) throw new Error('Shared history block is missing');
      const bytes = bytesAt(blockPath(id), HISTORY_ENVELOPE_MAX_BYTES), block = parseHistoryCheckpointEnvelope(JSON.parse(bytes.toString('utf8')), context);
      if (bytes.length !== expected.bytes || historyCheckpointEnvelopeId(block) !== id) throw new Error('Shared history block changed'); return { block, bytes: bytes.length }; },
    writeBlock(block: HistoryCheckpointEnvelope) { return run(() => { live(); const id = historyCheckpointEnvelopeId(block), bytes = Buffer.from(JSON.stringify(block));
      const existing = authenticateExisting(block); if (existing !== null) return existing;
      if (hold) { if (hold.blockId !== id) throw new Error('Wrong held shared ciphertext'); enter(hold.rootId); }
      capacity(bytes.length, 1);
      try { immutable(bytes, blockPath(id)); blocks.set(id, { id, bytes: bytes.length }); commit(catalog.read().pages); } catch (error) { failed = true; throw error; } finally { spending = false; } return bytes.length; }); },
    assertCapacity: capacity,
    usage() { live(); return { version: 2 as const, bytes: used, reservedBytes: maxBytes, controlPeakBytes: CONTROL_PEAK, peakBytes: peak,
      heldBytes: remaining().bytes + promises.reduce((n, p) => n + p.bytes, 0), heldBlocks: remaining().blocks + promises.reduce((n, p) => n + p.blocks, 0),
      blocks: blocks.size, objects: objects.size, pages: pages.length, generations: pages.reduce((n, p) => n + p.generations.length, 0), maximumBlocks: maxBlocks, maximumBytes: maxBytes }; },
    close() { if (!closed) { closed = true; catalog.close(); key.fill(0); claims.clear(); } },
  };
}
function flush(directory: string) { if (process.platform === 'win32') return; const fd = openSync(directory, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
