# FP32 model resource comparison

## Protocol fixed before measurement

The actual application has peaked near 2 GiB per model process even after correct
session disposal. Compare the default runtime with two intra-operation CPU
threads, then the same two threads with the CPU memory arena disabled. These are
[documented ONNX Runtime session options](https://onnxruntime.ai/docs/api/js/interfaces/InferenceSession.SessionOptions.html).
Keep the cached FP32 model, tokenizer, rewriting, prefix, pooling and normalization.
No production settings change in this experiment.

Each isolated child opens/disposes a setup probe, opens a session and embeds the
200 distinct needs/offers in the repository's labeled fixture, disposes it, then
opens/embeds/disposes one unlock session. Children run sequentially in three
cyclically counterbalanced orders. Do not force garbage collection; the live app
does not do that. Hash model artifacts and the dataset for reproduction. Compare
all vectors and pilot fingerprints against the first default-runtime trial.

Predetermined adoption gates, all required:

- All 200 pilot fingerprints agree in every trial; maximum vector coordinate
  difference is at most 0.000001.
- Median process peak RSS drops at least 20% and is at most 1 GiB.
- Median corpus inference time is at most 125% of baseline.
- Median CPU time across the three model lifetimes is at most 110% of baseline.
  Module import time is excluded from this CPU interval.

These are local engineering gates, not a claim of universal floating-point
equivalence or energy measurements. This small English corpus does not test long
input, multilingual quality, simultaneous application instances or saturation.
Matching the existing fingerprints does not fix their independently measured
privacy and matching-quality failures. A failed experiment must stay visible.

Command from the repository root:

```sh
npm run eval:embedding-resources -- --enforce --out /tmp/embedding-resources.json
```

Remote model downloads are disabled. No installers, relay traffic or user text
are involved. The JSON report retains aggregate measurements and hashes, without
embedding vectors or raw text.

## Result

The [nine isolated trials](embedding-resources-2026-10-18.json) reject both
candidates. Every trial produced all 200 byte-identical vectors and fingerprints.

| Runtime | Median peak RSS | Corpus inference | Lifecycle CPU | Eligible |
| --- | ---: | ---: | ---: | --- |
| Default | 1,006.2 MiB | 2,442 ms | 13.394 s | Baseline |
| Two CPU threads | 997.8 MiB | 4,620 ms | 10.335 s | No |
| Two CPU threads, arena disabled | 1,004.9 MiB | 4,468 ms | 10.081 s | No |

Peak memory improves by only 0.83% / 0.13%, while inference slows by 89.2% /
83.0%. The lower CPU total is useful evidence but insufficient for adoption under
the predeclared gates. `--enforce` exits 1 as intended. Keep production defaults.

Even with three model lifetimes, isolated default peaks are approximately 1 GiB,
below the earlier full-application peaks near 2 GiB. Measure full-application
memory at each HTTP operation before attributing that difference to model threads
or arena allocation. The full-application memory requirement remains open.

The subsequent [cache investigation](../developers/v0.4-model-memory.md) found
uncancelled eager model-file streams. The original short runtime comparison
could exit before those reads completed, so its approximately 1 GiB peaks are
not a steady-state application guarantee. A separate cache comparison includes
I/O settling time and confirms the correction without changing runtime options.
