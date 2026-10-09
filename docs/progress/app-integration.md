# App integration progress log

## Goal
Turn core + ui + viewer + shell into a working desktop app (spec: docs/progress/specs/app-integration.md,
task brief from team lead: state/, platform/, App wiring, enzymes, digest & gel, primers, features, save,
shortcuts, find bar; cloning out of scope -> disabled "Cloning (coming soon)").

## Done
- Read specs and APIs.
- apps/desktop/src/state/: history.ts (undo/redo snapshots), documents.ts (document model, edits via core
  ops, dirty = record !== savedRecord), store.ts (zustand: documents, active, sheets, close prompt, status),
  settings.ts (localStorage v1, defensive parse), analysis.ts (enzyme display sets, primer sites, search, ORFs).
- platform/: types.ts, browser.ts (input file / download / beforeunload), tauri.ts (dialog, fs, open-files
  event + take_pending_open_files, drag-drop, close-requested), index.ts (isTauri).
- app/: App.tsx, DocumentWindow.tsx, files.ts (open/parse, save/save-as, primers -> primer_bind on GenBank),
  commands.ts, shortcuts.ts, nativeMenu.ts (macOS menu bar via Tauri), samples.ts.
- features/: document/DocumentView (maps + SequenceView + context menu), inspector/InspectorPane,
  enzymes/DigestSheet + digest.ts + ChooseEnzymesSheet, primers/AddPrimerSheet, features/AddFeatureSheet,
  dialogs/NewSequence, SaveAs (browser), ClosePromptDialog.
- Shell change (noted): ToolbarContent got `cloningAvailable` prop (false -> disabled "Cloning (coming soon)").
- Added sample src/samples/pBAD30.gb (Biopython test data) + README row.
- main.tsx renders app/App.

- Ran in browser (port 5401): welcome, map, feature select, split, digest sheet, fragment open, typing+undo,
  search, primer add, dark theme, narrow window all verified via screenshots in /tmp/hh-shots/app/.
- Fixes after review: equischizomer dedupe of 6-cutter pool (map was flooded with ClaI/BspDI/Bsu15I...),
  Vector NTI backslash labels shown as spaces, CDS-aware translation in inspector, typing coalesced into one
  undo step, Tm only for 10..60 bp, primers from long selections take 20 bases, cut-to-cut fragment
  positions, inspector auto-hidden below 1100 px window width, File items in Actions menu on Win/Linux
  (shell ToolbarContent got `actionsMenuPrefix`).
- Vitest: src/state/__tests__/store.test.ts (18 tests) pass; all desktop tests 84/84.

- Hidden 'source' features in the views/sidebar (kept in data); samples open under their file name (pUC19, not SYNPUC19V).
- Playwright: apps/desktop/playwright.config.ts + e2e/smoke.spec.ts (4 tests: sample -> map -> feature -> digest/gel
  -> open fragment; edit + undo/redo; find; save -> download GenBank) all pass against vite on 5401.
- cargo build of src-tauri: OK. Dev server on 5401 stopped.

## Current state
DONE for this scope. tsc clean, desktop vitest 84/84, e2e 4/4, cargo build OK.
Screenshots: /tmp/hh-shots/app/ (welcome-light/dark, final-light-*, final-dark-*, c-digest, d-fragment, e-narrow...).

## Open problems / known issues
- GenBank cannot store primers: written as primer_bind features on save (they come back as features).
- Vector NTI backslash-for-space labels are converted on open in the app (core featureLabel keeps them).
- Not verified inside a real Tauri window (no `tauri dev` run): native menu (macOS), dialogs, fs, drag-drop,
  close-requested are written against the API but only type-checked/cargo-built.
- Alt+Mod+I / menu toggle change the persisted inspector setting; below 1100 px the inspector is controlled by
  a separate narrow-window state (toolbar button works, shortcut does not).
- Large genomes (> 1 Mb): enzyme display limited to the common set, ORFs off; analyses run on the main thread
  (no Web Worker yet).
- Running vitest from the repo root picks up other packages' tests that fail outside their own config
  (viewer suites) - not caused by this work; run per package.

## Next steps
- Manual `npm run tauri dev` smoke run on a desktop (WSLg / macOS).
- Web Worker for analyses on big records; cloning UI once the core cloning engine lands (menu stub present).
- Map context menu e2e, enzyme chooser e2e.
