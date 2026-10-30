# RSO5 baseline windows blocked postmortem — DEC-008

**Status: idle artifacts complete but 6 ms short of the strict 30-minute gate; sustained window incomplete after the 75-minute harness deadline; full baseline review blocked.** E2 remains blocked, E3 requires separate owner authorization, D4 remains prototype-only, and no economic affordability, production or K/R acceptance is claimed.

## Terminal blockers and cleanup

The v6 attempt used `delivery/results/econ-baseline-windows-manifest-v6.json` with all 26 source hashes verified. Its idle artifact set completed with 52/52 clean stops and zero survivors, but its phase markers span 1,799,994 ms, 6 ms short of 1,800,000 ms. The sustained window then reached finalization but did not produce process, disk, network, work, summary, decision, owner, power or cleanup artifacts before the 4,500,000 ms deadline killed the parent test. The log shows worker exits during final cleanup, but does not preserve a triggering finalization error. No sustained totals or clean-stop claim can be reconstructed.

One orphaned worker, PID 98966 with PPID 1, remained after parent exit. It was identified by its exact worker command and terminated with SIGKILL; `delivery/results/econ-baseline-windows-cleanup-v6-timeout.json` records zero survivors. No further window was started.

## Idle artifact measurements (30-minute gate failed)

| Metric | Result |
| --- | ---: |
| Warmup / baseline / cooldown | 60,002 / 1,799,994 / 60,380 ms |
| Separate work metric | 384,324 B |
| Request+response envelopes | 563 |
| Application payload bytes | 5,334,244 |
| Application WebSocket frame bytes | 5,337,672 |
| Worker user CPU | 6.839109 s |
| Worker system CPU | 2.252906 s |
| Maximum sampled process-tree RSS | 117,489,664 B |
| Sustained reads / retries | 0 / 0 |
| Clean stops / survivors | 52/52 / 0 |

Idle work equals the exact sum of per-role `used_bytes`; network edges reconcile exactly to message, payload and frame totals. No two-window aggregate is reported because the idle duration gate failed and sustained evidence is missing.

## Per-role idle work

| Role | Work bytes |
| --- | ---: |
| `observer-0` | 96,081 |
| `observer-1` | 96,081 |
| `observer-2` | 96,081 |
| `observer-3` | 96,081 |
| `replica-old-0-1` | 0 |
| `replica-old-0-2` | 0 |
| `replica-old-0-3` | 0 |
| `replica-old-0-4` | 0 |
| `replica-old-0-5` | 0 |
| `replica-old-1-1` | 0 |
| `replica-old-1-2` | 0 |
| `replica-old-1-3` | 0 |
| `replica-old-1-4` | 0 |
| `replica-old-1-5` | 0 |
| `replica-old-2-1` | 0 |
| `replica-old-2-2` | 0 |
| `replica-old-2-3` | 0 |
| `replica-old-2-4` | 0 |
| `replica-old-2-5` | 0 |
| `replica-old-3-1` | 0 |
| `replica-old-3-2` | 0 |
| `replica-old-3-3` | 0 |
| `replica-old-3-4` | 0 |
| `replica-old-3-5` | 0 |
| `replica-new-0-1` | 0 |
| `replica-new-0-2` | 0 |
| `replica-new-0-3` | 0 |
| `replica-new-0-4` | 0 |
| `replica-new-0-5` | 0 |
| `replica-new-1-1` | 0 |
| `replica-new-1-2` | 0 |
| `replica-new-1-3` | 0 |
| `replica-new-1-4` | 0 |
| `replica-new-1-5` | 0 |
| `replica-new-2-1` | 0 |
| `replica-new-2-2` | 0 |
| `replica-new-2-3` | 0 |
| `replica-new-2-4` | 0 |
| `replica-new-2-5` | 0 |
| `replica-new-3-1` | 0 |
| `replica-new-3-2` | 0 |
| `replica-new-3-3` | 0 |
| `replica-new-3-4` | 0 |
| `replica-new-3-5` | 0 |
| `runtime-old-0` | 0 |
| `runtime-old-1` | 0 |
| `runtime-old-2` | 0 |
| `runtime-old-3` | 0 |
| `runtime-new-0` | 0 |
| `runtime-new-1` | 0 |
| `runtime-new-2` | 0 |
| `runtime-new-3` | 0 |
| **Total** | **384,324** |

## Preserved attempts and limitations

All earlier failures and invalid or superseded identities are retained and hashed: unmapped durations; missing `runId` and `undefined` artifacts; stale v3 source identity and its 52-worker cleanup; v4 artifact collision; v5 idle artifacts plus retired resolved-retry failure; and v6 timeout. The resolved retry was rebound to the returning admission set without weakening retry rules, but the v6 sustained artifacts are still incomplete.

- Power remains exactly `blocked`: `powermetrics requires superuser; no calibrated external AC meter authorized`. No samples or energy estimates exist.
- Application WebSocket payload/frame accounting excludes handshake/control frames and TCP/IP bytes. Loopback is not Internet evidence; nettop matched zero worker rows.
- Per-process physical disk counters and fsync latency are unavailable; iostat is host-only. RSS is best-effort sampled on one host.
- Prices, budget, value, affordability and E3 remain open. No E2, production or K/R acceptance follows.

## Evidence hashes

`delivery/results/econ-baseline-windows-hashes.json` binds 55 artifacts, including the blocked execution/baseline, idle evidence with its duration shortfall, incomplete sustained identity, cleanup and all preserved baseline attempt history. The unified matrix hash sets were independently reverified: 254 evidence artifacts and 256 review artifacts, with zero mismatches.

| Artifact | SHA-256 |
| --- | --- |
| `delivery/results/econ-authorization-idle-baseline-complete.json` | `sha256:6315dd9d1f82756440a001266804b4a9e7778f9f8f1c116867bf5109627f0554` |
| `delivery/results/econ-authorization-idle-baseline-final.json` | `sha256:0018697e14abe29718e6735e35d31b9c640f9d72fdd6d0ca42e7448a25b53861` |
| `delivery/results/econ-authorization-idle-baseline.json` | `sha256:b5d8ce0943f5d23106d7060cda50c2d3e1e3d3ca0ff2c79ee4b5c93e3431087a` |
| `delivery/results/econ-authorization-sustained-max-envelope-complete.json` | `sha256:3cc036102e9405d22db05aaf23f4c4729c642bae84b2592b8aee9a43aa44aeff` |
| `delivery/results/econ-authorization-sustained-max-envelope-final.json` | `sha256:4c539b4bcc97232be56506eb0b0100ba2931a64a373c73ba5204fbb741bdf8d3` |
| `delivery/results/econ-authorization-undefined.json` | `sha256:881cc26069cb8650188a364bd04834896f7bfcedb6a2c72aa19a0e031072e908` |
| `delivery/results/econ-baseline-windows-baseline.json` | `sha256:bfe111ee71e072d657ff448e9f2ecfd0ab05966b21b1e3ac0c85c52faecffe7e` |
| `delivery/results/econ-baseline-windows-cleanup-v3-invalid.json` | `sha256:f8061dc4fa867b100196b735dbecf15c405852b084109cf3a9f265e7aafe32a7` |
| `delivery/results/econ-baseline-windows-cleanup-v6-timeout.json` | `sha256:4c83da5a2125d9486f0cc1a3f80839f702be89139b72e66d599bbca77b992b9b` |
| `delivery/results/econ-baseline-windows-execution.json` | `sha256:457020f49eab0d994df6e0f028c2aab994451de7f6e7ecc110a35cb592110473` |
| `delivery/results/econ-baseline-windows-failure-1793273355715.json` | `sha256:de34ad88eeddc2e4b57047dd49f7ce363e545805f8195c91e515987cb550280e` |
| `delivery/results/econ-baseline-windows-failure-1793275632618.json` | `sha256:52e3e7dbdaa77be32ed97d24281bd71f1cbcd9c5f537ef2d11ba3993dd234e93` |
| `delivery/results/econ-baseline-windows-failure-1793276315705.json` | `sha256:67c69da58d15d33d8a17044ed525597497476c1813999768ebc7f432bd7b45e5` |
| `delivery/results/econ-baseline-windows-failure-1793278625921.json` | `sha256:fc2c3d68c21b050a32237d43226faa945eaac31c84ea69872f931a0eb9783cd2` |
| `delivery/results/econ-baseline-windows-manifest-v2.json` | `sha256:593a5ca40f463b9d67fdce1a432c8b5eac5c878668e4c09943a4431273df5bd4` |
| `delivery/results/econ-baseline-windows-manifest-v3.json` | `sha256:437fd02a28e411414e37b280556f300c26f1d7da98fdda15135e3271a3bc6e26` |
| `delivery/results/econ-baseline-windows-manifest-v4.json` | `sha256:d4ad46541eb9d2eeba6abc6ae8e5ef1b5e5674edeb44a3a674e8a7f77cd72cd6` |
| `delivery/results/econ-baseline-windows-manifest-v5.json` | `sha256:b43898107bcd6165dd4066e92f8e0de920e8f9a4202b3b0d82211f2cc47a3e76` |
| `delivery/results/econ-baseline-windows-manifest-v6.json` | `sha256:467a35f13cd4d501ffe618682b993d7666a430bb4efacc7834a81c7d5b53f903` |
| `delivery/results/econ-baseline-windows-manifest.json` | `sha256:e2484ab4f089396d67ffbf59a2b4a77624c74ba0acc6d9199eafdf7a5ee13ecc` |
| `delivery/results/econ-cleanup-idle-baseline-complete.json` | `sha256:693e1651ecf9ec45655852742deabc7aa9df0e925060571b3ec9e008ad256681` |
| `delivery/results/econ-cleanup-idle-baseline-final.json` | `sha256:36d92ec7e4554581e9e83e3440c01dc577d15a9a19decc2e0e4881f7b953bfe6` |
| `delivery/results/econ-cleanup-idle-baseline.json` | `sha256:e401cddada1434160f9aaea1059b8f2fdd4387750d3c5304188fd31e093086cc` |
| `delivery/results/econ-cleanup-sustained-max-envelope-final.json` | `sha256:03817557f0890dc1744a7a6a79eb25346e8685c2060876b59c65a4c4515f071f` |
| `delivery/results/econ-cleanup-undefined.json` | `sha256:e9a62c311efc0be89670444adaca72ee019b2f61a1f146eeda7deb46308038bd` |
| `delivery/results/econ-decision-idle-baseline-complete.json` | `sha256:225993417223f4c17ec4176b4aaa6fc8f09c61a2e45d745157b1e0f28cbe2b4a` |
| `delivery/results/econ-decision-idle-baseline-final.json` | `sha256:e19fd3f0a5d90261fb60d2935b739e868cecaea2eae7e0cf4b2f662b552685d0` |
| `delivery/results/econ-decision-undefined.json` | `sha256:4707a774a187eea0b6d46d7e1fc28ba7afb9eb893afdd7f7ac3e9294572f9c15` |
| `delivery/results/econ-disk-idle-baseline-complete.json` | `sha256:eea2e2c82fcaf8beafac5675a763895effe09a61794b40066e181589ae78fdf1` |
| `delivery/results/econ-disk-idle-baseline-final.json` | `sha256:2e86ac4080459f153ceed3f88134e7c58e9d5bb4b1d85a321a161518b732951d` |
| `delivery/results/econ-disk-undefined.json` | `sha256:39b45114a6b1da321c0fd900ef41291693cd15361ad51a3c5e13f47ab18dc9b0` |
| `delivery/results/econ-lab-summary-idle-baseline-complete.json` | `sha256:fed3832605b116b70db797792b6e18da22b4a763084bde429070fa6a907eca29` |
| `delivery/results/econ-lab-summary-idle-baseline-final.json` | `sha256:8ec25d6933cf5b0242160da5e6b94e998059c1b145e7d99ab5ebcef80a56bd96` |
| `delivery/results/econ-lab-summary-undefined.json` | `sha256:30a28cf8afb470e01b8fe56054620aa9e3df3e4fb1c06c7b632ee71a489bbdd8` |
| `delivery/results/econ-network-idle-baseline-complete.json` | `sha256:97da487212038cf6c67bf1328fec959911ce40b2f01db7dc5a998a47f779c220` |
| `delivery/results/econ-network-idle-baseline-final.json` | `sha256:3b58e440960b105bb4b809549e5a50ffe41a123311294bff4948aaacae0b9389` |
| `delivery/results/econ-network-undefined.json` | `sha256:386db13519d6bb7af3b41ff0c931e95fc327415177d8ab370b96fa553c1df48a` |
| `delivery/results/econ-owner-assumptions-idle-baseline-complete.json` | `sha256:f602d221ec864e05db47e96602ac0ff5d875cf5f7bd51d0b4740076695ba0463` |
| `delivery/results/econ-owner-assumptions-idle-baseline-final.json` | `sha256:2ef0b1421126421e37f3aa170a4eb1b500f8ba3e14a66c75c9e03bee2677da71` |
| `delivery/results/econ-owner-assumptions-undefined.json` | `sha256:967640b415cba5dd142a756a7abaa6c04e4b907ead0d0466ff554a6aad1e93df` |
| `delivery/results/econ-power-idle-baseline-complete.csv` | `sha256:a49d5317c8c285874d1cf1de69bfc0b76be440d91dd8a2799b4c6587ce6c978a` |
| `delivery/results/econ-power-idle-baseline-complete.json` | `sha256:fb31b602a036c2a42b6e891e3136a28f2766048dab678b0181c54d7d6383ca24` |
| `delivery/results/econ-power-idle-baseline-final.csv` | `sha256:a49d5317c8c285874d1cf1de69bfc0b76be440d91dd8a2799b4c6587ce6c978a` |
| `delivery/results/econ-power-idle-baseline-final.json` | `sha256:388f0ecd02d77b1cb7b723fd14f569eb8aef7f6cd3ccc7b7b19b055e7c10bc53` |
| `delivery/results/econ-power-undefined.csv` | `sha256:a49d5317c8c285874d1cf1de69bfc0b76be440d91dd8a2799b4c6587ce6c978a` |
| `delivery/results/econ-power-undefined.json` | `sha256:85b27c9fed5b0bc663389a877ec61c469557cf8dcdf4485ff87faad41f3d837b` |
| `delivery/results/econ-process-idle-baseline-complete.json` | `sha256:ee5ea4f5b85de2858c09ed2b3347c7691a2d1cfa2b55b609ca22806345937078` |
| `delivery/results/econ-process-idle-baseline-final.json` | `sha256:3b2e8c89f2bea3c1321bf25e4677b44258be83129f70cbfc5ff3324fb19360ce` |
| `delivery/results/econ-process-undefined.json` | `sha256:3080ff12d4b66b06b5e016040e8a92a66ef9ac5f997fde1200809ee57d933deb` |
| `delivery/results/econ-work-idle-baseline-complete.json` | `sha256:2aa6fdbccc3c355f70ce789e903ac13936e2f72df0612b8bf4b77c447871870b` |
| `delivery/results/econ-work-idle-baseline-final.json` | `sha256:16c9e6e3447e86106350b62facd5958805cd7f6031a78abd9dc8139c9537dc70` |
| `delivery/results/econ-work-undefined.json` | `sha256:61a63df7270c17d22c20a9ed96c7019e5a06e69e5f31300310aa35e3c898e1e9` |
| `scripts/rso5-baseline-blocked-evidence.mjs` | `sha256:5335ca49e978bda80b3414ec1407b495a50dc4a88c43f8864589b78678235245` |
| `scripts/rso5-baseline-evidence.mjs` | `sha256:24f61c0cc5eb448887941bdef10689de7f18e04fda2d43e11e5f6943e85b2e8c` |
| `scripts/rso5-baseline-receipt.mjs` | `sha256:0d80d9438a3aa0509751ce7c6e89a8e7c5c50289403e581a69a5ac6f14ba3ba6` |

**Full baseline final review cannot proceed** until a complete 30-minute idle window and complete sustained evidence exist. Independent review of the previously accepted unified 20-run matrix remains available; this postmortem does not invalidate it.
