# ui-linear — implementer report (`<LinearMap />`)

Component key: `linear`. Ownership: `packages/viewer/src/linear/**`.
Third attempt: the two interrupted predecessors left a nearly complete implementation. This attempt
audited it end to end (tests, typecheck, screenshots of every story in both themes and both sizes,
Playwright interaction and frame-time checks), kept it, and fixed and polished what fell short (see
"Changes in this attempt").

Status: complete. 126 tests in `src/linear` (whole viewer package: 368) pass, and three runs in a
row gave the same result. `tsc --noEmit -p packages/viewer` reports no errors at all at the time of
writing, and `-p apps/desktop` reports none in linear files.

## Files (all in packages/viewer/src/linear/)

| File | Role |
|---|---|
| `index.ts` | Folder barrel (public API below) |
| `types.ts` | `MapTarget`, `FeatureClickInfo`, `MapShowOptions` (same shapes as the circular map and sequence view) |
| `LinearMap.tsx` | The component: state (controlled or uncontrolled selection and viewport), gestures, keyboard, glide animations, hover card, overview scrollbar |
| `LinearMapLayers.tsx` | Memoized SVG layers: `MapContent`, `SelectionUnderlay`, `SelectionOverlay`, `HighlightLayer` |
| `LinearMapTooltip.tsx` | Hover card content (same three-line layout as the circular map) |
| `LinearMap.module.css` | Styles; uses only `--hh-*` tokens |
| `layout.ts` | Pure geometry: static lane tracks (bp space) and the per-frame view model (culling, density, label placement, leaders, letters, ruler) |
| `lanes.ts` | Interval lane packing; origin-wrapping intervals; culling index (`visibleSpan`) |
| `enzymeLabels.ts` | Cut markers ("EcoRI (396)", unique cutters) and staggered-row label placement with leaders |
| `labelSpace.ts` | Row occupancy for collision-free labels |
| `labelColor.ts` | **new**: contrast-aware label text colour on custom feature fills |
| `ticks.ts` | Ruler steps (1/2/5 × 10^k) with no label collisions; bp, kb and Mb units |
| `viewport.ts` | Scale, zoom, pan, clamp, zoom-to-range and glide interpolation |
| `hitTest.ts` | Point to `MapTarget`; feature outlines; **new** `featureOnScreen` |
| `selectionGeometry.ts` | Selection pieces across the origin, caret positions, shift-extend |
| `shapes.ts` | SVG path builders (bars with 3' points, primer harpoons, ORF arrows) |
| `textMeasure.ts` | Canvas text measurement with the real UI font; deterministic estimate in tests |
| `galleryData.ts` | Demo data: synthetic 4.64 Mb genome (~4,500 features), primers, ORF scan, **new** `demoGeneLocus` |
| `LinearMap.gallery.tsx` | Gallery stories |
| `*.test.ts(x)` | 9 test files (see Tests) |

## Exported API (`packages/viewer/src/linear/index.ts`)

```ts
export { LinearMap } from './LinearMap';
export type { LinearMapProps } from './LinearMap';
export type { FeatureClickInfo, MapShowOptions, MapTarget } from './types';
export { LETTER_PX_PER_BASE, MAX_PX_PER_BASE, clampViewport, fullViewport, interpolateViewport,
  isFullViewport, panViewport, viewportForRange, zoomViewport } from './viewport';
```

```ts
export interface LinearMapProps {
  record: SeqRecord;
  /** Sites to draw, already filtered by the app: every one given is shown. */
  enzymeSites?: readonly EnzymeSite[];
  /** Primer binding sites; names come from record.primers (matched by primerId). */
  primerSites?: readonly PrimerBindingSite[];
  orfs?: readonly Orf[];
  /** Controlled selection (null = nothing selected). Leave undefined to let the map keep its own. */
  selection?: SequenceSelection | null;
  onSelectionChange?: (selection: SequenceSelection | null) => void;
  /** Feature to emphasise, e.g. the one hovered in the sidebar. */
  highlightedFeatureId?: string | null;
  onFeatureClick?: (featureId: string, info: FeatureClickInfo) => void;
  onFeatureHover?: (featureId: string | null) => void;
  onEnzymeClick?: (site: EnzymeSite) => void;
  onPrimerClick?: (primerId: string) => void;
  onContextMenu?: (target: MapTarget, event: ReactMouseEvent) => void;
  show?: MapShowOptions;
  className?: string;
  /**
   * Visible window in bp (fractional bounds allowed). Uncontrolled by default (the whole record).
   * Controlled: fullViewport(length) = zoom to fit; viewportForRange(selection.range, length,
   * topology) = zoom to selection; the map glides there. Zoom buttons can pass
   * zoomViewport(viewport, 2 or 0.5, centre, length, 0): the map clamps what it receives and
   * reports the clamped window once through onViewportChange.
   */
  viewport?: Range;
  onViewportChange?: (viewport: Range) => void;
}

export type MapTarget =
  | { kind: 'feature'; id: string }
  | { kind: 'enzyme'; site: EnzymeSite }
  | { kind: 'primer'; id: string }
  | { kind: 'orf'; orf: Orf }
  | { kind: 'background'; position: number /* gap */ }
  | { kind: 'sequence'; position: number /* 0-based base */ };

export interface FeatureClickInfo { clickCount: number; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }
export interface MapShowOptions { features?: boolean; enzymes?: boolean; primers?: boolean; orfs?: boolean }
```

Viewport helpers: `zoomViewport(vp, factor, anchorBp, length, plotWidth)`, `panViewport(vp, deltaBp,
length, plotWidth)`, `clampViewport(vp, length, plotWidth)`, `viewportForRange(range, length,
topology, margin = 0.1)`, `fullViewport(length)`, `isFullViewport(vp, length)`,
`interpolateViewport(from, to, t)`. Constants: `MAX_PX_PER_BASE = 24` (deepest zoom),
`LETTER_PX_PER_BASE = 8` (letters appear).

**For the integrator:** `MapTarget`, `FeatureClickInfo` and `MapShowOptions` are structurally
identical in `circular/`, `linear/` and `sequence/`. The circular map now uses the name
`MapShowOptions` too. `export *` from more than one folder creates ambiguous re-exports (TS2308),
so export the shared types once in `packages/viewer/src/index.ts`.

## Behaviour (as built)

- **Mouse and trackpad:** ⌘/ctrl + wheel and pinch zoom around the pointer (WebKit `gesture*`
  events are handled too, without double zooming). A horizontal swipe or shift + wheel pans. Plain
  vertical wheel stays native, so the pane scrolls when the map is taller than it.
- **Selection:**
  - Dragging anywhere selects and snaps to gaps. The view auto-scrolls when the drag reaches the
    left or right edge.
  - Clicking a feature, primer or ORF selects its extent (and calls `onFeatureClick` /
    `onPrimerClick`). Shift-click extends; on a circular record the shortest covering arc keeps a
    wrap. Clicking the backbone or ruler places the caret; clicking empty space clears.
  - Double-clicking a feature zooms to it (and selects it); double-clicking empty space zooms in 2×.
- **Keyboard (map focused):** ← → pan (shift: by a page), + − zoom, 0 zooms to fit, Home and End
  go to the ends, Esc clears the selection. Focus shows as a visible ring (`:focus-visible`).
- **Hover:** the feature, enzyme, primer or ORF card appears after 450 ms, and instantly when moving
  between items. Hovering a feature draws a ring and calls `onFeatureHover`. Hovering an enzyme
  highlights all its cuts in view.
- **Overview scrollbar:** a slim macOS-style scrollbar appears while zoomed. Drag its thumb, or
  click the track to glide there.
- **Animations:** viewport changes from the app glide over 320 ms with geometric span interpolation
  (constant zoom speed). They are disabled under `prefers-reduced-motion`.

## Design decisions

- **Forward strand above the backbone, reverse below (strand 0 goes above).** This mirrors the two
  strands of the backbone, so the strand reads at a glance even where arrow heads are sub-pixel,
  for example at genome scale. Each side stacks only its own lanes, which keeps it shallow.
  Features sit next to the backbone because they are the main content; ORFs and then primers sit
  outside them.
- **Lanes are packed once in bp space** (greedy first-fit, longest first), so nothing jumps between
  lanes while zooming or panning. Both pieces of an origin-spanning feature share one lane.
- **Label placement order:** inside the bar, then beside it (right, then left), then just outside it
  (above for top lanes, below for bottom lanes), then truncated inside with at least 4 characters,
  else left to the hover card. A shared occupancy model keeps labels clear of bars and of each
  other. A label sits 4 px from its own bar but 10 px from anything else, so it reads as belonging
  to its bar. Highlighted or selected features are labelled first, through a second layout pass
  that runs only when such a feature on screen lost its label.
- **Enzymes:** labels go in staggered rows above the map, unique cutters in semibold. Placement runs
  right to left and turns clusters into a staircase. Leaders never cross labels in lower rows, and
  unique cutters evict common cutters when rows run out. The number of rows is reserved from the
  whole-record view, so the layout does not jump while panning. At letter zoom, staggered cuts are
  drawn between the two strands.
- **Selection is an underlay plus crisp edges** (new; same approach as the circular map's wedge).
  Features keep their true colours instead of turning muddy in dark mode. Because nothing paints a
  background colour any more, enzyme leaders are now *interrupted* around outside labels instead of
  being covered by text halos.
- **Large records:** everything is culled to the viewport plus a 40 px margin. Features narrower
  than 1.5 px become slim 2 px bars when isolated, or merge into a density band in 2 px bins
  coloured by the dominant type with 4 opacity levels. With more than 150 tiny features in view
  they are not labelled. With more than 1,500 cuts in view only unique cutters get labels. Letters
  are one `<text>` per strand with an `x` list, never one DOM node per base.
- **Single-stranded molecules (RNA, protein)** have one line. At letter zoom an 18 px band opens and
  the letters sit on that line (fixed in this attempt).
- **Labels inside bars** on custom (file) colours switch to light text when that gives better WCAG
  contrast. Token fills keep the shared near-black text.
- **Positions:** `EcoRI (396)` is the 1-based base before the top-strand cut (SnapGene's
  convention, the same as the circular map). Ruler ticks sit at base centres, 1-based. Hover ranges
  read `526..1,203`.

## Changes in this attempt

1. **Detached labels (bug).** A feature lying entirely in the off-screen drawing margin got an
   "outside" label clamped to the map edge, next to no visible bar (e.g. "KS primer" and
   "pBR322ori-F" after zooming). Now only bars at least 1 px on screen get labels, and an outside
   label must overlap its bar's visible part. The pinned-label second pass now uses
   `featureOnScreen` instead of "has an outline", which avoided wasted layout passes. Pinned
   features inside density bands now get a label candidate.
2. **RNA and protein letters overlapped feature lane 0 (bug).** Fixed with the single-strand letter
   band described above.
3. **Controlled viewport drift (bug).** A viewport the map had to clamp was displayed clamped but
   never reported, so app zoom buttons acted on an invisible state. It is now reported once
   (loop-safe). Checked in the browser: "Zoom to selection" on a 20 bp primer leaves the app at
   2,084–2,137 bp, the deepest zoom.
4. **Selection underlay, leader gaps and no halos** (visual consistency with the circular map;
   cleaner dark theme).
5. **Contrast-aware text on custom feature colours** (`labelColor.ts`).
6. **New gallery stories:** `exons-introns` (spliced genes on both strands with dark custom
   colours) and `protein` (a protein overview plus an RNA at letter zoom).

## Tests (126 in 9 files: `cd packages/viewer && npx vitest run src/linear`)

- `viewport.test.ts`: scale and position mapping, zoom around the pointer, round trips,
  deepest-zoom and record limits, pan, clamping (idempotent; tiny records centred), framing a
  wrapping range, glide interpolation.
- `lanes.test.ts`: packing (optimal lane count, touching intervals, longest inner, origin-spanning
  pieces in one lane, maxLanes overflow, randomized no-overlap) and culling index (brute-force
  check).
- `enzymeLabels.test.ts`: label text and positions, unique cutters, staggered cuts across the
  origin, and the staircase, eviction, edge and random-dense guarantees of label placement.
- `layout.test.ts`:
  - no label overlaps for every sample at several zooms and widths;
  - **new:** labels stay attached to the visible part of their bar (fails without fix 1);
  - **new:** pinned label inside a density band;
  - **new:** single-stranded letters clear of features;
  - **new:** `leaderPath` gaps, and no leader crosses an outside label on any sample (21 of 42
    leaders on the linear sample have gaps);
  - genome density, culling, and 40 ms budgets.
- `selectionGeometry.test.ts`: wrap pieces, caret at both ends of the origin, cover and extend.
- `ticks.test.ts`, `labelSpace.test.ts`, and **new** `labelColor.test.ts`.
- `LinearMap.test.tsx` (jsdom): rendering, the a11y label, an empty record, letters, wrap pieces,
  the caret, the highlight ring, `show`, the genome DOM-size bound, every click / shift / drag /
  Escape selection path, wheel zoom and pan, keyboard, glides, double-click zoom, controlled vs
  uncontrolled viewport, **new** clamped-viewport report, hover card, context menu and enzyme
  click.

**Browser checks** (Playwright scripts, not committed, kept in the session scratchpad
`linear-ui/`): every interaction above was verified on the `interactive` story in both themes.

**Frame times** on the `genome-interactive` story: 120-step ctrl+wheel zoom from 4.6 Mb to 53 bp,
pan, hover sweep and drag. Unthrottled, p99 is 16.8 ms with no long tasks. With 4× CPU throttling
at 2× DPR, p99 is still 16.8 ms, except the keyboard glides at p90 33 ms.

## Screenshots: `/tmp/hh-shots/linear/final/`

All 18 stories × light/dark × 900×600 and 1600×1000, named `<story>-<theme>-<W>x<H>.png`.
Stories: pFA6a-kanMX6, pBAD30, pBR322, linear, features-only, exons-introns, primers-orfs,
zoomed-bases, zoomed-features, selection, selection-wraps-origin, caret, genome-4.6Mb, genome-60kb,
tiny, sticky-ends, protein, empty.

Interaction frames (1320×840): `interact-hover-feature-light`, `interact-hover-enzyme-light`,
`interact-hover-primer-dark`, `interact-shift-extend-dark`, `interact-dblclick-zoom-light`,
`interact-zoom-to-selection-light`.

The gallery also has stateful `interactive`, `interactive-circular` and `genome-interactive`
stories (controlled selection and viewport with a status bar and zoom buttons).

## Known limitations / notes for others

- **pBAD30 fixture names contain backslashes** ("operator\O2", "rrnB\T1\T2"). This is data from
  files that encode spaces as `\`. The GenBank/SnapGene parsers (core) should decide whether to
  unescape them; the viewer shows names as given.
- **Partial features** (`partialStart` / `partialEnd`) are drawn like complete ones, with no jagged
  end.
- **Unique cutters** are counted over the `enzymeSites` given, so the app should pass all sites of
  each enzyme it shows (the spec's "already filtered" contract).
- **Limits:** at most 6 enzyme label rows and 24 lanes per side. Features beyond the lane limit
  share the last lane.
- **Map export as SVG/PNG** (app spec): the SVG takes its colours from CSS classes and `var()`, so
  an exporter must inline computed styles. No export helper is provided here.
- **No touch-specific gestures.** Mouse, trackpad and keyboard only.
- **Suggestion for the circular map and sequence view owners:** they still put near-black text on
  every fill. `labelColorOnFill` could move to `common/colors.ts` and be shared.

## Requested token additions

- `--hh-feature-label-on-dark`: light text for labels inside dark custom-coloured feature bars.
  Currently falls back to `var(--hh-accent-contrast)` (#fff in both themes).
- Optional: `--hh-map-leader` for enzyme leader lines (currently `--hh-separator-strong`), so maps
  can tune leaders without changing separators app-wide.
