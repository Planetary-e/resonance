# Publication-to-match latency diagnostic — 2026-10-01

## Finding

The [CI run at 1382057](https://github.com/Planetary-e/resonance/actions/runs/36823136891) passed all 517 functional tests but failed one of 44 evaluation metrics: **501.4 ms**, against **<500 ms**, for `V2 publication → match indexing`. Its name understated the timed work: it includes connecting, receiving/verifying a publication, durable placement/publication records, matching, signing the match, encrypting two mailbox notices, committing them durably and returning a verified acknowledgement. Embedding inference is outside that timer.

The next [CI run at c617114](https://github.com/Planetary-e/resonance/actions/runs/36836603369), **before this optimization**, passed all 525 tests and 44/44 evaluation metrics; the same timing was **309.1 ms**. The two remote samples show run-to-run variation, not a consistently reproducible application failure. They do not identify its cause.

Five local runs did **not** reproduce the 501.4 ms result. Profiling did identify avoidable CPU work: the complete two-publication benchmark verified signatures **50 times over seven distinct message/signature/key tuples**. Some repetition correctly authenticates data at different public boundaries; nine calls instead repeated an already completed check within the same synchronous constructor/store invocation.

Those nine checks were removed without adding a cache or changing the cryptographic algorithm, wire format, acceptance rules or durable writes. This reduces known application overhead; it does not establish the exact cause of a single remote timing spike. The GitHub runner was not profiled during the failing sample, so CPU scheduling, storage and other environmental costs remain possible contributors.

## Local comparison

[Raw measurements and method](publication-match-2026-10-01.json) retain every sample. Each variant used one fresh Node process, the real cached model, the CPU sampler and forwarded/timed `fsyncSync` calls. Each of its five runs used a fresh persistent relay with two publications. The optimized measurements still used the **original benchmark**; only the four production validation files differed from baseline `c617114`.

| Run | Before: durable match acknowledgement | After: durable match acknowledgement |
|---:|---:|---:|
| 1 | 146.6 ms | 123.9 ms |
| 2 | 126.4 ms | 105.1 ms |
| 3 | 120.7 ms | 101.3 ms |
| 4 | 121.7 ms | 101.2 ms |
| 5 | 117.9 ms | 101.6 ms |
| Median | **121.7 ms** | **101.6 ms** |

The observed median fell approximately **16.5%**. A separate call-count run confirmed **41 checks over the same seven distinct tuples** afterwards. The CPU sample was dominated by TweetNaCl arithmetic; fsync totals across relay startup, both publications and shutdown stayed around 21–25 ms per run. Those flush totals are not an isolated breakdown of the match timer.

This is a small sequential comparison on one Apple computer, not an interleaved statistical experiment, Internet measurement, production-load test or energy result. Profiler overhead and warm-up affect the values. It excludes private-hop scheduling, blind-token admission, network replication and realistic relay population size.

## Changes and preserved checks

- Match construction already authenticates both publications before calculating the body. Its private binding helper now checks relationships and dates without repeating those same signatures. The public verifier still authenticates the match and both publications on every call.
- Notice construction uses that complete public verifier once, then retains its identity, payload, signature and recipient checks.
- Each publication/match store authenticates an input once per public `evaluate` or `apply` call, then uses a private state-comparison helper. Independent calls, journal validation and replay still authenticate their own inputs. No trusted flag or unchecked entry point is exported.
- The new tampering regression changes either publication's expiry while preserving IDs, original signature strings and match references. Creation, verification and notice generation must all refuse it. Existing tests retain malformed-signature, incompatible-pair, threshold, revision, conflict, tombstone and encryption coverage.

## Make future failures diagnosable

The metric is now named **V2 publication → durable encrypted match**. It reports both elapsed and process CPU time, plus match/envelope counts in the JSON report. Process CPU can exceed wall time because it includes all process threads; it is not a request-exclusive CPU measurement or energy estimate.

The gate remains **<500 ms**, and additionally requires both encrypted mailbox envelopes to exist. It still measures one sample in each quick evaluation; there is no retry-until-pass, averaging away a slow run or changed threshold. A uniquely created temporary directory and an OS-assigned loopback port replace guessed fixture names/ports; cleanup removes that benchmark's state. The explicit IPv4 loopback address avoids mixing localhost address selection into this local application measurement.

Repeat the quick evaluation from the repository root:

```sh
node --import tsx packages/eval/src/run.ts --quick
```

To collect five isolated-flow wall-time samples without profiler instrumentation:

```sh
node --import tsx --input-type=module <<'JS'
import { EmbeddingEngine } from './packages/core/src/index.ts';
import { benchmarkChannelFlow } from './packages/eval/src/benchmarks/channel-flow.ts';
const engine = new EmbeddingEngine();
await engine.initialize();
for (let run = 1; run <= 5; run++) {
  console.log(JSON.stringify({ run, results: await benchmarkChannelFlow(engine) }));
}
JS
```

## Validation checkpoint

TypeScript compilation, the focused match/mailbox/store checks (**4 files / 21 tests**) and the full local suite (**105 files / 526 tests**, one worker) passed. The [final quick evaluation](eval-2026-10-01-08-45-09.md) passed **44/44 metrics**. Its durable match timer was **110.1 ms wall / 152.2 ms process CPU**, with one match and two encrypted envelopes; first-publication acceptance was **36.8 ms wall / 58.7 ms process CPU**. No profiling hooks were installed for this final evaluation. Remote performance remains a separate check; local success is not a release certification.
