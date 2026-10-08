SequenceView (component key: `sequence`) is finished and working. The earlier engineer's partial work was a solid base but had no tests and several bugs; I fixed those and completed everything in the spec. 95 tests pass, both typechecks are clean, and I checked every story by screenshot in both themes at 900×600 and 1600×1000, plus scripted interaction runs in headless Chromium.

FILES (all in /home/srdgjuchdr/HHereditas/packages/viewer/src/sequence/)
Modified from the partial work:
- SequenceView.tsx — the component
- SequenceRow.tsx — draws one row
- layout.ts — the row model
- editing.ts — keyboard/text/clipboard → edit and selection intents
- types.ts
- SequenceView.module.css
- SequenceView.gallery.tsx
- index.ts — the folder's barrel

Kept as they were: translation.ts (codon mapping), translate-lite.ts, measure.ts, sequenceGalleryData.ts (demo-only data: enzyme/primer/ORF finders, the synthetic 4.6 Mb genome, the naive edit applier).

New test files: layout.test.ts, editing.test.ts, translation.test.ts, SequenceView.test.tsx.

EXPORTED API (index.ts)
```
export interface SequenceViewProps {
  record: SeqRecord;
  enzymeSites?: readonly EnzymeSite[];
  primerSites?: readonly PrimerBindingSite[];
  orfs?: readonly Orf[];
  searchHits?: readonly SearchHit[];
  selection?: SequenceSelection | null;          // undefined = the view keeps its own
  onSelectionChange?: (selection: SequenceSelection | null) => void;
  highlightedFeatureId?: string | null;
  onFeatureClick?: (featureId: string, info: FeatureClickInfo) => void;
  onFeatureHover?: (featureId: string | null) => void;
  onEnzymeClick?: (site: EnzymeSite) => void;
  onPrimerClick?: (primerId: string) => void;
  onContextMenu?: (target: MapTarget, event: React.MouseEvent) => void;
  show?: SequenceViewShow;
  basesPerRow?: number | 'auto';
  editable?: boolean;
  onEdit?: (edit: SequenceEdit) => void;
  onInvalidInput?: (text: string) => void;
  scrollTo?: { position: number; requestId: number };
  translate?: (codingDna: string, feature: Feature) => string;
  className?: string;
}
type MapTarget = { kind:'feature'; id:string } | { kind:'enzyme'; site:EnzymeSite } | { kind:'primer'; id:string }
               | { kind:'orf'; orf:Orf } | { kind:'background'; position:number /* gap */ } | { kind:'sequence'; position:number };
interface FeatureClickInfo { clickCount:number; shiftKey:boolean; metaKey:boolean; ctrlKey:boolean }
type SequenceEdit = { kind:'insert'; gap:number; bases:string } | { kind:'delete'; range:Range } | { kind:'replace'; range:Range; bases:string };
interface SequenceViewShow { complement?; features?; enzymes?; primers?; translations?; orfs?; numbering?: boolean }   // complement and translations default true
```
Helper exports:
- Row model: `SEQUENCE_VIEW_METRICS`, `autoBasesPerRow`, `buildRowModel`, `cutCounts`, `enzymeLabelText`, `gapAtPoint`, `rowAtY`, `rowOfBase`, plus the types `RowModel`, `RowModelInput`, `RowLayout`, `RowGeometry`, `SequenceMetrics`, `LayoutFeature`, `LayoutPrimer`, `FeaturePiece`, `BarPiece`, `FeatureLane`, `EnzymeLabel`, `CutMark`, `PrimerPiece`, `OrfPiece`, `PointHit`.
- Editing: `keyIntent`, `textIntent`, `deleteIntent`, `cutIntent`, `copyText`, `cleanSequenceInput(text, molecule?)`, `selectionAfterEdit`, `extendBy`, `extendSelectionTo`, `coverSelection`, plus the types `CaretAffinity`, `EditingContext`, `KeyInput`, `KeyIntent`, `TextIntent`.
- Translation: `buildCodingInfo`, `codonAtBase`, `codonRange`, `codonStartOffset`, `CodingInfo`, `translateLite`, `translateFeatureLite`, `codonToAminoAcid`, `TranslateLiteOptions`.

BUGS FIXED IN THE PARTIAL WORK
- `scrollTo` ran before the view was measured, so the genome story landed at 3.30 Mb instead of 2.32 Mb. Requests now wait for measurement.
- Scroll position was lost whenever the layout changed. The first visible base now stays put on resize, edits and layer toggles, and a new `record.id` starts at the top.
- The layout was rebuilt on every 8 px of window resize. It now depends only on bases per row, and the wasted first build before measurement is gone.
- Caret placement after edits at the circular origin: Backspace at the end jumped to the start, and bases typed at the origin vanished to the end of the last row with no caret there. Both now follow the core's semantics (an insert at gap 0 is appended at L).
- Tabbing into the view with nothing selected made typing go silently to position 0. A caret now appears at the first row on screen.
- The hidden input sat at the top of the content when there was no caret, so focusing it could scroll the view to the top.
- Two CSS class names were undefined and rendered as a literal `undefined` class.
- Protein and RNA records used DNA input cleaning. Proteins now accept amino-acid letters and `*`; RNA keeps U.

DESIGN DECISIONS
- The CDS translation is one continuous strip: alternating codon tints in the feature colour, cells meeting in the middle of the 10-base gaps, stronger tints in dark mode, stops shown as a red `*`.
- Primer arrows have an opaque under-layer so enzyme label lines pass behind them instead of showing through.
- The enzyme label number is the cut gap (EcoRI G^AATTC → "EcoRI (396)"), the same rule the circular and linear maps use.
- Clicking a feature selects its extent and reports `clickCount` 1; a double-click reports 2 and also selects it. Shift+click extends the selection over the feature.
- Copy/cut/paste go through a hidden textarea whose one-space placeholder is always selected, so the browser fires copy and cut events (needed for Tauri webviews). The textarea is explicitly `user-select: text`.
- Rows render outside the current window only within a 480 px margin. Content taller than 15M px gets scaled scrolling.
- Colours come only from tokens. The one exception is per-theme opacity overrides for the codon tints, done in my CSS module.

TESTS
95 passing in 4 files: layout (32), editing (28), translation (11), component (24).
- Coverage: the row model (rows, offsets, lanes, heights, labels, cut marks across row ends and the origin, primers, ORFs, a 2 Mb record) and pointer → gap hit-testing.
- Also: keys → insert/delete/replace edits including origin wrap, selection extension across the origin, copied text, and component behaviour (click, drag, shift+click, feature/codon/enzyme clicks, hover, context menu, typing, paste, copy, cut, read-only, scrollTo, scroll anchoring, focus caret).
- The full viewer suite has 1 failure, in `src/linear/LinearMap.test.tsx` (another agent's).

PERFORMANCE (Chromium, 4.6 Mb genome, 5,033 features, 3,805 enzyme sites)
- Steady scrolling: 16.7 ms average per frame, p95 17.8 ms, so 60 fps.
- Extreme flinging (2,500 px per frame, every row new each frame): about 35 ms per frame.
- Full layout build: about 42 ms warm in Node, 22–80 ms in the browser.
- Resizing without a bases-per-row change: about 30 ms.

SCREENSHOTS (/tmp/hh-shots/sequence/, 90 files)
- `<story>-<light|dark>-<900x600|1600x1000>.png` for pFA6a, pBAD30, pBR322, linear, editing, selection-rows, selection-origin, translations, reverse-cds, primers, primers-origin, search, orfs, narrow, no-complement, bases-per-row-60, sticky-ends, empty, protein, genome-4.6Mb.
- `wide-light-1600x1000.png`, `wide-dark-1600x1000.png`.
- `interaction-{drag-select,typing,enzyme-click,focus-hover}-{light,dark}.png`.
- None of the captures logged console errors.

KNOWN LIMITATIONS
- Not verified in WebKit, which is what Tauri uses on macOS and Linux; only Chromium is installed here. Japanese/Korean input-method composition is handled in code but was not exercised in automation.
- Every edit rebuilds the whole layout: about 40–80 ms per keystroke on the 4.6 Mb genome, well under 1 ms for plasmids.
- Feature lanes are packed per row, so a long feature can move up a lane when one frees up in the next row.
- The built-in translator only distinguishes start codons for tables 1 and 11; the app should inject the core `translate`.
- Tooltips are native; fuzzy feature ends get no special styling.
- The `translate` function and the annotation arrays should be memoized by the app, since changing them rebuilds the layout.
- The sequence text is hidden from screen readers. The hidden input's label and a live region announce the selection.
- `basesPerRow` and `scrollTo` take effect immediately, but the layout waits for the viewport to be measured (before first paint).

REQUESTS
- No token additions required. Optionally, the design-system agent could add per-theme codon-tint tokens to replace my opacity overrides.
- No shared files were changed.
- Integrator: `MapTarget` and `FeatureClickInfo` are exported, structurally identical, by the circular, linear and sequence folders, so re-export them only once in the viewer barrel.