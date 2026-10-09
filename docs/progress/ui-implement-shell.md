# ui-implement-shell: progress log

Component key: `shell` (design system primitives + application shell). Spec: `docs/progress/specs/ui-shell.md`. Port: **5201**.

## Goal
Finish TASK 1 (UI primitives in `packages/ui/src/components/*`), TASK 2 (app shell in `apps/desktop/src/shell/*`) and TASK 3 (galleries `UiKit.gallery.tsx`, `Shell.gallery.tsx`) to production standard, verified visually in light/dark at 900x600 and 1600x1000; write `docs/progress/findings/ui-shell.implementer-report.md`.

## Status: DONE (session 3)
Report: `docs/progress/findings/ui-shell.implementer-report.md` (includes full API appendices).

## Done
- Sessions 1-2 (predecessor): all 30 primitives, all shell components, both galleries, tests.
- Session 3 audit + fixes:
  - SplitView: drag-to-close keeps the pre-drag size for re-opening (test).
  - SegmentedControl: deterministic arrow/Home/End selection (test).
  - Tooltip/Popover exit fades.
  - Tauri drag regions: `deep` on Toolbar root + all passive parts (a bare attribute on an ancestor blocks deep regions in Tauri 2.12), `false` on field frames / NumberField / SegmentedControl; AppShell titlebar deep; Welcome hero drag surface (tests emulate Tauri's drag.js).
  - FeatureColorWell: live preview + single commit on native `change` / popover close (was: a commit per `input` event); picker starts at the current colour (resolveHexColor) (tests).
  - SourceList focus ring only on non-selected active rows; `contextMenuItemId` outline; Sidebar `contextMenuItem` (tests).
  - AppShell inactive window: graphite accent tokens inside the window.
  - StatusBar container query (<480px hides document info); toolbar title shrinks last, compact search width 150-170px, compact gap 6px.
  - Inspector: QualifierEditor (Edit/Done, key/value fields, remove, add, flags), `selectionDetails`, `children` cards, `onFeatureColorPreview` (tests).
  - ToolbarContent: `shortcuts` + DEFAULT_TOOLBAR_SHORTCUTS (integration-spec bindings), segment tooltips with shortcuts, `enzymeDisplayOptions` / `enzymeDisplayLabels`, EnzymeDisplay 'commercial' (tests).
  - WelcomeScreen drop overlay below the title strip.
  - Galleries: 4,545-feature genome; fixed 960x620 `narrow` / `narrow-welcome`; open submenu / context menu; sidebar context-menu wiring demo; table frames; no literal colours.

## Current state
- Tests: packages/ui 91/91, apps/desktop 66/66. tsc clean for packages/ui and apps/desktop (only packages/core/src/seq/translate.ts error, not ours).
- Final screenshots: /tmp/hh-shots/shell/uikit (34), /tmp/hh-shots/shell/window (36), /tmp/hh-shots/shell/interaction (28). No console errors/warnings in any story.
- Dev server on 5201 stopped.

## Open problems / decisions (for the integrator)
- Shortcut hints are display-only; pass the command registry bindings via `ToolbarContent.shortcuts` (defaults follow app-integration.md: Alt+Mod+S / Alt+Mod+I / Mod+1-3 / Mod+E / Mod+D / Mod+F).
- Qualifier values are single-line fields (no multi-line TextField primitive yet).
- Auto-collapsing the inspector at small window sizes is an app-level policy (not done in AppShell).

## Next steps
- None for this component. Integrator: wire AppShell/ToolbarContent/Sidebar/Inspector/StatusBar/MainArea to the store (see the report's wiring section and `DocumentWindow` in Shell.gallery.tsx).
