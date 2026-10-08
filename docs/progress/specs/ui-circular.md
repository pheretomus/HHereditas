COMPONENT KEY: circular. YOUR PORT: 5102.
OWNERSHIP: packages/viewer/src/circular/** (CircularMap.tsx, geometry.ts, layout.ts (lanes + label layout), CircularMap.module.css, CircularMap.gallery.tsx, index.ts, tests).
COMPONENT: <CircularMap /> (export interface CircularMapProps): the plasmid map, the signature view of the app.
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
  rotation?: number;   // extra prop: degrees; 0 = origin at 12 o'clock (default)
LOOK & BEHAVIOUR (SnapGene quality, Apple polish):
- Fills its container (useElementSize); the circle radius adapts to leave room for labels.
- Backbone circle; ruler ticks just inside with nicely rounded intervals (~8–12 labelled ticks).
- Features as arcs (band ~10–12 px) with an arrowhead at the 3' end for stranded features (strand 0: plain band); overlapping features stacked on concentric lanes (greedy lane assignment in circular coordinates, wrapping features handled); multi-segment features drawn per segment with a thin connector; colours via featureFill/featureStroke; hover highlight; highlightedFeatureId emphasised.
- Labels: a feature label goes INSIDE its arc along a curved path when it fits (textPath, oriented so it is never upside down), else OUTSIDE with a thin leader line. Enzyme labels outside the ring. Outside labels must never overlap: lay them out per side (right half / left half), sorted by angle, spread vertically with leader lines (SnapGene style); if they cannot all fit, drop the lowest-priority ones and show a subtle "+N more" note; priority: selected/highlighted > features (longer first) > unique-cutter enzymes > other enzymes > primers.
- Primers: thin arrows just outside the backbone, coloured --hh-primer-fwd / --hh-primer-rev, names in the outside label layout.
- ORFs (show.orfs): thin arcs on an inner lane with arrowheads, colour --hh-orf.
- Centre text: record name (semibold, ellipsis if long) and length "3,938 bp".
- Selection: translucent wedge (--hh-seq-selection) from the centre to the backbone over the selected arc plus an emphasised backbone arc; a radial caret line when the selection is empty. Wrapping selections render correctly.
- Interaction: click a feature → onSelectionChange(feature extent) + onFeatureClick; click an enzyme label/tick → onEnzymeClick(site); click/drag in the ring area → caret / arc selection following the pointer angle (support dragging across the origin by tracking the cumulative angle, in either direction); shift+click extends from the anchor; Escape clears; hover tooltip (name, type, 1-based range "1,234..2,345", length, strand) as a lightweight overlay.
- Linear records: render gracefully (a small gap at the origin), although the app will normally use LinearMap for them. Empty record or no features: sensible empty state.
- Performance: layout memoized on (record, sites, size); pBR322 with all its features and sites re-renders on hover in < 8 ms.
TESTS: geometry (position↔angle incl. rotation and wrap), lane assignment (no overlaps, wrapping features), label layout (no overlapping label boxes for every SAMPLE at 600×600 and 1200×900), drag selection across the origin, click-to-feature selection.
GALLERY (CircularMap.gallery.tsx): every SAMPLE; a selection wrapping the origin; highlighted feature; dense labels (pBR322 with all enzymes); ORFs shown (hand-made Orf objects); tiny (400×400) and large; dark via &theme=dark.
