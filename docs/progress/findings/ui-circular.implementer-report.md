# ui-circular — implementer report (`<CircularMap />`)

Status: **complete against docs/progress/specs/ui-circular.md.** 91/91 tests pass, `tsc --noEmit` is clean
for packages/viewer and apps/desktop (the only error is in packages/core `seq/translate.ts`, which is not mine).
I checked every story in both themes at 900×600 and 1600×1000, plus interactions in real Chromium.

This was the third attempt. The predecessor's code (geometry, lane packing, SnapGene-style label columns,
interaction, tests) was sound, so I kept it and focused on verification, fixes and polish (see "Changes in this
pass").

## Files (all in packages/viewer/src/circular/)

| File | Role |
| --- | --- |
| `CircularMap.tsx` | Component: props, selection/drag/hover plumbing, memoized SVG layers, tooltip, lazy layout for heavy maps |
| `CircularMap.module.css` | All colours via `--hh-*` tokens (SVG colours via classes or `style`, never presentation attributes) |
| `geometry.ts` | Position↔angle scale (rotation, linear-origin gap), polar math, SVG path builders (arc, band, arrow, thin arrow, wedge), ruler ticks |
| `layout.ts` | Stage 1 `buildMapModel` (lanes, pieces, unique cutters, primer reservations) → stage 2 `computeGeometry` (radius trials, radial plan, shapes, inside labels, ruler, centre text) → stage 3 `placeLabels` (outside label columns, leaders, priority dropping, "+N more") |
| `hitTest.ts` | DOM-free hit testing (labels, cut ticks, primers, features, ORFs, ring, background) and `MapTarget` mapping |
| `measure.ts` | Text measurement (canvas-backed and cached; a deterministic estimator in tests) and truncation |
| `types.ts` | `MapTarget`, `FeatureClickInfo`, `MapShowOptions` |
| `index.ts` | Folder barrel (see below) |
| `CircularMap.gallery.tsx`, `circularGalleryData.ts` | 22 stories (incl. `perf-pBR322` with a React Profiler), a gallery-only enzyme scanner, hand-made ORFs, a synthetic 4.6 Mb genome |
| `geometry.test.ts`, `layout.test.ts`, `CircularMap.test.tsx` | 16 + 49 + 26 tests |

## Exported API (`circular/index.ts`)

```ts
export { CircularMap } from './CircularMap';
export type { CircularMapProps } from './CircularMap';
export type { FeatureClickInfo, MapShowOptions, MapTarget } from './types';
// pure helpers, prefixed so a package barrel can re-export every folder without clashes
export { type AngleScale as CircularAngleScale, angleToGap as circularAngleToGap,
  angleToPosition as circularAngleToPosition, createAngleScale as createCircularAngleScale,
  positionToAngle as circularPositionToAngle } from './geometry';
export { type LabelPlacement as CircularLabelPlacement, type MapGeometry as CircularMapGeometry,
  type MapModel as CircularMapModel, buildMapModel as buildCircularMapModel,
  computeGeometry as computeCircularGeometry, placeLabels as placeCircularLabels } from './layout';
```

```ts
export interface CircularMapProps {
  record: SeqRecord;
  /** Sites to draw (already filtered by the app): every one given is shown. */
  enzymeSites?: readonly EnzymeSite[];
  /** Primer binding sites; names come from record.primers (matched by primerId). */
  primerSites?: readonly PrimerBindingSite[];
  orfs?: readonly Orf[];
  /** Controlled selection (null = nothing selected). Omit (undefined) to let the map keep its own. */
  selection?: SequenceSelection | null;
  onSelectionChange?: (selection: SequenceSelection | null) => void;
  /** Feature to emphasise, e.g. hovered in the sidebar. */
  highlightedFeatureId?: string | null;
  onFeatureClick?: (featureId: string, info: FeatureClickInfo) => void;
  onFeatureHover?: (featureId: string | null) => void;
  onEnzymeClick?: (site: EnzymeSite) => void;
  onPrimerClick?: (primerId: string) => void;
  onContextMenu?: (target: MapTarget, event: React.MouseEvent) => void;
  /** Layers to draw; each defaults to visible when its data is given. */
  show?: MapShowOptions;
  className?: string;
  /** Map rotation in degrees, clockwise; 0 (default) puts the origin at 12 o'clock. */
  rotation?: number;
}

export type MapTarget =
  | { kind: 'feature'; id: string }
  | { kind: 'enzyme'; site: EnzymeSite }
  | { kind: 'primer'; id: string }        // id = PrimerBindingSite.primerId
  | { kind: 'orf'; orf: Orf }
  | { kind: 'background'; position: number /* gap */ }
  | { kind: 'sequence'; position: number }; // 0-based base under the pointer (ring area)

export interface FeatureClickInfo { clickCount: number; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }
export interface MapShowOptions { features?: boolean; enzymes?: boolean; primers?: boolean; orfs?: boolean }
```

Note for the integrator: `MapTarget`, `FeatureClickInfo` and `MapShowOptions` are structurally identical to the
types with the same names in `linear/` (and `sequence/` for the first two). A package barrel should export one copy.

## Behaviour (spec checklist)

- **Size:** fills its container (`useElementSize`). The radius is the largest of a few trials whose outside labels fit
  about as well as the best trial; a bare map keeps some breathing room.
- **Ring:** backbone circle. The ruler sits inside the annotations, with rounded steps (1/2/2.5/5×10ᵏ, about 8–12
  labelled ticks), minor ticks, and an origin mark.
- **Features:** arcs on concentric lanes. Lanes come from greedy longest-first packing in circular coordinates,
  and origin-wrapping ranges are handled. Bands are 9–13 px depending on radius and squeeze when lanes run out.
  Stranded features have a 3′ arrowhead; strand 0 gets a plain band. Multi-segment features are drawn per piece
  with a thin connector. Colours come from `featureFill` / `featureStroke`. Hover shows an accent outline, and so
  does `highlightedFeatureId`, which also pins its label.
- **Labels:**
  - **Inside labels:** a curved `textPath` inside the band, used only when the name fits, and never upside down.
  - **Outside labels:** SnapGene-style left and right columns sorted by angle. Positions are a least-squares spread
    within per-label windows, and labels hug a circle around the map. Each has a two-part leader: a radial stub,
    then a straight segment that never cuts the ring. Labels never overlap (tested for every sample at 5 sizes).
  - **Priority when space runs out:** pinned (selected or highlighted) > features (longer first) > unique cutters
    (bold) > other enzymes > primers, with a "+N more" note at the bottom.
  - **Enzyme label text:** "EcoRI (396)" is the 1-based base before the top-strand cut, the same convention as the
    sequence view and the linear map.
- **Primers:** thin `--hh-primer-fwd` / `--hh-primer-rev` arrows just outside the backbone, stacked on lanes; their
  names go in the outside label layout.
- **ORFs:** thin `--hh-orf` arrows on lanes inside the features.
- **Centre:** the record name (semibold; it shrinks a little, then gets an ellipsis) and the length. Linear records
  add "· linear".
- **Selection:** a translucent `--hh-seq-selection` wedge, fading towards the centre, plus an emphasized backbone arc
  and faint radial edges. Selections that wrap the origin render correctly. An empty selection shows a radial caret
  with a knob.
- **Interaction:**
  - Clicking a feature calls `onSelectionChange(feature extent)` and `onFeatureClick` (with clickCount and
    modifiers). Shift+click covers both features.
  - Clicking an enzyme label or cut tick calls `onEnzymeClick(site)`. Clicking a primer or ORF selects its range
    (primers also call `onPrimerClick`).
  - Clicking in the ring sets a caret. Dragging follows the cumulative pointer angle, so it crosses the origin in
    either direction and keeps its direction past the anchor. Shift+click or shift+drag extends from the anchor.
  - Escape clears the selection. Clicking the background deselects.
  - Context menu reports the `MapTarget`. A hover tooltip shows name, type · strand, 1-based "1,234..2,345" and
    length (or the equivalent for enzymes, primers and ORFs).
- **Linear records:** a 7° gap at the origin with end caps. A drag never jumps across the gap.
- **Empty states:** "Empty sequence" (dashed ring) and "No features" (the ruler hangs off the backbone).
- **Accessibility:** focusable group with `aria-roledescription="plasmid map"` and a summary `aria-label`. The focus
  ring shows for keyboard focus only. A polite live region announces the selection.

## Changes in this pass

1. **Primer arrows were nearly invisible.** A 20-mer on a large plasmid drew as a dot (4 px minimum). They now draw
   at least 14 px long. The tip stays exactly on the 3′ end and the extra length goes on the 5′ side. Arrows sit
   6 px off the backbone, clear of the cut ticks.
   - The model now reserves 1.5 % of the molecule per primer on its lane (`PrimerItem.extent`). Lengthened arrows
     on the same lane can therefore never touch. A randomized test covers this at 3 sizes.
2. **Origin-spanning joins showed a seam.** `featurePieces()` merges consecutive segments that continue each other,
   so GenBank `join(2701..3000,1..180)` draws as one continuous arrow with its label centred. The tooltip counts
   pieces, not raw segments.
3. **Live resize of heavy maps.** Maps with more than 800 annotations follow a live resize lazily. The previous
   drawing is scaled through `viewBox` until the size has been stable for 150 ms, then laid out again crisply.
   - Pointer → layout coordinate mapping accounts for the scaling.
   - Genome live resize went from about 197 ms to about 16 ms per step. Light maps still re-lay out on every step.
4. **Enzyme hover shows every site of that enzyme:** label pills, darker leaders and red cut ticks. This makes it
   clear at a glance where else the enzyme cuts.
5. **Smaller fixes and cleanups:**
   - Drags only emit `onSelectionChange` on real changes.
   - The tooltip uses `--hh-shadow-tooltip` and `--hh-z-tooltip`.
   - The live region says "Caret at the origin" instead of "after base 0".
   - `MapLayers` is renamed `MapShowOptions`, the name `LinearMap` uses.
   - The barrel is trimmed to the component API plus prefixed helpers. Previously it exported generic names like
     `computeGeometry` and `formatRangeText` that could clash in a package barrel.
6. **New gallery story `edge-cases`:** a whole-circle feature, an origin join, a zero-length feature, a strandless
   feature, a gene+CDS duplicate, a very long name, a 10-lane stack, a two-cut BaeI site, and an uncut site.

## Design decisions

- **Unnamed features rank lower.** An unnamed feature (name = type, e.g. pBR322's many "misc_binding") ranks below
  unique cutters on large maps and below primers on maps under 520 px. This is a deliberate refinement of the
  spec's order: such a label carries little information, the feature is still drawn, and its tooltip names it.
  Named features follow the spec order.
- **Duplicate labels are merged.** Features with the same name and extent (gene + CDS) share one outside label.
- **Drag area.** The whole disc (except the centre) starts a caret or drag, not just the band. This is a larger,
  more forgiving target. Pressing on a feature and dragging selects the drag range; it does not count as a
  feature click.
- **Ruler placement.** The ruler sits inside the innermost annotation lane (as SnapGene does), and on bare maps
  directly on the backbone. Tick numbers switch to compact units at 100 kb and above ("4 Mb").
- **Crowded maps.** A slightly smaller circle is preferred over losing labels: radius trials of 1 to 0.76 × the
  maximum, chosen by a weighted label-drop cost.
- **Show defaults.** Every layer defaults to visible when its data is given. `show.x = false` hides it, the same
  as LinearMap and SequenceView.

## Performance (Chromium, measured)

- **Hover, pBR322 at 1600×1000:** re-renders take 0.6–0.7 ms median, 1.1 ms p95, 1.7 ms max (budget: < 8 ms). The
  layers are memoized, so hover and selection only re-render small overlays.
- **Layout math:** plasmids take under 5 ms. The synthetic 4.6 Mb genome (4,500+ features) takes about 29 ms, plus
  about 250 ms of first React/DOM render. Hover on the genome takes about 0.8 ms.
- **Live resize:** pBR322 about 18 ms per step; genome about 16 ms per step (previously about 197 ms).

## Tests (`cd packages/viewer && npx vitest run src/circular`): 91 pass

- **geometry (16):** position↔angle with rotation and wrap, the linear gap, polar math, path builders, arrowhead
  side, ruler steps (8–12 labels).
- **layout (49):**
  - Lane packing: random circular records never overlap; wrapping features.
  - Model: enzyme labels and unique cutters; the cut-label convention.
  - Outside labels: for every SAMPLE at 600×600, 1200×900, 400×400, 900×600 and 1600×1000, there are no overlaps,
    labels stay in view, leaders never cut the ring, and the "+N more" count is consistent. Also covered: primers,
    ORFs, rotation, pinned labels, drop priority, determinism.
  - Inside labels: fit and orientation.
  - Shapes: multi-segment connectors, origin-join merging, primer arrows (minimum length, 3′ tip, lane
    separation), linear gap, empty states, long names.
  - Genome layout speed.
- **component (26):**
  - Rendering and ARIA; unique-cutter bold.
  - Selection: wrapping wedge and caret; highlight; show switches; empty states.
  - Clicks: click-to-feature selection and `onFeatureClick` info, the origin-wrapping feature, shift+click
    covering, enzyme label and tick clicks, primer click.
  - Drags: clockwise and counter-clockwise across the origin, cumulative-angle direction, drag starting on a
    feature, emits only on change.
  - Caret, shift extension, Escape; tooltip and hover callbacks; all sites of a hovered enzyme; context-menu
    targets; uncontrolled mode; a linear drag never wrapping.
  - Resizing: light maps re-lay out immediately; heavy maps scale with correct pointer mapping, then re-lay out
    after settling.

## Screenshots (/tmp/hh-shots/circular/final/)

- **Stories:** `<story>-<light|dark>-<900x600|1600x1000>.png` for all 21 stories (84 files): pFA6a, pBAD30,
  pBR322, linear, selection-wrapping-origin, caret, highlighted-feature, dense-labels, few-cutters, orfs, primers,
  features-only, rotated, tiny, tiny-dense, large, long-name, edge-cases, no-features, empty, genome.
- **Interactions** (`interaction/`, light and dark):
  - hover-feature, hover-enzyme, hover-enzyme-all-sites (2×)
  - drag-cw-during, drag-cw, shift-extend, click-feature, focus
  - genome-live-resize-scaled-dark, genome-live-resize-settled-dark
- **Predecessor images** were moved to /tmp/hh-shots/circular/_previous/ (superseded).

## Known limitations

- **Feature names come from the fixtures verbatim.** pBAD30's ApE-style labels show backslashes ("operator\O2").
  If those should become spaces, the GenBank parser in core is the place to do it.
- **Very short features look stubby.** A feature shorter than about two arrowhead lengths draws as a compact
  pointed "tag" shape. This is legible, but the shapes are heavy when many cluster together.
- **Leaders can cross at pole clusters.** In very dense clusters at 12 or 6 o'clock that are split between both
  columns, some leader segments can cross inside the bundle. Labels themselves never overlap.
- **Primer lane limit.** More than 4 overlapping primer lanes share the outermost lane.
- **Recognized but uncut sites** (only possible near linear ends) are drawn like cuts at the site start, the same as
  LinearMap.
- **No keyboard caret movement.** The only key is Escape; caret movement and typing belong to the sequence view.
- **Font loading costs one extra layout.** Each web-font `loadingdone` triggers a full re-layout. For the genome
  this costs about 90 ms once at startup.

## Requested token additions

None are required: everything uses existing tokens and there are no local fallbacks. One suggestion for the
owner of `common/colors.ts`: add `--hh-feature-label-on-fill` (light and dark) so the shared
`FEATURE_LABEL_ON_FILL` constant (`rgba(0,0,0,0.82)`, used for curved inside labels) becomes a token.
