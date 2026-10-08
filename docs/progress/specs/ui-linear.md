COMPONENT KEY: linear. YOUR PORT: 5103.
OWNERSHIP: packages/viewer/src/linear/** (LinearMap.tsx, layout.ts, LinearMap.module.css, LinearMap.gallery.tsx, index.ts, tests).
COMPONENT: <LinearMap /> (export interface LinearMapProps): horizontal map for linear records and an alternative view of circular ones (drawn from the origin).
Shared data/interaction props used by all three sequence visualizations (keep names identical across components; export the target type as MapTarget from your folder, structurally identical to: { kind: 'feature'; id: string } | { kind: 'enzyme'; site: EnzymeSite } | { kind: 'primer'; id: string } | { kind: 'orf'; orf: Orf } | { kind: 'background'; position: number /* gap */ } | { kind: 'sequence'; position: number }):
  record: SeqRecord;
  enzymeSites?: readonly EnzymeSite[];             // already filtered by the app: show every one given
  primerSites?: readonly PrimerBindingSite[];      // primer names via record.primers (match primerId)
  orfs?: readonly Orf[];
  selection?: SequenceSelection | null;
  onSelectionChange?: (selection: SequenceSelection | null) => void;
  highlightedFeatureId?: string | null;            // e.g. hovered in the sidebar
  onFeatureClick?: (featureId: string, info: { clickCount: number; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }) => void;
  onFeatureHover?: (featureId: string | null) => void;
  onEnzymeClick?: (site: EnzymeSite) => void;
  onPrimerClick?: (primerId: string) => void;
  onContextMenu?: (target: MapTarget, event: React.MouseEvent) => void;
  show?: { features?: boolean; enzymes?: boolean; primers?: boolean; orfs?: boolean };
  className?: string;
Conventions: user-visible positions are 1-based (formatPosition); enzyme labels show the 1-based position of the top-strand cut, e.g. "EcoRI (396)"; an enzyme that cuts the record exactly once is a "unique cutter" and its label is emphasised (bold); clicking a feature also calls onSelectionChange with the feature's extent.
  viewport?: Range; onViewportChange?: (viewport: Range) => void;   // extra props: visible window in bp; uncontrolled by default (whole record)
LOOK & BEHAVIOUR:
- Ruler with adaptive nice ticks; a backbone that reads as double-stranded DNA; features as rounded bars with pointed 3' ends, stacked in lanes (decide and justify: forward above / reverse below the backbone, or all above), labels inside bars when they fit, else beside/above without overlaps; enzyme cut markers with labels above (no overlaps: staggered rows); primers as thin arrows; ORFs optional.
- Zoom: ctrl/cmd + wheel and trackpad pinch (arrives as ctrl+wheel) around the pointer; horizontal wheel / shift+wheel pans; dragging along the ruler/backbone selects; double-click a feature zooms to it; controlled viewport supports zoom-to-selection / zoom-to-fit from the app. At high zoom (≥ ~8 px per base) draw base letters on the backbone (top strand + complement).
- Selection: drag selects (for circular records a selection that wraps the origin is drawn as two pieces); click feature selects it; shift+click extends; caret line for empty selections; hover tooltip like the circular map.
- Must stay smooth for a 4.6 Mb record with ~4,500 features: cull to the viewport, aggregate sub-pixel features (draw density instead), skip labels that cannot fit, never per-base DOM at low zoom.
TESTS: scale/position mapping with zoom and pan, lane packing, label de-overlap, wrap selection pieces, viewport clamping.
GALLERY (LinearMap.gallery.tsx): every SAMPLE (circular ones too), a zoomed-in view showing bases, a selection, a synthetic 4.6 Mb record with thousands of features, dark via &theme=dark.
