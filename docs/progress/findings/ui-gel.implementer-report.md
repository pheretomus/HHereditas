The gel component is finished and checked by eye in both themes at 900×600 and 1600×1000: all 56 gel tests pass, and there are no type errors in the gel files. The previous engineer's work already covered the whole spec. I kept it, fixed one real bug and polished the rest.

**Bug fixed:** the size labels written next to sample bands (`showSizes='all'`) could move a full line away from their band. In crowded lanes a label then sat beside the wrong band (at 700×300 "600 bp" was next to the 500 bp band). Each label now stays closer to its own band than to any other, and labels that can't fit are dropped (the band still has its tooltip).

**Other changes:**
- **Slab width:** the slab used to be at least half as wide as it is tall, which left empty gel between the ladder sizes and the ladder lane. It now hugs the lanes, with a minimum of 3 lanes wide or 0.3× its height, so one or two lanes still look like a gel.
- **Reference bands:** they keep their labels when a ladder is labelled like a sample, and those labels are bold like the ones at the left.
- **Lane labels:** rotated labels may now be up to 200 px long on tall views (was 150). When lanes are too narrow to show any labels, hovering a lane shows its name.
- **Small fixes:** the hyphen in "co-migrating" no longer renders with gaps in the tooltip; the keyboard focus ring lines up with the selection outline; lane accessible names are computed once per layout instead of on every hover.
- **Two new stories:** `long-labels` and `many-lanes` (a 48-lane colony-PCR screen).

**Performance:** on the 4.6 Mb genome story (about 18,000 fragments in one lane), hover sweeps and window resizes held 60 fps, measured in headless Chromium only, not yet in WebKit/Tauri. Layout plus 2,000 hit-tests takes about 33 ms.

**Files** (all in `/home/srdgjuchdr/HHereditas/packages/viewer/src/gel/`): `GelView.tsx`, `GelThumbnail.tsx`, `GelBands.tsx` (internal), `GelView.module.css`, `GelView.gallery.tsx`, `layout.ts`, `format.ts`, `measure.ts`, `types.ts`, `index.ts`, `GelView.test.tsx`, `layout.test.ts`, `format.test.ts`.

**API:**
```ts
export interface GelViewProps {
  lanes: readonly GelLane[]; agarosePercent?: number; selectedLaneId?: string | null;
  onLaneClick?: (laneId: string) => void;
  onBandHover?: (laneId: string, band: GelLaneBand | null) => void;
  showSizes?: 'ladder' | 'all' | 'none'; className?: string;
}
export interface GelThumbnailProps { lanes: readonly GelLane[]; width?: number /*160*/; height?: number /*200*/; className?: string; 'aria-label'?: string }
export interface GelLane { id: string; label: string; kind: 'ladder' | 'sample'; bands: readonly GelLaneBand[] }
export interface GelLaneBand { size: number; position: number; intensity: number; count?: number;
  labels?: readonly string[]; emphasized?: boolean; sizes?: readonly number[]; massNg?: number }
export type GelSizeLabels = 'ladder' | 'all' | 'none';
```
- `sizes` and `massNg` are optional extras. The core's `GelBand` can be passed in unchanged.
- `index.ts` also exports helpers:
  - layout: `computeGelLayout`, `placeGelLabels` (targets now accept optional `minY`/`maxY`), `hitTestGel`, `gelLaneAt`, `gelPositionToY` / `gelYToPosition`, `gelBandAlpha`, `gelBandGlow`, `gelBandThickness`, `gelSmearAlpha`, `GEL_MAX_LANE_WIDTH`, `GEL_SMEAR_THRESHOLD`
  - text: `formatGelSize`, `formatGelSizeRange`, `formatAgarose`, `describeGelBand`, `describeGelSmear`, `gelDescriptionText`, `gelLaneAriaLabel`, `gelLaneName`, `approximateGelTextWidth`, `createGelTextMeasurer`
  - the matching layout types; `GelSizeLabel` gained an `emphasized` field.

**Design decisions:**
- The gel stays dark in both themes, using the `--hh-gel-*` tokens.
- Brightness and thickness follow intensity like a camera exposure: faint bands stay visible, bright ones saturate and glow.
- Ladder sizes sit at the left; a different last ladder is labelled at the right. Labels never overlap: they get leaders when moved and are thinned when crowded, never dropping reference bands.
- Lane labels are horizontal when they fit, otherwise rotated 45° or 90° and truncated with the full text in a tooltip; on very narrow lanes they are hidden.
- Lanes with more than 160 bands are drawn as a smear; hovering it summarises the fragments under the pointer.
- The lanes form a keyboard-navigable list: arrows, Home/End, Enter/Space and Escape, with a live region announcing bands.

**Screenshots** (in `/tmp/hh-shots/gel/final/`):
- `<story>-{light,dark}-{900,1600}.png` for all 14 stories: digest, digest-sizes, interactive, single-lane, twelve-lanes, twelve-lanes-sizes, long-labels, many-lanes, dense-ladder, dense-ladder-2pct, empty-lane, no-lanes, genome-smear, thumbnail
- `interact/`: band, doublet, reference-band, truncated-label, smear and hidden-lane tooltips; click to select; keyboard focus
- `small/`: 360×480 and 700×300

**Known limitations:**
- Lanes are at least 10 px wide, so a 48-lane gel scrolls sideways below about 650 px.
- At 360 px wide the sample size labels are dropped and only tooltips remain.
- Very bright bands that overlap merge into one saturated block (it looks like an overexposed photo).

**Requests:**
- **Core gel module:** merged bands carry no top/bottom extent, so an unresolved group of fragments is drawn as one band at its average position instead of a smear. Exposing the topmost and bottommost fragment positions on merged bands would let the view draw it properly.
- **Tokens (optional):** `--hh-gel-well`, `--hh-gel-well-edge` and `--hh-gel-guide`. Local fallbacks derived from `--hh-gel-band` are already in place.
- **Integrator:** export `./gel` from the viewer barrel, and pass `GelView` a memoized `lanes` array (a new array re-runs the layout).

I first overwrote a shared scratchpad file, `scratchpad/shots.mjs` — probably the previous gel engineer's, but I can't confirm. Its old contents can't be recovered; my later scratch files are in `scratchpad/gelwork/`. The dev server on port 5105 is stopped.