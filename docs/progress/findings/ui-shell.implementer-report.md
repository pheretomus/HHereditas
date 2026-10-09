# ui-shell: implementer report

Component key `shell` (design system primitives + application shell). Spec: `docs/progress/specs/ui-shell.md`.
This report covers the finished state after three sessions; session 3 audited the predecessor's work,
verified it interactively (Playwright) and visually (both themes; 900×600, 960×620, 1320×840 and
1600×1000; mac, windows and linux chrome), fixed the defects found, and completed the integration
surface the app-integration spec needs. Progress log: `docs/progress/ui-implement-shell.md`.

## Status

- TASK 1: 30 primitives in `packages/ui/src/components/*` (Button, IconButton, SegmentedControl, Toolbar /
  ToolbarGroup / ToolbarSpacer / ToolbarTitle, SourceList, SplitView / SplitPane, Popover, Menu, ContextMenu,
  Sheet, Dialog, TextField, SearchField, NumberField, Select, Checkbox, Switch, Slider, Tooltip (+ Provider),
  Badge, Kbd, Separator, Disclosure, PropertyList, EmptyState, Spinner, Banner, Table, Tabs, Field), each
  with its own `index.ts` and CSS module, re-exported from `components/index.ts`.
- TASK 2: shell in `apps/desktop/src/shell/*` (AppShell, ToolbarContent, Sidebar, MainArea, Inspector,
  StatusBar, WelcomeScreen, plus VisualizationPlaceholder, FeatureColorWell, QualifierEditor, glyphs and the
  pure models), exported from `apps/desktop/src/shell/index.ts`.
- TASK 3: `apps/desktop/src/dev/UiKit.gallery.tsx` (17 stories) and `apps/desktop/src/dev/Shell.gallery.tsx`
  (15 stories: welcome, welcome-first-run, welcome-drop, document, split, sequence, no-selection, focus-mode,
  narrow, narrow-welcome, linear-record, dense-annotations, searching, inactive-window, large-genome).
- Tests: `packages/ui` 91 passing (7 files); `apps/desktop` 66 passing (2 files). `tsc --noEmit` is clean
  for `packages/ui` and for `apps/desktop`, apart from one error in `packages/core/src/seq/translate.ts`,
  which another agent owns.

## Changes in session 3 (fixes and additions)

Defects found by interactive testing and fixed:
1. **SplitView**: dragging a side pane closed went through the minimum size first, so showing the pane
   again brought it back at the minimum (200 px) instead of its width before the drag. A drag that snaps a
   pane closed now keeps the size it had when the drag started (macOS behaviour). Test added.
2. **SegmentedControl**: with Radix, arrow keys only selected while the key was still held when its
   deferred focus move ran, so quick taps moved focus without choosing. Arrow keys, Home and End now move
   *and* select deterministically (radio-group pattern), skipping disabled segments and wrapping around.
   Test updated.
3. **Window drag regions (Tauri 2.12 `drag.js`)**: a plain `data-tauri-drag-region` on an ancestor *stops*
   Tauri's ancestor walk (`return el === target`). Children without the attribute (for example the
   "Edited" label) therefore could not drag the window. The Toolbar root and all its passive parts now use
   `data-tauri-drag-region="deep"`. Field frames, NumberField and the SegmentedControl root carry `"false"`,
   so clicks in their padding never start a drag. The AppShell title bar is `deep`. The WelcomeScreen hero
   drags through a background surface, not through the scrolling section, so the scrollbar keeps working.
   A test emulates Tauri's exact algorithm.
4. **FeatureColorWell**: React's `onChange` on `<input type="color">` fires on every `input` event, so
   dragging in the system colour panel would have committed dozens of feature edits (an undo-history
   flood). The well now previews live (optional `onPreview` / `Inspector.onFeatureColorPreview`) and
   commits once, on the native `change` event or when the popover closes. The listener is attached through
   a callback ref, because Radix mounts popover content one render after `open` turns true. The system
   panel now starts at the feature's current colour: `resolveHexColor` resolves `var(--hh-feature-…)`.
   This also removed the last hard-coded colour (`#808080`). Tests added.
5. **Tooltips and popovers**: a tooltip closed during rapid keyboard focus changes stayed at full opacity
   until its open animation ended. Tooltips and popovers now fade out quickly when they close.

Polish:
- **Inactive window** (`windowActive={false}`): inside the window the accent turns graphite, as in macOS.
  This covers pop-up indicators, checkboxes, switches, sidebar icons, and the sequence selection and caret
  tokens. Previously only the toolbar dimmed.
- **SourceList**: the keyboard focus ring is drawn only on active rows that are not selected. On a selected
  row, the emphasized accent fill already shows focus, as in macOS sidebars.
- **Narrow windows**: the StatusBar hides the redundant document length below 480 px, using a container
  query, so the selection text is not cut off. In the toolbar, the title gives way last. In compact density
  the search field width scales from 150 to 170 px (`searchFieldWidth`) and the gaps tighten to 6 px.
  The full title and the "Search sequence" placeholder now fit at 900 px and at 960 px.
- **WelcomeScreen**: the drop overlay starts below the title strip, so the traffic lights stay clear.

Added for the integrator (from `docs/progress/specs/app-integration.md`):
- **Qualifier editing** in the Inspector's Feature card (the spec's "Feature editor (name, type, strand,
  colour, qualifiers)"). Edit / Done switches the read-only list to key/value fields: remove a row with −,
  add one with "Add Qualifier", Return or blur commits, Esc reverts. The whole new list is sent as
  `FeatureEdit.qualifiers`. Valueless flags such as `/pseudo` read "Yes", and a key added without a value
  becomes a flag. New component: `QualifierEditor`. Tests added.
- **`Inspector.selectionDetails`** adds extra rows to the Selection card (for example MW, or the
  translation of the selection). **`Inspector.children`** adds extra cards between Feature and Analysis
  (for example a Primer card).
- **`ToolbarContent.shortcuts`** and **`DEFAULT_TOOLBAR_SHORTCUTS`**: the hint defaults now match the
  integration spec. These are display hints only; the app binds the keys:
  - ⌥⌘S sidebar and ⌥⌘I inspector. The sidebar hint was ⌃⌘S before.
  - ⌘1–3 views, ⌘E enzymes, ⌘D digest, ⌘F search.
  - Every view segment now has a tooltip with its shortcut. Test added.
- **Enzyme menu**: `enzymeDisplayOptions` and `enzymeDisplayLabels`, plus the new `EnzymeDisplay` value
  `'commercial'` ("Commercial (≥ 6 bp sites)") from the integration spec. `'custom'` is listed
  automatically while it is current (`enzymeMenuChoices`). Tests added.
- **Context menus on sidebar rows**: `SourceList.contextMenuItemId` and `Sidebar.contextMenuItem` outline
  the right-clicked row in accent without changing the selection, as in macOS. The Shell gallery shows the
  complete wiring: the menu opens on rows only, and the outline clears when the menu closes. Test added.

Galleries:
- The synthetic genome now has 4,545 features over 4.64 Mb; the spec asks for about 4,500.
- `narrow` and `narrow-welcome` render a fixed 960×620 window, the minimum size in `tauri.conf.json`, at
  any viewport size.
- The UiKit menu story shows the Clone submenu open, and the context-menu story opens its menu on mount.
  The table stories have visible frames.

## Files (all within the ownership list)

`packages/ui/src/`:
- `index.ts` (unchanged; re-exports `components`).
- `components/index.ts`.
- `components/<Name>/{<Name>.tsx, <Name>.module.css, index.ts}` for each of the 30 primitives. Menu adds
  `MenuItemInner.tsx` and `menu.module.css`, which ContextMenu and Select share.
- Helpers: `NumberField/number.ts`, `Sheet/confirmKey.ts`, `SourceList/layout.ts`, `SplitView/layout.ts`
  and `Table/selection.ts`.
- Tests: `components/controls.test.tsx`, `NumberField/NumberField.test.tsx`, `Sheet/Sheet.test.tsx`,
  `SourceList/SourceList.test.tsx`, `SplitView/SplitView.test.tsx`, `Table/Table.test.tsx` and
  `lib/lib.test.ts`.
- `lib/{cx, mergeRefs, platform, shortcut, useControllableState, index}.ts`, `test/setup.ts` and
  `env.d.ts`.
- `styles/index.css` and `styles/tokens.css`.

`apps/desktop/src/shell/`:
- Components: `AppShell`, `ToolbarContent`, `Sidebar`, `MainArea`, `Inspector`, `QualifierEditor` (new in
  session 3), `FeatureColorWell`, `StatusBar`, `WelcomeScreen` and `VisualizationPlaceholder` (each
  `.tsx` with its `.module.css`), plus `glyphs.tsx` and `glyphs.module.css`.
- Models: `selectionSummary.ts`, `sidebarModel.ts`, `featureTypes.ts`, `format.ts`, `types.ts` and
  `ids.ts`.
- `index.ts`.
- Tests: `__tests__/{components.test.tsx, model.test.ts, setup.ts}`.

`apps/desktop/src/dev/`: `UiKit.gallery.tsx` and `Shell.gallery.tsx`.

## Exported API

The complete props interfaces and types are reproduced verbatim from the sources in Appendix A (`@hhereditas/ui`)
and Appendix B (shell). Public surface (barrels):

**@hhereditas/ui** (`packages/ui/src/components/index.ts`):
- Components:
  - Controls: Badge, Banner, Button, Checkbox, Dialog, Disclosure, EmptyState, Field, IconButton, Kbd,
    NumberField, PropertyList, PropertyRow, SearchField, SegmentedControl, Select, Separator, Sheet,
    Slider, SourceList, Spinner, SplitPane, SplitView, Switch, Table, TextField.
  - Tabs: Tabs, TabsList, TabsTrigger, TabsContent.
  - Toolbar: Toolbar, ToolbarGroup, ToolbarSpacer, ToolbarTitle.
  - Tooltip and TooltipProvider.
  - Menu: Menu, MenuTrigger, MenuContent, MenuItem, MenuCheckboxItem, MenuRadioGroup, MenuRadioItem,
    MenuLabel, MenuSeparator, MenuGroup, MenuSub, MenuSubTrigger, MenuSubContent.
  - ContextMenu, with the same item set prefixed `ContextMenu*`.
  - Popover, PopoverTrigger, PopoverContent, PopoverAnchor, PopoverClose.
- Helpers:
  - `cx`, `mergeRefs`, `useControllableState`.
  - `getPlatform`, `usePlatform`, `Platform`.
  - `formatShortcut`, `shortcutKeys`.
  - `isConfirmKey`.
  - Number rules: `formatNumberValue`, `parseNumberInput`, `stepNumber`, `normalizeNumber`, `decimalsOf`.
  - Pane sizing: `resolvePaneResize`, `dividerTarget`, `maxPaneSize`.
  - Source-list layout: `buildSourceListRows`, `visibleRowRange`, `scrollToReveal`.
  - Table rules: `compareValues`, `nextSelection`, `sortRows`.
- Types: the props interface of every component listed above, plus:
  - ControlSize, ButtonVariant, BadgeTone, BannerTone.
  - SegmentedOption, SelectOption, SelectEntry, PropertyItem.
  - SheetAction, DialogAction.
  - TableColumn, TableSort, TableBodyRenderProps, SelectionMode, SortDirection.
  - SourceListItem, SourceListSection, SourceListRow, SourceListMetrics.
  - PaneConstraint, PaneResize.

**Shell** (`apps/desktop/src/shell/index.ts`):
- Components: AppShell, ToolbarContent, Sidebar, MainArea, Inspector, StatusBar, WelcomeScreen,
  VisualizationPlaceholder, FeatureColorWell, QualifierEditor, CompositionBar, DocumentGlyph, FeatureGlyph,
  PrimerGlyph.
- Constants: `SIDEBAR_LIMITS`, `INSPECTOR_LIMITS`, `SIDEBAR_PANE_ID`, `INSPECTOR_PANE_ID`,
  `DEFAULT_TOOLBAR_SHORTCUTS`, `DEFAULT_ENZYME_DISPLAY_OPTIONS`, `ENZYME_DISPLAY_LABELS`,
  `TOOLBAR_DENSITY`, `COMMON_FEATURE_TYPES`.
- Hooks: `useSelectionSummary(record, selection)` and `useSequenceIndex(seq)`. Compute the summary once and
  pass it to both the Inspector and the StatusBar.
- Pure helpers:
  - Selection: `summarizeSelection`, `summarizeSequence`, `countBases`, `buildSequenceIndex`, `gcPercent`,
    `describeCaret`, `formatSelectionRange`, `formatSelectionStatus`.
  - Sidebar: `featureRows`, `primerRows`, `enzymeRows`, `matchesFilter`.
  - Toolbar: `toolbarDensity`, `searchFieldWidth`, `enzymeMenuChoices`.
  - Feature types: `featureTypeOptions`, `featureTypeLabel`, `qualifierLabel`.
  - Formatting: `formatLength`, `formatCompactLength`, `formatDocumentSubtitle`, `formatPercent`,
    `lengthUnit`, `formatFeatureLocation`.
  - Colours: `readSwatchPalette`, `resolveHexColor`.
  - Qualifiers: `qualifiersFromRows`, `sameQualifiers`, `keyColumnWidth`.
- Types: AppShellProps, ToolbarContentProps, ToolbarShortcuts, ToolbarDensity, SidebarProps,
  SidebarSectionId, MainAreaProps, InspectorProps, InspectorCardId, FeatureEdit, QualifierEditorProps,
  FeatureColorWellProps, StatusBarProps, WelcomeScreenProps, VisualizationPlaceholderProps,
  FeatureGlyphProps, SelectionSummary, BaseComposition, SequenceIndex, FeatureRow, PrimerRow, EnzymeRow,
  FeatureTypeOption, DocumentSummary, EnzymeDisplay, RecentFile, SampleSequence, ShellAction,
  SidebarItemRef, ViewMode.

### How the integrator wires the window (see `DocumentWindow` in `Shell.gallery.tsx`)

```tsx
<AppShell windowActive={focused} sidebarVisible={…} onSidebarVisibleChange={…} inspectorVisible={…} onInspectorVisibleChange={…}
  sidebarWidth={…} onSidebarWidthChange={…}   /* persist widths */
  toolbar={<ToolbarContent title={record.name} subtitle={formatDocumentSubtitle(n, record.topology)} edited={dirty}
            view={view} onViewChange={…} enzymeDisplay={…} onEnzymeDisplayChange={…} onChooseEnzymes={…} onAction={…}
            searchValue={…} onSearchChange={…} onSearchSubmit={…} searchStatus="3 of 12" searchRef={findRef}
            shortcuts={/* from the command registry */} enzymeDisplayOptions={['unique','unique-dual','common','commercial','none']} />}
  sidebar={<Sidebar documents={…} activeDocumentId={…} record={record} enzymeSites={shownSites} selectedItem={…} onSelectItem={…}
            onActivateItem={zoomTo} onItemContextMenu={…} contextMenuItem={…} emphasized={focused ? undefined : false} />}
  inspector={<Inspector selection={summary} tm={tm} selectionDetails={[…]} feature={feature} sequenceLength={n} topology={record.topology}
              onFeatureChange={(id, edit) => store.editFeature(id, edit)} onFeatureColorPreview={…} onZoomToFeature={…} onDeleteFeature={…}
              sequenceComposition={wholeSequence} analysisActions={…}>{/* extra cards */}</Inspector>}
  statusBar={<StatusBar selection={summary} length={n} topology={record.topology} message={transient} />}>
  <MainArea view={view} map={<CircularMap …/>} sequence={<SequenceView …/>} splitRatio={…} onSplitRatioChange={…} banner={warnings} />
</AppShell>
```
- Without a document, render `<WelcomeScreen …/>` instead. In the desktop app, drive `dropActive` from
  Tauri's drag-drop events; in the browser, `onDropFiles` works with DOM drag events.
- `FeatureEdit` fields are partial: `name`, `type`, `strand`, `color` (null means the type colour) and
  `qualifiers` (the complete new list). Each commit is one undoable edit.
- To show a sidebar context menu, wrap the Sidebar in a `ContextMenu`. In `onItemContextMenu`, record the
  item synchronously (a ref). The trigger's `onContextMenu` calls `preventDefault()` when no row was hit,
  so empty space gets no menu. Set `contextMenuItem` while the menu is open and clear it in
  `onOpenChange(false)`. A complete example is `SidebarContextMenu` in the gallery.
- `searchRef` focuses the search field for ⌘F. The tooltip and menu shortcut hints come from `shortcuts`,
  so pass the command registry's bindings to keep them in sync.

## Design decisions

- **Layout (macOS 11+ document window)**:
  - The sidebar runs the full window height, and the traffic lights sit on its top strip
    (`--hh-traffic-light-inset`, 78 px, on mac only).
  - The unified 52 px toolbar spans the content and the inspector. When the sidebar is hidden, the
    toolbar shifts right by the traffic-light inset.
  - Content sits on a white canvas with the 26 px status bar beneath it; the inspector is on the right.
  - Side panes resize on 0.5 px hairline dividers with an 8 px grab area. A pane snaps closed below half
    its minimum and can also be closed by double-clicking or pressing Return on its divider, or with the
    toolbar toggles.
  - Windows and Linux get the same design without the inset, because they keep their native title bar.
- **Hierarchy through weight and colour, not boxes**:
  - The grey frame is `--hh-bg-window`, `--hh-bg-sidebar` and `--hh-bg-inspector`; only the canvas is
    white.
  - Inspector cards are separated by hairlines alone, with right-aligned secondary labels.
  - Text is 13 px, controls are 24 px (sm) and 28 px (md), lucide icons are 16 px at stroke width 1.75,
    and motion runs 120–200 ms.
  - Accent is reserved for the emphasized selection, primary actions, toggled state and focus.
- **Progressive disclosure**: the toolbar holds just one view switcher, two menus, the search field and
  the pane toggles. Everything else is in menus, popovers, the colour well, inspector cards (collapsible)
  and Edit mode for qualifiers.
- **Selection semantics**: the sidebar selection is grey until the list has focus, then accent (macOS
  "emphasized"). An inactive window forces it grey. The right-clicked row is outlined and not selected.
- **Performance**:
  - SourceList is virtualized and stays smooth with 5,000+ rows; the 4,545-feature genome showed no long
    tasks while scrolling.
  - Selection statistics come from a block index of cumulative base counts every 1,024 bases. Any range
    costs two lookups plus at most two partial blocks, so updating while dragging stays cheap on a 4.6 Mb
    genome.
  - A selection change on the large genome costs about 13 ms in Vite dev mode. The profile is dominated by
    React 19's development-only work: prop-diff logging, validation and owner stacks.
- **Drag regions**: `deep` on every passive container, `false` on control frames. This follows the Tauri
  2.12 rule, which is verified by a test.
- **Keyboard**:
  - SourceList implements the tree pattern: arrow keys, Home/End, Page Up/Down, ←/→ to collapse or expand
    a section, Return to activate, and type-ahead.
  - SegmentedControl implements the radio group: arrow keys select.
  - SplitView dividers implement the window-splitter pattern: arrow keys resize (Shift for larger steps),
    Home/End go to the limits, Return collapses.
  - Sheet: Return runs the primary action and Esc cancels. It respects IME composition, so Return does not
    fire while Korean, Japanese or Chinese input is being composed.
  - Tooltips appear on keyboard focus but not when focus returns to the trigger programmatically.

## Tests (Vitest + Testing Library, jsdom)

- `packages/ui` (91 tests):
  - Primitives: Button, IconButton, SegmentedControl (click, arrow keys, Home/End, skipping disabled
    segments), SearchField, Switch and Checkbox, Field, Kbd, Tooltip, PropertyList (copy), Popover
    (initial focus), Menu.
  - Toolbar drag regions: an emulation of Tauri's walk, including fields and segmented controls.
  - Disclosure, Banner, EmptyState.
  - NumberField: parsing, stepping, commit and revert.
  - Sheet and Dialog: Return, Esc, IME composition, the tertiary button.
  - SourceList: layout, virtualization range, reveal, selection and activation, collapsing, the
    context-menu outline.
  - SplitView: pure sizing rules, keyboard, collapse, drag, and keeping the pre-drag size on drag-close.
  - Table: selection rules and sorting.
  - lib: shortcut formatting, platform, refs, controllable state.
- `apps/desktop` (66 tests):
  - Models:
    - Base counting through the block index, checked against a naive count, including origin-spanning
      ranges.
    - Selection summaries; a 4.6 Mb selection must summarize quickly.
    - Formatting, sidebar rows, toolbar density and search width, enzyme menu choices.
    - The qualifier edit model.
  - Components:
    - ToolbarContent: title, edited state, pane toggles, views, enzyme menu with custom options, actions
      and submenu, search, shortcut hints.
    - Sidebar: lists, typed references, filtering, empty state.
    - Inspector: caret, selection, Tm placeholder; name editing; strand and colour; colour preview and
      commit-once; qualifier editing (edit, remove, add, flags, read-only); extra rows and cards; actions;
      collapsing.
    - StatusBar.
    - MainArea: views, keeping visualizations mounted.
    - AppShell: layout, drag regions, traffic-light inset, collapse, inactive state.
    - WelcomeScreen: actions, lists, drop.
- Interactive checks used Playwright scripts against Vite on port 5201: tab order, menus and submenus,
  sidebar keyboard navigation and collapsing, divider drag/collapse/restore, renaming, colour well, type
  pop-up, qualifier editing, context menu, the large-genome profile. No console errors or warnings in any
  story.

## Screenshots (`/tmp/hh-shots/shell/`)

- `uikit/`: all 17 UiKit stories, light and dark, 1320×840 (34 files).
- `window/`: the Shell stories (36 files):
  - welcome, first-run and drop, in both themes and at 1600×1000, 900×600 and the fixed 960×620 window.
  - document at 1600×1000 and 900×600 in both themes; windows (light and dark) and linux chrome.
  - split view at 1600×1000 in both themes; sequence; no-selection.
  - focus-mode on mac, and dark on windows.
  - narrow 960×620 in both themes.
  - linear record, dense annotations (pBR322, 48 features), searching, inactive window, and the 4.6 Mb
    genome, each in both themes.
- `interaction/`: in both themes (28 files):
  - Toolbar: enzymes menu, actions menu with the Clone submenu, a tooltip with its shortcut, keyboard
    focus in the view switcher.
  - Sidebar: emphasized selection, divider dragging, dragged closed, re-opened at the pre-drag width,
    context menu on a row.
  - Inspector: colour well, type pop-up, qualifier editing.
  - Welcome screen: hover and keyboard focus.

## Known limitations

- **Placeholders**: MainArea draws neutral placeholders until the CircularMap, LinearMap and SequenceView
  are passed in as `map` and `sequence`.
- **Display-only hints**: the shortcut hints are display only; the app must bind the keys, ideally from
  the same registry it passes as `shortcuts`. ⌃⌘S is the macOS convention for the sidebar; the default
  follows the integration spec's ⌥⌘S.
- **Single-line qualifier values**: qualifier values are edited in single-line fields. A long
  `/translation` scrolls horizontally, because there is no multi-line TextField primitive yet. Key fields
  replace spaces with underscores; there is no further validation of INSDC qualifier keys.
- **Plain inspector values**: inspector values are plain text with copy buttons. Each copy button is a
  keyboard tab stop; that is kept on purpose for accessibility, but it lengthens the Tab order through the
  inspector.
- **Simulated focus state**: `windowActive` and `emphasized` are driven by the app from Tauri focus events.
  The galleries simulate them.
- **Sheet overlay**: the Sheet dims the whole webview, including the toolbar. The window can still be
  dragged by its native frame, but not by the toolbar, while a sheet is open.
- **Narrow layout**: at the 960 px minimum window size with both side panes open, the canvas is about
  424 px wide. The side panes keep their widths until the canvas reaches its 360 px minimum; collapsing
  the inspector automatically at small sizes is an app-level policy.
- **Gallery approximations**: the dev gallery mocks the macOS traffic lights; the real ones are drawn by
  the OS. The UiKit menu and context-menu stories force their open state for screenshots.

## Requested token additions

None. All colours come from `--hh-*` tokens. The 84 dark-theme variables in `[data-theme='dark']` and the
`prefers-color-scheme` block were verified identical by script. The inactive-window look reuses
`--hh-gray`.

---

## Appendix A: `@hhereditas/ui` declarations (verbatim from the sources)

Module-level exports per file are listed; the public surface is the per-component `index.ts` barrels above (internal helpers such as `MenuItemInner`, `headerKey`, `keyboardDelta` are not re-exported).

#### `packages/ui/src/components/Badge/Badge.tsx`
Exports: `Badge`
```ts
export type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';

export interface BadgeProps extends ComponentPropsWithRef<'span'> {
  tone?: BadgeTone;
  /** Solid fill (white text) instead of the soft tinted style. */
  solid?: boolean;
  size?: 'sm' | 'md';
}
```

#### `packages/ui/src/components/Banner/Banner.tsx`
Exports: `Banner`
```ts
export type BannerTone = 'info' | 'success' | 'warning' | 'error';

export interface BannerProps {
  tone?: BannerTone;
  title?: ReactNode;
  /** Message text. */
  children?: ReactNode;
  /** Buttons at the trailing end (small plain buttons work best). */
  actions?: ReactNode;
  /** Shows a close button. */
  onDismiss?: () => void;
  /** Custom icon, or false for none. */
  icon?: ReactNode | false;
  className?: string;
}
```

#### `packages/ui/src/components/Button/Button.tsx`
Exports: `Button`
```ts
export type ButtonVariant = 'default' | 'primary' | 'plain' | 'destructive';

/** Control heights: sm = 24 px, md = 28 px. */
export type ControlSize = 'sm' | 'md';

export interface ButtonProps extends ComponentPropsWithRef<'button'> {
  /**
   * default: bordered push button; primary: accent-filled default action (Return);
   * plain: borderless toolbar button; destructive: push button with a red label.
   */
  variant?: ButtonVariant;
  size?: ControlSize;
  /** Leading icon (e.g. a lucide icon; sized to 16 px / 14 px automatically). */
  icon?: ReactNode;
  /** Trailing icon, e.g. a chevron on a menu button. */
  trailingIcon?: ReactNode;
  /** Replaces the icon with a spinner and disables the button. */
  loading?: boolean;
  /** Stretch to the width of the container. */
  block?: boolean;
}
```

#### `packages/ui/src/components/Checkbox/Checkbox.tsx`
Exports: `Checkbox`
```ts
export interface CheckboxProps extends Omit<ComponentPropsWithRef<typeof CheckboxPrimitive.Root>, 'children'> {
  /** Text next to the box (clicking it toggles). Without a label, pass aria-label. */
  label?: ReactNode;
  /** Secondary line under the label. */
  description?: ReactNode;
}
```

#### `packages/ui/src/components/ContextMenu/ContextMenu.tsx`
Exports: `ContextMenu`, `ContextMenuTrigger`, `ContextMenuGroup`, `ContextMenuRadioGroup`, `ContextMenuSub`, `ContextMenuContent`, `ContextMenuItem`, `ContextMenuCheckboxItem`, `ContextMenuRadioItem`, `ContextMenuLabel`, `ContextMenuSeparator`, `ContextMenuSubTrigger`, `ContextMenuSubContent`
```ts
export type ContextMenuContentProps = ComponentPropsWithRef<typeof ContextMenuPrimitive.Content>;

export interface ContextMenuItemProps extends ComponentPropsWithRef<typeof ContextMenuPrimitive.Item> {
  /** 16 px leading icon. */
  icon?: ReactNode;
  /** Platform-neutral shortcut ("Mod+Shift+O") shown at the trailing edge. */
  shortcut?: string;
  /** Red label for actions that delete or discard. */
  destructive?: boolean;
}

export interface ContextMenuCheckboxItemProps extends ComponentPropsWithRef<typeof ContextMenuPrimitive.CheckboxItem> {
  icon?: ReactNode;
  shortcut?: string;
}

export interface ContextMenuRadioItemProps extends ComponentPropsWithRef<typeof ContextMenuPrimitive.RadioItem> {
  icon?: ReactNode;
  shortcut?: string;
}

export interface ContextMenuSubTriggerProps extends ComponentPropsWithRef<typeof ContextMenuPrimitive.SubTrigger> {
  icon?: ReactNode;
}
```

#### `packages/ui/src/components/Dialog/Dialog.tsx`
Exports: `Dialog`
```ts
export type DialogAction = SheetAction;

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 48–64 px artwork above the title (app icon, warning symbol…). */
  icon?: ReactNode;
  title: ReactNode;
  /** Informative text under the title. */
  message?: ReactNode;
  /** Extra content (e.g. a "Don't ask again" checkbox). */
  children?: ReactNode;
  /** Default button: focused on open, Return triggers it. Closes the alert after onAction. */
  primaryAction: DialogAction;
  /** Cancel button: Esc triggers it. Closes the alert after onAction. */
  secondaryAction?: DialogAction;
  /** Optional third button (e.g. "Don't Save"); buttons stack vertically when present. */
  tertiaryAction?: DialogAction;
  /** Width in px (default 260, like macOS alerts). */
  width?: number;
  className?: string;
}
```

#### `packages/ui/src/components/Disclosure/Disclosure.tsx`
Exports: `Disclosure`
```ts
export interface DisclosureProps {
  title: ReactNode;
  children?: ReactNode;
  open?: boolean;
  /** Default true. */
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Controls at the trailing end of the header (small icon buttons, a badge…). Not part of the toggle. */
  actions?: ReactNode;
  /**
   * section: inspector card with a bold title and a hairline above (default);
   * plain: inline disclosure triangle + label, no separators.
   */
  variant?: 'section' | 'plain';
  className?: string;
  id?: string;
}
```

#### `packages/ui/src/components/EmptyState/EmptyState.tsx`
Exports: `EmptyState`
```ts
export interface EmptyStateProps {
  /** 32–40 px illustration or icon. */
  icon?: ReactNode;
  title: ReactNode;
  message?: ReactNode;
  /** Buttons or links. */
  actions?: ReactNode;
  /** sm: inspector / sidebar; md: panels (default); lg: the main canvas. */
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}
```

#### `packages/ui/src/components/Field/Field.tsx`
Exports: `Field`
```ts
export interface FieldProps {
  label: ReactNode;
  /** The control. Gets an id (if it has none) and aria-describedby for hint/error. */
  children: ReactElement<{ id?: string; 'aria-describedby'?: string; invalid?: boolean }>;
  /** Help text under the control. */
  hint?: ReactNode;
  /** Error text under the control (replaces the hint, marks the control invalid). */
  error?: ReactNode;
  /** stacked: label above (default); inline: label in a right-aligned column on the left (macOS forms). */
  layout?: 'stacked' | 'inline';
  /** Width of the label column in inline layout (px, default 120). */
  labelWidth?: number;
  className?: string;
}
```

#### `packages/ui/src/components/IconButton/IconButton.tsx`
Exports: `IconButton`
```ts
export interface IconButtonProps extends Omit<ComponentPropsWithRef<'button'>, 'children'> {
  /** The icon (a lucide icon is sized to 16 px, or 14 px for size="sm"). */
  icon: ReactNode;
  /** Required: icon-only buttons need an accessible name. Also the default tooltip. */
  'aria-label': string;
  /** plain: borderless toolbar style (default); default: bordered push-button style. */
  variant?: 'plain' | 'default';
  size?: ControlSize;
  /**
   * Toggle state for on/off buttons (e.g. "Show Inspector"). Sets aria-pressed and tints
   * the icon with the accent colour while on.
   */
  pressed?: boolean;
  /** Tooltip text; defaults to the aria-label. Pass false for no tooltip. */
  tooltip?: ReactNode | false;
  /** Keyboard shortcut shown in the tooltip ("Mod+Alt+I"). */
  shortcut?: string;
}
```

#### `packages/ui/src/components/Kbd/Kbd.tsx`
Exports: `Kbd`
```ts
export interface KbdProps extends ComponentPropsWithRef<'kbd'> {
  /**
   * Platform-neutral shortcut such as "Mod+Shift+F" (Mod = ⌘ on macOS, Ctrl elsewhere).
   * Rendered as one key cap per key. Ignored when children are given.
   */
  shortcut?: string;
  /** Override the detected platform (mainly for documentation and tests). */
  platform?: Platform;
}
```

#### `packages/ui/src/components/Menu/Menu.tsx`
Exports: `Menu`, `MenuTrigger`, `MenuGroup`, `MenuRadioGroup`, `MenuSub`, `MenuContent`, `MenuItem`, `MenuCheckboxItem`, `MenuRadioItem`, `MenuLabel`, `MenuSeparator`, `MenuSubTrigger`, `MenuSubContent`
```ts
export type MenuContentProps = ComponentPropsWithRef<typeof DropdownMenu.Content>;

export interface MenuItemProps extends ComponentPropsWithRef<typeof DropdownMenu.Item> {
  /** 16 px leading icon. */
  icon?: ReactNode;
  /** Platform-neutral shortcut ("Mod+Shift+O") shown at the trailing edge. */
  shortcut?: string;
  /** Red label for actions that delete or discard. */
  destructive?: boolean;
}

export interface MenuCheckboxItemProps extends ComponentPropsWithRef<typeof DropdownMenu.CheckboxItem> {
  icon?: ReactNode;
  shortcut?: string;
}

export interface MenuRadioItemProps extends ComponentPropsWithRef<typeof DropdownMenu.RadioItem> {
  icon?: ReactNode;
  shortcut?: string;
}

export interface MenuSubTriggerProps extends ComponentPropsWithRef<typeof DropdownMenu.SubTrigger> {
  icon?: ReactNode;
}
```

#### `packages/ui/src/components/Menu/MenuItemInner.tsx`
Exports: `MenuItemInner`

#### `packages/ui/src/components/NumberField/NumberField.tsx`
Exports: `NumberField`
```ts
export interface NumberFieldProps
  extends Omit<
    TextFieldProps,
    'value' | 'defaultValue' | 'onChange' | 'onValueChange' | 'type' | 'trailing' | 'min' | 'max' | 'step'
  > {
  value: number | null;
  onValueChange: (value: number | null) => void;
  min?: number;
  max?: number;
  /** Arrow keys / stepper increment (default 1). Shift+arrow uses `largeStep` (default 10 × step). */
  step?: number;
  largeStep?: number;
  /** Decimal places (default: those of `step`). */
  precision?: number;
  /** Unit shown inside the field after the number ("bp", "°C", "nM"). */
  unit?: ReactNode;
  /** Show the stepper arrows (default true). */
  stepper?: boolean;
  /** Allow an empty field (value null). Otherwise clearing the text reverts. */
  allowEmpty?: boolean;
}
```

#### `packages/ui/src/components/Popover/Popover.tsx`
Exports: `Popover`, `PopoverTrigger`, `PopoverAnchor`, `PopoverClose`, `PopoverContent`
```ts
export interface PopoverContentProps extends ComponentPropsWithRef<typeof PopoverPrimitive.Content> {
  /** Draw the macOS-style arrow pointing at the trigger (default true). */
  arrow?: boolean;
  /** Inner padding: none (lists), sm (8 px) or md (14 px, default). */
  padding?: 'none' | 'sm' | 'md';
  /** Fixed width (px or CSS length). */
  width?: number | string;
}
```

#### `packages/ui/src/components/PropertyList/PropertyList.tsx`
Exports: `PropertyList`, `PropertyRow`
```ts
export interface PropertyItem {
  label: ReactNode;
  value: ReactNode;
  /** Text put on the clipboard by the copy button (default: the value when it is a string or number). */
  copyValue?: string;
  /** Monospaced value (sequences, coordinates). */
  mono?: boolean;
  /** Native tooltip on the value (e.g. the untruncated text). */
  title?: string;
  /** Clamp the value to this many lines (ellipsis); the copy button still copies everything. */
  maxLines?: number;
  /** Override the list's copyable setting for this row. */
  copyable?: boolean;
  /** React key (default: the label when it is a string). */
  key?: string;
}

export interface PropertyListProps {
  items?: readonly PropertyItem[];
  /** PropertyRow elements (alternative to `items`). */
  children?: ReactNode;
  /** Width of the label column in px (default 88). */
  labelWidth?: number;
  /** Show copy buttons on hover (default true). */
  copyable?: boolean;
  className?: string;
  style?: CSSProperties;
}

export interface PropertyRowProps {
  label: ReactNode;
  children: ReactNode;
  copyValue?: string;
  mono?: boolean;
  title?: string;
  /** Clamp the value to this many lines (ellipsis). */
  maxLines?: number;
  /** Override the list's copyable setting for this row. */
  copyable?: boolean;
}
```

#### `packages/ui/src/components/SearchField/SearchField.tsx`
Exports: `SearchField`
```ts
export interface SearchFieldProps
  extends Omit<TextFieldProps, 'leading' | 'trailing' | 'type' | 'value' | 'defaultValue' | 'onSubmit'> {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  /** Return (direction "next") or Shift+Return ("previous"). */
  onSubmit?: (value: string, direction: 'next' | 'previous') => void;
  /** Called after the field was cleared with the clear button or Esc. */
  onClear?: () => void;
  /** Short status shown before the clear button, e.g. "3 of 12". */
  status?: ReactNode;
}
```

#### `packages/ui/src/components/SegmentedControl/SegmentedControl.tsx`
Exports: `SegmentedControl`
```ts
export interface SegmentedOption<T extends string = string> {
  value: T;
  /** Visible text (also the accessible name and the tooltip in icon-only mode). */
  label: string;
  icon?: ReactNode;
  disabled?: boolean;
  /** Tooltip; defaults to the label when the control shows icons only. */
  tooltip?: string;
  /** Shortcut shown in the tooltip. */
  shortcut?: string;
}

export interface SegmentedControlProps<T extends string = string> {
  options: readonly SegmentedOption<T>[];
  value: T;
  onValueChange: (value: T) => void;
  /** Accessible name of the group, e.g. "View". */
  'aria-label': string;
  size?: ControlSize;
  /** Show icons only (labels move to tooltips and accessible names). */
  iconOnly?: boolean;
  /** Stretch to the container width with equal-width segments. */
  fill?: boolean;
  disabled?: boolean;
  className?: string;
  id?: string;
}
```

#### `packages/ui/src/components/Select/Select.tsx`
Exports: `Select`
```ts
export interface SelectOption<T extends string = string> {
  /** Non-empty string. */
  value: T;
  label: ReactNode;
  /** Plain text for type-ahead when `label` is not a string. */
  textValue?: string;
  icon?: ReactNode;
  disabled?: boolean;
}

export type SelectEntry<T extends string = string> =
  | SelectOption<T>
  | { type: 'separator' }
  | { type: 'label'; label: ReactNode };

export interface SelectProps<T extends string = string> {
  value?: T;
  defaultValue?: T;
  onValueChange?: (value: T) => void;
  options: readonly SelectEntry<T>[];
  placeholder?: string;
  size?: ControlSize;
  disabled?: boolean;
  'aria-label'?: string;
  id?: string;
  name?: string;
  /** Width of the button (px or CSS length). */
  width?: number | string;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
}
```

#### `packages/ui/src/components/Separator/Separator.tsx`
Exports: `Separator`
```ts
export interface SeparatorProps extends ComponentPropsWithRef<typeof SeparatorPrimitive.Root> {
  /** Indent both ends (e.g. 16 px inside an inspector card). */
  inset?: number;
  /** Stronger line (between major regions). */
  strong?: boolean;
}
```

#### `packages/ui/src/components/Sheet/Sheet.tsx`
Exports: `Sheet`
```ts
export interface SheetAction {
  label: ReactNode;
  onAction?: () => void;
  disabled?: boolean;
  /** Red label (e.g. "Delete"). */
  destructive?: boolean;
  /** Shows a spinner and disables the button. */
  loading?: boolean;
}

export interface SheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  /** One-line explanation under the title. */
  description?: ReactNode;
  /** Body content (form fields, previews…). */
  children?: ReactNode;
  /** Default button (accent). Return triggers it. The handler closes the sheet when done. */
  primaryAction?: SheetAction;
  /**
   * Cancel button; Esc triggers it. Defaults to "Cancel", which closes the sheet.
   * Pass null for no secondary button.
   */
  secondaryAction?: SheetAction | null;
  /** Called when the sheet is dismissed with Esc or the Cancel button. */
  onCancel?: () => void;
  /** Footer content aligned to the start (help button, "Don't ask again" checkbox…). */
  footerStart?: ReactNode;
  /** Width in px (default 480). */
  width?: number;
  /** Element focused when the sheet opens (default: the first focusable element). */
  initialFocusRef?: RefObject<HTMLElement | null>;
  className?: string;
}
```

#### `packages/ui/src/components/Slider/Slider.tsx`
Exports: `Slider`
```ts
export interface SliderProps {
  value?: number;
  defaultValue?: number;
  /** Called continuously while dragging. */
  onValueChange?: (value: number) => void;
  /** Called once when the user finishes a change (pointer up / key). */
  onValueCommit?: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  /** Number of evenly spaced tick marks under the track (0 = none). */
  ticks?: number;
  size?: ControlSize;
  disabled?: boolean;
  'aria-label'?: string;
  /** Spoken value, e.g. (v) => `${v} %`. */
  getValueText?: (value: number) => string;
  id?: string;
  className?: string;
  style?: CSSProperties;
}
```

#### `packages/ui/src/components/SourceList/SourceList.tsx`
Exports: `SourceList`
```ts
export interface SourceListItem {
  /** Unique across ALL sections of the list (prefix ids if needed, e.g. "feature:f12"). */
  id: string;
  /** Row text; also used for type-ahead and the accessible name. */
  label: string;
  /** Accessible name when it should say more than the label (e.g. "pUC19, edited"). */
  accessibleLabel?: string;
  /** 16 px leading icon or glyph. Generic (currentColor) icons are tinted with the accent colour. */
  icon?: ReactNode;
  /** Dim, right-aligned detail text (e.g. "861 bp"). */
  secondary?: ReactNode;
  /** Trailing count, badge or accessory. */
  trailing?: ReactNode;
  /**
   * Small pointer controls (e.g. a close button) shown at the trailing edge while the row is
   * hovered; they replace `trailing` while visible. Clicks on them do not select the row.
   * Give them tabIndex={-1}: the list is one Tab stop, and keyboard users act on rows with
   * shortcuts or a context menu.
   */
  actions?: ReactNode;
  disabled?: boolean;
  /** Native tooltip, e.g. the full name when the label is truncated. */
  title?: string;
}

export interface SourceListSection {
  id: string;
  /** Section header text. Sections without a title have no header and cannot collapse. */
  title?: string;
  /** Shown at the end of the header (e.g. the number of items). */
  count?: ReactNode;
  items: readonly SourceListItem[];
  /** Default true for titled sections. */
  collapsible?: boolean;
  /** Placeholder row shown when the section has no items (e.g. "No primers"). */
  emptyText?: string;
  /**
   * Tint of generic (currentColor) row icons: 'accent' (default, like macOS sidebars) or
   * 'secondary' for long lists where blue icons would be noisy.
   */
  iconTone?: 'accent' | 'secondary';
}

export interface SourceListProps {
  sections: readonly SourceListSection[];
  /** Accessible name, e.g. "Sidebar". */
  'aria-label': string;
  /** Id of the selected item (single selection). */
  selectedId?: string | null;
  /** Click, or keyboard navigation (selection follows focus, as in macOS sidebars). */
  onSelect?: (item: SourceListItem, section: SourceListSection) => void;
  /** Double-click or Return on an item. */
  onActivate?: (item: SourceListItem, section: SourceListSection) => void;
  /** Collapsed section ids (controlled). */
  collapsedSections?: readonly string[];
  defaultCollapsedSections?: readonly string[];
  onCollapsedSectionsChange?: (sectionIds: string[]) => void;
  /**
   * Selection style. Default (undefined): emphasized (accent) while the list has keyboard
   * focus, neutral grey otherwise, like macOS. true/false force a style (e.g. false while
   * the window is inactive).
   */
  emphasized?: boolean;
  /** Right-click on an item (use it to show a ContextMenu for that item). */
  onItemContextMenu?: (item: SourceListItem, section: SourceListSection, event: MouseEvent) => void;
  /**
   * Item whose context menu is open: drawn with an accent outline (macOS marks the
   * right-clicked row without selecting it). Set it in onItemContextMenu and clear it when
   * the menu closes.
   */
  contextMenuItemId?: string | null;
  /** Row height in px (default 28). */
  rowHeight?: number;
  /** Scroll the selected item into view when `selectedId` changes (default true). */
  revealSelection?: boolean;
  className?: string;
  style?: CSSProperties;
  id?: string;
}
```

#### `packages/ui/src/components/Spinner/Spinner.tsx`
Exports: `Spinner`
```ts
export interface SpinnerProps extends Omit<ComponentPropsWithRef<'span'>, 'children'> {
  /** Diameter in px (default 16). */
  size?: number;
  /** Accessible name (default "Loading"). Pass an empty string for a purely decorative spinner. */
  label?: string;
}
```

#### `packages/ui/src/components/SplitView/SplitView.tsx`
Exports: `SplitPane`, `SplitView`
```ts
export interface SplitPaneProps {
  /** Stable id (unique within the SplitView). */
  id: string;
  children?: ReactNode;
  /**
   * Size in px along the split axis (controlled). Panes with `size` or `defaultSize` are
   * FIXED and user-resizable; panes with neither are FLEXIBLE and fill the remaining space.
   */
  size?: number;
  defaultSize?: number;
  /** Called while the user drags a divider or uses the arrow keys on it. */
  onSizeChange?: (size: number) => void;
  minSize?: number;
  maxSize?: number;
  /** The pane can be collapsed (dragged closed, double-click / Return on its divider). */
  collapsible?: boolean;
  collapsed?: boolean;
  defaultCollapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
  /** Keep children mounted (hidden) while collapsed. Default true. */
  keepMounted?: boolean;
  /** Name used for the divider ("Resize Sidebar"). */
  label?: string;
  className?: string;
  style?: CSSProperties;
}

export interface SplitViewProps {
  /** horizontal: panes side by side (vertical dividers); vertical: panes stacked. */
  orientation?: 'horizontal' | 'vertical';
  /** SplitPane elements. */
  children: ReactNode;
  /** Animate collapsing and expanding (default true). */
  animated?: boolean;
  className?: string;
  style?: CSSProperties;
}
```

#### `packages/ui/src/components/Switch/Switch.tsx`
Exports: `Switch`
```ts
export interface SwitchProps extends Omit<ComponentPropsWithRef<typeof SwitchPrimitive.Root>, 'children'> {
  /** Text next to the switch (clicking it toggles). Without a label, pass aria-label. */
  label?: ReactNode;
  /** Put the label before the switch (settings rows) instead of after it. */
  labelPosition?: 'start' | 'end';
  size?: ControlSize;
}
```

#### `packages/ui/src/components/Table/Table.tsx`
Exports: `Table`
```ts
export interface TableColumn<T> {
  key: string;
  header: ReactNode;
  /** Grid track: px number or any CSS track ("minmax(120px, 2fr)"). Default: minmax(0, 1fr). */
  width?: number | string;
  align?: 'start' | 'center' | 'end';
  sortable?: boolean;
  /** Cell content (default: String(row[key])). */
  render?: (row: T, index: number) => ReactNode;
  /** Value used by the built-in sort (default: row[key]). */
  sortValue?: (row: T) => string | number | null | undefined;
  /** Monospaced, tabular cells. */
  mono?: boolean;
}

export interface TableSort {
  key: string;
  direction: SortDirection;
}

export interface TableBodyRenderProps<T> {
  /** Rows in display (sorted) order. */
  rows: readonly T[];
  rowCount: number;
  rowHeight: number;
  headerHeight: number;
  /**
   * Renders the row at display index `index`. Pass `style` to position it, e.g.
   * { position: 'absolute', top: 0, transform: `translateY(${start}px)` }.
   */
  renderRow: (index: number, style?: CSSProperties) => ReactNode;
}

export interface TableProps<T> {
  columns: readonly TableColumn<T>[];
  rows: readonly T[];
  rowKey: (row: T, index: number) => string;
  'aria-label': string;
  /** Current sort (controlled); null = unsorted. */
  sort?: TableSort | null;
  defaultSort?: TableSort | null;
  onSortChange?: (sort: TableSort | null) => void;
  /** The parent sorts `rows` itself (the table only shows the indicator). */
  manualSorting?: boolean;
  /** Default 'single'. */
  selectionMode?: SelectionMode;
  selectedKeys?: readonly string[];
  defaultSelectedKeys?: readonly string[];
  onSelectionChange?: (keys: string[]) => void;
  /** Double-click or Return. */
  onRowActivate?: (row: T, index: number) => void;
  onRowContextMenu?: (row: T, index: number, event: MouseEvent) => void;
  /** Alternating row backgrounds (default true). */
  zebra?: boolean;
  /** Row height in px (default 24). */
  rowHeight?: number;
  /**
   * Custom body rendering, e.g. with @tanstack/react-virtual. Use `scrollRef` as the
   * virtualizer's scroll element and `onScrollToRow` so keyboard navigation can reveal rows.
   */
  renderBody?: (body: TableBodyRenderProps<T>) => ReactNode;
  /** Ref to the scrolling element (needed for external virtualization). */
  scrollRef?: Ref<HTMLDivElement>;
  /** Called when keyboard navigation needs row `index` to be visible (virtualized bodies). */
  onScrollToRow?: (index: number) => void;
  /** Shown when there are no rows. */
  emptyState?: ReactNode;
  className?: string;
  style?: CSSProperties;
}
```

#### `packages/ui/src/components/Tabs/Tabs.tsx`
Exports: `Tabs`, `TabsList`, `TabsTrigger`, `TabsContent`
```ts
export interface TabsTriggerProps extends ComponentPropsWithRef<typeof TabsPrimitive.Trigger> {
  icon?: ReactNode;
}
```

#### `packages/ui/src/components/TextField/TextField.tsx`
Exports: `TextField`
```ts
export interface TextFieldProps extends Omit<ComponentPropsWithRef<'input'>, 'size' | 'prefix' | 'width'> {
  size?: ControlSize;
  /** Red outline and aria-invalid. */
  invalid?: boolean;
  /** Content inside the field before the text (icon). */
  leading?: ReactNode;
  /** Content inside the field after the text (unit, small button). */
  trailing?: ReactNode;
  /** Receives the new string value on every edit (in addition to onChange). */
  onValueChange?: (value: string) => void;
  /** Monospaced text, e.g. for sequences and coordinates. */
  mono?: boolean;
  /** Width of the field (px or CSS length). Default: fills the available width. */
  width?: number | string;
  /** Class name of the outer frame (className goes there too). */
  className?: string;
}
```

#### `packages/ui/src/components/Toolbar/Toolbar.tsx`
Exports: `Toolbar`, `ToolbarGroup`, `ToolbarSpacer`, `ToolbarTitle`
```ts
export interface ToolbarProps extends ComponentPropsWithRef<'div'> {
  /** window: 52 px unified title-bar toolbar; inline: 36 px bar inside panels. */
  size?: 'window' | 'inline';
  /** Accessible name, e.g. "Document toolbar". */
  'aria-label'?: string;
}

export interface ToolbarGroupProps extends ComponentPropsWithRef<'div'> {
  /** Accessible name of the group (optional). */
  label?: string;
}

export interface ToolbarSpacerProps {
  /** Fixed width in px; omit for a flexible space that pushes later items to the end. */
  width?: number;
  className?: string;
}

export interface ToolbarTitleProps extends Omit<ComponentPropsWithRef<'div'>, 'title'> {
  title: ReactNode;
  /** Secondary line, e.g. "3,938 bp · circular". */
  subtitle?: ReactNode;
  /** Optional accessory after the title (e.g. an "edited" dot). */
  accessory?: ReactNode;
}
```

#### `packages/ui/src/components/Tooltip/Tooltip.tsx`
Exports: `TooltipProvider`, `Tooltip`
```ts
export interface TooltipProviderProps {
  children: ReactNode;
  /** Hover delay before the first tooltip appears (ms). */
  delayDuration?: number;
  /** Window in which moving to another trigger shows its tooltip immediately (ms). */
  skipDelayDuration?: number;
}

export interface TooltipProps {
  /** Tooltip text. When empty/undefined the trigger is rendered without a tooltip. */
  content: ReactNode;
  /** Optional keyboard shortcut hint, platform-neutral ("Mod+Shift+F"). */
  shortcut?: string;
  /** The trigger: a single element that accepts a ref and DOM props (Button, IconButton, …). */
  children: ReactElement;
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
  sideOffset?: number;
  delayDuration?: number;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  disabled?: boolean;
  className?: string;
}
```

#### `packages/ui/src/components/NumberField/number.ts`
Exports: `decimalsOf`, `formatNumberValue`, `parseNumberInput`, `normalizeNumber`, `stepNumber`

#### `packages/ui/src/components/Sheet/confirmKey.ts`
Exports: `isConfirmKey`

#### `packages/ui/src/components/SourceList/layout.ts`
Exports: `DEFAULT_METRICS`, `headerKey`, `itemKey`, `isCollapsible`, `buildSourceListRows`, `visibleRowRange`, `scrollToReveal`
```ts
/** Minimal shape needed for layout (the component's sections satisfy it). */
export interface LayoutSection {
  id: string;
  title?: string;
  collapsible?: boolean;
  emptyText?: string;
  items: readonly { id: string }[];
}

export type SourceListRow =
  | { kind: 'header'; key: string; sectionIndex: number; top: number; height: number; gap: number; expanded: boolean }
  | { kind: 'item'; key: string; sectionIndex: number; itemIndex: number; top: number; height: number }
  | { kind: 'empty'; key: string; sectionIndex: number; top: number; height: number };

export interface SourceListMetrics {
  rowHeight: number;
  headerHeight: number;
  /** Extra space above every section header except the first. */
  sectionGap: number;
  paddingTop: number;
  paddingBottom: number;
}
```

#### `packages/ui/src/components/SplitView/layout.ts`
Exports: `resolvePaneResize`, `dividerTarget`, `maxPaneSize`, `keyboardDelta`
```ts
/**
 * Pure sizing rules for SplitView (unit-tested).
 *
 * A pane is either FIXED (has a size in px, user-resizable) or FLEXIBLE (shares the space
 * left over). Dragging a divider resizes the fixed pane next to it; the flexible pane(s)
 * absorb the difference and never shrink below their minimum.
 */
export interface PaneConstraint {
  min: number;
  max: number;
  collapsible: boolean;
}

export interface PaneResize {
  /** New size in px; undefined when the pane collapses (its last size is kept for re-expanding). */
  size: number | undefined;
  collapsed: boolean;
}
```

#### `packages/ui/src/components/Table/selection.ts`
Exports: `nextSelection`, `compareValues`, `sortRows`
```ts
/** Row-selection and sorting rules for Table (pure, unit-tested). */
export type SelectionMode = 'none' | 'single' | 'multiple';

export interface ClickModifiers {
  /** Cmd on macOS, Ctrl elsewhere: toggle one row. */
  toggle: boolean;
  /** Shift: extend from the anchor. */
  range: boolean;
}

export type SortDirection = 'ascending' | 'descending';
```

#### `packages/ui/src/lib/cx.ts`
Exports: `cx`

#### `packages/ui/src/lib/mergeRefs.ts`
Exports: `mergeRefs`

#### `packages/ui/src/lib/platform.ts`
Exports: `getPlatform`, `usePlatform`
```ts
/**
 * Platform detection for platform-specific details (shortcut glyphs, window chrome).
 * The app tags <html> with `hh-platform-mac | hh-platform-windows | hh-platform-linux`
 * before the first render (apps/desktop/src/environment.ts); that class wins, so
 * `?platform=…` overrides in the gallery are respected.
 */
export type Platform = 'mac' | 'windows' | 'linux';
```

#### `packages/ui/src/lib/shortcut.ts`
Exports: `shortcutKeys`, `formatShortcut`

#### `packages/ui/src/lib/useControllableState.ts`
Exports: `useControllableState`


## Appendix B: shell declarations (verbatim from the sources)

#### `apps/desktop/src/shell/AppShell.tsx`
Exports: `SIDEBAR_LIMITS`, `INSPECTOR_LIMITS`, `AppShell`
```ts
export interface AppShellProps {
  /** Toolbar items, usually <ToolbarContent/>. Rendered in the title bar row. */
  toolbar?: ReactNode;
  /** Left pane, usually <Sidebar/>. Omit for a window without a sidebar. */
  sidebar?: ReactNode;
  /** Right pane, usually <Inspector/>. Omit for a window without an inspector. */
  inspector?: ReactNode;
  /** Bar under the main content, usually <StatusBar/>. */
  statusBar?: ReactNode;
  /** Main content, usually <MainArea/>. */
  children?: ReactNode;

  /** Sidebar shown (controlled). Dragging the divider closed reports false. */
  sidebarVisible?: boolean;
  defaultSidebarVisible?: boolean;
  onSidebarVisibleChange?: (visible: boolean) => void;
  /** Sidebar width in px (controlled). */
  sidebarWidth?: number;
  defaultSidebarWidth?: number;
  onSidebarWidthChange?: (width: number) => void;

  inspectorVisible?: boolean;
  defaultInspectorVisible?: boolean;
  onInspectorVisibleChange?: (visible: boolean) => void;
  inspectorWidth?: number;
  defaultInspectorWidth?: number;
  onInspectorWidthChange?: (width: number) => void;

  /** False while the window is in the background: chrome dims like an inactive macOS window. */
  windowActive?: boolean;
  /** Platform chrome (default: detected). macOS reserves room for the traffic lights. */
  platform?: Platform;
  className?: string;
  style?: CSSProperties;
}
```

#### `apps/desktop/src/shell/FeatureColorWell.tsx`
Exports: `readSwatchPalette`, `resolveHexColor`, `FeatureColorWell`
```ts
export interface FeatureColorWellProps {
  /** The feature's own colour ('#rrggbb'); undefined when it uses its type's colour. */
  value?: string;
  /** CSS colour shown for the automatic (type) colour. */
  automaticColor: string;
  /**
   * New colour, or null for "back to the type colour". Called once per choice: a palette
   * chip, Automatic, or the system colour panel when it is closed. Omit for a read-only well.
   */
  onChange?: (color: string | null) => void;
  /** Live colour while the user drags in the system colour panel (not committed yet). */
  onPreview?: (color: string) => void;
  /** Palette override (default: the --hh-swatch-* tokens). */
  palette?: readonly string[];
  'aria-label'?: string;
  /** Element id of the visible label (for aria-labelledby). */
  'aria-labelledby'?: string;
}
```

#### `apps/desktop/src/shell/Inspector.tsx`
Exports: `formatFeatureLocation`, `Inspector`, `CompositionBar`
```ts
export type InspectorCardId = 'selection' | 'feature' | 'analysis';

/** An edit made in the Feature card. */
export interface FeatureEdit {
  name?: string;
  type?: string;
  strand?: Strand;
  /** '#rrggbb', or null to go back to the type's colour. */
  color?: string | null;
  /** The complete new qualifier list (file order kept; added qualifiers at the end). */
  qualifiers?: Qualifier[];
}

export interface InspectorProps {
  /** Selection summary (useSelectionSummary). Undefined/null when no document is open. */
  selection?: SelectionSummary | null;
  /** Melting temperature of the selected bases in °C, when the app computes one. */
  tm?: number | null;
  /**
   * Extra rows for the Selection card while bases are selected (e.g. molecular weight, the
   * translation of the selection), after Range / Length / GC / Tm.
   */
  selectionDetails?: readonly PropertyItem[];
  /** Whole-sequence composition, shown by the Analysis card when no bases are selected. */
  sequenceComposition?: BaseComposition | null;
  /** The feature to inspect (usually the selected one). */
  feature?: Feature | null;
  /** Length and topology of the sequence, for the feature's location text. */
  sequenceLength?: number;
  topology?: Topology;
  molecule?: MoleculeType;
  /** Commits Feature-card edits. Omit for a read-only card. */
  onFeatureChange?: (featureId: string, edit: FeatureEdit) => void;
  /**
   * Live colour while the user drags in the system colour panel ("Other…"), before it is
   * committed through onFeatureChange; use it to preview the colour in the visualizations.
   */
  onFeatureColorPreview?: (featureId: string, color: string) => void;
  onZoomToFeature?: (featureId: string) => void;
  onDeleteFeature?: (featureId: string) => void;
  /** Buttons at the foot of the Analysis card (e.g. Find ORFs, Translate). */
  analysisActions?: ReactNode;
  /**
   * Extra cards between the Feature and Analysis cards, e.g. a Primer card:
   * <Disclosure title="Primer"><PropertyList … /></Disclosure>.
   */
  children?: ReactNode;
  /** Collapsed cards (controlled). */
  collapsedCards?: readonly InspectorCardId[];
  defaultCollapsedCards?: readonly InspectorCardId[];
  onCollapsedCardsChange?: (cards: InspectorCardId[]) => void;
  className?: string;
}
```

#### `apps/desktop/src/shell/MainArea.tsx`
Exports: `MainArea`
```ts
export interface MainAreaProps {
  view: ViewMode;
  /** The map (CircularMap / LinearMap). Default: a neutral placeholder. */
  map?: ReactNode;
  /** The sequence view. Default: a neutral placeholder. */
  sequence?: ReactNode;
  /** Shape of the placeholder map. */
  topology?: Topology;
  /** Centre text of the placeholder map (e.g. the document name and length). */
  placeholderTitle?: ReactNode;
  placeholderSubtitle?: ReactNode;
  /** Share of the height given to the map in split view, 0..1 (controlled). */
  splitRatio?: number;
  /** Initial share when uncontrolled (default 0.46). */
  defaultSplitRatio?: number;
  /** Called while the divider between map and sequence is dragged. */
  onSplitRatioChange?: (ratio: number) => void;
  /** Inline message above the visualization (e.g. a read-only Banner). */
  banner?: ReactNode;
  className?: string;
}
```

#### `apps/desktop/src/shell/QualifierEditor.tsx`
Exports: `qualifiersFromRows`, `keyColumnWidth`, `sameQualifiers`, `QualifierEditor`
```ts
export interface QualifierEditorProps {
  /** All qualifiers of the feature, in file order. */
  qualifiers: readonly Qualifier[];
  /**
   * Qualifiers hidden in the read-only list because another field already shows them (e.g. a
   * /label equal to the feature name). The editor shows every qualifier.
   */
  isRedundant?: (qualifier: Qualifier) => boolean;
  /** Commits a complete new list. Omit for a read-only list. */
  onChange?: (qualifiers: Qualifier[]) => void;
  /** Width of the label column (matches the surrounding PropertyLists). */
  labelWidth: number;
  /** Changes when another feature is shown: leaves edit mode. */
  resetKey?: string;
}
```

#### `apps/desktop/src/shell/Sidebar.tsx`
Exports: `Sidebar`
```ts
/** Collapsible annotation sections of the sidebar. */
export type SidebarSectionId = 'features' | 'primers' | 'enzymes';

export interface SidebarProps {
  /** Open documents, listed at the top. */
  documents: readonly DocumentSummary[];
  activeDocumentId?: string | null;
  /** A document row was clicked (or chosen with the keyboard). */
  onActivateDocument?: (id: string) => void;
  /** Shows a close button on hovered document rows. */
  onCloseDocument?: (id: string) => void;
  /** The active document, whose features and primers are listed. Null when none is open. */
  record?: Pick<SeqRecord, 'features' | 'primers' | 'seq' | 'topology'> | null;
  /** Restriction sites currently displayed; listed grouped by enzyme with site counts. */
  enzymeSites?: readonly EnzymeSite[];
  /** The selected annotation (highlighted row). */
  selectedItem?: SidebarItemRef | null;
  onSelectItem?: (item: SidebarItemRef) => void;
  /** Double-click or Return on an annotation (e.g. zoom to it). */
  onActivateItem?: (item: SidebarItemRef) => void;
  /**
   * Right-click on an annotation. Wrap the Sidebar in a ContextMenu (its trigger receives the
   * same event) and remember the item here to build the menu for it.
   */
  onItemContextMenu?: (item: SidebarItemRef, event: MouseEvent) => void;
  /** The annotation whose context menu is open (outlined); null once the menu closes. */
  contextMenuItem?: SidebarItemRef | null;
  /** Collapsed annotation sections (controlled). */
  collapsedSections?: readonly SidebarSectionId[];
  defaultCollapsedSections?: readonly SidebarSectionId[];
  onCollapsedSectionsChange?: (sections: SidebarSectionId[]) => void;
  /** Filter text for the annotation list (controlled); omit to keep it internal. */
  filter?: string;
  onFilterChange?: (filter: string) => void;
  /**
   * Selection style: undefined = accent while the list has focus (macOS default);
   * false while the window is inactive.
   */
  emphasized?: boolean;
  className?: string;
}
```

#### `apps/desktop/src/shell/StatusBar.tsx`
Exports: `StatusBar`
```ts
export interface StatusBarProps {
  /** Selection summary (useSelectionSummary); null shows no selection text. */
  selection?: SelectionSummary | null;
  /** Document length, shown at the trailing end with the topology. */
  length?: number;
  topology?: Topology;
  molecule?: MoleculeType;
  /** Short transient message ("Copied 861 bp") shown instead of the selection text. */
  message?: ReactNode;
  /** Extra trailing items (e.g. a zoom level), placed before the document length. */
  trailing?: ReactNode;
  className?: string;
}
```

#### `apps/desktop/src/shell/ToolbarContent.tsx`
Exports: `DEFAULT_TOOLBAR_SHORTCUTS`, `TOOLBAR_DENSITY`, `toolbarDensity`, `searchFieldWidth`, `ENZYME_DISPLAY_LABELS`, `DEFAULT_ENZYME_DISPLAY_OPTIONS`, `enzymeMenuChoices`, `ToolbarContent`
```ts
export interface ToolbarContentProps {
  /** Document title. Omit when no document is open. */
  title?: string;
  /** Second line, e.g. formatDocumentSubtitle(…) → "3,938 bp · circular". */
  subtitle?: ReactNode;
  /** Shows "Edited" after the title (unsaved changes). */
  edited?: boolean;
  /** Sidebar toggle; omit onToggleSidebar to hide the button. */
  sidebarVisible?: boolean;
  onToggleSidebar?: () => void;
  /** Inspector toggle; omit onToggleInspector to hide the button. */
  inspectorVisible?: boolean;
  onToggleInspector?: () => void;
  view: ViewMode;
  onViewChange: (view: ViewMode) => void;
  /** Which restriction sites are shown. */
  enzymeDisplay: EnzymeDisplay;
  onEnzymeDisplayChange: (display: EnzymeDisplay) => void;
  /** "Choose…" in the enzyme menu (open the enzyme chooser). */
  onChooseEnzymes?: () => void;
  /**
   * Choices of the enzyme menu, in order (default DEFAULT_ENZYME_DISPLAY_OPTIONS). 'custom'
   * is listed automatically while it is the current display.
   */
  enzymeDisplayOptions?: readonly EnzymeDisplay[];
  /** Names of the choices, overriding ENZYME_DISPLAY_LABELS (e.g. { unique: 'Unique 6+ cutters' }). */
  enzymeDisplayLabels?: Partial<Record<EnzymeDisplay, string>>;
  /** Commands of the Actions menu. */
  onAction?: (action: ShellAction) => void;
  /** Sequence search (controlled when searchValue is given). */
  searchValue?: string;
  onSearchChange?: (value: string) => void;
  /** Return / Shift+Return in the search field. */
  onSearchSubmit?: (value: string, direction: 'next' | 'previous') => void;
  /** Short result status in the search field, e.g. "3 of 12". */
  searchStatus?: ReactNode;
  /** Ref to the search input (focus it for ⌘F). */
  searchRef?: Ref<HTMLInputElement>;
  /** Disables the document commands (e.g. while a file loads). */
  disabled?: boolean;
  /**
   * Keyboard shortcuts shown in tooltips and menus (display only: the app binds the keys).
   * Defaults: DEFAULT_TOOLBAR_SHORTCUTS. Pass the app's command bindings to keep them in sync.
   */
  shortcuts?: Partial<ToolbarShortcuts>;
  className?: string;
}

/** Platform-neutral shortcut strings ("Alt+Mod+S"; Mod = ⌘ on macOS, Ctrl elsewhere). */
export interface ToolbarShortcuts {
  toggleSidebar: string;
  toggleInspector: string;
  viewMap: string;
  viewSequence: string;
  viewSplit: string;
  enzymes: string;
  digest: string;
  search: string;
}

export type ToolbarDensity = 'regular' | 'compact' | 'tight';
```

#### `apps/desktop/src/shell/VisualizationPlaceholder.tsx`
Exports: `VisualizationPlaceholder`
```ts
export interface VisualizationPlaceholderProps {
  kind: 'map' | 'sequence';
  /** Map placeholders draw a ring (circular) or a bar (linear). */
  topology?: Topology;
  /** Centre label of the map, e.g. the document name. */
  title?: ReactNode;
  /** Second centre line, e.g. "3,938 bp". */
  subtitle?: ReactNode;
  className?: string;
}
```

#### `apps/desktop/src/shell/WelcomeScreen.tsx`
Exports: `WelcomeScreen`
```ts
export interface WelcomeScreenProps {
  appName?: string;
  /** One line under the app name. */
  tagline?: ReactNode;
  /** Shown as "Version 0.1.0". */
  version?: string;
  onOpen?: () => void;
  onNewSequence?: () => void;
  recentFiles?: readonly RecentFile[];
  onOpenRecent?: (file: RecentFile) => void;
  /** Shows a "Clear" button on the Recent list. */
  onClearRecent?: () => void;
  samples?: readonly SampleSequence[];
  onOpenSample?: (sample: SampleSequence) => void;
  /**
   * Files are being dragged over the window. Drive it from Tauri's drag-drop events (which
   * replace DOM drag events in the desktop app); in a browser the screen tracks DOM drags.
   */
  dropActive?: boolean;
  /** Files dropped onto the screen (browser drag and drop). */
  onDropFiles?: (files: File[]) => void;
  className?: string;
}
```

#### `apps/desktop/src/shell/glyphs.tsx`
Exports: `FeatureGlyph`, `PrimerGlyph`, `DocumentGlyph`
```ts
export interface FeatureGlyphProps {
  /** CSS colour of the feature (see featureFill). */
  color: string;
  strand: Strand;
  className?: string;
}
```

#### `apps/desktop/src/shell/featureTypes.ts`
Exports: `COMMON_FEATURE_TYPES`, `featureTypeOptions`, `featureTypeLabel`, `qualifierLabel`
```ts
/** Common INSDC feature keys offered by the inspector's Type pop-up, with readable names. */
export interface FeatureTypeOption {
  /** INSDC feature key, stored in Feature.type. */
  value: string;
  label: string;
}
```

#### `apps/desktop/src/shell/format.ts`
Exports: `lengthUnit`, `formatLength`, `formatCompactLength`, `formatDocumentSubtitle`, `formatPercent`

#### `apps/desktop/src/shell/ids.ts`
Exports: `SIDEBAR_PANE_ID`, `INSPECTOR_PANE_ID`

#### `apps/desktop/src/shell/selectionSummary.ts`
Exports: `buildSequenceIndex`, `countBases`, `gcPercent`, `summarizeSelection`, `summarizeSequence`, `formatSelectionRange`, `describeCaret`, `formatSelectionStatus`, `useSequenceIndex`, `useSelectionSummary`
```ts
/** Base counts of a stretch of sequence. */
export interface BaseComposition {
  a: number;
  c: number;
  g: number;
  /** T (and U). */
  t: number;
  /** IUPAC S (G or C): counted as GC. */
  s: number;
  /** IUPAC W (A or T): counted as AT. */
  w: number;
  /** Anything else (N, other ambiguity codes, gaps). */
  other: number;
  /** All characters counted. */
  total: number;
}

export interface SequenceIndex {
  readonly seq: string;
  readonly blockSize: number;
  /** cumulative[k * CHANNELS + ch] = count of channel ch in seq[0, k * blockSize). */
  readonly cumulative: Uint32Array;
}

export interface SelectionSummary {
  /** True when at least one base is selected (otherwise only a caret is placed). */
  hasBases: boolean;
  /** Normalized selected range (end may exceed the length on circular sequences). */
  range: Range;
  /** Caret gap position. */
  caret: number;
  /** Number of selected bases. */
  length: number;
  /** 1-based first and last selected base (last < first when the range wraps the origin). */
  first: number;
  last: number;
  wrapsOrigin: boolean;
  /** Composition of the selected bases; null without a selection. */
  composition: BaseComposition | null;
  gcPercent: number | null;
  sequenceLength: number;
  topology: Topology;
}
```

#### `apps/desktop/src/shell/sidebarModel.ts`
Exports: `featureRows`, `primerRows`, `enzymeRows`, `matchesFilter`
```ts
export interface FeatureRow {
  id: string;
  name: string;
  type: string;
  strand: Strand;
  /** CSS colour (custom colour or the type's token). */
  color: string;
  /** Bases covered (sum of segments). */
  length: number;
  /** 0-based start of the feature's extent. */
  start: number;
}

export interface PrimerRow {
  id: string;
  name: string;
  /** Oligo length in nucleotides. */
  length: number;
}

export interface EnzymeRow {
  name: string;
  /** Number of recognition sites. */
  count: number;
  /** Top-strand cut positions (gap positions), ascending. */
  cuts: number[];
}
```

#### `apps/desktop/src/shell/types.ts`
```ts
/** What the main area shows: the map, the sequence, or the map above the sequence. */
export type ViewMode = 'map' | 'sequence' | 'split';

/**
 * Which restriction sites are displayed (toolbar enzyme menu): single cutters, single and
 * double cutters, a common lab set, all commercially available enzymes with ≥ 6 bp sites,
 * none, or an enzyme list chosen by the user.
 */
export type EnzymeDisplay = 'unique' | 'unique-dual' | 'common' | 'commercial' | 'none' | 'custom';

/** Commands of the toolbar's Actions menu. */
export type ShellAction =
  | 'clone-restriction'
  | 'clone-gibson'
  | 'clone-golden-gate'
  | 'clone-pcr'
  | 'digest'
  | 'find-orfs'
  | 'primers';

/** An open document, as listed in the sidebar. */
export interface DocumentSummary {
  id: string;
  name: string;
  /** Length in bases (or residues for proteins). */
  length: number;
  topology: Topology;
  molecule?: MoleculeType;
  /** Has unsaved changes. */
  edited?: boolean;
}

/** A recently opened file, as listed on the welcome screen. */
export interface RecentFile {
  /** Stable id, e.g. the file path. */
  id: string;
  name: string;
  /** Folder shown under the name, e.g. "~/Documents/Plasmids". */
  location?: string;
  /** Short, already formatted date, e.g. "Yesterday" or "12 Mar". */
  modified?: string;
  length?: number;
  topology?: Topology;
}

/** A bundled example sequence, as listed on the welcome screen. */
export interface SampleSequence {
  id: string;
  name: string;
  /** One line, e.g. "Yeast gene deletion cassette". */
  description?: string;
  length: number;
  topology: Topology;
}

/** What is selected in the sidebar's annotation list. */
export interface SidebarItemRef {
  kind: 'feature' | 'primer' | 'enzyme';
  /** Feature id, primer id, or enzyme name. */
  id: string;
}
```

