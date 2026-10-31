# RSO5 DEC-012 bounded research lifecycle receipt — October 31, 2026

**Status: bounded lifecycle and complete inventory PASS for revised-budget research only; no production, K/R, deployment or economic approval.** Original-cap failures and uncapped diagnostics are preserved unchanged.

## Contract and result

DEC-012 sets per-operation work to **26,611,731 B** and cumulative work to **1,016,959,841 B**, with arrival intensity limited to <=4.13% of the DEC-011 measured sustained rate. This lifecycle used normal bounded metering for every operation: `diagnosticUnbounded:false`, `budgetId:'DEC-012'`, and every operation's `maximumBytes=26,611,731`.

Focused RSO5 manifest: **17/17 PASS**. Actual-source noEmit: **PASS, exit 0**. Complete lifecycle: **PASS**, with 272 top-level records and complete required inventory.

- Actual cumulative work: **677,973,227 B**, below the DEC-012 cumulative budget by 338,986,614 B.
- Maximum operation: `local-C-recovery:3`, **17,741,154 B**, below the per-operation budget by 8,870,577 B.
- Operations crossing the DEC-012 per-operation budget: **0**.
- First operation/cumulative crossings: **none**.
- Forecast difference: **407,840,969 B** above the historical forecast of 270,132,258 B; the historical forecast is not used as the DEC-012 cap.
- Actual inventory: {"legacyPreparations":4,"runtimePhaseCalls":102,"leaderProposals":6,"retries":7,"viewChangeGroups":2,"newViewCalls":8,"completeLocalCLossRecoveries":4}.
- Unreachable classes: **none**.
- Acceptance evaluation: `passed_revised_budget_research`.

Both result artifacts are identical with SHA-256 `a82f20cf8e16cc9d9db144115cba2aac0e129b2fee67763ec755a22b1e2ddd7f`. The summary is `delivery/results/rso5-dec012-evidence-summary.json`, and the candidate manifest is `docs/handover/2026-10-31/rso5-dec012-candidate-hashes.json`.

## Remaining limitations

This is a scenario-fit research result only. It does not establish production affordability, physical power, physical-network cost, labor, representative maxima, lifetime/history growth, E3 or K1–K8. Arrival intensity must remain <=4.13% of the DEC-011 measured sustained rate. Power remains blocked with no samples; loopback is not Internet evidence. Production and any revised production budget require separate owner decisions and independent physical/operational evidence.

Final same-run hashes:

```
a30ef803491f8eb6d7ec6fc21364aa93cd69c3adc596d2f0c38823a6e318348e  packages/core/package.json
520e3fe1c833bfe6bee0c60336e6edf54065180364e5b245e09f8bac0be838cf  packages/core/src/admission-work.ts
eb4c2b0009e78fedd68701c1d42224a1cfc87a2aa7a345b4c1aed8b85ae2ad67  packages/core/src/admission-policy.ts
186d95b010074b88e7d9e2a097b2e20e9a412884e22f9d06cb9e796812cc2956  packages/core/src/admission-policy-advance.ts
4b9f4ce2b970a1358e859fd999bad853bd83792aaf0cbb2b7e223221e3cf1b04  packages/core/src/admission-policy-freshness.ts
4c7d8f0ebd24a65a4fce600775824c913932e38e17b7216e972eea0527bd8e59  packages/core/src/admission-witness.ts
9444bac8fbc2493f86ee334688a5a181184fbc6f926c7a9822f9cb4bee1b7a8c  packages/core/src/admission-witness-handoff.ts
1dfb07a6d2ff695c44c50a94d94cea42e0f01865998bb8af9b44f231bbdc5427  packages/relay/src/protected-policy-observer.ts
5daa22fd8879101cd0a53cccc9ec019927d8de3efddc141ea6a53a9e4729952d  packages/relay/src/witness-handoff-state.ts
d123ec73672a8922408ab401db4ffb0f1cb46914dc9805c1c0f07ad1fa7ab5a3  packages/relay/src/sustainable-recovery-work.ts
799b4be4d88eccc15863d9ec8da3ef95f2f543c092a0bc42fe7a546d92ea54b8  packages/relay/src/sustainable-rso5-opaque.ts
b19c5cba4c085757a0b1bf1d4770e55253602e5ea67ccbed5a07de60c671f982  packages/relay/src/sustainable-rso5-arena.ts
7a446e2e35eb433de421aa64cf6bef32d2efea588cf102380793e4726618632d  packages/relay/src/sustainable-rso5-protected-arena.ts
f20f841e31d0610c6707aef7f521acb0b571252c56197a2e3af66bc17a62cb72  packages/relay/src/sustainable-rso5-codec.ts
8278b6bfcafd8473c9d09d2055715030b4c41bfa6a492963e85f25728d2d0140  packages/relay/src/sustainable-recovery-manifest.ts
ac98127fcf7e7c8cfd86fde30c8c26a685626fa4a8652c9e773266ab9733d6f3  packages/relay/src/sustainable-rso5-manifest.ts
48b1d68f2d1438c2c2bcee5a7ead31ec3c95d8d3adaff70817d140751c2aaf10  packages/relay/src/sustainable-rso5-runtime.ts
ed8798244bc1ee77c4c1c60f31b3c07adb09d5a3e237d8fbd81216c522df8f78  packages/relay/src/__tests__/sustainable-rso5-manifest.test.ts
f7ab4b37c76812e1a8413cbdab12d15bb9eef1b497f4c24c7c4286bee7de59b0  packages/relay/src/__tests__/sustainable-rso5-runtime.integration.test.ts
a82f20cf8e16cc9d9db144115cba2aac0e129b2fee67763ec755a22b1e2ddd7f  delivery/results/RUN-RSO5-DEC-012.json
a82f20cf8e16cc9d9db144115cba2aac0e129b2fee67763ec755a22b1e2ddd7f  delivery/results/rso5-dec012-operation-work.json
ab9f79601119758ae6ca81aa9d99b0fa67b986da7c81b54e479e83485e566567  delivery/results/rso5-dec012-evidence-summary.json
05e536f6426829b390d098a71410ca5ddd6ff0790146320bb6ffedeb30129a72  scripts/rso5-dec012-finalize-evidence.mjs
```

No failure was tuned and no campaign, deployment or release action occurred. Parent owns commit/push.

## Independent verdict

Independent review returned **ACCEPT revised-budget research evidence**. It verified the DEC-012 contract, normal bounded metering on every operation, complete inventory and all 23 candidate hashes. Parent's final actual total is **677,973,227 B**, leaving **338,986,614 B** cumulative headroom; maximum operation is **17,741,154 B**, leaving **8,870,577 B** per-operation headroom, with zero crossings. Both result files are identical with SHA-256 `a82f20cf8e16cc9d9db144115cba2aac0e129b2fee67763ec755a22b1e2ddd7f`.

This accepts only the revised-budget research evidence. It does not establish production feasibility, physical or economic affordability, representative maxima, lifetime/history growth or K/R compliance. The <=4.13% arrival constraint remains a research restriction requiring separate physical and operational validation.
