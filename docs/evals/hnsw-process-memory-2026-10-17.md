# Isolated HNSW process memory — 2026-10-17

The old evaluator subtracted JavaScript heap samples, missing native allocations
and sometimes reporting negative memory after garbage collection. Its replacement
runs each index workload in a fresh child process and reports absolute resident
memory snapshots plus the OS high-water mark. Historical heap-delta reports remain
historical; they are not valid index or device memory budgets.

## Observations

One run per size on macOS arm64, Node v24.19.0; 768 dimensions, seed 20261017,
100 queries and five results per query. The sizes ran sequentially.

| Vectors | Process peak RSS | Search p95 | Index insertion | Workload CPU time |
| --- | --- | --- | --- | --- |
| 10,000 | 136.2 MiB | 1.58 ms | 27.59 s | 27.67 s |
| 100,000 | 449.2 MiB | 2.24 ms | 487.55 s | 485.93 s |

Both sizes meet the existing search p95 <5 ms and peak RSS <4096 MiB thresholds.
That broad memory threshold does not select a production device budget. Insertion
time is informational and remains visible alongside search latency.

[Raw measurements and source hashes](hnsw-process-memory-2026-10-17.json) retain
all four RSS snapshots, workload settings and runtime/process identity. The code
was based on `4412d09` plus the changes identified by those hashes. A short test
group overlapped the beginning of 10K; no deliberate heavy parallel benchmark ran
during 100K. Host scheduling, temperature and power modes were not controlled.
These are observations, not a repeated cross-device performance distribution.

## Method and reproduction

From the repository root with Node 24 dependencies installed:

```sh
node --import tsx --input-type=module - <<'JS'
import { benchmarkHnswPerformance } from './packages/eval/src/benchmarks/hnsw-performance.ts';
console.log(JSON.stringify(await benchmarkHnswPerformance(false), null, 2));
JS
```

Use `true` for 10K. The ordinary quick/full evaluator uses the same measurement.
Children have a 15-minute deadline, bounded errors and cancellation. The caller
waits for process closure, and absent/invalid measurements fail instead of
reporting zero memory. Three focused tests cover real native workers, invalid
samples, deadline/cancellation and report generation. Package typechecking passes.

Node documents [`process.resourceUsage().maxRSS`](https://nodejs.org/docs/latest-v24.x/api/process.html#processresourceusage)
in KiB: multiply by 1024 for bytes, then divide by 1048576 for MiB.
[`process.memoryUsage.rss()`](https://nodejs.org/docs/latest-v24.x/api/process.html#processmemoryusagerss)
returns resident bytes including C++/JavaScript objects and code. The baseline,
post-initialization, post-insertion and post-search values are absolute samples.
No heap subtraction estimates native ownership.

The child imports the real relay index and runtime dependencies. Its peak covers
the whole child through search completion, including imports and native memory.
It excludes the evaluator parent, full desktop, embeddings, active relays,
concurrent histories and recovery. CPU time is not energy. Concurrent/near-capacity
full-application costs, total traffic and physical energy remain open v0.4 gates.
