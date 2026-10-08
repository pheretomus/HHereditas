# HHereditas — progress & next steps (handoff)

Work was paused on purpose (usage limit). Agents were stopped mid-stage; their file edits are on
disk. Nothing below has been verified end-to-end yet. Run `npm test -w @hhereditas/core` first.

## Done and committed
- Monorepo scaffold, data model (`packages/core/src/types.ts`), seq helpers, fixtures.
- Desktop scaffold (Vite + React + Tauri 2 config, CSP, dialog/fs plugins), design tokens,
  dev gallery + `apps/desktop/scripts/shot.mjs`, app icon, CI/release workflows, docs/DEVELOPMENT.md.

## Core engine (`packages/core/src`) — state per module
Implemented + reviewed by 2 adversarial reviewers each. Fix stage was running when stopped.

| Module | State | Next step |
|---|---|---|
| io/genbank, fasta, location | implemented, reviewed | apply review findings (throws past ~125k warnings: avoid `push(...spread)`; quadratic multi-line location building; BOM before later LOCUS/'>' header; fuzzy '<'/'>' at origin joins), then verify |
| io/snapgene | implemented, reviewed | CRITICAL: stale /codon_start overrides SnapGene readingFrame; >65k features drops record; quadratic paths on crafted files; then verify |
| enzymes | implemented, reviewed, fixes applied (6) | final verification only |
| primers | implemented, reviewed | RNA templates (U) never match; designPrimer U-primers/clamp window; Unicode case-folding validation; then verify |
| ops | implemented, reviewed | CRITICAL: extractRange keeps /codon_start when clipping CDS 5' end; RNA revcomp; origin two-segment joins; /transl_except remap; extractRange of singly-cut plasmid parentRange; property tests failing; then verify |
| seq (translate, codons, orf, search, stats) | implemented, reviewed, fixes applied | final verification only |
| gel | implemented, reviewed | band merging (no single-linkage chaining), Bioneer ladder masses, high-% TBE model; then verify |
| cloning | NOT STARTED | implement per spec in the core workflow script (PCR, digestRecord, ligate, restrictionClone, Gibson + primer design, Golden Gate, calculators) |
| io/index.ts + detect/parseAny | NOT STARTED | integrator task |

Full specs and review findings: workflow scripts/journals under
`~/.claude/projects/-home-srdgjuchdr-HHereditas/225da931-c073-4b48-924b-5eee162738b9/`
(core run `wf_f226c94c-0ec`, UI run `wf_a5edd79f-913`).

## UI — state per component
| Component | Path | State | Next step |
|---|---|---|---|
| Design system | packages/ui/src/components (~30 primitives) | partially built | finish, gallery `UiKit`, review |
| App shell | apps/desktop/src/shell | not started (0 files) | build per spec |
| CircularMap | packages/viewer/src/circular | partially built | finish + tests, review |
| LinearMap | packages/viewer/src/linear | partially built | finish + tests, review |
| SequenceView | packages/viewer/src/sequence | implemented | design + interaction review → fix → verify |
| GelView | packages/viewer/src/gel | implemented | design + interaction review → fix → verify |

## After that
1. Integration: zustand store, open/save (Tauri + browser), wire shell + viewers, undo/redo,
   enzymes/primers/features panels, digest + gel sheet, cloning wizards, export, settings.
2. E2E tests + visual review of the whole app.

## Needs sudo (run in a separate WSL terminal)
```bash
sudo apt update && sudo apt install -y build-essential pkg-config libwebkit2gtk-4.1-dev libxdo-dev \
  libssl-dev libayatana-appindicator3-dev librsvg2-dev fonts-noto-cjk libnss3 libnspr4 libgbm1 xvfb
```
Then: `npm run tauri dev -w @hhereditas/desktop` opens the desktop window (via WSLg).
