COMPONENT KEY: sequence. YOUR PORT: 5104.
OWNERSHIP: packages/viewer/src/sequence/** (SequenceView.tsx, layout.ts (row model), editing.ts (keyboard/clipboard → edit intents), translate-lite.ts, SequenceView.module.css, SequenceView.gallery.tsx, index.ts, tests).
COMPONENT: <SequenceView /> (export interface SequenceViewProps): SnapGene-style annotated sequence text, the main editing surface.
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
Extra props:
  searchHits?: readonly SearchHit[];
  show?: { complement?: boolean /* default true */; features?: boolean; enzymes?: boolean; primers?: boolean; translations?: boolean /* default true: translate CDS features */; orfs?: boolean; numbering?: boolean };
  basesPerRow?: number | 'auto';   // default 'auto': fit the width, a multiple of 10
  editable?: boolean;
  onEdit?: (edit: SequenceEdit) => void;   // export type SequenceEdit = { kind: 'insert'; gap: number; bases: string } | { kind: 'delete'; range: Range } | { kind: 'replace'; range: Range; bases: string }
  onInvalidInput?: (text: string) => void;   // pasted/typed text that is not DNA
  scrollTo?: { position: number; requestId: number };   // scroll so that base is visible whenever requestId changes
  translate?: (codingDna: string, feature: Feature) => string;   // injected translator; until the core translate() exists, ship a tiny standard-code translator in translate-lite.ts as the default
LOOK (study how SnapGene's sequence view reads): per row: 1-based position number at the left (right-aligned, tabular figures); enzyme names above the bases with clear cut-site marks (top-strand cut between the right bases, bottom-strand cut mark in the complement row: SnapGene's stepped cut line is ideal); the top strand in monospace with a small gap every 10 bases; the complement strand below in a lighter colour; feature bars under the sequence (one lane per overlapping feature, coloured, with direction arrows, the name centred in the visible part, repeated on every row the feature spans); CDS translation rows (amino acids centred under their codons, 1-letter, stops as *, subtle alternating codon shading; honour /codon_start and strand); primers as arrows above (forward) / below (reverse) with their bases (mismatches marked); ORFs optional; search hits highlighted. Row heights vary with content.
BEHAVIOUR:
- Virtualized rows with exact variable heights (precompute a row model: lanes/annotations per row, prefix sums for offsets) so the 4.6 Mb genome scrolls smoothly; only visible rows exist in the DOM.
- Mouse: mousedown on a base places the caret at the nearest gap; drag selects (auto-scroll past the edges); shift+click extends from the anchor; double-click a feature bar selects the feature; click on a codon of a translation selects that codon.
- Keyboard (focusable container + hidden textarea for input/IME/clipboard): arrows move the caret (up/down by row), shift+arrows extend, Home/End go to row start/end, cmd/ctrl+A selects all, Escape collapses; when editable: typing IUPAC letters inserts at the caret (or replaces the selection), Backspace/Delete delete, cmd/ctrl+V pastes (clean with normalizeDna; invalid → onInvalidInput), cmd/ctrl+X cuts; cmd/ctrl+C copies the selected bases as plain text via the copy event (must work in Tauri webviews). Circular records: selections may wrap (end > L): e.g. shift+left from the caret at 0 wraps to the end.
- Continuous selection highlight across rows; blinking caret.
TESTS: row model (bases per row, lanes, heights, offsets), hit-testing pointer → gap, keyboard → edit intents (insert/delete/replace incl. wrap), selection extension across the origin, copied text.
GALLERY (SequenceView.gallery.tsx): every SAMPLE; an editing demo (stateful wrapper applying edits to a local copy with naive string ops, demo only); a selection spanning rows and one wrapping the origin; translations visible; narrow (600 px) and wide (1600 px); a synthetic 4.6 Mb record performance story; dark via &theme=dark.
