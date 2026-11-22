import { fork, type ChildProcess } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  createLeasedIndexV1,
  createOriginalCommitmentV1,
  generateOriginalCommitmentKeyV1,
  verifyAdmissionCapabilityV2,
  type AdmissionCapabilityV2,
  type LeasedIndexKeyMaterialV1,
  type RelayDescriptorV1,
} from '@resonance/core';
import type {
  AdmissionCapabilityProviderV2,
  AdmissionCapabilityRequestContextV2,
} from '../../relay-client.js';

export function digest(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('base64url');
}

export const admissionProvider: AdmissionCapabilityProviderV2 = Object.assign(
  (context: AdmissionCapabilityRequestContextV2): AdmissionCapabilityV2 => ({
    version: 2,
    kind: 'admission-capability',
    scheme: 'live-test-v1',
    issuer: 'community:test',
    token: digest(`token:${context.requestBinding}`),
    requestProof: digest(context.requestBinding),
  }),
  { assertMaintenanceDestination: () => {} },
);

export const ADMISSION_FOR_LOCAL: AdmissionCapabilityV2 = {
  version: 2,
  kind: 'admission-capability',
  scheme: 'live-test-v1',
  issuer: 'community:test',
  token: 'A'.repeat(43),
  requestProof: 'B'.repeat(43),
};

export function fixedIndex(
  keys: LeasedIndexKeyMaterialV1,
  createdAt: number,
  expiresAt: number,
  fill = 1,
  leaseSequence = 0,
) {
  return createLeasedIndexV1({
    leaseSequence,
    groupId: 'public',
    itemType: 'need',
    derivationId: 'process-death-control-v1',
    fingerprintEpoch: 'epoch-1',
    fingerprint: new Uint8Array(64).fill(fill),
    originalCommitment: createOriginalCommitmentV1(new Uint8Array(8), generateOriginalCommitmentKeyV1()),
    createdAt,
    expiresAt,
  }, keys);
}

export interface ProcessDeathEvidence {
  pid: number;
  signal: string | null;
  barrier: string;
}

class FixtureProcess {
  readonly child: ChildProcess;
  readonly token = randomBytes(32).toString('base64url');
  readonly ready: Promise<void>;
  protected readonly exited: Promise<[number | null, NodeJS.Signals | null]>;
  private nextId = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  private stderr = '';
  protected lastBarrier = 'process-loss';

  constructor(fixtureName: string, environment: Record<string, string>) {
    const fixture = fileURLToPath(new URL(`./${fixtureName}`, import.meta.url));
    this.child = fork(fixture, [], {
      cwd: process.cwd(),
      execArgv: ['--import', 'tsx'],
      env: { ...process.env, ...environment, RESONANCE_TEST_CONTROL_TOKEN: this.token },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    this.child.stderr?.on('data', chunk => { this.stderr += String(chunk); });
    this.exited = new Promise(resolve => this.child.once('exit', (code, signal) => resolve([code, signal])));
    this.ready = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Fixture did not start: ${this.stderr}`)), 10_000);
      this.child.on('message', (message: any) => {
        if (message.event === 'ready') {
          clearTimeout(timeout);
          this.readyMessage(message);
          resolve();
        }
        if (message.event === 'failed') {
          clearTimeout(timeout);
          reject(new Error(message.error));
        }
        if (typeof message.id !== 'number') return;
        const request = this.pending.get(message.id);
        if (!request) return;
        this.pending.delete(message.id);
        if (message.error) request.reject(new Error(message.error));
        else request.resolve(message.result);
      });
      this.child.once('exit', code => {
        clearTimeout(timeout);
        reject(new Error(`Fixture exited ${code}: ${this.stderr}`));
        for (const request of this.pending.values()) request.reject(new Error('Fixture process exited'));
        this.pending.clear();
      });
    });
  }

  protected readyMessage(_message: any): void {}

  request(command: string, fields: Record<string, unknown> = {}): Promise<any> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.send({ id, command, token: this.token, ...fields });
    });
  }

  async kill(barrier = this.lastBarrier): Promise<ProcessDeathEvidence> {
    const pid = this.child.pid!;
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGKILL');
    const [, signal] = await this.exited;
    if (signal !== 'SIGKILL') throw new Error(`Expected SIGKILL, received ${signal ?? 'no signal'}`);
    return { pid, signal, barrier };
  }

  async stop(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    try { await this.request('stop'); } finally { await this.exited; }
  }
}

export class ProcessRelay extends FixtureProcess {
  descriptor!: RelayDescriptorV1;
  endpoint!: string;

  private constructor(persistDir: string, approvedRelays: string[]) {
    super('client-held-relay-process.ts', {
      RESONANCE_TEST_CLIENT_HELD_RELAY: JSON.stringify({ persistDir, approvedRelays }),
    });
  }

  static async start(persistDir: string, approvedRelays: string[] = []): Promise<ProcessRelay> {
    const relay = new ProcessRelay(persistDir, approvedRelays);
    await relay.ready;
    return relay;
  }

  protected readyMessage(message: any): void {
    this.descriptor = message.descriptor;
    this.endpoint = message.descriptor.endpoints[0];
  }

  async arm(barrier: string, raw: string): Promise<void> {
    this.lastBarrier = barrier;
    await this.request('arm', { barrier, binding: digest(raw) });
  }

  async authenticatedSpends(): Promise<number> {
    return (await this.request('stats')).authenticatedSpends;
  }
}

export class LocalProcess extends FixtureProcess {
  private constructor(kind: 'offline' | 'content', path: string, key: Uint8Array) {
    super('client-held-local-process.ts', {
      RESONANCE_TEST_CLIENT_HELD_LOCAL: JSON.stringify({
        kind,
        path,
        key: Buffer.from(key).toString('base64url'),
      }),
    });
  }

  static async start(
    kind: 'offline' | 'content',
    path: string,
    key: Uint8Array,
  ): Promise<LocalProcess> {
    const process = new LocalProcess(kind, path, key);
    await process.ready;
    return process;
  }

  async run(barrier: string, options: { raw?: string; recordId?: string; now?: number }): Promise<any> {
    this.lastBarrier = barrier;
    const source = options.raw ?? options.recordId;
    if (!source) throw new Error('A local crash barrier requires an exact operation or record');
    return this.request('run', { barrier, ...options, binding: digest(source) });
  }
}
