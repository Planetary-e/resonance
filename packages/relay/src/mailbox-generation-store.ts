import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  truncateSync,
  writeSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, join } from 'node:path';
import {
  createLeasedIndexGenerationIdV1,
  createOfflineDiscoveryAckIdForReplicaKeyV1,
  createOfflineDiscoveryReceiptV1,
  isLeasedIndexActiveV1,
  offlineDiscoveryAdmissionBindingV1,
  OfflineDiscoveryQuotaLedgerV1,
  parseLeasedIndexOperationV1,
  parseOfflineDiscoveryAckV1,
  parseOfflineDiscoveryDepositV1,
  serializeLeasedIndexOperationV1,
  serializeOfflineDiscoveryDepositV1,
  verifyLeasedIndexV1,
  verifyLeasedIndexWithdrawalV1,
  verifyOfflineDiscoveryAckForDepositV1,
  verifyOfflineDiscoveryAckV1,
  verifyOfflineDiscoveryDepositV1,
  type AdmissionCapabilityV2,
  type Identity,
  type LeasedIndexV1,
  type LeasedIndexWithdrawalV1,
  type OfflineDiscoveryAckV1,
  type OfflineDiscoveryDepositV1,
  type OfflineDiscoveryQuotaLimitsV1,
  type OfflineDiscoveryReplicaReceiptV1,
  type OfflineDiscoverySyncEventV1,
} from '@resonance/core';

const JOURNAL_FILENAME = 'generation-mailbox.ndjson';
const MAX_SYNC_EVENTS = 8;

export type GenerationMailboxDepositStatus =
  | 'stored'
  | 'duplicate'
  | 'conflicting_request'
  | 'drain_required'
  | 'stale_index'
  | 'withdrawn'
  | 'expired'
  | 'invalid'
  | 'invalid_link'
  | 'admission_rejected'
  | 'verification_unavailable'
  | 'request_limit'
  | 'byte_limit';

export interface GenerationMailboxDepositResult {
  status: GenerationMailboxDepositStatus;
  receipt?: OfflineDiscoveryReplicaReceiptV1;
  conflictBytes?: string;
}

export interface GenerationMailboxAckResult {
  status: 'acknowledged' | 'duplicate' | 'unknown_ack' | 'expired' | 'invalid' | 'withdrawn';
}

interface AdmissionRecord {
  depositBytes: string;
  admission: AdmissionCapabilityV2;
  actualBytes: number;
  ackId: string;
}

interface GenerationRecord {
  depositBytes: string;
  deposit: OfflineDiscoveryDepositV1;
  admission: AdmissionCapabilityV2;
  actualBytes: number;
  ackId: string;
  ack?: OfflineDiscoveryAckV1;
  conflictBytes?: string;
  conflictDeposit?: OfflineDiscoveryDepositV1;
}

interface RequestRecord {
  requestId: string;
  generations: Map<string, GenerationRecord>;
}

interface LeaseRecord {
  quota: OfflineDiscoveryQuotaLedgerV1;
  requests: Map<string, RequestRecord>;
  withdrawal?: LeasedIndexWithdrawalV1;
  withdrawalIndex?: LeasedIndexV1;
}

type JournalEntry =
  | { kind: 'admission'; record: AdmissionRecord }
  | { kind: 'deposit'; record: AdmissionRecord }
  | { kind: 'conflict'; record: AdmissionRecord }
  | { kind: 'ack'; ack: OfflineDiscoveryAckV1; evidence: AdmissionRecord }
  | { kind: 'withdrawal'; withdrawal: LeasedIndexWithdrawalV1; index: LeasedIndexV1 };

interface JournalRecord {
  sequence: number;
  entry: JournalEntry;
}

export interface MailboxGenerationStoreOptions {
  directory: string;
  relayIdentity: Identity;
  currentIndex(clientLeaseId: string): LeasedIndexV1 | undefined;
  authorizedIndex?(clientLeaseId: string): LeasedIndexV1 | undefined;
  indexForGeneration(generationId: string): LeasedIndexV1 | undefined;
  verifyAdmission(capability: AdmissionCapabilityV2, binding: string): boolean;
}

/** Quota limits are per selected replica per clientLeaseId; no relay-global quota is represented. */
export class MailboxGenerationStore {
  private readonly directory: string;
  private readonly journalPath: string;
  private readonly options: MailboxGenerationStoreOptions;
  private leases = new Map<string, LeaseRecord>();
  private admissions = new Map<string, AdmissionRecord>();
  private journal: JournalRecord[] = [];
  private poisoned = false;

  constructor(options: MailboxGenerationStoreOptions) {
    this.options = options;
    this.directory = options.directory;
    this.journalPath = join(options.directory, JOURNAL_FILENAME);
    mkdirSync(this.directory, { recursive: true });
    this.load();
  }

  deposit(
    raw: string,
    admission: AdmissionCapabilityV2,
    now: number,
    replicated = false,
  ): GenerationMailboxDepositResult {
    this.ensureWritable();
    let deposit: OfflineDiscoveryDepositV1;
    try {
      deposit = parseOfflineDiscoveryDepositV1(raw);
      if (raw !== serializeOfflineDiscoveryDepositV1(deposit) && !verifyOfflineDiscoveryDepositV1(deposit)) {
        throw new Error('Invalid deposit');
      }
    } catch {
      return { status: 'invalid' };
    }
    const lease = this.leases.get(deposit.clientLeaseId);
    const request = lease?.requests.get(deposit.requestId);
    const prior = request?.generations.get(deposit.generationId);
    if (lease?.withdrawal) return { status: 'withdrawn' };
    if (prior?.depositBytes === raw) {
      return {
        status: 'duplicate',
        ...(now >= prior.deposit.createdAt && now < prior.deposit.expiresAt ? {
          receipt: createOfflineDiscoveryReceiptV1(prior.deposit, 'already-stored', this.options.relayIdentity, now),
        } : {}),
      };
    }
    if (prior?.conflictBytes === raw) return { status: 'conflicting_request', conflictBytes: raw };
    if (!Number.isSafeInteger(now) || now < deposit.createdAt) return { status: 'invalid' };
    if (now >= deposit.expiresAt) return { status: 'expired' };
    const index = this.options.indexForGeneration(deposit.generationId);
    if (!index || !verifyLeasedIndexV1(index)) return { status: 'verification_unavailable' };
    if (!matchesIndex(deposit, index)) return { status: 'invalid' };
    const current = this.options.currentIndex(deposit.clientLeaseId);
    const currentMatches = current && createLeasedIndexGenerationIdV1(current) === deposit.generationId
      && isLeasedIndexActiveV1(current, now);
    if (!replicated && !currentMatches && !prior?.ack) return { status: 'stale_index' };

    if (prior) {
      if (prior.conflictBytes) {
        return { status: 'conflicting_request', conflictBytes: prior.conflictBytes };
      }
      const charge = this.conflictCharge(lease!, request!, prior, raw, deposit);
      if (charge.status === 'byte_limit') return { status: 'byte_limit' };
      const record = this.admissionRecord(raw, admission, deposit, prior.actualBytes);
      this.append({ kind: 'conflict', record });
      prior.conflictBytes = raw;
      prior.conflictDeposit = deposit;
      return { status: 'conflicting_request', conflictBytes: raw };
    }

    if (request && deposit.previousGenerationId === undefined) return { status: 'invalid_link' };
    if (!request && deposit.previousGenerationId !== undefined) return { status: 'invalid_link' };
    if (request && !validReplacementLink(request, deposit)) return { status: 'invalid_link' };
    const activeGenerations = request ? Array.from(request.generations.values())
      .filter(generation => !generation.ack && generation.deposit.expiresAt > now).length : 0;
    if (activeGenerations >= 2) return { status: 'drain_required' };

    const actualBytes = admissionBytes(raw, admission);
    const ackId = ackIdForDeposit(deposit);
    const targetLease = lease ?? this.newLease(deposit.clientLeaseId);
    const quotaInput = {
      requestId: deposit.requestId,
      generationId: deposit.generationId,
      replayBytes: new TextEncoder().encode(raw),
      actualBytes,
      ackIds: [ackId],
    };
    const generationInput = {
      requestId: deposit.requestId,
      generationId: deposit.generationId,
      ackId,
      replayBytes: new TextEncoder().encode(raw),
      actualBytes,
    };
    const preflight = request
      ? targetLease.quota.checkRedeposit(generationInput)
      : targetLease.quota.checkAdmission(quotaInput);
    if (preflight.status === 'request_limit' || preflight.status === 'byte_limit'
      || preflight.status === 'drain_required') {
      return { status: preflight.status };
    }
    if (preflight.status === 'conflict') return { status: 'conflicting_request' };
    const key = admissionKey(deposit.requestId, deposit.generationId);
    const priorAdmission = this.admissions.get(key);
    if (priorAdmission && priorAdmission.depositBytes !== raw) return { status: 'admission_rejected' };
    if (!this.options.verifyAdmission(admission, offlineDiscoveryAdmissionBindingV1(deposit))) {
      return { status: 'admission_rejected' };
    }
    const record: AdmissionRecord = { depositBytes: raw, admission, actualBytes, ackId };
    if (!priorAdmission) {
      this.append({ kind: 'admission', record });
      this.admissions.set(key, record);
    }
    this.append({ kind: 'deposit', record });
    const committed = request
      ? targetLease.quota.redeposit(generationInput)
      : targetLease.quota.admit(quotaInput);
    if (committed.status !== 'admitted') throw new Error('Accepted deposit quota preflight changed');
    if (!lease) this.leases.set(deposit.clientLeaseId, targetLease);
    const targetRequest = request ?? this.newRequest(targetLease, deposit.requestId);
    targetRequest.generations.set(deposit.generationId, {
      depositBytes: raw,
      deposit,
      admission,
      actualBytes,
      ackId,
    });
    return {
      status: 'stored',
      receipt: createOfflineDiscoveryReceiptV1(deposit, 'stored', this.options.relayIdentity, now),
    };
  }

  acknowledge(raw: string, now: number): GenerationMailboxAckResult {
    this.ensureWritable();
    let ack: OfflineDiscoveryAckV1;
    try { ack = parseOfflineDiscoveryAckV1(raw); } catch { return { status: 'invalid' }; }
    const generation = this.findGeneration(ack.clientLeaseId, ack.requestId, ack.generationId);
    if (!generation) return { status: 'unknown_ack' };
    return this.commitAck(ack, generation, now);
  }

  applySyncEvent(event: OfflineDiscoverySyncEventV1, now: number): GenerationMailboxDepositResult | GenerationMailboxAckResult {
    this.ensureWritable();
    if (event.kind === 'deposit') {
      return this.deposit(serializeOfflineDiscoveryDepositV1(event.deposit), event.admission, now, true);
    }
    if (event.kind === 'withdrawal') return this.withdrawReplica(event.withdrawal, event.index);
    if (!verifyOfflineDiscoveryAckV1(event.ack)
      || !verifyOfflineDiscoveryDepositV1(event.deposit)) return { status: 'invalid' };
    const generation = this.findGeneration(
      event.ack.clientLeaseId,
      event.ack.requestId,
      event.ack.generationId,
    );
    if (generation) return this.commitAck(event.ack, generation, now);
    const index = this.options.indexForGeneration(event.deposit.generationId);
    if (!index || !verifyOfflineDiscoveryAckForDepositV1(event.ack, event.deposit, index)) {
      return { status: 'invalid' };
    }
    if (now >= event.ack.requestExpiresAt) return { status: 'expired' };
    const lease = this.leases.get(event.ack.clientLeaseId) ?? this.newLease(event.ack.clientLeaseId);
    if (lease.withdrawal) return { status: 'withdrawn' };
    const evidence = this.admissionRecord(
      serializeOfflineDiscoveryDepositV1(event.deposit),
      event.admission,
      event.deposit,
      admissionBytes(serializeOfflineDiscoveryDepositV1(event.deposit), event.admission),
    );
    const existingRequest = lease.requests.get(event.ack.requestId);
    const quota = existingRequest ? lease.quota.checkRedeposit({
      requestId: event.deposit.requestId,
      generationId: event.deposit.generationId,
      ackId: evidence.ackId,
      replayBytes: new TextEncoder().encode(evidence.depositBytes),
      actualBytes: evidence.actualBytes,
    }) : lease.quota.checkAdmission({
      requestId: event.deposit.requestId,
      generationId: event.deposit.generationId,
      replayBytes: new TextEncoder().encode(evidence.depositBytes),
      actualBytes: evidence.actualBytes,
      ackIds: [evidence.ackId],
    });
    if (quota.status === 'request_limit' || quota.status === 'byte_limit'
      || quota.status === 'drain_required') return { status: quota.status };
    if (quota.status !== 'admitted') return { status: 'invalid' };
    if (!this.options.verifyAdmission(event.admission, offlineDiscoveryAdmissionBindingV1(event.deposit))) {
      return { status: 'admission_rejected' };
    }
    this.append({ kind: 'admission', record: evidence });
    this.append({ kind: 'ack', ack: event.ack, evidence });
    this.admissions.set(admissionKey(event.ack.requestId, event.ack.generationId), evidence);
    if (existingRequest) lease.quota.redeposit({
      requestId: event.deposit.requestId,
      generationId: event.deposit.generationId,
      ackId: evidence.ackId,
      replayBytes: new TextEncoder().encode(evidence.depositBytes),
      actualBytes: evidence.actualBytes,
    });
    else lease.quota.admit({
      requestId: event.deposit.requestId,
      generationId: event.deposit.generationId,
      replayBytes: new TextEncoder().encode(evidence.depositBytes),
      actualBytes: evidence.actualBytes,
      ackIds: [evidence.ackId],
    });
    lease.quota.acknowledge(event.ack.ackId);
    if (!this.leases.has(event.ack.clientLeaseId)) this.leases.set(event.ack.clientLeaseId, lease);
    const request = existingRequest ?? this.newRequest(lease, event.ack.requestId);
    request.generations.set(event.ack.generationId, {
      depositBytes: evidence.depositBytes,
      deposit: event.deposit,
      admission: event.admission,
      actualBytes: evidence.actualBytes,
      ackId: evidence.ackId,
      ack: event.ack,
    });
    return { status: 'acknowledged' };
  }

  withdraw(withdrawal: LeasedIndexWithdrawalV1): GenerationMailboxAckResult {
    this.ensureWritable();
    if (!verifyLeasedIndexWithdrawalV1(withdrawal)) return { status: 'invalid' };
    const retained = this.leases.get(withdrawal.clientLeaseId)?.withdrawalIndex;
    const index = retained ?? this.options.currentIndex(withdrawal.clientLeaseId)
      ?? this.options.authorizedIndex?.(withdrawal.clientLeaseId);
    if (!index || !withdrawalMatchesIndex(withdrawal, index)) return { status: 'invalid' };
    return this.commitWithdrawal(withdrawal, index);
  }

  private withdrawReplica(
    withdrawal: LeasedIndexWithdrawalV1,
    evidence: LeasedIndexV1,
  ): GenerationMailboxAckResult {
    this.ensureWritable();
    if (!verifyLeasedIndexWithdrawalV1(withdrawal) || !verifyLeasedIndexV1(evidence)
      || !withdrawalMatchesIndex(withdrawal, evidence)) return { status: 'invalid' };
    const retained = this.leases.get(withdrawal.clientLeaseId)?.withdrawalIndex;
    const current = retained ?? this.options.currentIndex(withdrawal.clientLeaseId)
      ?? this.options.authorizedIndex?.(withdrawal.clientLeaseId);
    const historical = this.options.indexForGeneration(createLeasedIndexGenerationIdV1(evidence));
    const authorized = [current, historical].find(index => index
      && serializeLeasedIndexOperationV1(index) === serializeLeasedIndexOperationV1(evidence));
    if (!authorized) return { status: 'invalid' };
    return this.commitWithdrawal(withdrawal, evidence);
  }

  private commitWithdrawal(
    withdrawal: LeasedIndexWithdrawalV1,
    index: LeasedIndexV1,
  ): GenerationMailboxAckResult {
    const existing = this.leases.get(withdrawal.clientLeaseId);
    if (existing?.withdrawal) {
      if (serializeLeasedIndexOperationV1(existing.withdrawal) === serializeLeasedIndexOperationV1(withdrawal)
        && existing.withdrawalIndex
        && serializeLeasedIndexOperationV1(existing.withdrawalIndex) === serializeLeasedIndexOperationV1(index)) {
        return { status: 'duplicate' };
      }
      return { status: 'invalid' };
    }
    const lease = existing ?? this.newLease(withdrawal.clientLeaseId);
    this.append({ kind: 'withdrawal', withdrawal, index });
    lease.withdrawal = withdrawal;
    lease.withdrawalIndex = index;
    for (const request of lease.requests.values()) lease.quota.withdraw(request.requestId);
    if (!existing) this.leases.set(withdrawal.clientLeaseId, lease);
    return { status: 'acknowledged' };
  }

  fetch(mailboxId: string, now: number, limit = 64): string[] {
    const result: { key: string; bytes: string }[] = [];
    for (const lease of this.leases.values()) {
      if (lease.withdrawal) continue;
      for (const request of lease.requests.values()) {
        for (const generation of request.generations.values()) {
          if (generation.deposit.mailboxId !== mailboxId || generation.ack || generation.conflictBytes
            || generation.deposit.expiresAt <= now) continue;
          result.push({ key: generation.deposit.envelopeId, bytes: generation.depositBytes });
        }
      }
    }
    return result.sort((a, b) => a.key.localeCompare(b.key))
      .slice(0, Math.max(0, Math.min(limit, 64))).map(item => item.bytes);
  }

  syncEvents(cursor: number, limit = MAX_SYNC_EVENTS): { events: OfflineDiscoverySyncEventV1[]; nextCursor: number } {
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('Invalid anti-entropy cursor');
    const events: OfflineDiscoverySyncEventV1[] = [];
    let nextCursor = cursor;
    for (const record of this.journal) {
      if (record.sequence <= cursor) continue;
      const event = syncEvent(record);
      if (!event) continue;
      if (events.length >= Math.max(0, Math.min(limit, MAX_SYNC_EVENTS))) break;
      events.push(event);
      nextCursor = record.sequence;
    }
    return { events, nextCursor };
  }

  repairFrom(source: MailboxGenerationStore, clientLeaseId: string, now: number): number {
    let cursor = 0;
    let applied = 0;
    while (true) {
      const page = source.syncEvents(cursor, MAX_SYNC_EVENTS);
      for (const event of page.events) {
        if (eventLeaseId(event) !== clientLeaseId) continue;
        const result = this.applySyncEvent(event, now);
        if (['stored', 'duplicate', 'acknowledged'].includes(result.status)) applied++;
      }
      if (page.nextCursor === cursor) return applied;
      cursor = page.nextCursor;
    }
  }

  compact(now: number): void {
    this.ensureWritable();
    const retained = this.journal.filter(record => journalLiveAfter(record, now));
    if (retained.length === this.journal.length) return;
    const temporary = join(this.directory, `.${basename(this.journalPath)}.${randomBytes(8).toString('hex')}.tmp`);
    let fd: number | undefined;
    try {
      fd = openSync(temporary, 'wx', 0o600);
      for (const record of retained) {
        const bytes = Buffer.from(`${JSON.stringify(record)}\n`);
        writeAll(fd, bytes);
      }
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(temporary, this.journalPath);
      fsyncDirectory(this.directory);
    } catch (error) {
      this.poisoned = true;
      throw error;
    } finally {
      if (fd !== undefined) closeSync(fd);
      rmSync(temporary, { force: true });
    }
    this.load();
  }

  setQuotaLimits(clientLeaseId: string, limits: OfflineDiscoveryQuotaLimitsV1): void {
    const lease = this.leases.get(clientLeaseId) ?? this.newLease(clientLeaseId);
    lease.quota.setLimits(limits);
    if (!this.leases.has(clientLeaseId)) this.leases.set(clientLeaseId, lease);
  }

  quota(clientLeaseId: string) {
    return this.leases.get(clientLeaseId)?.quota.snapshot()
      ?? this.newLease(clientLeaseId).quota.snapshot();
  }

  private commitAck(
    ack: OfflineDiscoveryAckV1,
    generation: GenerationRecord,
    now: number,
  ): GenerationMailboxAckResult {
    if (generation.ack) return { status: generation.ack.signature === ack.signature ? 'duplicate' : 'invalid' };
    const index = this.options.indexForGeneration(generation.deposit.generationId);
    if (!index || !verifyOfflineDiscoveryAckForDepositV1(ack, generation.deposit, index)) {
      return { status: 'invalid' };
    }
    if (now >= ack.requestExpiresAt) return { status: 'expired' };
    const evidence = this.admissionRecord(
      generation.depositBytes,
      generation.admission,
      generation.deposit,
      generation.actualBytes,
    );
    this.append({ kind: 'ack', ack, evidence });
    generation.ack = ack;
    const lease = this.leases.get(ack.clientLeaseId)!;
    lease.quota.acknowledge(ack.ackId);
    return { status: 'acknowledged' };
  }

  private conflictCharge(
    lease: LeaseRecord,
    request: RequestRecord,
    generation: GenerationRecord,
    raw: string,
    deposit: OfflineDiscoveryDepositV1,
  ) {
    return lease.quota.chargeConflict({
      requestId: request.requestId,
      generationId: deposit.generationId,
      ackId: generation.ackId,
      replayBytes: new TextEncoder().encode(raw),
      actualBytes: Buffer.byteLength(raw),
    });
  }

  private admissionRecord(
    depositBytes: string,
    admission: AdmissionCapabilityV2,
    deposit: OfflineDiscoveryDepositV1,
    actualBytes: number,
  ): AdmissionRecord {
    return { depositBytes, admission, actualBytes, ackId: ackIdForDeposit(deposit) };
  }

  private newLease(clientLeaseId: string): LeaseRecord {
    return { quota: new OfflineDiscoveryQuotaLedgerV1(), requests: new Map() };
  }

  private newRequest(lease: LeaseRecord, requestId: string): RequestRecord {
    const request = { requestId, generations: new Map<string, GenerationRecord>() };
    lease.requests.set(requestId, request);
    return request;
  }

  private findGeneration(clientLeaseId: string, requestId: string, generationId: string): GenerationRecord | undefined {
    return this.leases.get(clientLeaseId)?.requests.get(requestId)?.generations.get(generationId);
  }

  private append(entry: JournalEntry): void {
    this.ensureWritable();
    const record = { sequence: (this.journal.at(-1)?.sequence ?? 0) + 1, entry };
    try {
      appendFileSync(this.journalPath, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
      const fd = openSync(this.journalPath, 'r');
      try { fsyncSync(fd); } finally { closeSync(fd); }
    } catch (error) {
      this.poisoned = true;
      throw error;
    }
    this.journal.push(record);
  }

  private load(): void {
    this.leases = new Map();
    this.admissions = new Map();
    this.journal = [];
    this.poisoned = false;
    if (!existsSync(this.journalPath)) return;
    const data = readFileSync(this.journalPath);
    const lastNewline = data.lastIndexOf(0x0a);
    if (lastNewline + 1 !== data.length) truncateSync(this.journalPath, lastNewline + 1);
    if (lastNewline < 0) return;
    const lines = data.subarray(0, lastNewline).toString('utf8').split('\n');
    for (const line of lines) {
      const record = JSON.parse(line) as JournalRecord;
      if (!Number.isSafeInteger(record.sequence)
        || record.sequence <= (this.journal.at(-1)?.sequence ?? 0)) {
        throw new Error('Invalid generation mailbox journal sequence');
      }
      this.replay(record.entry);
      this.journal.push(record);
    }
  }

  private replay(entry: JournalEntry): void {
    if (entry.kind === 'admission') {
      const deposit = parseOfflineDiscoveryDepositV1(entry.record.depositBytes);
      this.admissions.set(admissionKey(deposit.requestId, deposit.generationId), entry.record);
      return;
    }
    if (entry.kind === 'withdrawal') {
      if (!withdrawalMatchesIndex(entry.withdrawal, entry.index)) {
        throw new Error('Invalid journaled withdrawal authorization');
      }
      const lease = this.leases.get(entry.withdrawal.clientLeaseId) ?? this.newLease(entry.withdrawal.clientLeaseId);
      lease.withdrawal = entry.withdrawal;
      lease.withdrawalIndex = entry.index;
      for (const request of lease.requests.values()) lease.quota.withdraw(request.requestId);
      if (!this.leases.has(entry.withdrawal.clientLeaseId)) this.leases.set(entry.withdrawal.clientLeaseId, lease);
      return;
    }
    const evidence = entry.kind === 'ack' ? entry.evidence : entry.record;
    const deposit = parseOfflineDiscoveryDepositV1(evidence.depositBytes);
    const lease = this.leases.get(deposit.clientLeaseId) ?? this.newLease(deposit.clientLeaseId);
    if (!this.leases.has(deposit.clientLeaseId)) this.leases.set(deposit.clientLeaseId, lease);
    if (entry.kind === 'ack') {
      if (!verifyOfflineDiscoveryAckV1(entry.ack)) throw new Error('Invalid journaled ACK');
      let generation = this.findGeneration(deposit.clientLeaseId, deposit.requestId, deposit.generationId);
      if (!generation) {
        const request = lease.requests.get(deposit.requestId);
        const status = request ? lease.quota.redeposit({
          requestId: deposit.requestId,
          generationId: deposit.generationId,
          ackId: evidence.ackId,
          replayBytes: new TextEncoder().encode(evidence.depositBytes),
          actualBytes: evidence.actualBytes,
        }) : lease.quota.admit({
          requestId: deposit.requestId,
          generationId: deposit.generationId,
          replayBytes: new TextEncoder().encode(evidence.depositBytes),
          actualBytes: evidence.actualBytes,
          ackIds: [evidence.ackId],
        });
        if (status.status !== 'admitted') throw new Error('Journaled ACK exceeds accepted quota');
        const targetRequest = request ?? this.newRequest(lease, deposit.requestId);
        targetRequest.generations.set(deposit.generationId, {
          depositBytes: evidence.depositBytes,
          deposit,
          admission: evidence.admission,
          actualBytes: evidence.actualBytes,
          ackId: evidence.ackId,
        });
        generation = targetRequest.generations.get(deposit.generationId)!;
      }
      generation.ack = entry.ack;
      lease.quota.acknowledge(entry.ack.ackId);
      return;
    }
    const quotaInput = {
      requestId: deposit.requestId,
      generationId: deposit.generationId,
      replayBytes: new TextEncoder().encode(evidence.depositBytes),
      actualBytes: evidence.actualBytes,
      ackIds: [evidence.ackId],
    };
    const request = lease.requests.get(deposit.requestId);
    if (entry.kind === 'conflict') {
      const generation = request?.generations.get(deposit.generationId);
      if (!generation) throw new Error('Orphaned journaled conflict');
      lease.quota.chargeConflict({
        requestId: deposit.requestId,
        generationId: deposit.generationId,
        ackId: evidence.ackId,
        replayBytes: new TextEncoder().encode(evidence.depositBytes),
        actualBytes: Buffer.byteLength(evidence.depositBytes),
      });
      generation.conflictBytes = evidence.depositBytes;
      generation.conflictDeposit = deposit;
      return;
    }
    const status = request ? lease.quota.redeposit({
      requestId: deposit.requestId,
      generationId: deposit.generationId,
      ackId: evidence.ackId,
      replayBytes: new TextEncoder().encode(evidence.depositBytes),
      actualBytes: evidence.actualBytes,
    }) : lease.quota.admit(quotaInput);
    if (status.status !== 'admitted') throw new Error('Journaled deposit exceeds accepted quota');
    const targetRequest = request ?? this.newRequest(lease, deposit.requestId);
    targetRequest.generations.set(deposit.generationId, {
      depositBytes: evidence.depositBytes,
      deposit,
      admission: evidence.admission,
      actualBytes: evidence.actualBytes,
      ackId: evidence.ackId,
    });
  }

  private ensureWritable(): void {
    if (this.poisoned) throw new Error('Mailbox journal write failed; reopen before reuse');
  }
}

function withdrawalMatchesIndex(
  withdrawal: LeasedIndexWithdrawalV1,
  index: LeasedIndexV1,
): boolean {
  return verifyLeasedIndexWithdrawalV1(withdrawal)
    && verifyLeasedIndexV1(index)
    && withdrawal.publicationId === index.publicationId
    && withdrawal.publicationKey === index.publicationKey
    && withdrawal.clientLeaseId === index.clientLeaseId
    && withdrawal.leaseSequence <= index.leaseSequence + 1
    && withdrawal.semanticRevision <= index.semanticRevision;
}

function matchesIndex(deposit: OfflineDiscoveryDepositV1, index: LeasedIndexV1): boolean {
  return deposit.generationId === createLeasedIndexGenerationIdV1(index)
    && deposit.clientLeaseId === index.clientLeaseId
    && deposit.publicationId === index.publicationId
    && deposit.mailboxId === index.mailbox.id
    && deposit.envelope.mailboxEncryptionKey === index.mailbox.encryptionKey;
}

function validReplacementLink(request: RequestRecord, deposit: OfflineDiscoveryDepositV1): boolean {
  if (deposit.previousGenerationId === undefined || deposit.previousEnvelopeId === undefined) return false;
  const previous = request.generations.get(deposit.previousGenerationId);
  if (!previous || previous.deposit.envelopeId !== deposit.previousEnvelopeId) return false;
  return Array.from(request.generations.values()).every(generation => (
    generation.deposit.requestId === deposit.requestId
    && generation.deposit.clientLeaseId === deposit.clientLeaseId
    && generation.deposit.expiresAt === deposit.expiresAt
    && generation.deposit.createdAt === deposit.createdAt
  ));
}

function admissionKey(requestId: string, generationId: string): string {
  return `${requestId}\n${generationId}`;
}

function ackIdForDeposit(deposit: OfflineDiscoveryDepositV1): string {
  return createOfflineDiscoveryAckIdForReplicaKeyV1({
    clientLeaseId: deposit.clientLeaseId,
    mailboxId: deposit.mailboxId,
    generationId: deposit.generationId,
    envelopeId: deposit.envelopeId,
  });
}

function admissionBytes(raw: string, admission: AdmissionCapabilityV2): number {
  return Buffer.byteLength(raw) + Buffer.byteLength(JSON.stringify(admission)) + 256;
}

function syncEvent(record: JournalRecord): OfflineDiscoverySyncEventV1 | undefined {
  if (record.entry.kind === 'deposit' || record.entry.kind === 'conflict') {
    const deposit = parseOfflineDiscoveryDepositV1(record.entry.record.depositBytes);
    return { kind: 'deposit', deposit, admission: record.entry.record.admission };
  }
  if (record.entry.kind === 'ack') {
    const deposit = parseOfflineDiscoveryDepositV1(record.entry.evidence.depositBytes);
    return { kind: 'ack', ack: record.entry.ack, deposit, admission: record.entry.evidence.admission };
  }
  if (record.entry.kind === 'withdrawal') {
    return { kind: 'withdrawal', withdrawal: record.entry.withdrawal, index: record.entry.index };
  }
  return undefined;
}

function eventLeaseId(event: OfflineDiscoverySyncEventV1): string {
  return event.kind === 'withdrawal' ? event.withdrawal.clientLeaseId : event.deposit.clientLeaseId;
}

function journalLiveAfter(record: JournalRecord, now: number): boolean {
  if (record.entry.kind === 'withdrawal') return true;
  const evidence = record.entry.kind === 'ack' ? record.entry.evidence : record.entry.record;
  return parseOfflineDiscoveryDepositV1(evidence.depositBytes).expiresAt > now;
}

function writeAll(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
}

function fsyncDirectory(path: string): void {
  if (process.platform === 'win32') return;
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
