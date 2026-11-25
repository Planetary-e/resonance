import fs, {
  existsSync,
  lstatSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface DiskActivityEvent {
  atMicros: number;
  sequence: number;
  operation: string;
  deltaBytes: number;
}

export function realDirectoryBytes(path: string): number {
  try {
    const stats = lstatSync(path);
    if (stats.isFile()) return stats.size;
    if (!stats.isDirectory()) return 0;
  } catch { return 0; }
  let total = 0;
  let entries;
  try { entries = readdirSync(path, { withFileTypes: true }); }
  catch { return 0; }
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) total += realDirectoryBytes(child);
    else if (entry.isFile()) {
      try { total += lstatSync(child).size; } catch { /* Concurrent replacement. */ }
    }
  }
  return total;
}

export function summarizeDiskActivity(baselineBytes: number, events: readonly DiskActivityEvent[]) {
  const ordered = [...events].sort((first, second) => (
    first.atMicros - second.atMicros || first.sequence - second.sequence
    || first.operation.localeCompare(second.operation)
  ));
  let finalBytes = baselineBytes;
  let eventOrderedPeakBytes = baselineBytes;
  let upper = baselineBytes;
  let peakUpperBoundBytes = baselineBytes;
  let lower = baselineBytes;
  let peakLowerBoundBytes = baselineBytes;
  const operationCounts: Record<string, number> = {};
  let index = 0;
  while (index < ordered.length) {
    const atMicros = ordered[index].atMicros;
    const group: DiskActivityEvent[] = [];
    while (index < ordered.length && ordered[index].atMicros === atMicros) {
      group.push(ordered[index++]);
    }
    for (const event of group) {
      finalBytes += event.deltaBytes;
      eventOrderedPeakBytes = Math.max(eventOrderedPeakBytes, finalBytes);
      operationCounts[event.operation] = (operationCounts[event.operation] ?? 0) + 1;
    }
    upper += group.filter(event => event.deltaBytes > 0).reduce((sum, event) => sum + event.deltaBytes, 0);
    peakUpperBoundBytes = Math.max(peakUpperBoundBytes, upper);
    upper += group.filter(event => event.deltaBytes < 0).reduce((sum, event) => sum + event.deltaBytes, 0);
    lower += group.filter(event => event.deltaBytes < 0).reduce((sum, event) => sum + event.deltaBytes, 0);
    lower += group.filter(event => event.deltaBytes > 0).reduce((sum, event) => sum + event.deltaBytes, 0);
    peakLowerBoundBytes = Math.max(peakLowerBoundBytes, lower);
  }
  return {
    baselineBytes,
    finalBytes,
    eventOrderedPeakBytes,
    peakLowerBoundBytes,
    peakUpperBoundBytes,
    eventCount: ordered.length,
    operationCounts,
  };
}

let active: HarnessDiskAccounting | undefined;

export class HarnessDiskAccounting {
  private readonly root: string;
  private readonly aliases: string[];
  private readonly baselineBytes: number;
  private readonly activity: DiskActivityEvent[] = [];
  private readonly descriptors = new Map<number, string>();
  private readonly originals: Record<string, any> = {};
  private sequence = 0;
  private mutationDepth = 0;
  private installed = true;

  constructor(root: string) {
    if (active) throw new Error('Harness disk accounting is already installed');
    this.root = resolve(root);
    this.aliases = [...new Set([this.root, canonicalBase(this.root)])];
    this.baselineBytes = realDirectoryBytes(this.root);
    active = this;
    this.instrument();
  }

  snapshot() {
    return summarizeDiskActivity(this.baselineBytes, this.activity);
  }

  summary(additionalEvents: readonly DiskActivityEvent[] = []) {
    return summarizeDiskActivity(this.baselineBytes, [...this.activity, ...additionalEvents]);
  }

  events(): DiskActivityEvent[] {
    return this.activity.map(event => ({ ...event }));
  }

  reconcile(additionalEvents: readonly DiskActivityEvent[] = []) {
    const summary = this.summary(additionalEvents);
    const actualFinalBytes = realDirectoryBytes(this.root);
    return { ...summary, actualFinalBytes, matchesActualFinalBytes: summary.finalBytes === actualFinalBytes };
  }

  restore(): void {
    if (!this.installed) return;
    this.installed = false;
    for (const [name, original] of Object.entries(this.originals)) (fs as any)[name] = original;
    syncBuiltinESMExports();
    if (active === this) active = undefined;
  }

  private instrument(): void {
    this.replace('writeFileSync', args => [this.target(args[0])]);
    this.replace('appendFileSync', args => [this.target(args[0])]);
    this.replace('writeSync', args => [this.target(args[0])]);
    this.replace('writevSync', args => [this.target(args[0])]);
    this.replace('truncateSync', args => [this.target(args[0])]);
    this.replace('ftruncateSync', args => [this.target(args[0])]);
    this.replace('renameSync', args => [this.target(args[0]), this.target(args[1])]);
    this.replace('rmSync', args => [this.target(args[0])]);
    this.replace('unlinkSync', args => [this.target(args[0])]);
    this.replace('cpSync', args => [this.target(args[0]), this.target(args[1])]);
    this.replace('copyFileSync', args => [this.target(args[0]), this.target(args[1])]);
    this.replace('linkSync', args => [this.target(args[0]), this.target(args[1])]);

    this.originals.openSync = fs.openSync;
    (fs as any).openSync = (path: any, ...args: any[]) => {
      const target = this.target(path);
      const fd = this.originals.openSync.call(fs, path, ...args);
      if (target !== undefined) {
        this.descriptors.set(fd, target);
        this.record('openSync', 0);
      }
      return fd;
    };
    this.originals.closeSync = fs.closeSync;
    (fs as any).closeSync = (fd: number) => {
      try { return this.originals.closeSync.call(fs, fd); }
      finally { this.descriptors.delete(fd); }
    };
    for (const name of ['mkdirSync', 'rmdirSync']) {
      this.originals[name] = (fs as any)[name];
      (fs as any)[name] = (...args: any[]) => {
        const target = this.target(args[0]);
        const result = this.originals[name].apply(fs, args);
        if (target !== undefined) this.record(name, 0);
        return result;
      };
    }
    syncBuiltinESMExports();
  }

  private replace(name: string, targets: (args: any[]) => (string | undefined)[]): void {
    const original = (fs as any)[name];
    this.originals[name] = original;
    (fs as any)[name] = (...args: any[]) => {
      const paths = targets(args).filter((path): path is string => path !== undefined);
      if (paths.length === 0 || this.mutationDepth > 0) return original.apply(fs, args);
      const before = paths.map(path => realDirectoryBytes(path));
      this.mutationDepth++;
      try { return original.apply(fs, args); }
      finally {
        this.mutationDepth--;
        const after = paths.map(path => realDirectoryBytes(path));
        this.record(name, after.reduce((sum, value, index) => sum + value - before[index], 0));
      }
    };
  }

  private target(value: any): string | undefined {
    if (typeof value === 'number') return this.descriptors.get(value);
    let path: string;
    if (typeof value === 'string') path = value;
    else if (Buffer.isBuffer(value)) path = value.toString();
    else if (value instanceof URL) path = fileURLToPath(value);
    else return undefined;
    const resolved = resolve(path);
    return this.aliases.some(alias => resolved === alias || resolved.startsWith(`${alias}${sep}`))
      ? resolved
      : undefined;
  }

  private record(operation: string, deltaBytes: number): void {
    this.activity.push({
      atMicros: Math.floor((performance.timeOrigin + performance.now()) * 1000),
      sequence: ++this.sequence,
      operation,
      deltaBytes,
    });
  }
}

function canonicalBase(path: string): string {
  let current = resolve(path);
  const missing: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return resolve(path);
    missing.unshift(basename(current));
    current = parent;
  }
  return join(realpathSync(current), ...missing);
}
