/** Offline capacity model only: no MPC, anonymity, packet-loss or energy qualification. */
export const PRIVATE_SCHEDULE = Object.freeze({ slotMs: 500, wireBytes: 4096, overheadReserveBytes: 1024,
  payloadBytes: 3072, accessHourlyCap: 64 * 1024 ** 2, allHourlyCap: 256 * 1024 ** 2,
  otherEdgesBytesPerSecond: 32 * 1024 });
export const CAPTURED_SCHEDULE_PAYLOAD = Object.freeze({ requestBytes: 15495, replyBytes: 11213 });
type Interval = { startMs: number; endMs: number };
export interface PrivateScheduleInput {
  durationMs: number;
  profile?: { slotMs: number; wireBytes: number; usefulBytes: number };
  clients: Array<{ id: string; enrollment: Interval[]; startupAccessBytes?: number; startupAllBytes?: number }>;
  submissions: Array<{ id: string; clientId: string; atMs: number; requestBytes?: number; replyBytes?: number; processingMs: number }>;
  maxPendingPerClient?: number;
  deadlineMs?: number;
  /** Deterministic synthetic cell loss, not packet-loss qualification. Retry uses a later fixed slot. */
  droppedCells?: Array<{ clientId: string; tick: number; lane: 0 | 1 | 2 | 3 }>;
}
type Status = 'pending' | 'completed' | 'rejected' | 'failed';
type Operation = { id: string; clientId: string; atMs: number; requestBytes: number; replyBytes: number; processingMs: number;
  deadline: number; status: Status; reason: string | null; completedAtMs: number | null; requestRemaining: number; replyRemaining: number; readyAt: number | null };
type Cell = { op: Operation; payload: number };
function integer(n: unknown, name: string, min: number, max: number): asserts n is number {
  if (!Number.isSafeInteger(n) || (n as number) < min || (n as number) > max) throw new Error(`Invalid ${name}`);
}
function identifier(value: unknown) { if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(value)) throw new Error('Invalid identifier'); }
function quantile(values: number[], fraction: number) {
  if (!values.length) return { value: null, reason: 'no-submissions' };
  const value = values[Math.ceil(values.length * fraction) - 1];
  return Number.isFinite(value) ? { value, reason: null } : { value: null, reason: 'infinite-failed-or-rejected' };
}
export function evaluatePrivateSchedule(input: PrivateScheduleInput) {
  const profile = input.profile ?? { slotMs: 500, wireBytes: 4096, usefulBytes: 3072 };
  if (![[500, 4096, 3072], [250, 2048, 1536], [125, 1024, 768]].some(p => p[0] === profile.slotMs && p[1] === profile.wireBytes && p[2] === profile.usefulBytes)) throw new Error('Invalid profile');
  const { slotMs, wireBytes, usefulBytes } = profile;
  integer(input.durationMs, 'duration', slotMs, 3_600_000);
  if (input.durationMs % slotMs) throw new Error('Duration must align to slots');
  if (!Array.isArray(input.clients) || input.clients.length < 1 || input.clients.length > 32
    || !Array.isArray(input.submissions) || input.submissions.length > 10000
    || input.durationMs / slotMs * (input.submissions.length + input.clients.length) > 50_000_000) throw new Error('Simulation bounds exceeded');
  const maximum = input.maxPendingPerClient ?? 32, deadlineMs = input.deadlineMs ?? 10000;
  integer(maximum, 'queue limit', 1, 128); integer(deadlineMs, 'deadline', 1, 10000);
  const ids = new Set<string>();
  const clients = input.clients.map(client => {
    identifier(client.id); if (ids.has(client.id)) throw new Error('Duplicate client'); ids.add(client.id);
    if (!Array.isArray(client.enrollment) || client.enrollment.length > 100) throw new Error('Invalid enrollment');
    let previous = -1;
    for (const interval of client.enrollment) {
      integer(interval.startMs, 'enrollment start', 0, input.durationMs); integer(interval.endMs, 'enrollment end', 0, input.durationMs);
      if (interval.startMs % slotMs || interval.endMs % slotMs || interval.startMs < previous || interval.endMs <= interval.startMs) throw new Error('Invalid enrollment intervals');
      previous = interval.endMs;
    }
    const access = client.startupAccessBytes ?? 0, all = client.startupAllBytes ?? 0;
    integer(access, 'startup access', 0, 1024 ** 3); integer(all, 'startup all', access, 1024 ** 3);
    return { id: client.id, enrollment: client.enrollment, lanes: [[], [], [], []] as Cell[][],
      accessBytes: access, transportBytes: 0, reservedBytes: 0, startupAllBytes: all, slots: 0, realCells: 0, lostCells: 0, deliveredPayloadBytes: 0 };
  });
  const byClient = new Map(clients.map(client => [client.id, client]));
  const opIds = new Set<string>();
  const operations: Operation[] = input.submissions.map(submission => {
    identifier(submission.id); if (opIds.has(submission.id) || !byClient.has(submission.clientId)) throw new Error('Duplicate operation or unknown client'); opIds.add(submission.id);
    integer(submission.atMs, 'submission time', 0, input.durationMs); integer(submission.processingMs, 'processing', 0, 60000);
    const requestBytes = submission.requestBytes ?? CAPTURED_SCHEDULE_PAYLOAD.requestBytes;
    const replyBytes = submission.replyBytes ?? CAPTURED_SCHEDULE_PAYLOAD.replyBytes;
    integer(requestBytes, 'request bytes', 1, 1024 ** 2); integer(replyBytes, 'reply bytes', 1, 1024 ** 2);
    return { ...submission, requestBytes, replyBytes, deadline: submission.atMs + deadlineMs, status: 'pending', reason: null,
      completedAtMs: null, requestRemaining: Math.ceil(requestBytes / usefulBytes), replyRemaining: Math.ceil(replyBytes / usefulBytes), readyAt: null };
  });
  if (operations.reduce((n, op) => n + op.requestRemaining + op.replyRemaining, 0) > 262144) throw new Error('Fragment bound exceeded');
  const clientOperations = new Map(clients.map(client => [client.id, operations.filter(op => op.clientId === client.id)]));
  const admitted = new Set<Operation>();
  const drops = new Set<string>();
  if (!Array.isArray(input.droppedCells ?? []) || (input.droppedCells?.length ?? 0) > 10000) throw new Error('Invalid loss bounds');
  for (const drop of input.droppedCells ?? []) {
    if (!byClient.has(drop.clientId)) throw new Error('Unknown loss client');
    integer(drop.tick, 'loss tick', 0, input.durationMs / slotMs - 1); integer(drop.lane, 'loss lane', 0, 3);
    const key = `${drop.clientId}:${drop.tick}:${drop.lane}`; if (drops.has(key)) throw new Error('Duplicate loss cell'); drops.add(key);
  }
  const arrivals = operations.map((op, index) => ({ op, index })).sort((a, b) => a.op.atMs - b.op.atMs || a.index - b.index);
  const enrolled = (client: typeof clients[number], time: number) => client.enrollment.some(interval => time >= interval.startMs && time < interval.endMs);
  function fragment(op: Operation, bytes: number, lane: Cell[]) {
    for (let left = bytes; left > 0; left -= usefulBytes) lane.push({ op, payload: Math.min(left, usefulBytes) });
  }
  let arrival = 0;
  for (let tick = 0; tick < input.durationMs / slotMs; tick++) {
    const time = tick * slotMs, end = time + slotMs;
    for (const op of operations) if (op.status === 'pending' && op.deadline <= time) { op.status = 'failed'; op.reason = 'deadline'; }
    for (const op of admitted) if (op.status === 'pending' && !enrolled(byClient.get(op.clientId)!, time)) { op.status = 'failed'; op.reason = 'enrollment-ended'; }
    // Arrivals between boundaries enter at the next slot; their original deadlines do not move.
    while (arrival < arrivals.length && arrivals[arrival].op.atMs <= time) {
      const op = arrivals[arrival++].op, client = byClient.get(op.clientId)!;
      if (op.status !== 'pending') continue;
      if (!enrolled(client, op.atMs)) { op.status = 'rejected'; op.reason = 'not-enrolled'; }
      else if (!enrolled(client, time)) { op.status = 'failed'; op.reason = 'enrollment-ended'; }
      else if (clientOperations.get(op.clientId)!.filter(other => admitted.has(other) && other.status === 'pending').length >= maximum) {
        op.status = 'rejected'; op.reason = 'queue-capacity';
      } else if (op.status === 'pending') { admitted.add(op); fragment(op, op.requestBytes, client.lanes[0]); }
    }
    for (const client of clients) {
      if (!enrolled(client, time)) continue;
      client.slots++; client.accessBytes += 2 * wireBytes; client.transportBytes += 4 * wireBytes; client.reservedBytes += 32768 * slotMs / 1000;
      for (const op of clientOperations.get(client.id)!) if ( op.status === 'pending' && op.readyAt !== null && op.readyAt <= time) {
        fragment(op, op.replyBytes, client.lanes[2]); op.readyAt = null;
      }
      // Snapshot all four lanes before delivery, forbidding same-tick forwarding.
      const selected = client.lanes.map(lane => { while (lane.length && lane[0].op.status !== 'pending') lane.shift(); return lane[0]; });
      selected.forEach((cell, lane) => {
        if (!cell) return;
        client.realCells++;
        if (drops.has(`${client.id}:${tick}:${lane}`)) { client.lostCells++; return; }
        client.lanes[lane].shift(); client.deliveredPayloadBytes += cell.payload;
        if (cell.op.deadline < end) { cell.op.status = 'failed'; cell.op.reason = 'deadline'; return; }
        if (lane === 0 || lane === 2) client.lanes[lane + 1].push(cell);
        else if (lane === 1 && --cell.op.requestRemaining === 0) cell.op.readyAt = end + cell.op.processingMs;
        else if (lane === 3 && --cell.op.replyRemaining === 0) { cell.op.status = 'completed'; cell.op.completedAtMs = end; }
      });
    }
  }
  for (const op of operations) if (op.status === 'pending') { op.status = 'failed'; op.reason = op.deadline <= input.durationMs ? 'deadline' : 'simulation-end'; }
  const completed = operations.filter(op => op.status === 'completed').length;
  const costs = clients.map(client => ({ clientId: client.id, enrolledMs: client.slots * slotMs, accessBytes: client.accessBytes,
    transportBytes: client.transportBytes, reservedBytes: client.reservedBytes, startupAllBytes: client.startupAllBytes,
    allBytes: client.transportBytes + client.reservedBytes + client.startupAllBytes,
    fixedWireCells: client.slots * 4, realCells: client.realCells, dummyCells: client.slots * 4 - client.realCells,
    lostRealCells: client.lostCells, deliveredPayloadBytes: client.deliveredPayloadBytes }));
  const totals = costs.reduce((a, c) => ({ accessBytes: a.accessBytes + c.accessBytes, transportBytes: a.transportBytes + c.transportBytes,
    reservedBytes: a.reservedBytes + c.reservedBytes, allBytes: a.allBytes + c.allBytes }), { accessBytes: 0, transportBytes: 0, reservedBytes: 0, allBytes: 0 });
  const latencies = operations.map(op => op.completedAtMs === null ? Infinity : op.completedAtMs - op.atMs).sort((a, b) => a - b);
  return { model: 'offline-fixed-cell-pipeline-v1', profile, deadlineMs, limitations: ['No MPC rounds/payloads modeled; other-edge reserve is only a cost allocation, not proof those schedules hide activity.',
    'Synthetic dropped cells are not packet-loss qualification. No AUC, privacy, watts or cryptographic performance claim.', 'Startup costs are explicit caller inputs; zero defaults do not establish zero startup cost.',
    'Hour caps are report-only capacity checks, not an enforcing runtime budget controller.'],
    submitted: operations.length, completed, rejected: operations.filter(op => op.status === 'rejected').length,
    failed: operations.filter(op => op.status === 'failed').length,
    operations: operations.map(op => ({ id: op.id, clientId: op.clientId, status: op.status, reason: op.reason, completedAtMs: op.completedAtMs,
      latencyMs: op.completedAtMs === null ? null : op.completedAtMs - op.atMs, infiniteLatency: op.completedAtMs === null })),
    latencyMs: { p50: quantile(latencies, .5), p95: quantile(latencies, .95), p99: quantile(latencies, .99) }, costs, totals,
    bytesPerCompletion: completed ? { value: totals.allBytes / completed, reason: null } : { value: null, reason: 'infinite-zero-completions' },
    horizonCaps: { accessBytesPerClient: PRIVATE_SCHEDULE.accessHourlyCap, allBytesPerClient: PRIVATE_SCHEDULE.allHourlyCap,
      /* Horizon is at most one hour; these are absolute hour budgets, not a normalized rate. */
      withinAccess: costs.every(c => c.accessBytes <= PRIVATE_SCHEDULE.accessHourlyCap), withinAll: costs.every(c => c.allBytes <= PRIVATE_SCHEDULE.allHourlyCap) } };
}
