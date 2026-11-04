# RSO5 DEC-011 full-warmup baseline receipt

**Status: 2/2 corrected diagnostic windows pass all timing, evidence and cleanup gates; independent budget review may proceed; E2 remains blocked by physical power; no revised-budget, economic, production or K/R approval.**

## Frozen execution and correction

Command: `node scripts/rso5-dec11-baseline.mjs`. Execution began at `2026-10-31T06:41:52.701Z` and completed at `2026-10-31T07:48:19.259Z`. Frozen manifest: `delivery/results/econ-dec11-baseline-manifest.json`; all 26 source hashes verify.

DEC-010 sustained warmup was marked but not awaited. DEC-011 enforces the existing monotonic warmup interval before bootstrap. Recovery behavior, retry authorization, work/cost and timing requirements are unchanged. Prior stack-safe bounded finalization, traffic pagination and cleanup behavior are preserved. All DEC-008/DEC-010 attempts and unified matrix artifacts remain intact.

## Timing compliance and finalization

| Window | Seed | Warmup monotonic | Baseline monotonic | Cooldown to first post-cooldown stop | Finalization |
| --- | --- | ---: | ---: | ---: | --- |
| `idle-dec11-baseline` | `0xE007B001` | 60,002.14 ms | 1,800,003.706 ms | 60,245 ms | startup → warmup → baseline → cooldown → metrics → host-tools → stop-workers → network-evidence → artifacts → summary → cleanup |
| `sustained-dec11-max-envelope` | `0xE007B002` | 102,237.834 ms | 1,800,081.799 ms | 69,309 ms | startup → warmup → baseline → cooldown → metrics → host-tools → stop-workers → network-evidence → artifacts → summary → cleanup |

Both warmups exceed 60,000 ms, both baseline phases exceed 1,800,000 ms, and both cooldowns exceed 60,000 ms. Each run has metrics, host-tools, stop-workers, network-evidence, artifacts, summary and cleanup phases, with 52/52 clean stops and zero survivors.

## Actual measurements

| Metric | Idle | Sustained | Aggregate / maximum |
| --- | ---: | ---: | ---: |
| Separate work metric | 384,324 B | 24,600,514,019 B | 24,600,898,343 B |
| Request+response envelopes | 459 | 1,887,817 | 1,888,276 |
| Application payload bytes | 5,198,073 | 3,401,745,747 | 3,406,943,820 |
| Application WebSocket frame bytes | 5,200,877 | 3,413,095,379 | 3,418,296,256 |
| Worker user CPU | 6.949021 s | 2021.626417 s | 2028.575438 s |
| Worker system CPU | 2.169174 s | 653.485506 s | 655.654680 s |
| Maximum sampled process-tree RSS | 116,686,848 B | 480,313,344 B | 480,313,344 B |
| Sustained reads | 0 | 18,252 | 18,252 |
| Sustained retries | 0 | 36,504 | 36,504 |
| Recovered proofs | 0 | 164 | 164 |
| Logical process-held copy audits | 0 | 164 | 164 |

Per-role work sums exactly match each total. Every network edge reconciles to message, payload and frame totals and to the execution record. Sustained retries use the returning admission set and create no new proofs or configurations.

## Per-role work

| Role | Idle bytes | Sustained bytes | Combined bytes |
| --- | ---: | ---: | ---: |
| `observer-0` | 96,081 | 799,848,680 | 799,944,761 |
| `observer-1` | 96,081 | 799,848,680 | 799,944,761 |
| `observer-2` | 96,081 | 799,848,680 | 799,944,761 |
| `observer-3` | 96,081 | 799,848,680 | 799,944,761 |
| `replica-old-0-1` | 0 | 10,974,931 | 10,974,931 |
| `replica-old-0-2` | 0 | 10,974,931 | 10,974,931 |
| `replica-old-0-3` | 0 | 10,974,931 | 10,974,931 |
| `replica-old-0-4` | 0 | 10,974,931 | 10,974,931 |
| `replica-old-0-5` | 0 | 10,974,931 | 10,974,931 |
| `replica-old-1-1` | 0 | 10,974,931 | 10,974,931 |
| `replica-old-1-2` | 0 | 10,974,931 | 10,974,931 |
| `replica-old-1-3` | 0 | 10,974,931 | 10,974,931 |
| `replica-old-1-4` | 0 | 10,974,931 | 10,974,931 |
| `replica-old-1-5` | 0 | 10,974,931 | 10,974,931 |
| `replica-old-2-1` | 0 | 10,974,931 | 10,974,931 |
| `replica-old-2-2` | 0 | 10,974,931 | 10,974,931 |
| `replica-old-2-3` | 0 | 10,974,931 | 10,974,931 |
| `replica-old-2-4` | 0 | 10,974,931 | 10,974,931 |
| `replica-old-2-5` | 0 | 10,974,931 | 10,974,931 |
| `replica-old-3-1` | 0 | 10,974,931 | 10,974,931 |
| `replica-old-3-2` | 0 | 10,974,931 | 10,974,931 |
| `replica-old-3-3` | 0 | 10,974,931 | 10,974,931 |
| `replica-old-3-4` | 0 | 10,974,931 | 10,974,931 |
| `replica-old-3-5` | 0 | 10,974,931 | 10,974,931 |
| `replica-new-0-1` | 0 | 8,032,287 | 8,032,287 |
| `replica-new-0-2` | 0 | 8,032,287 | 8,032,287 |
| `replica-new-0-3` | 0 | 8,032,287 | 8,032,287 |
| `replica-new-0-4` | 0 | 8,032,287 | 8,032,287 |
| `replica-new-0-5` | 0 | 8,032,287 | 8,032,287 |
| `replica-new-1-1` | 0 | 8,032,287 | 8,032,287 |
| `replica-new-1-2` | 0 | 8,032,287 | 8,032,287 |
| `replica-new-1-3` | 0 | 8,032,287 | 8,032,287 |
| `replica-new-1-4` | 0 | 8,032,287 | 8,032,287 |
| `replica-new-1-5` | 0 | 8,032,287 | 8,032,287 |
| `replica-new-2-1` | 0 | 8,032,287 | 8,032,287 |
| `replica-new-2-2` | 0 | 8,032,287 | 8,032,287 |
| `replica-new-2-3` | 0 | 8,032,287 | 8,032,287 |
| `replica-new-2-4` | 0 | 8,032,287 | 8,032,287 |
| `replica-new-2-5` | 0 | 8,032,287 | 8,032,287 |
| `replica-new-3-1` | 0 | 8,032,287 | 8,032,287 |
| `replica-new-3-2` | 0 | 8,032,287 | 8,032,287 |
| `replica-new-3-3` | 0 | 8,032,287 | 8,032,287 |
| `replica-new-3-4` | 0 | 8,032,287 | 8,032,287 |
| `replica-new-3-5` | 0 | 8,032,287 | 8,032,287 |
| `runtime-old-0` | 0 | 5,229,387,486 | 5,229,387,486 |
| `runtime-old-1` | 0 | 5,223,415,134 | 5,223,415,134 |
| `runtime-old-2` | 0 | 5,223,078,906 | 5,223,078,906 |
| `runtime-old-3` | 0 | 5,223,078,906 | 5,223,078,906 |
| `runtime-new-0` | 0 | 36,640,861 | 36,640,861 |
| `runtime-new-1` | 0 | 28,457,882 | 28,457,882 |
| `runtime-new-2` | 0 | 28,457,882 | 28,457,882 |
| `runtime-new-3` | 0 | 28,457,882 | 28,457,882 |
| **Total** | **384,324** | **24,600,514,019** | **24,600,898,343** |

## Limitations and budget-review boundary

- Power remains exactly `blocked`: `powermetrics requires superuser; no calibrated external AC meter authorized`. No power samples or energy estimates exist; CPU/work bytes are not watts.
- Application payload/frame accounting excludes handshake/control frames and TCP/IP bytes. Loopback is not Internet evidence. Nettop matched 0 and 0 worker rows.
- Per-process physical disk counters and fsync latency are unavailable; logical arena bytes are not physical I/O and iostat is host-only. RSS is best-effort sampled on one host; logical process-held copies are not physical devices.
- Business draws remain nondeterministic. Prices, budget, value and affordability remain pending. E3 requires separate owner authorization. Original work-threshold failures and all K/R gates remain open.

Final decision evidence: `delivery/results/econ-dec11-budget-review-decision.json`. **Independent budget review may proceed** using measured mandatory maxima, complete failure history and uncertainty margins. A revised budget, economic affordability or production deployment requires separate owner approval; none is granted here.

## Evidence hashes

`delivery/results/econ-dec11-baseline-hashes.json` binds 50 artifacts, including both DEC-011 runs, warmup/finalization smoke, frozen manifest, decision evidence and prior blocked receipts/hash sets.

| Artifact | SHA-256 |
| --- | --- |
| `delivery/results/econ-authorization-dec11-finalization-smoke.json` | `sha256:2ea41258d929cf189a44db32b4830173cfac7698ffcfc9108a01523753f88051` |
| `delivery/results/econ-authorization-idle-dec11-baseline.json` | `sha256:9ee7e9ffb4085c33d54fb67a0567975c4f43a933606dc9b471375ab5dc6e8060` |
| `delivery/results/econ-authorization-sustained-dec11-max-envelope.json` | `sha256:352a59ba533c1bd05a74e7b9ae0a07dfb667a045b3a859c053dd90cac79a7c88` |
| `delivery/results/econ-cleanup-dec11-finalization-smoke.json` | `sha256:c9178b849032976fa4406330b159e7c76ea638cb8e5629cba92a0c51ff2f30d0` |
| `delivery/results/econ-cleanup-idle-dec11-baseline.json` | `sha256:a65ce55eff657ab747096cd51e1b1c9a6c60071774cd6c140989ec644dfde3ab` |
| `delivery/results/econ-cleanup-sustained-dec11-max-envelope.json` | `sha256:f63677d1bce829a9b44374b23acc5ff6722a157561dd8419f31064775e169425` |
| `delivery/results/econ-dec11-baseline-baseline.json` | `sha256:a672d7e1fbe1a6bf4d7f76f88784aa1dbd29df525450eff4f6674759be120e32` |
| `delivery/results/econ-dec11-baseline-execution.json` | `sha256:754aaf7639dc51f5c30f07dbf9bdac17ef6d0e3710e89afb660c65ef6aff6369` |
| `delivery/results/econ-dec11-baseline-manifest.json` | `sha256:4ae6b94bdc5ddde4d65fda0110c001c510a222ba30239be001642a44acb4dbd0` |
| `delivery/results/econ-dec11-budget-review-decision.json` | `sha256:8beed0f6a8834751c2739c8bac0b497e11c12a2eae886d626446dbee8b554b20` |
| `delivery/results/econ-decision-dec11-finalization-smoke.json` | `sha256:3cdbda17f051d242972799f7877673c1f98320ebc220a55d7cb8d0b0841fd45c` |
| `delivery/results/econ-decision-idle-dec11-baseline.json` | `sha256:fbb803a81d9f6959aab6253d68f2b248975f89835bbed6a94a2353b433af176c` |
| `delivery/results/econ-decision-sustained-dec11-max-envelope.json` | `sha256:cd57b2dbe8d58bb7867d826353090fc08ba6c06dac239bdb67a219ba1ddc7d4f` |
| `delivery/results/econ-disk-dec11-finalization-smoke.json` | `sha256:069946b7a5c14f841897fae949e5074a7524df098af8b6e8bcd06b3f08fe2e9b` |
| `delivery/results/econ-disk-idle-dec11-baseline.json` | `sha256:1b4c8ee86f2cc05a28b470b7c7b2c6d851aa037c8adf54db2a8b5c72a7b80fac` |
| `delivery/results/econ-disk-sustained-dec11-max-envelope.json` | `sha256:557c4c495ef2b67b91930c4fa27b3aba2a741b285290c1dc36c40709ef416363` |
| `delivery/results/econ-finalization-dec11-finalization-smoke.json` | `sha256:bf7bcea9aa6e4398fd73fb0f6b4d0abc07166fcf46366ac63ec49c3d7ea36f8e` |
| `delivery/results/econ-finalization-idle-dec11-baseline.json` | `sha256:d84fd2a0496b98c514070b308b5a6941c6c2e9b2c59ded9f639f6a95c4671924` |
| `delivery/results/econ-finalization-sustained-dec11-max-envelope.json` | `sha256:a9cc47ae89668ec9119448e2491b365827d3db600a47aa791293f64c4089a50e` |
| `delivery/results/econ-lab-summary-dec11-finalization-smoke.json` | `sha256:520d23bb6d1c013c18f96aa7c9a6833b148282a31543ca2c479cc7f7f5e33065` |
| `delivery/results/econ-lab-summary-idle-dec11-baseline.json` | `sha256:4b676d9b698218e0d75269e8d0c75537be759323a7373c5b5cd8323278d5a600` |
| `delivery/results/econ-lab-summary-sustained-dec11-max-envelope.json` | `sha256:a7a55befe7e12ac82ff8551b4e9e3f6789650160bb82befd8e49c391a0f149bb` |
| `delivery/results/econ-network-dec11-finalization-smoke.json` | `sha256:ba8b9687757e6e71272929292bbfbd825a641e6fdf9ac5ddbaf07a6fad5a8f7a` |
| `delivery/results/econ-network-idle-dec11-baseline.json` | `sha256:88e6ce01e98a288956725308a38182fcae9efa5294ac6ecbe0ba9e297f9ad657` |
| `delivery/results/econ-network-sustained-dec11-max-envelope.json` | `sha256:9c0bd95856082db5105da3a0a955157ef064bfad775bd514b4868571bbea36be` |
| `delivery/results/econ-new-view-readiness-dec11-finalization-smoke.json` | `sha256:52b7b4b92713264d2cbe1849df5915dbcc99892538bb98a32776dd7ae05af068` |
| `delivery/results/econ-new-view-readiness-sustained-dec11-max-envelope.json` | `sha256:1521afa3eb35c155dcb172c292992a975302c756d352d153c836ecdb628c6213` |
| `delivery/results/econ-owner-assumptions-dec11-finalization-smoke.json` | `sha256:76a08836c0259b53937e89e6398032270af053d8dd1669d4d523c24d4f8beee1` |
| `delivery/results/econ-owner-assumptions-idle-dec11-baseline.json` | `sha256:578f78b5edc68e8411b78a78f7f592000e21b147ad8925fafc4f663627a71328` |
| `delivery/results/econ-owner-assumptions-sustained-dec11-max-envelope.json` | `sha256:6190f0e73caf632300548148f926a7797f879bd40be514490126913967a53339` |
| `delivery/results/econ-power-dec11-finalization-smoke.csv` | `sha256:a49d5317c8c285874d1cf1de69bfc0b76be440d91dd8a2799b4c6587ce6c978a` |
| `delivery/results/econ-power-dec11-finalization-smoke.json` | `sha256:dd8ad18a58c9d4261d1094d7c7c0bc83d348f4e0e7eb05bb2548b10a6acf9c06` |
| `delivery/results/econ-power-idle-dec11-baseline.csv` | `sha256:a49d5317c8c285874d1cf1de69bfc0b76be440d91dd8a2799b4c6587ce6c978a` |
| `delivery/results/econ-power-idle-dec11-baseline.json` | `sha256:6f712b8b79397f557d446d94480ab1967c5bcf18c701d7b63be496f6ccb06382` |
| `delivery/results/econ-power-sustained-dec11-max-envelope.csv` | `sha256:a49d5317c8c285874d1cf1de69bfc0b76be440d91dd8a2799b4c6587ce6c978a` |
| `delivery/results/econ-power-sustained-dec11-max-envelope.json` | `sha256:5db796b2bacc93b6dd0afda4b9a3b9f059c138813a6fb9b816001112f3a8421d` |
| `delivery/results/econ-process-dec11-finalization-smoke.json` | `sha256:6d33d164cad895a1942195d75a1c2ad6e44411596062a96319e3334a27187b7c` |
| `delivery/results/econ-process-idle-dec11-baseline.json` | `sha256:01ef8205e1c1b7426bfb814bfb730f5f1d8eb6be02aafe5c27eafc5fc7430798` |
| `delivery/results/econ-process-sustained-dec11-max-envelope.json` | `sha256:78c10f6ae2e7a270301f0d230d61551dcae2f6a16aaf7f5e75ab1166c8b8b4e0` |
| `delivery/results/econ-production-baseline-hashes.json` | `sha256:ca049c2d5d2ce1836bfec5d95849f2d11752488178eda2e3bd3b7872cf5404fc` |
| `delivery/results/econ-production-evaluation-decision.json` | `sha256:02d82114e269551e9b275b9a0868f765bc4a679a2c566842dc6782cf9b117663` |
| `delivery/results/econ-work-dec11-finalization-smoke.json` | `sha256:394def9451dd98514176579eb3d03116185f89f77ba52c7ae473328ff5e2e35a` |
| `delivery/results/econ-work-idle-dec11-baseline.json` | `sha256:4e2a663b68bc0486cc56c941a216474c9b9f05e916df9048ae2373267a65ba9c` |
| `delivery/results/econ-work-sustained-dec11-max-envelope.json` | `sha256:8a27906a1f777cb43a59cf9efd7dd522b7d06f5b83d139da06df8067f8ec2ac2` |
| `docs/evals/v04-production-evaluation-baseline-2026-10-30.md` | `sha256:519ab5affbe7971bc757cfd8f79e83440743c5f7e0a875ab888a787314ddd55f` |
| `docs/evals/v04-recovery-economic-baseline-windows-2026-10-30.md` | `sha256:f448e6d4e5e1a3ddf7cb88caa5c0dcaa58ac7b1dd1054ac7789d2b9fe25a75c9` |
| `packages/relay/src/__tests__/sustainable-rso5-dec11-finalization.integration.test.ts` | `sha256:a236c773fe5f7716df9d125c940764d9b198aba13fe70a6967133a88cea01f3b` |
| `scripts/rso5-dec11-baseline-evidence.mjs` | `sha256:7715ab597cfb29874d63896d316cc5636e228d3704b0a376129907488d2c512b` |
| `scripts/rso5-dec11-baseline-manifest.mjs` | `sha256:487df01f09fd3915905b71627867c90cda0509b30db32dd622e88c5da55d4d0d` |
| `scripts/rso5-dec11-baseline.mjs` | `sha256:761e2a20d7747fefda85b1b6607b54724169d7ef6733537ae4c15b5f73e1b275` |
