import {
  constants,
  monitorEventLoopDelay,
  PerformanceObserver,
} from 'node:perf_hooks';

const GC_ENTRY_LIMIT = 128;
const RPC_ENTRY_LIMIT = 256;

export function memorySample() {
  const value = process.memoryUsage();
  return {
    rssBytes: value.rss,
    heapUsedBytes: value.heapUsed,
    heapTotalBytes: value.heapTotal,
    externalBytes: value.external,
    arrayBuffersBytes: value.arrayBuffers,
  };
}

export class RuntimeTelemetry {
  private readonly loopDelay = monitorEventLoopDelay({ resolution: 20 });
  private readonly observer: PerformanceObserver;
  private gcEntries: Array<{ atMicros: number; kind: string; durationMs: number }> = [];
  private gcTotals = { count: 0, durationMs: 0, droppedEntries: 0 };

  constructor() {
    this.loopDelay.enable();
    this.observer = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        const kind = (entry as any).detail?.kind;
        const name = kind === constants.NODE_PERFORMANCE_GC_MAJOR ? 'major'
          : kind === constants.NODE_PERFORMANCE_GC_MINOR ? 'minor'
            : kind === constants.NODE_PERFORMANCE_GC_INCREMENTAL ? 'incremental'
              : kind === constants.NODE_PERFORMANCE_GC_WEAKCB ? 'weakcb' : 'other';
        this.gcTotals.count++;
        this.gcTotals.durationMs += entry.duration;
        this.gcEntries.push({
          atMicros: Math.floor((performance.timeOrigin + performance.now()) * 1000),
          kind: name,
          durationMs: entry.duration,
        });
        if (this.gcEntries.length > GC_ENTRY_LIMIT) {
          this.gcEntries.shift();
          this.gcTotals.droppedEntries++;
        }
      }
    });
    this.observer.observe({ entryTypes: ['gc'] });
  }

  sample() {
    const milliseconds = (value: number) => Number.isFinite(value) ? value / 1e6 : 0;
    const delay = {
      meanMs: milliseconds(this.loopDelay.mean),
      maxMs: milliseconds(this.loopDelay.max),
      p50Ms: milliseconds(this.loopDelay.percentile(50)),
      p95Ms: milliseconds(this.loopDelay.percentile(95)),
      p99Ms: milliseconds(this.loopDelay.percentile(99)),
    };
    this.loopDelay.reset();
    const gc = { ...this.gcTotals, entries: this.gcEntries.splice(0) };
    return { eventLoopDelay: delay, gc };
  }

  stop(): void {
    this.loopDelay.disable();
    this.observer.disconnect();
  }
}

export class RpcTelemetry {
  private readonly active = new Map<string, number>();
  private readonly maximumActive = new Map<string, number>();
  private readonly totals = new Map<string, { count: number; totalMs: number; maxMs: number }>();
  private readonly completed: Array<{ relayIndex: number; phase: string; durationMs: number; atMicros: number }> = [];

  async measure<T>(relayIndex: number, phase: string, operation: () => Promise<T>): Promise<T> {
    const key = `${relayIndex}:${phase}`;
    const active = (this.active.get(key) ?? 0) + 1;
    this.active.set(key, active);
    this.maximumActive.set(key, Math.max(this.maximumActive.get(key) ?? 0, active));
    const started = performance.now();
    try { return await operation(); }
    finally {
      this.active.set(key, (this.active.get(key) ?? 1) - 1);
      const durationMs = performance.now() - started;
      const total = this.totals.get(key) ?? { count: 0, totalMs: 0, maxMs: 0 };
      total.count++;
      total.totalMs += durationMs;
      total.maxMs = Math.max(total.maxMs, durationMs);
      this.totals.set(key, total);
      this.completed.push({
        relayIndex,
        phase,
        durationMs,
        atMicros: Math.floor((performance.timeOrigin + performance.now()) * 1000),
      });
      if (this.completed.length > RPC_ENTRY_LIMIT) this.completed.shift();
    }
  }

  snapshot(relayIndex?: number) {
    const selected = relayIndex === undefined
      ? this.completed
      : this.completed.filter(entry => entry.relayIndex === relayIndex);
    const phases = [...new Set([
      ...this.active.keys(),
      ...this.maximumActive.keys(),
      ...this.totals.keys(),
    ])].filter(key => relayIndex === undefined || key.startsWith(`${relayIndex}:`));
    return {
      active: Object.fromEntries(phases.map(key => [key, this.active.get(key) ?? 0])),
      maximumActive: Object.fromEntries(phases.map(key => [key, this.maximumActive.get(key) ?? 0])),
      totals: Object.fromEntries(phases.map(key => [key, this.totals.get(key)])),
      completed: selected.map(entry => ({ ...entry })),
    };
  }
}

export interface OperationContentionRecord {
  sequence: number;
  kind: 'publish' | 'search' | 'mailbox';
  outcome: 'good' | 'refused' | 'retry' | 'uncertain' | 'deadline_exceeded' | 'inconclusive';
  errorClass?: string;
  phases?: Record<string, number>;
  contention?: unknown;
}

export function attachOperationContention(
  record: OperationContentionRecord,
  relays: Array<{ index: number; contentionSnapshot(): unknown }>,
): void {
  record.contention = relays.map(relay => ({
    relayIndex: relay.index,
    samples: relay.contentionSnapshot(),
  }));
}

export function attachDeadlineContention(
  record: OperationContentionRecord,
  relays: Array<{ index: number; contentionSnapshot(): unknown }>,
): void {
  if (record.outcome === 'deadline_exceeded') attachOperationContention(record, relays);
}

export function operationContentionEvidence(records: readonly OperationContentionRecord[]) {
  return records.filter(record => record.contention).map(record => ({
    sequence: record.sequence,
    kind: record.kind,
    outcome: record.outcome,
    errorClass: record.errorClass,
    phases: record.phases,
    relays: record.contention,
  }));
}
