# DEC-025 allocation attribution review — 2026-11-25

## Verdict

**Close the bounded diagnostic with unresolved memory variability.** Independent review finds the attribution-only instrumentation measurement-safe. No specific local allocation rewrite is justified. Protected-admission evaluation may proceed separately without waiving the failed resource gate.

Every relay has exactly 10,000 publications, generations, persisted operations, canonical operations and active records; conflicts are zero and operation/matching totals are consistent. No second canonical set or duplicate parser/log structure exists.

Parent and relay `heapUsed` are much smaller than RSS, while `heapTotal`, external bytes and array buffers do not explain the peaks. Parent-ready RSS ranges from 422,985,728 B to 588,038,144 B with heapTotal near 376 MB; ready relays show RSS 353.8–363.7 MB against heapUsed 106.9–145.1 MB and heapTotal 215.6–222.1 MB. This supports allocator/RSS retention and GC timing variability, not demonstrated duplicate retention.

Focused tests: **5/5 passed**; actual-source noEmit, build and diff checks passed. A monitor-free startup probe preserved cardinality and disk reconciliation. A separate load-path attempt had the late-monitor IPC shutdown race and is not used as qualification evidence.

`processTreeRssPass` remains explicitly failed and variability remains unresolved. No full K7, production or K/R acceptance follows. Next measure the real `withDecision` queue and durable authorization path rather than another burst rerun or speculative rewrite.
