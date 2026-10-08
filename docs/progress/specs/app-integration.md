# App integration spec (apps/desktop)

Goal: turn the finished engine (`@hhereditas/core`) and components (`@hhereditas/ui`,
`@hhereditas/viewer`, `apps/desktop/src/shell`) into a working SnapGene-like desktop app.
Read first: `docs/progress/specs/_common-ui.md` (rules, gallery, screenshots), every API summary
in `docs/progress/api/*.md`, and `packages/core/src/types.ts` (coordinate conventions).

Product direction (owner): macOS-like, visualization first, few options visible at once
(progressive disclosure: popovers, inspector, context menus, sheets). English UI.

## Architecture

```
apps/desktop/src/
  main.tsx                 bootstrap (fonts, styles, environment, gallery in dev) → <App/>
  App.tsx                  AppShell wired to the store; global shortcuts; drag & drop; window title
  state/
    store.ts               zustand store (documents, active document, settings, UI state)
    documents.ts           document model + actions (open, new, close, edit, undo/redo)
    history.ts             per-document undo/redo of { record, selection, label }
    settings.ts            persisted settings (localStorage, versioned, defensive parsing)
    analysis.ts            derived data hooks: enzyme sites, primer sites, ORFs, search hits (memoized by
                           record identity + settings; heavy work for records > 200 kb in a Web Worker)
  platform/
    index.ts               isTauri(); picks the implementation
    tauri.ts               dialog/fs plugin + window APIs (title, close-requested, drag-drop paths)
    browser.ts             <input type=file>, Blob downloads, beforeunload
    menu.ts                native app menu on macOS (Tauri menu API); no native menu bar on Windows/Linux
  commands/                command registry {id, title, shortcut, enabled(ctx), run(ctx)} used by menus,
                           toolbar, context menus and keyboard shortcuts (single source of truth)
  features/
    document/              DocumentView: Map (circular or linear by topology) / Sequence / Split;
                           selection shared across views; scroll-to-feature
    sidebar/               documents list, Features / Primers / Enzymes sections wired to the store
    inspector/             Selection (range, length, GC %, Tm for ≤ 60 bp, MW, translation of selection),
                           Feature editor (name, type, strand, colour, qualifiers), Primer details
    enzymes/               enzyme-set popover (Unique 6+ cutters (default), Unique & dual, Common set,
                           Commercial ≥ 6 bp, None, Custom… searchable list with filters), Digest & Gel sheet
                           (choose enzymes → fragments table + GelView with ladder picker, agarose %, open a
                           fragment as a new document)
    primers/               add primer from selection (fwd/rev) or pasted sequence; primer editor (Tm/GC/length
                           live, hairpin/dimer warnings); Design primers for selection (designPrimerPair);
                           binding sites shown in all views; copy order list
    features/              add feature from selection; edit; delete; colour; show/hide by type
    cloning/               sheets/wizards: PCR, Restriction cloning, Gibson assembly (with primer design and
                           NEBuilder-style amounts calculator), Golden Gate. Each: inputs (open documents or
                           files) → live preview (map + gel thumbnail + warnings) → "Create" opens the product
                           as a new document with a comment describing how it was made
    search/                find bar (DNA with IUPAC + mismatches, protein 6-frame), next/previous, count
    analysis/              ORF finder toggle + min length; translation display options
    export/                Save / Save As (GenBank default; FASTA; SnapGene .dna marked experimental),
                           export map as SVG/PNG
    settings/              theme (system/light/dark), default enzyme set, Tm conditions, binding stringency
    welcome/               welcome screen: Open…, New sequence…, recent files, bundled samples (src/samples)
```

## Behaviour requirements

- Open: GenBank (.gb .gbk .genbank .ape), FASTA (.fa .fasta .fas .fna), SnapGene (.dna), plain text;
  multi-record files open every record; parse warnings shown in a non-blocking banner.
- Save: Cmd/Ctrl+S writes back to the same path when the format is GenBank/FASTA; for .dna sources ask
  (Save As GenBank, or experimental .dna). Save As offers formats. Dirty marker in the title and sidebar;
  closing a dirty document or the window asks Save / Don't Save / Cancel.
- Editing: SequenceView edit intents → core ops (insert/delete/replace) with feature remapping; every
  change is undoable (Cmd/Ctrl+Z, Shift+Cmd/Ctrl+Z); selection restored on undo.
- Shortcuts (Cmd on macOS, Ctrl elsewhere): N new, O open, S save, Shift+S save as, W close, Z / Shift+Z,
  F find, 1/2/3 map/sequence/split, Alt+Cmd+S sidebar, Alt+Cmd+I inspector, E enzymes popover,
  D digest sheet. Show them in menus and tooltips.
- Drag & drop files onto the window opens them (Tauri drag-drop paths; browser File objects).
- Large records (E. coli 4.6 Mb): opening, scrolling and selecting stay responsive (worker for analyses).
- Everything works in the browser dev mode too (npm run dev) so it can be tested with Playwright;
  Tauri-only features degrade gracefully there.

## Quality gates

- Vitest unit tests for the store (edit/undo/redo, open/close, dirty tracking), commands and analysis hooks.
- Playwright E2E against the dev server (apps/desktop/e2e/): open sample → select feature → digest → gel;
  edit + undo; PCR; restriction cloning; Gibson; export (browser download); keyboard shortcuts.
- Visual review in light/dark, mac/windows platform variants, 960×620 and 1600×1000.
- `cargo build` of src-tauri and a manual smoke run via `npm run tauri dev` (WSLg) at the end.
