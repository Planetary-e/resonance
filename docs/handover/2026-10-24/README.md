# Portable handover evidence — October 24, 2026

[Start at HANDOVER](../../../HANDOVER.md). Files here are selected textual evidence,
not a complete source/runtime snapshot. Small original logs/manifests/patch are
verbatim and contain historical local filesystem paths. No credentials, user data
or encrypted runtime fixtures are included.

- [Evidence SHA256 manifest](evidence-hashes.json): copied logs, candidate/final/closing manifests and correction patch; includes original provenance and availability.
- [Current 931-path source identity](source-identity.json): source, test, script and configuration files, including inherited dirty/untracked dependencies.
- [Original eight-path corrected review candidate](review-candidate-hashes.json): all eight matched local source at handover.
- [13 focused PASS](frozen-focused.log), [46 composed PASS, unreviewed](composed-unreviewed.log), [source noEmit log](source-tsc-final.log) and [result summary](result.json). Successful typecheck log is empty.
- [Historical failed equivocation regression](historical-equivocation-regression.log), [its receipt](historical-equivocation-regression-receipt.json) and [historical failed vertical](historical-vertical-final-diagnostic.log): earlier rejected candidate, not current status.
- [Correction patch](correction.patch): eight-file correction delta; not a complete checkout.
- [Relative noEmit overlay](source-tsconfig.json): intended historical compiler options without workstation absolute paths; selection independently checked.
- [Parent portable source noEmit PASS](portable-typecheck-validation.json), exit0 over 671 inputs, and [showConfig](portable-source-showconfig.json): verifies the current exact source; historical empty log alone does not establish its inputs.
- [Independent review instructions](REVIEW.md).
- [Pre-handover completion plan](completion-plan-before-handover.md) and [pre-handover execution roadmap](execution-roadmap-before-handover.md): verbatim historical archives, superseded for active status; [archive hashes](archive-hashes.json).
- [Read-only pre-handover local Git status](local-git-status.txt): inherited working tree; not a handover diff.

Other historical `/tmp` paths mentioned in old documents are external references;
portable availability is unknown unless listed in the evidence manifest. In
particular no reopenable historical encrypted fixture is claimed. The source
identity requires the full matching working tree to be transferred separately.
The source overlay was converted mechanically. Its 671-file selection differs
from the historical absolute overlay (which yielded no `files` in showConfig);
the parent independently ran the portable noEmit command: PASS, exit0, unchanged
source identity. This does not retroactively establish the historical selection.
No app test or build was run.

## Mechanical identity verification

Run from repository root; this reads and hashes files only:

```sh
python3 - <<'PYCODE'
import hashlib, json
from pathlib import Path
folder = Path('docs/handover/2026-10-24')
for row in json.loads((folder / 'source-identity.json').read_text())['paths']:
    path = Path(row['path'])
    assert hashlib.sha256(path.read_bytes()).hexdigest() == row['sha256'], path
for row in json.loads((folder / 'evidence-hashes.json').read_text()):
    if 'sha256' in row:
        path = folder / row['path']
        assert hashlib.sha256(path.read_bytes()).hexdigest() == row['sha256'], path
print('Source and portable evidence identities match')
PYCODE
```

[Handover validation report](validation.json), [documentation changed paths](handover-changed-paths.txt)
and [handover package hashes](package-hashes.json) record this documentation pass.
The package hash list excludes itself and does not replace the wider source identity.
