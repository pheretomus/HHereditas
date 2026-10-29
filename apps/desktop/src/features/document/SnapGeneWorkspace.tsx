/**
 * SnapGene-style workspace layout with HHereditas White + Bio-Green (#16794b) accent.
 * Implements the 4-row SnapGene header (Menu Bar, Document Tab Strip, Icon+Label Action Toolbar,
 * View Tabs Bar with Circular/Linear Map Switcher), full-width white canvas, 7-button left
 * floating layer toggle bar, bottom-left search bar, and bottom-right enzyme set status bar.
 */
import type {
  AlignedSequence,
  EnzymeSite,
  Orf,
  Primer,
  PrimerBindingSite,
  Range,
  SearchHit,
  SeqRecord,
} from "@hhereditas/core";
import {
  addPrimer,
  alignSequenceToReference,
  featureExtent,
  featureLength,
  formatRange,
  makeFeature,
  newId,
  normalizeRange,
  oligoGcContent,
  parseAny,
  parseTraceFile,
  replaceRange,
  reverseComplement,
  reverseComplementRecord,
  setTopology,
  sliceRange,
  tm,
  translate,
} from "@hhereditas/core";
import {
  Button,
  Checkbox,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
  Menu,
  MenuCheckboxItem,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubContent,
  MenuSubTrigger,
  MenuTrigger,
  SearchField,
  Tooltip,
  TooltipProvider,
  cx,
} from "@hhereditas/ui";
import {
  ALIGNMENT_REVEAL,
  AlignedReadsPanel,
  TRACE_COLUMN_WIDTH,
  TRACE_RIGHT_PADDING,
  featureFill,
  formatInt,
  hasSelectedBases,
  selectRange,
  type FeatureClickInfo,
  type MapWidthChange,
} from "@hhereditas/viewer";
import {
  AlignVerticalSpaceAround,
  ArrowDown,
  ArrowLeftRight,
  ArrowRightToLine,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Circle,
  ClipboardPaste,
  Combine,
  Copy,
  Eye,
  EyeOff,
  FilePlus,
  FolderOpen,
  GitCompareArrows,
  Hash,
  Info,
  MapPin,
  Minus,
  PanelLeft,
  Pencil,
  Plus,
  Printer,
  Redo2,
  Rows2,
  Save,
  Scissors,
  Search,
  Sparkles,
  Tag,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import {
  copySelection,
  deleteFeatureCommand,
  deletePrimerCommand,
  setPrimersHiddenCommand,
  detectCommonFeaturesCommand,
  openSelectionAsDocument,
  openWithDialog,
  requestClose,
  saveDocument,
  selectedText,
} from "../../app/commands";
import { openFiles } from "../../app/files";
import { SAMPLES } from "../../app/samples";
import {
  Sidebar,
  formatSelectionStatus,
  type DocumentSummary,
  type EnzymeDisplay,
  type SelectionSummary,
  type SidebarItemRef,
} from "../../shell";
import {
  ENZYME_DISPLAY_CHOICES,
  ENZYME_DISPLAY_NAMES,
} from "../../state/analysis";
import {
  isDirty,
  redoLabel,
  undoLabel,
  type DocumentState,
} from "../../state/documents";
import { useSettings } from "../../state/settings";
import { useApp } from "../../state/store";
import { DocumentView, type DocumentLayerShow } from "./DocumentView";
import styles from "./SnapGeneWorkspace.module.css";

export type SnapGeneTab =
  "map" | "sequence" | "enzymes" | "features" | "primers" | "history";

export interface SnapGeneWorkspaceProps {
  doc: DocumentState;
  shownDoc: DocumentState;
  documents: readonly DocumentSummary[];
  enzymeSites: readonly EnzymeSite[];
  primerSites: readonly PrimerBindingSite[];
  orfs: readonly Orf[];
  searchHits: readonly SearchHit[] | null;
  summary: SelectionSummary | null;
  inspector: ReactNode;
  banner?: ReactNode;
  searchRef: RefObject<HTMLInputElement | null>;
  searchQuery: string;
  onSearchQueryChange: (q: string) => void;
  searchStatus?: ReactNode;
  onSearchSubmit: (value: string, direction: "next" | "previous") => void;
  onSelectSidebarItem: (item: SidebarItemRef, zoom?: boolean) => void;
  statusMessage?: ReactNode;
}

/** Length of the align mode's open / close animations (side panel, trace panel); matches the CSS. */
const ALIGN_ANIMATION_MS = 240;
/** Room for the horizontal scrollbar under the one-line sequence view. */
const TRACE_TOP_SCROLLBAR = 16;
/** The top row (side panel list and the line) is at least this tall, so the list of reads stays usable. */
const TRACE_TOP_MIN = 260;
const LEFT_PANEL_WIDTH_KEY = "hh.leftPanelWidth";
const LEFT_PANEL_DEFAULT = 236;
const LEFT_PANEL_MIN = 160;
const LEFT_PANEL_MAX = 640;

/** One-line sequence view of the align mode: columns as wide as the trace panel's, starting at the canvas's left edge. */
const TRACE_SEQUENCE_METRICS = {
  charWidth: TRACE_COLUMN_WIDTH,
  groupGap: 0,
  paddingLeft: 0,
  paddingRight: TRACE_RIGHT_PADDING,
};

export function SnapGeneWorkspace({
  doc,
  shownDoc,
  documents,
  enzymeSites,
  primerSites,
  orfs,
  searchHits,
  summary,
  inspector,
  banner,
  searchRef,
  searchQuery,
  onSearchQueryChange,
  searchStatus,
  onSearchSubmit,
  onSelectSidebarItem,
  statusMessage,
}: SnapGeneWorkspaceProps) {
  const app = useApp.getState();
  const settings = useSettings();
  const record = doc.record;
  const n = record.seq.length;
  const hasBases = hasSelectedBases(doc.selection);

  // Active SnapGene tab: 'map' | 'sequence' | 'enzymes' | 'features' | 'primers' | 'history'
  const [subTab, setSubTab] = useState<
    "enzymes" | "features" | "primers" | "history" | null
  >(null);
  const activeTab: SnapGeneTab =
    subTab ?? (doc.view === "sequence" ? "sequence" : "map");

  // Map rendering mode: Circular [◯] vs Linear [━] (Screenshot 1 vs Screenshot 2!)
  const [mapMode, setMapMode] = useState<"circular" | "linear">(() =>
    record.topology === "circular" ? "circular" : "linear",
  );
  useEffect(() => {
    setMapMode(record.topology === "circular" ? "circular" : "linear");
  }, [doc.id, record.topology]);

  // Left side panel (Screenshot 3!) & Right Info panel: off by default so the canvas is wide open like SnapGene
  const [leftPanelOpen, setLeftPanelOpen] = useState(
    () => (record.alignedSequences?.length ?? 0) > 0,
  );
  const [leftPanelMode, setLeftPanelMode] = useState<"align" | "explorer">(
    "align",
  );
  const [rightInfoOpen, setRightInfoOpen] = useState(false);
  // the side panel unfolds from the left edge and folds back when closed. Over a map it really grows (the map narrows
  // with it while the reads' band opens) and, when closed, waits for the reads to slide out before folding.
  const mapPanelAnimation = doc.view !== "sequence";
  const leftPanelState = usePresence(
    leftPanelOpen,
    mapPanelAnimation
      ? ALIGNMENT_REVEAL.slideOut + ALIGNMENT_REVEAL.close
      : ALIGN_ANIMATION_MS,
    true,
    // over a map the reads slide in after the panel has opened: no render until they are in place
    mapPanelAnimation
      ? ALIGNMENT_REVEAL.open + ALIGNMENT_REVEAL.slideIn + 300
      : ALIGN_ANIMATION_MS + 300,
  );
  // width of the left panel, dragged on its right edge and remembered between sessions
  const [leftPanelWidth, setLeftPanelWidth] = useState(() => {
    try {
      const v = Number(localStorage.getItem(LEFT_PANEL_WIDTH_KEY));
      return v >= LEFT_PANEL_MIN && v <= LEFT_PANEL_MAX ? v : LEFT_PANEL_DEFAULT;
    } catch {
      return LEFT_PANEL_DEFAULT;
    }
  });
  // the linear map is told how its width is about to change, with the timing of the panel's animation (CSS
  // sidePanelGrow / sidePanelShrink), so its labels move to their new places together with the panel
  const mapWidthChange = useMemo<MapWidthChange | undefined>(() => {
    if (!mapPanelAnimation) return undefined;
    if (leftPanelState === "opening") {
      return { by: -leftPanelWidth, delay: 34, duration: 300, easing: "cubic-bezier(0.16, 1, 0.3, 1)" };
    }
    if (leftPanelState === "closing") {
      return { by: leftPanelWidth, delay: 220, duration: 280, easing: "cubic-bezier(0.4, 0, 0.2, 1)" };
    }
    return undefined;
  }, [mapPanelAnimation, leftPanelState, leftPanelWidth]);
  const onLeftPanelResizePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startW = leftPanelWidth;
    let width = startW;
    const move = (ev: PointerEvent) => {
      width = Math.max(LEFT_PANEL_MIN, Math.min(LEFT_PANEL_MAX, startW + ev.clientX - startX));
      setLeftPanelWidth(width);
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      try {
        localStorage.setItem(LEFT_PANEL_WIDTH_KEY, String(Math.round(width)));
      } catch {
        // the width is then only kept for this session
      }
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  };
  // Align mode (the "Align with:" panel) works on the linear map only: the circular map is switched off while it is on.
  const alignActive = leftPanelOpen && leftPanelMode === "align";
  useEffect(() => {
    if (alignActive && mapMode === "circular") setMapMode("linear");
  }, [alignActive, mapMode]);

  // Floating Layer Visibility state
  const [showEnzymesLayer, setShowEnzymesLayer] = useState(true);
  const [showFeaturesLayer, setShowFeaturesLayer] = useState(true);
  const [showPrimersLayer, setShowPrimersLayer] = useState(true);
  const [showAlignmentsLayer, setShowAlignmentsLayer] = useState(true);
  const [showNumberingLayer, setShowNumberingLayer] = useState(true);
  const [showLengthsLayer, setShowLengthsLayer] = useState(false);
  const [showPrimerLocationsLayer, setShowPrimerLocationsLayer] =
    useState(false);
  const [showComplementLayer, setShowComplementLayer] = useState(true);
  const [showTranslationsLayer, setShowTranslationsLayer] = useState(true);

  // Alignment panel state ("Align with:")
  const [selectedAlignedId, setSelectedAlignedId] = useState<string | null>(
    () => record.alignedSequences?.[0]?.id ?? null,
  );
  const [pasteAlignOpen, setPasteAlignOpen] = useState(false);
  const [pasteAlignName, setPasteAlignName] = useState("Sequencing_Read_1");
  const [pasteAlignSeq, setPasteAlignSeq] = useState("");
  const alignFileInputRef = useRef<HTMLInputElement>(null);

  // Two floating glass bars over the canvas (the layer toggles are single floating buttons); each can be dragged (see useDraggableBar).
  const tabsBar = useDraggableBar();
  const modeBar = useDraggableBar();

  useEffect(() => {
    if ((record.alignedSequences?.length ?? 0) > 0) {
      setLeftPanelOpen(true);
      setLeftPanelMode("align");
      setShowAlignmentsLayer(true);
      setSelectedAlignedId((prev) =>
        record.alignedSequences?.some((a) => a.id === prev)
          ? prev
          : (record.alignedSequences?.[0]?.id ?? null),
      );
    }
  }, [doc.id, record.alignedSequences?.length]);

  // Bottom-left search bar open state
  const [searchOpen, setSearchOpen] = useState(false);
  useEffect(() => {
    if (searchQuery.trim().length > 0) setSearchOpen(true);
  }, [searchQuery]);

  // Primers unchecked in the Primers tab (SnapGene `visible="0"`) are not drawn on the maps or the sequence view.
  const shownPrimerSites = useMemo(() => {
    const hidden = new Set(
      record.primers.filter((p) => p.hidden).map((p) => p.id),
    );
    return hidden.size === 0
      ? primerSites
      : primerSites.filter((s) => !hidden.has(s.primerId));
  }, [primerSites, record.primers]);

  // Table filter for Enzymes / Features / Primers tabs
  const [tableFilter, setTableFilter] = useState("");

  const layerShow = useMemo<DocumentLayerShow>(
    () => ({
      enzymes: showEnzymesLayer,
      features: showFeaturesLayer,
      primers: showPrimersLayer,
      orfs: settings.showOrfs,
      // the map shows the reads while the align mode is on (they slide in and out with its panel)
      alignments: showAlignmentsLayer && alignActive,
      translations: showTranslationsLayer,
      complement: showComplementLayer,
      numbering: showNumberingLayer,
      lengths: showLengthsLayer,
      primerLocations: showPrimerLocationsLayer,
    }),
    [
      showEnzymesLayer,
      showFeaturesLayer,
      showPrimersLayer,
      settings.showOrfs,
      showAlignmentsLayer,
      alignActive,
      showTranslationsLayer,
      showComplementLayer,
      showNumberingLayer,
      showLengthsLayer,
      showPrimerLocationsLayer,
    ],
  );

  // ---- Alignment ("Align with:") mutations ----------------------------------------------
  const alignedList = record.alignedSequences ?? [];

  // Align mode + Sequence view: the reads and their chromatograms in a panel under the sequence (SnapGene's
  // "Original Sequence" pane); the reads are then not repeated inside the sequence view.
  const traceReads = useMemo(
    () => alignedList.filter((a) => a.aligned && a.visible),
    [alignedList],
  );
  const tracePanelOn =
    alignActive &&
    subTab === null &&
    doc.view === "sequence" &&
    traceReads.length > 0;
  // the trace panel slides in and out; while it slides out the layout of the align mode stays
  // it animates only when the align mode is switched on or off, not when only the view (Sequence / Map) changes
  const prevAlignActive = useRef(alignActive);
  const alignToggled = prevAlignActive.current !== alignActive;
  useEffect(() => {
    prevAlignActive.current = alignActive;
  }, [alignActive]);
  const traceState = usePresence(
    tracePanelOn,
    ALIGN_ANIMATION_MS,
    alignToggled,
  );
  const traceShown = traceState !== "closed";
  const traceLayerShow = useMemo<DocumentLayerShow>(
    // the reads stay on the (hidden) map, so coming back to it does not slide them in again
    () => ({ ...layerShow, numbering: false }),
    [layerShow],
  );
  // the sequence above runs as one line with the panel's column width and left margin, and both scroll together
  const [traceScrollLeft, setTraceScrollLeft] = useState(0);
  // the one line above is as tall as its content until the divider is dragged
  const [traceTopHeight, setTraceTopHeight] = useState(0);
  const traceSequenceLayout = useMemo(
    () => ({
      basesPerRow: Math.max(1, n),
      metrics: TRACE_SEQUENCE_METRICS,
      scrollLeft: traceScrollLeft,
      onScrollLeftChange: setTraceScrollLeft,
      onContentHeightChange: setTraceTopHeight,
    }),
    [n, traceScrollLeft],
  );
  /** Share of the height given to the trace panel once the divider was dragged; null: the line above fits its content. */
  const [traceRatio, setTraceRatio] = useState<number | null>(null);
  const alignSplitRef = useRef<HTMLDivElement>(null);
  // the panel's info column is as wide as everything left of the canvas (the side panel and its border)
  const canvasAreaRef = useRef<HTMLDivElement>(null);
  const [traceInfoWidth, setTraceInfoWidth] = useState(0);
  useLayoutEffect(() => {
    const el = canvasAreaRef.current;
    if (!traceShown || !el) return;
    const update = () => setTraceInfoWidth(el.offsetLeft);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [traceShown]);
  // The floating bars and buttons lie over this whole column, so they can be dragged over the reads below the
  // canvas too. They rest against the column, but keep to the canvas sideways, so its left and right edges within
  // the column are published as CSS variables. Written straight to the node: the canvas is resized at every frame
  // while a side panel slides, and a render per frame there is what makes that animation stutter.
  const floatingLayerRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const layer = floatingLayerRef.current;
    const canvas = canvasAreaRef.current;
    const column = alignSplitRef.current;
    if (!layer || !canvas || !column) return;
    const update = () => {
      const c = canvas.getBoundingClientRect();
      const col = column.getBoundingClientRect();
      layer.style.setProperty("--canvas-l", `${Math.round(c.left - col.left)}px`);
      layer.style.setProperty("--canvas-r", `${Math.round(col.right - c.right)}px`);
    };
    update();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(update);
    ro.observe(canvas);
    ro.observe(column);
    return () => ro.disconnect();
  }, []);
  const onTraceSplitPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const box = alignSplitRef.current?.getBoundingClientRect();
    if (!box || box.height <= 0) return;
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const r = 1 - (ev.clientY - box.top) / box.height;
      setTraceRatio(Math.max(0.15, Math.min(0.85, r)));
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  };

  const appendAlignedSequences = (
    newItems: AlignedSequence[],
    flashText: string,
  ) => {
    if (newItems.length === 0) return;
    app.change((r) => {
      const existing = r.alignedSequences ?? [];
      const merged = [
        ...existing,
        ...newItems.map((item, i) => ({
          ...item,
          sortOrder: existing.length + i,
        })),
      ];
      return { ...r, alignedSequences: merged };
    }, "Align Sequences");
    setShowAlignmentsLayer(true);
    setLeftPanelOpen(true);
    setLeftPanelMode("align");
    setSelectedAlignedId(newItems[0].id);
    if (newItems[0].aligned && n > 0) {
      app.selectItem(null, newItems[0].refRange, { zoom: false });
    }
    app.flash(flashText);
  };

  const handleAlignFilesPicked = async (e: ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files;
    if (!fileList || fileList.length === 0) return;
    const added: AlignedSequence[] = [];
    for (let i = 0; i < fileList.length; i++) {
      const f = fileList[i];
      const bytes = new Uint8Array(await f.arrayBuffer());
      const stem = f.name.replace(/\.[^.]+$/, "") || f.name;
      // 1. Check if it is an SCF / AB1 Sanger trace file
      const trace = parseTraceFile(bytes);
      if (trace) {
        added.push(
          alignSequenceToReference(record.seq, record.topology, {
            id: `${Date.now()}_${i}`,
            name: stem,
            sequence: trace.bases,
            quality: trace.quality,
            trace: trace.trace,
            runDate: trace.runDate,
            isTrace: true,
          }),
        );
        continue;
      }
      // 2. Otherwise parse as .dna / .gb / .fa / raw sequence
      const parsed = parseAny(bytes, f.name);
      if (parsed.records.length > 0) {
        for (const rec of parsed.records) {
          added.push(
            alignSequenceToReference(record.seq, record.topology, {
              id: `${Date.now()}_${i}_${rec.id}`,
              name: rec.name || stem,
              sequence: rec.seq,
              isTrace: false,
            }),
          );
        }
      } else {
        const rawText = new TextDecoder()
          .decode(bytes)
          .replace(/[^ACGTRYSWKMBDHVNacgtryswkmbdhvn]/g, "");
        if (rawText.length >= 12) {
          added.push(
            alignSequenceToReference(record.seq, record.topology, {
              id: `${Date.now()}_${i}`,
              name: stem,
              sequence: rawText,
              isTrace: false,
            }),
          );
        }
      }
    }
    e.target.value = "";
    if (added.length === 0) {
      app.flash(
        "Could not extract alignable DNA sequences from the selected file(s).",
        "error",
      );
      return;
    }
    const alignedCount = added.filter((a) => a.aligned).length;
    appendAlignedSequences(
      added,
      `Aligned ${alignedCount} of ${added.length} sequence${added.length > 1 ? "s" : ""} to ${record.name}`,
    );
  };

  const handleAlignOpenDocument = (otherDocId: string) => {
    const other = useApp.getState().documents.find((d) => d.id === otherDocId);
    if (!other) return;
    const aln = alignSequenceToReference(record.seq, record.topology, {
      id: `doc_${other.id}_${Date.now()}`,
      name: other.record.name,
      sequence: other.record.seq,
      isTrace: false,
    });
    appendAlignedSequences(
      [aln],
      aln.aligned
        ? `Aligned ${other.record.name} (${formatRange(aln.refRange, n)}, ${aln.identity}% identity)`
        : `${other.record.name} did not match ${record.name} above threshold`,
    );
  };

  const handleAlignPastedSequence = () => {
    const clean = pasteAlignSeq
      .replace(/[^ACGTRYSWKMBDHVNacgtryswkmbdhvn]/g, "")
      .toUpperCase();
    if (clean.length < 12) {
      app.flash("Enter at least 12 bases of DNA sequence to align.", "error");
      return;
    }
    const name = pasteAlignName.trim() || `Read_${alignedList.length + 1}`;
    const aln = alignSequenceToReference(record.seq, record.topology, {
      id: `paste_${Date.now()}`,
      name,
      sequence: clean,
      isTrace: false,
    });
    setPasteAlignOpen(false);
    setPasteAlignSeq("");
    setPasteAlignName(`Sequencing_Read_${alignedList.length + 2}`);
    appendAlignedSequences(
      [aln],
      aln.aligned
        ? `Aligned ${name} (${formatRange(aln.refRange, n)}, ${aln.identity}% identity)`
        : `${name} added (no significant alignment match on ${record.name})`,
    );
  };

  const handleSimulateSequencingReads = () => {
    if (n < 40) {
      app.flash(
        "Reference sequence is too short to simulate sequencing reads.",
        "error",
      );
      return;
    }
    const spanF = Math.min(750, Math.max(60, Math.floor(n * 0.42)));
    const startF = Math.min(Math.floor(n * 0.04), Math.max(0, n - spanF));
    const rawF =
      "GCTAGCGCT" + record.seq.slice(startF, startF + spanF) + "ATCGATCGA";

    const spanR = Math.min(780, Math.max(60, Math.floor(n * 0.45)));
    const startR = Math.max(0, Math.min(n - spanR, Math.floor(n * 0.48)));
    const rawR =
      "TTAGGCTAG" +
      reverseComplement(record.seq.slice(startR, startR + spanR)) +
      "CCGTAAGCT";

    const alnR = alignSequenceToReference(record.seq, record.topology, {
      id: `sim_r_${Date.now()}`,
      name: `${record.name}_R`,
      sequence: rawR,
      isTrace: true,
    });
    const alnF = alignSequenceToReference(record.seq, record.topology, {
      id: `sim_f_${Date.now() + 1}`,
      name: `${record.name}_F`,
      sequence: rawF,
      isTrace: true,
    });
    // Switch to Linear Map View automatically if in Circular Map View so the user sees the SnapGene warm-amber alignment band!
    setMapMode("linear");
    appendAlignedSequences(
      [alnR, alnF],
      `Aligned ${alnR.name} (←) and ${alnF.name} (→) to ${record.name}`,
    );
  };

  const toggleAlignedVisible = (id: string) => {
    app.change(
      (r) => ({
        ...r,
        alignedSequences: (r.alignedSequences ?? []).map((a) =>
          a.id === id ? { ...a, visible: !a.visible } : a,
        ),
      }),
      "Toggle Aligned Sequence Visibility",
    );
  };

  const moveSelectedAligned = (delta: -1 | 1) => {
    if (!selectedAlignedId || alignedList.length < 2) return;
    const idx = alignedList.findIndex((a) => a.id === selectedAlignedId);
    const targetIdx = idx + delta;
    if (idx < 0 || targetIdx < 0 || targetIdx >= alignedList.length) return;
    app.change(
      (r) => {
        const next = [...(r.alignedSequences ?? [])];
        const [item] = next.splice(idx, 1);
        next.splice(targetIdx, 0, item);
        return {
          ...r,
          alignedSequences: next.map((a, i) => ({ ...a, sortOrder: i })),
        };
      },
      delta < 0 ? "Move Aligned Sequence Up" : "Move Aligned Sequence Down",
    );
  };

  const removeAlignedSequence = (id: string) => {
    app.change(
      (r) => ({
        ...r,
        alignedSequences: (r.alignedSequences ?? []).filter((a) => a.id !== id),
      }),
      "Remove Aligned Sequence",
    );
    if (selectedAlignedId === id) {
      const remaining = alignedList.filter((a) => a.id !== id);
      setSelectedAlignedId(remaining[0]?.id ?? null);
    }
  };

  // ---- SnapGene Feature & Primer Operations (Duplicate, Fuse, Split, Pair Generation) ----
  const duplicateSelectedFeature = () => {
    if (doc.selectedItem?.kind !== "feature") return;
    const orig = record.features.find((f) => f.id === doc.selectedItem!.id);
    if (!orig) return;
    const dup = makeFeature({
      type: orig.type,
      name: `${orig.name} (copy)`,
      strand: orig.strand,
      segments: orig.segments.map((s) => ({ ...s })),
      qualifiers: orig.qualifiers.map((q) => ({ ...q })),
      ...(orig.color ? { color: orig.color } : {}),
    });
    app.change(
      (r) => ({ ...r, features: [...r.features, dup] }),
      "Duplicate Feature",
    );
    app.selectItem({ kind: "feature", id: dup.id });
    app.flash(`Duplicated feature as "${dup.name}"`);
  };

  const fuseSelectedFeatures = () => {
    const ids = doc.selectedFeatureIds ?? [];
    if (ids.length < 2) {
      app.flash(
        "Ctrl+click at least 2 features on the Map or Features table to fuse them.",
      );
      return;
    }
    const chosen = ids
      .map((id) => record.features.find((f) => f.id === id))
      .filter((f): f is NonNullable<typeof f> => !!f);
    if (chosen.length < 2) return;
    const first = chosen[0];
    const allSegments = chosen
      .flatMap((f) => f.segments.map((s) => ({ ...s })))
      .sort((a, b) => a.start - b.start);
    const fusedName = chosen.map((f) => f.name).join("-");
    const fused = makeFeature({
      type: first.type,
      name: fusedName,
      strand: first.strand,
      segments: allSegments,
      qualifiers: first.qualifiers.map((q) => ({ ...q })),
      ...(first.color ? { color: first.color } : {}),
    });
    const idSet = new Set(ids);
    app.change(
      (r) => ({
        ...r,
        features: [...r.features.filter((f) => !idSet.has(f.id)), fused],
      }),
      "Fuse Features",
    );
    app.selectItem({ kind: "feature", id: fused.id });
    app.flash(
      `Fused ${chosen.length} features into "${fusedName}" (${allSegments.length} segments)`,
    );
  };

  const splitSelectedFeatureAtCaret = () => {
    if (doc.selectedItem?.kind !== "feature") return;
    const feat = record.features.find((f) => f.id === doc.selectedItem!.id);
    if (!feat || feat.segments.length === 0) return;
    const seg = feat.segments[0];
    const caret = doc.selection?.caret ?? Math.floor((seg.start + seg.end) / 2);
    const splitPoint =
      caret > seg.start && caret < seg.end
        ? caret
        : Math.floor((seg.start + seg.end) / 2);
    if (splitPoint <= seg.start || splitPoint >= seg.end) {
      app.flash(
        "Place the caret inside the feature to split it into two segments.",
      );
      return;
    }
    const f1 = makeFeature({
      type: feat.type,
      name: `${feat.name} (part 1)`,
      strand: feat.strand,
      segments: [{ start: seg.start, end: splitPoint }],
      qualifiers: feat.qualifiers.map((q) => ({ ...q })),
      ...(feat.color ? { color: feat.color } : {}),
    });
    const f2 = makeFeature({
      type: feat.type,
      name: `${feat.name} (part 2)`,
      strand: feat.strand,
      segments: [{ start: splitPoint, end: seg.end }],
      qualifiers: feat.qualifiers.map((q) => ({ ...q })),
      ...(feat.color ? { color: feat.color } : {}),
    });
    app.change(
      (r) => ({
        ...r,
        features: r.features.flatMap((f) =>
          f.id === feat.id ? [f1, f2] : [f],
        ),
      }),
      "Split Feature",
    );
    app.selectItem({ kind: "feature", id: f1.id });
    app.flash(`Split "${feat.name}" at base ${splitPoint + 1}`);
  };

  const duplicateSelectedPrimer = () => {
    if (doc.selectedItem?.kind !== "primer") return;
    const orig = record.primers.find((p) => p.id === doc.selectedItem!.id);
    if (!orig) return;
    const dup = {
      id: newId("p"),
      name: `${orig.name}_copy`,
      sequence: orig.sequence,
      ...(orig.description ? { description: orig.description } : {}),
    };
    app.change((r) => addPrimer(r, dup), "Duplicate Primer");
    app.selectItem({ kind: "primer", id: dup.id });
    app.flash(`Duplicated primer as "${dup.name}"`);
  };

  const generatePrimerPairFromSelection = () => {
    if (n < 20) return;
    const targetRange =
      hasBases && doc.selection
        ? normalizeRange(doc.selection.range, n, record.topology)
        : { start: 0, end: Math.min(n, 500) };
    const regionSeq = sliceRange(record.seq, targetRange);
    if (regionSeq.length < 20) {
      app.flash(
        "Select at least 20 bp to generate Forward & Reverse PCR primers.",
        "error",
      );
      return;
    }
    const pLen = Math.min(22, Math.max(18, Math.floor(regionSeq.length / 2)));
    const fwdSeq = regionSeq.slice(0, pLen);
    const revSeq = reverseComplement(regionSeq.slice(-pLen));
    const idx = Math.floor(record.primers.length / 2) + 1;
    const pF = {
      id: newId("p"),
      name: `${record.name}_F${idx}`,
      sequence: fwdSeq,
      description: `Forward primer for ${formatRange(targetRange, n)}`,
    };
    const pR = {
      id: newId("p"),
      name: `${record.name}_R${idx}`,
      sequence: revSeq,
      description: `Reverse primer for ${formatRange(targetRange, n)}`,
    };
    app.change(
      (r) => addPrimer(addPrimer(r, pF), pR),
      "Generate Primer Pair from Selection",
    );
    app.flash(
      `Generated primer pair ${pF.name} (${fwdSeq.length} nt) & ${pR.name} (${revSeq.length} nt)`,
    );
  };

  const reverseComplementSelectionCommand = () => {
    if (!hasBases || !doc.selection) return;
    const r = normalizeRange(doc.selection.range, n, record.topology);
    const sub = sliceRange(record.seq, r);
    const rc = reverseComplement(sub);
    app.change(
      (rec) => replaceRange(rec, r, rc),
      "Reverse Complement Selection",
    );
    app.flash(
      `Reverse-complemented ${sub.length.toLocaleString("en-US")} bp (${formatRange(r, n)})`,
    );
  };

  const switchTab = (tab: SnapGeneTab) => {
    if (tab === "map") {
      setSubTab(null);
      if (doc.view === "sequence") app.setView("map");
    } else if (tab === "sequence") {
      setSubTab(null);
      app.setView("sequence");
    } else {
      setSubTab(tab);
    }
  };

  const cutSelection = async () => {
    if (!hasBases || !doc.selection) return;
    await copySelection();
    const r = normalizeRange(doc.selection.range, n, record.topology);
    app.applyEdit({ kind: "delete", range: r });
  };

  const pasteAtCaret = async () => {
    try {
      const text = await navigator.clipboard.readText();
      const clean = text.replace(/[^ACGTUacgtu]/g, "").toUpperCase();
      if (!clean) {
        app.flash(
          "Clipboard does not contain a valid DNA/RNA sequence",
          "error",
        );
        return;
      }
      if (hasBases && doc.selection) {
        const r = normalizeRange(doc.selection.range, n, record.topology);
        app.applyEdit({ kind: "replace", range: r, bases: clean });
      } else {
        const gap = doc.selection?.caret ?? 0;
        app.applyEdit({ kind: "insert", gap, bases: clean });
      }
    } catch {
      app.flash("Paste with Ctrl+V / ⌘V inside the Sequence view", "info");
    }
  };

  const canUndo = undoLabel(doc) !== null;
  const canRedo = redoLabel(doc) !== null;
  const enzymeSetName =
    ENZYME_DISPLAY_NAMES[settings.enzymeDisplay] ?? "Unique 6+ Cutters";

  // Unique enzymes summary for the Enzymes tab
  const enzymeTableRows = useMemo(() => {
    const byName = new Map<
      string,
      { name: string; cuts: number[]; sites: EnzymeSite[] }
    >();
    for (const s of enzymeSites) {
      const entry = byName.get(s.enzyme) ?? {
        name: s.enzyme,
        cuts: [],
        sites: [],
      };
      for (const c of s.cuts) entry.cuts.push(c.top <= 0 ? n : c.top);
      entry.sites.push(s);
      byName.set(s.enzyme, entry);
    }
    const q = tableFilter.trim().toLowerCase();
    return [...byName.values()]
      .filter((r) => !q || r.name.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [enzymeSites, n, tableFilter]);

  return (
    <TooltipProvider>
      <div className={styles.window} data-tauri-drag-region="deep">
        {/* =====================================================================
            ROW 1: SnapGene Top Menu Bar
            File | Edit | View | Enzymes | Features | Primers | Actions | Tools | Window | Help
           ===================================================================== */}
        <header
          className={styles.menuBar}
          role="menubar"
          aria-label="Application menu"
        >
          <span className={styles.appBadge}>HHereditas</span>

          {/* FILE MENU */}
          <Menu modal={false}>
            <MenuTrigger asChild>
              <button type="button" className={styles.menuTrigger}>
                File
              </button>
            </MenuTrigger>
            <MenuContent align="start">
              <MenuItem
                icon={<FilePlus />}
                shortcut="Mod+N"
                onSelect={() => app.openSheet("new-sequence")}
              >
                New DNA / RNA File…
              </MenuItem>
              <MenuItem
                icon={<FolderOpen />}
                shortcut="Mod+O"
                onSelect={() => void openWithDialog()}
              >
                Open…
              </MenuItem>
              <MenuSub>
                <MenuSubTrigger icon={<FolderOpen />}>
                  Open Sample Plasmid
                </MenuSubTrigger>
                <MenuSubContent>
                  {SAMPLES.map((s) => (
                    <MenuItem
                      key={s.id}
                      onSelect={() =>
                        openFiles(
                          [
                            {
                              name: s.fileName,
                              path: null,
                              data: new TextEncoder().encode(s.text),
                            },
                          ],
                          {
                            name: s.name,
                          },
                        )
                      }
                    >
                      {s.name} ({formatInt(s.length)} bp)
                    </MenuItem>
                  ))}
                </MenuSubContent>
              </MenuSub>
              <MenuSub>
                <MenuSubTrigger icon={<FilePlus />}>Import</MenuSubTrigger>
                <MenuSubContent>
                  <MenuItem onSelect={() => alignFileInputRef.current?.click()}>
                    Align Imported Sequences / Sanger Traces…
                  </MenuItem>
                  <MenuItem
                    onSelect={() => app.openSheet("clone-anneal-oligos")}
                  >
                    Anneal Oligonucleotides…
                  </MenuItem>
                  <MenuItem onSelect={() => app.openSheet("codon-optimize")}>
                    Back-Translate Protein Sequence…
                  </MenuItem>
                </MenuSubContent>
              </MenuSub>
              <MenuSeparator />
              <MenuItem
                icon={<Save />}
                shortcut="Mod+S"
                onSelect={() => void saveDocument()}
              >
                Save
              </MenuItem>
              <MenuItem
                shortcut="Shift+Mod+S"
                onSelect={() => void saveDocument(undefined, true)}
              >
                Save As…
              </MenuItem>
              <MenuSub>
                <MenuSubTrigger icon={<Save />}>Export Sequence</MenuSubTrigger>
                <MenuSubContent>
                  <MenuItem
                    onSelect={() =>
                      app.openSheet("save-as", {
                        defaultName: record.name,
                        format: "snapgene",
                      })
                    }
                  >
                    SnapGene DNA (.dna)…
                  </MenuItem>
                  <MenuItem
                    onSelect={() =>
                      app.openSheet("save-as", {
                        defaultName: record.name,
                        format: "genbank",
                      })
                    }
                  >
                    GenBank (.gb / .gbk)…
                  </MenuItem>
                  <MenuItem
                    onSelect={() =>
                      app.openSheet("save-as", {
                        defaultName: record.name,
                        format: "fasta",
                      })
                    }
                  >
                    FASTA (.fa / .fasta)…
                  </MenuItem>
                </MenuSubContent>
              </MenuSub>
              <MenuSeparator />
              <MenuItem
                icon={<Info />}
                onSelect={() =>
                  app.openSheet("sequence-properties", {
                    propertiesTab: "properties",
                  })
                }
              >
                Sequence Properties &amp; Methylation…
              </MenuItem>
              <MenuItem icon={<Printer />} onSelect={() => window.print()}>
                Print…
              </MenuItem>
              <MenuSeparator />
              <MenuItem
                icon={<X />}
                shortcut="Mod+W"
                onSelect={() => requestClose()}
              >
                Close
              </MenuItem>
            </MenuContent>
          </Menu>

          {/* EDIT MENU */}
          <Menu modal={false}>
            <MenuTrigger asChild>
              <button type="button" className={styles.menuTrigger}>
                Edit
              </button>
            </MenuTrigger>
            <MenuContent align="start">
              <MenuItem
                icon={<Undo2 />}
                shortcut="Mod+Z"
                disabled={!canUndo}
                onSelect={() => app.undo()}
              >
                {undoLabel(doc) ? `Undo ${undoLabel(doc)}` : "Undo"}
              </MenuItem>
              <MenuItem
                icon={<Redo2 />}
                shortcut="Shift+Mod+Z"
                disabled={!canRedo}
                onSelect={() => app.redo()}
              >
                {redoLabel(doc) ? `Redo ${redoLabel(doc)}` : "Redo"}
              </MenuItem>
              <MenuSeparator />
              <MenuItem
                icon={<Scissors />}
                shortcut="Mod+X"
                disabled={!hasBases}
                onSelect={() => void cutSelection()}
              >
                Cut
              </MenuItem>
              <MenuItem
                icon={<Copy />}
                shortcut="Mod+C"
                disabled={!hasBases}
                onSelect={() => void copySelection()}
              >
                Copy Top Strand (5′→3′)
              </MenuItem>
              <MenuSub>
                <MenuSubTrigger icon={<Copy />}>Copy Special</MenuSubTrigger>
                <MenuSubContent>
                  <MenuItem
                    disabled={!hasBases}
                    onSelect={() => {
                      const txt = selectedText(doc);
                      if (txt) {
                        void navigator.clipboard.writeText(
                          reverseComplement(txt),
                        );
                        app.flash(
                          `Copied bottom strand (${txt.length.toLocaleString("en-US")} bp reverse complement)`,
                        );
                      }
                    }}
                  >
                    Copy Bottom Strand (5′→3′ Reverse Complement)
                  </MenuItem>
                  <MenuItem
                    disabled={!hasBases}
                    onSelect={() => {
                      const txt = selectedText(doc);
                      if (txt && txt.length >= 3) {
                        try {
                          const aa = translate(txt, { cds: false });
                          void navigator.clipboard.writeText(aa);
                          app.flash(
                            `Copied ${aa.length} amino acids to clipboard`,
                          );
                        } catch {
                          app.flash("Could not translate selection", "error");
                        }
                      }
                    }}
                  >
                    Copy Amino Acid Translation
                  </MenuItem>
                  <MenuItem
                    onSelect={() => {
                      void navigator.clipboard.writeText(record.seq);
                      app.flash(
                        `Copied entire sequence (${record.seq.length.toLocaleString("en-US")} bp)`,
                      );
                    }}
                  >
                    Copy Entire Sequence ({formatInt(n)} bp)
                  </MenuItem>
                </MenuSubContent>
              </MenuSub>
              <MenuItem
                icon={<ClipboardPaste />}
                shortcut="Mod+V"
                onSelect={() => void pasteAtCaret()}
              >
                Paste
              </MenuItem>
              <MenuSeparator />
              <MenuItem
                shortcut="Mod+A"
                disabled={n === 0}
                onSelect={() => {
                  app.setSelection(
                    selectRange({ start: 0, end: n }, n, record.topology),
                  );
                  app.flash(`Selected all ${formatInt(n)} bp`);
                }}
              >
                Select All ({formatInt(n)} bp)
              </MenuItem>
              <MenuItem
                shortcut="Mod+G"
                onSelect={() => app.openSheet("goto-position")}
              >
                Select Range / Go to Position…
              </MenuItem>
              <MenuSeparator />
              <MenuItem
                disabled={!hasBases}
                onSelect={() => reverseComplementSelectionCommand()}
              >
                Reverse Complement Selection
              </MenuItem>
              <MenuItem
                onSelect={() => {
                  app.change(
                    (r) => reverseComplementRecord(r),
                    "Flip Sequence",
                  );
                  app.flash(
                    `Flipped entire sequence ${record.name} (reverse complement)`,
                  );
                }}
              >
                Flip Sequence (Reverse Complement Molecule)
              </MenuItem>
              <MenuItem
                disabled={record.topology !== "circular"}
                onSelect={() =>
                  app.openSheet("sequence-properties", {
                    propertiesTab: "origin",
                  })
                }
              >
                Set Origin (Rotate Circular Origin)…
              </MenuItem>
              <MenuItem
                onSelect={() => {
                  const nextTop =
                    record.topology === "circular" ? "linear" : "circular";
                  app.change(
                    (r) => setTopology(r, nextTop),
                    `Make ${nextTop === "circular" ? "Circular" : "Linear"}`,
                  );
                  app.flash(`Changed topology of ${record.name} to ${nextTop}`);
                }}
              >
                {record.topology === "circular"
                  ? "Convert to Linear Sequence"
                  : "Circularize Sequence"}
              </MenuItem>
              <MenuItem
                onSelect={() =>
                  app.openSheet("sequence-properties", {
                    propertiesTab: "methylation",
                  })
                }
              >
                Change Methylation &amp; Sticky Ends…
              </MenuItem>
              <MenuSeparator />
              <MenuItem
                disabled={!hasBases}
                onSelect={() => openSelectionAsDocument()}
              >
                Extract Selection to New File
              </MenuItem>
              <MenuItem
                icon={<Search />}
                shortcut="Mod+F"
                onSelect={() => {
                  setSearchOpen(true);
                  setTimeout(() => searchRef.current?.focus(), 20);
                }}
              >
                Find Sequence…
              </MenuItem>
            </MenuContent>
          </Menu>

          {/* VIEW MENU */}
          <Menu modal={false}>
            <MenuTrigger asChild>
              <button type="button" className={styles.menuTrigger}>
                View
              </button>
            </MenuTrigger>
            <MenuContent align="start">
              <MenuItem
                shortcut="Mod+1"
                disabled={alignActive}
                onSelect={() => {
                  switchTab("map");
                  setMapMode("circular");
                }}
              >
                Map — Circular View
              </MenuItem>
              <MenuItem
                onSelect={() => {
                  switchTab("map");
                  setMapMode("linear");
                }}
              >
                Map — Linear View
              </MenuItem>
              <MenuItem shortcut="Mod+2" onSelect={() => switchTab("sequence")}>
                Sequence View
              </MenuItem>
              <MenuItem
                shortcut="Mod+3"
                onSelect={() => {
                  setSubTab(null);
                  app.setView(doc.view === "split" ? "map" : "split");
                }}
              >
                {doc.view === "split" && !subTab
                  ? "Hide Split (Map + Sequence)"
                  : "Split View (Map + Sequence)"}
              </MenuItem>
              <MenuSeparator />
              <MenuItem onSelect={() => switchTab("enzymes")}>
                Enzymes View ({enzymeTableRows.length})
              </MenuItem>
              <MenuItem onSelect={() => switchTab("features")}>
                Features View ({shownDoc.record.features.length})
              </MenuItem>
              <MenuItem onSelect={() => switchTab("primers")}>
                Primers View ({record.primers.length})
              </MenuItem>
              <MenuItem onSelect={() => switchTab("history")}>
                History View
              </MenuItem>
              <MenuSeparator />
              <MenuCheckboxItem
                checked={leftPanelOpen && leftPanelMode === "align"}
                onCheckedChange={(checked) => {
                  setLeftPanelOpen(checked);
                  if (checked) {
                    setLeftPanelMode("align");
                    setShowAlignmentsLayer(true);
                  }
                }}
              >
                Show Aligned Sequences Panel (Align with:)
              </MenuCheckboxItem>
              <MenuCheckboxItem
                checked={leftPanelOpen}
                onCheckedChange={setLeftPanelOpen}
              >
                Show Side Panel
              </MenuCheckboxItem>
              <MenuCheckboxItem
                checked={rightInfoOpen}
                onCheckedChange={setRightInfoOpen}
              >
                Show Info Inspector
              </MenuCheckboxItem>
              <MenuSeparator />
              <MenuCheckboxItem
                checked={showLengthsLayer}
                onCheckedChange={setShowLengthsLayer}
              >
                Show Feature &amp; Primer Lengths (bp)
              </MenuCheckboxItem>
              <MenuCheckboxItem
                checked={showPrimerLocationsLayer}
                onCheckedChange={setShowPrimerLocationsLayer}
              >
                Show Primer Locations (start .. end)
              </MenuCheckboxItem>
              <MenuCheckboxItem
                checked={showTranslationsLayer}
                onCheckedChange={setShowTranslationsLayer}
              >
                Show Protein Translations
              </MenuCheckboxItem>
              <MenuCheckboxItem
                checked={showComplementLayer}
                onCheckedChange={setShowComplementLayer}
              >
                Show Complement Strand
              </MenuCheckboxItem>
              <MenuCheckboxItem
                checked={showNumberingLayer}
                onCheckedChange={setShowNumberingLayer}
              >
                Show Base Numbering
              </MenuCheckboxItem>
            </MenuContent>
          </Menu>

          {/* ENZYMES MENU */}
          <Menu modal={false}>
            <MenuTrigger asChild>
              <button type="button" className={styles.menuTrigger}>
                Enzymes
              </button>
            </MenuTrigger>
            <MenuContent align="start">
              <MenuLabel>Enzyme Set</MenuLabel>
              <MenuRadioGroup
                value={settings.enzymeDisplay}
                onValueChange={(v) =>
                  settings.update({ enzymeDisplay: v as EnzymeDisplay })
                }
              >
                {ENZYME_DISPLAY_CHOICES.map((d) => (
                  <MenuRadioItem key={d} value={d}>
                    {ENZYME_DISPLAY_NAMES[d]}
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
              <MenuSeparator />
              <MenuItem
                shortcut="Mod+E"
                onSelect={() => app.openSheet("choose-enzymes")}
              >
                Choose Enzymes…
              </MenuItem>
              <MenuCheckboxItem
                checked={showEnzymesLayer}
                onCheckedChange={setShowEnzymesLayer}
              >
                Show Enzymes on Map &amp; Sequence
              </MenuCheckboxItem>
              <MenuItem
                onSelect={() =>
                  app.openSheet("sequence-properties", {
                    propertiesTab: "methylation",
                  })
                }
              >
                Dam / Dcm / EcoKI Methylation Settings…
              </MenuItem>
              <MenuSeparator />
              <MenuItem
                icon={<AlignVerticalSpaceAround />}
                shortcut="Mod+D"
                onSelect={() => app.openSheet("digest")}
              >
                Restriction Digest / Agarose Gel…
              </MenuItem>
            </MenuContent>
          </Menu>

          {/* FEATURES MENU */}
          <Menu modal={false}>
            <MenuTrigger asChild>
              <button type="button" className={styles.menuTrigger}>
                Features
              </button>
            </MenuTrigger>
            <MenuContent align="start">
              <MenuItem
                icon={<Tag />}
                onSelect={() => app.openSheet("add-feature")}
              >
                Add Feature…
              </MenuItem>
              <MenuItem
                icon={<Pencil />}
                disabled={doc.selectedItem?.kind !== "feature"}
                onSelect={() => {
                  if (doc.selectedItem?.kind === "feature") {
                    app.openSheet("edit-feature", {
                      featureId: doc.selectedItem.id,
                    });
                  }
                }}
              >
                Edit Feature…
              </MenuItem>
              <MenuItem
                icon={<Copy />}
                disabled={doc.selectedItem?.kind !== "feature"}
                onSelect={() => duplicateSelectedFeature()}
              >
                Duplicate Feature
              </MenuItem>
              <MenuItem
                icon={<Trash2 />}
                disabled={doc.selectedItem?.kind !== "feature"}
                onSelect={() => {
                  if (doc.selectedItem?.kind === "feature") {
                    deleteFeatureCommand(doc.selectedItem.id);
                  }
                }}
              >
                Delete Feature
              </MenuItem>
              <MenuSeparator />
              <MenuItem
                icon={<Combine />}
                disabled={(doc.selectedFeatureIds?.length ?? 0) < 2}
                onSelect={() => fuseSelectedFeatures()}
              >
                Fuse Features{" "}
                {(doc.selectedFeatureIds?.length ?? 0) >= 2
                  ? `(${doc.selectedFeatureIds!.length})`
                  : ""}
                …
              </MenuItem>
              <MenuItem
                icon={<Scissors />}
                disabled={doc.selectedItem?.kind !== "feature"}
                onSelect={() => splitSelectedFeatureAtCaret()}
              >
                Split Feature at Caret
              </MenuItem>
              {(doc.selectedFeatureIds?.length ?? 0) >= 2 ? (
                <MenuItem
                  icon={<Combine />}
                  onSelect={() =>
                    app.openSheet("clone-gibson", {
                      featureIds: [...(doc.selectedFeatureIds ?? [])],
                    })
                  }
                >
                  Gibson Calculation ({doc.selectedFeatureIds!.length} selected
                  features)…
                </MenuItem>
              ) : null}
              <MenuSeparator />
              <MenuItem
                icon={<Sparkles />}
                onSelect={() => detectCommonFeaturesCommand()}
              >
                Detect Common Features…
              </MenuItem>
              <MenuSeparator />
              <MenuCheckboxItem
                checked={showFeaturesLayer}
                onCheckedChange={setShowFeaturesLayer}
              >
                Show Features
              </MenuCheckboxItem>
              <MenuCheckboxItem
                checked={showTranslationsLayer}
                onCheckedChange={setShowTranslationsLayer}
              >
                Show CDS Translations
              </MenuCheckboxItem>
              <MenuCheckboxItem
                checked={showLengthsLayer}
                onCheckedChange={setShowLengthsLayer}
              >
                Show Feature Lengths (bp)
              </MenuCheckboxItem>
              <MenuSeparator />
              <MenuItem onSelect={() => switchTab("features")}>
                View All Features ({shownDoc.record.features.length})
              </MenuItem>
            </MenuContent>
          </Menu>

          {/* PRIMERS MENU */}
          <Menu modal={false}>
            <MenuTrigger asChild>
              <button type="button" className={styles.menuTrigger}>
                Primers
              </button>
            </MenuTrigger>
            <MenuContent align="start">
              <MenuItem
                icon={<ArrowRightToLine />}
                onSelect={() => app.openSheet("add-primer", { direction: 1 })}
              >
                Add Primer (Top Strand)…
              </MenuItem>
              <MenuItem
                onSelect={() => app.openSheet("add-primer", { direction: -1 })}
              >
                Add Primer (Bottom Strand)…
              </MenuItem>
              <MenuItem
                icon={<Sparkles />}
                onSelect={() => generatePrimerPairFromSelection()}
              >
                Add Primers from Selection (Fwd &amp; Rev Pair)
              </MenuItem>
              <MenuSeparator />
              <MenuItem
                icon={<Pencil />}
                disabled={doc.selectedItem?.kind !== "primer"}
                onSelect={() => {
                  if (doc.selectedItem?.kind === "primer") {
                    app.openSheet("edit-primer", {
                      primerId: doc.selectedItem.id,
                    });
                  }
                }}
              >
                Edit Primer…
              </MenuItem>
              <MenuItem
                icon={<Copy />}
                disabled={doc.selectedItem?.kind !== "primer"}
                onSelect={() => duplicateSelectedPrimer()}
              >
                Duplicate Primer
              </MenuItem>
              <MenuItem
                icon={<Trash2 />}
                disabled={doc.selectedItem?.kind !== "primer"}
                onSelect={() => {
                  if (doc.selectedItem?.kind === "primer") {
                    deletePrimerCommand(doc.selectedItem.id);
                  }
                }}
              >
                Delete Primer
              </MenuItem>
              <MenuSeparator />
              <MenuCheckboxItem
                checked={showPrimersLayer}
                onCheckedChange={setShowPrimersLayer}
              >
                Show Primers
              </MenuCheckboxItem>
              <MenuCheckboxItem
                checked={showPrimerLocationsLayer}
                onCheckedChange={setShowPrimerLocationsLayer}
              >
                Show Primer Locations (start .. end)
              </MenuCheckboxItem>
              <MenuSeparator />
              <MenuItem onSelect={() => switchTab("primers")}>
                View All Primers ({record.primers.length})
              </MenuItem>
            </MenuContent>
          </Menu>

          {/* ACTIONS MENU */}
          <Menu modal={false}>
            <MenuTrigger asChild>
              <button type="button" className={styles.menuTrigger}>
                Actions
              </button>
            </MenuTrigger>
            <MenuContent align="start">
              <MenuLabel>Cloning &amp; Assembly</MenuLabel>
              <MenuItem onSelect={() => app.openSheet("clone-restriction")}>
                Restriction and Insertion Cloning…
              </MenuItem>
              <MenuItem onSelect={() => app.openSheet("clone-gibson")}>
                Gibson Assembly…
              </MenuItem>
              <MenuItem onSelect={() => app.openSheet("clone-golden-gate")}>
                Golden Gate Assembly…
              </MenuItem>
              <MenuItem onSelect={() => app.openSheet("clone-infusion")}>
                In-Fusion Cloning…
              </MenuItem>
              <MenuItem onSelect={() => app.openSheet("clone-topo")}>
                TOPO / TA Cloning…
              </MenuItem>
              <MenuSeparator />
              <MenuLabel>PCR &amp; Oligonucleotides</MenuLabel>
              <MenuItem onSelect={() => app.openSheet("clone-pcr")}>
                PCR…
              </MenuItem>
              <MenuItem onSelect={() => app.openSheet("clone-mutagenesis")}>
                Site-Directed Mutagenesis…
              </MenuItem>
              <MenuItem onSelect={() => app.openSheet("clone-anneal-oligos")}>
                Anneal Oligos…
              </MenuItem>
              <MenuSeparator />
              <MenuItem
                icon={<AlignVerticalSpaceAround />}
                shortcut="Mod+D"
                onSelect={() => app.openSheet("digest")}
              >
                Simulate Agarose Gel…
              </MenuItem>
              <MenuSeparator />
              <MenuItem
                onSelect={() => {
                  app.change(
                    (r) => reverseComplementRecord(r),
                    "Flip Sequence",
                  );
                  app.flash(`Flipped sequence ${record.name}`);
                }}
              >
                Flip Sequence (Reverse Complement)
              </MenuItem>
              <MenuItem
                disabled={record.topology !== "circular"}
                onSelect={() =>
                  app.openSheet("sequence-properties", {
                    propertiesTab: "origin",
                  })
                }
              >
                Set Origin…
              </MenuItem>
            </MenuContent>
          </Menu>

          {/* TOOLS MENU */}
          <Menu modal={false}>
            <MenuTrigger asChild>
              <button type="button" className={styles.menuTrigger}>
                Tools
              </button>
            </MenuTrigger>
            <MenuContent align="start">
              <MenuItem
                icon={<GitCompareArrows />}
                onSelect={() => {
                  setLeftPanelOpen(true);
                  setLeftPanelMode("align");
                  setShowAlignmentsLayer(true);
                }}
              >
                Align to Reference Sequence (Align with:)…
              </MenuItem>
              <MenuItem
                icon={<Sparkles />}
                onSelect={() => handleSimulateSequencingReads()}
              >
                Simulate Forward &amp; Reverse Sequencing Reads
              </MenuItem>
              <MenuSeparator />
              <MenuItem onSelect={() => app.openSheet("codon-optimize")}>
                Back-Translate / Codon Optimization…
              </MenuItem>
              <MenuCheckboxItem
                checked={settings.showOrfs}
                onCheckedChange={(v) => settings.update({ showOrfs: v })}
              >
                Show Open Reading Frames (ORFs)
              </MenuCheckboxItem>
              <MenuItem
                icon={<Sparkles />}
                onSelect={() => detectCommonFeaturesCommand()}
              >
                Auto-Annotate Common Features
              </MenuItem>
              <MenuSeparator />
              <MenuItem
                shortcut="Mod+G"
                onSelect={() => app.openSheet("goto-position")}
              >
                Go to Position / Select Range…
              </MenuItem>
              <MenuItem
                onSelect={() =>
                  app.openSheet("sequence-properties", {
                    propertiesTab: "properties",
                  })
                }
              >
                Sequence Properties &amp; Statistics…
              </MenuItem>
              <MenuItem
                icon={<Search />}
                shortcut="Mod+F"
                onSelect={() => {
                  setSearchOpen(true);
                  setTimeout(() => searchRef.current?.focus(), 20);
                }}
              >
                Find DNA Sequence…
              </MenuItem>
            </MenuContent>
          </Menu>

          {/* WINDOW MENU */}
          <Menu modal={false}>
            <MenuTrigger asChild>
              <button type="button" className={styles.menuTrigger}>
                Window
              </button>
            </MenuTrigger>
            <MenuContent align="start">
              <MenuLabel>Open Documents</MenuLabel>
              {documents.map((d) => (
                <MenuItem key={d.id} onSelect={() => app.activate(d.id)}>
                  {d.name} ({formatInt(d.length)} bp)
                </MenuItem>
              ))}
            </MenuContent>
          </Menu>

          {/* HELP MENU */}
          <Menu modal={false}>
            <MenuTrigger asChild>
              <button type="button" className={styles.menuTrigger}>
                Help
              </button>
            </MenuTrigger>
            <MenuContent align="start">
              <MenuItem
                onSelect={() =>
                  app.flash(
                    "HHereditas — SnapGene-compatible Molecular Biology Suite",
                  )
                }
              >
                About HHereditas
              </MenuItem>
            </MenuContent>
          </Menu>
        </header>

        {/* =====================================================================
            ROW 2: SnapGene Document Tab Strip
            [◧] [📁] | [🧬 TALED_Right... ×] [+]
           ===================================================================== */}
        <div className={styles.tabStrip}>
          <Tooltip
            content={leftPanelOpen ? "Hide Side Panel" : "Show Side Panel"}
          >
            <button
              type="button"
              className={cx(
                styles.stripIconBtn,
                leftPanelOpen && styles.stripIconBtnActive,
              )}
              aria-label="Toggle Side Panel"
              onClick={() => setLeftPanelOpen((v) => !v)}
            >
              <PanelLeft />
            </button>
          </Tooltip>
          <Tooltip content="Open File… (Ctrl+O)">
            <button
              type="button"
              className={styles.stripIconBtn}
              aria-label="Open File"
              onClick={() => void openWithDialog()}
            >
              <FolderOpen />
            </button>
          </Tooltip>

          <div
            className={styles.docTabs}
            role="tablist"
            aria-label="Open documents"
          >
            {documents.map((d) => {
              const active = d.id === doc.id;
              return (
                <div
                  key={d.id}
                  role="tab"
                  aria-selected={active}
                  className={cx(styles.docTab, active && styles.docTabActive)}
                  onClick={() => app.activate(d.id)}
                >
                  <span className={styles.docTabBadge}>
                    {d.topology === "circular" ? "◯" : "━"}
                  </span>
                  <span className={styles.docTabName}>{d.name}</span>
                  {d.edited ? (
                    <span
                      className={styles.docTabDirty}
                      title="Unsaved changes"
                    />
                  ) : null}
                  <button
                    type="button"
                    className={styles.docTabClose}
                    aria-label={`Close ${d.name}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      requestClose(d.id);
                    }}
                  >
                    <X />
                  </button>
                </div>
              );
            })}
            <Tooltip content="New Sequence… (Ctrl+N)">
              <button
                type="button"
                className={styles.newTabBtn}
                aria-label="New Sequence"
                onClick={() => app.openSheet("new-sequence")}
              >
                <Plus />
              </button>
            </Tooltip>
          </div>
        </div>

        {/* =====================================================================
            ROW 3: SnapGene Icon-Over-Text Action Toolbar
            Save | Undo | Redo | Cut | Copy | Paste | Print  ||  Detect | Clone | Gel  ...  <Name>.dna (N bp) | Info
           ===================================================================== */}
        <div
          className={styles.actionToolbar}
          role="toolbar"
          aria-label="Document actions"
        >
          <button
            type="button"
            className={styles.toolBtn}
            onClick={() => void saveDocument()}
          >
            <Save />
            <span className={styles.toolBtnLabel}>
              Save <ChevronDown />
            </span>
          </button>
          <button
            type="button"
            className={styles.toolBtn}
            disabled={!canUndo}
            onClick={() => app.undo()}
          >
            <Undo2 />
            <span className={styles.toolBtnLabel}>Undo</span>
          </button>
          <button
            type="button"
            className={styles.toolBtn}
            disabled={!canRedo}
            onClick={() => app.redo()}
          >
            <Redo2 />
            <span className={styles.toolBtnLabel}>Redo</span>
          </button>
          <button
            type="button"
            className={styles.toolBtn}
            disabled={!hasBases}
            onClick={() => void cutSelection()}
          >
            <Scissors />
            <span className={styles.toolBtnLabel}>Cut</span>
          </button>
          <button
            type="button"
            className={styles.toolBtn}
            disabled={!hasBases}
            onClick={() => void copySelection()}
          >
            <Copy />
            <span className={styles.toolBtnLabel}>
              Copy <ChevronDown />
            </span>
          </button>
          <button
            type="button"
            className={styles.toolBtn}
            onClick={() => void pasteAtCaret()}
          >
            <ClipboardPaste />
            <span className={styles.toolBtnLabel}>Paste</span>
          </button>
          <button
            type="button"
            className={styles.toolBtn}
            onClick={() => window.print()}
          >
            <Printer />
            <span className={styles.toolBtnLabel}>Print</span>
          </button>

          <span className={styles.toolbarDivider} aria-hidden />

          {/* HHereditas Quick Molecular Biology Buttons */}
          <Tooltip content="Auto-detect SnapGene common features, tags &amp; protease sites">
            <button
              type="button"
              className={styles.toolBtn}
              onClick={() => detectCommonFeaturesCommand()}
            >
              <Sparkles />
              <span className={styles.toolBtnLabel}>Detect</span>
            </button>
          </Tooltip>

          <Menu modal={false}>
            <MenuTrigger asChild>
              <button type="button" className={styles.toolBtn}>
                <Combine />
                <span className={styles.toolBtnLabel}>
                  Clone <ChevronDown />
                </span>
              </button>
            </MenuTrigger>
            <MenuContent align="start">
              <MenuItem onSelect={() => app.openSheet("clone-restriction")}>
                Restriction Cloning…
              </MenuItem>
              <MenuItem onSelect={() => app.openSheet("clone-gibson")}>
                Gibson Assembly…
              </MenuItem>
              <MenuItem onSelect={() => app.openSheet("clone-golden-gate")}>
                Golden Gate Assembly…
              </MenuItem>
              <MenuItem onSelect={() => app.openSheet("clone-infusion")}>
                In-Fusion Cloning…
              </MenuItem>
              <MenuItem onSelect={() => app.openSheet("clone-topo")}>
                TOPO / TA Cloning…
              </MenuItem>
              <MenuSeparator />
              <MenuItem onSelect={() => app.openSheet("clone-pcr")}>
                PCR…
              </MenuItem>
              <MenuItem onSelect={() => app.openSheet("clone-mutagenesis")}>
                Site-Directed Mutagenesis…
              </MenuItem>
              <MenuItem onSelect={() => app.openSheet("clone-anneal-oligos")}>
                Anneal Oligos…
              </MenuItem>
            </MenuContent>
          </Menu>

          <Tooltip content="Simulate Restriction Digest &amp; Agarose Gel">
            <button
              type="button"
              className={styles.toolBtn}
              onClick={() => app.openSheet("digest")}
            >
              <AlignVerticalSpaceAround />
              <span className={styles.toolBtnLabel}>Gel</span>
            </button>
          </Tooltip>

          <div className={styles.toolbarRight}>
            <div className={styles.docHeaderTitle}>
              <span className={styles.docHeaderName}>
                {doc.fileName ?? `${record.name}.dna`}
              </span>
              <span className={styles.docHeaderLength}>
                ({formatInt(n)} bp)
              </span>
            </div>
            <Tooltip
              content={
                rightInfoOpen
                  ? "Hide Sequence Info &amp; Inspector"
                  : "Show Sequence Info &amp; Inspector"
              }
            >
              <button
                type="button"
                className={cx(
                  styles.toolBtn,
                  rightInfoOpen && styles.toolBtnActive,
                )}
                onClick={() => setRightInfoOpen((v) => !v)}
              >
                <Info />
                <span className={styles.toolBtnLabel}>Info</span>
              </button>
            </Tooltip>
          </div>
        </div>

        {/* =====================================================================
            MAIN WORKSPACE BODY:
            Optional Left Side Panel + Full-Width White Canvas + Optional Right Info Panel
           ===================================================================== */}
        <div ref={alignSplitRef} className={styles.workspaceColumn}>
        <div
          className={styles.workspaceBody}
          style={
            traceShown
              ? {
                  flex:
                    traceRatio === null
                      ? `0 0 ${Math.max(TRACE_TOP_MIN, traceTopHeight + TRACE_TOP_SCROLLBAR)}px`
                      : `0 0 ${(1 - traceRatio) * 100}%`,
                }
              : undefined
          }
        >
          <input
            ref={alignFileInputRef}
            type="file"
            multiple
            accept=".dna,.fa,.fasta,.fna,.gb,.gbk,.genbank,.scf,.ab1,.seq,.txt"
            style={{ display: "none" }}
            onChange={(e) => void handleAlignFilesPicked(e)}
          />
          {leftPanelState !== "closed" ? (
            <aside
              className={cx(
                styles.leftSidePanel,
                leftPanelState === "opening" &&
                  (mapPanelAnimation
                    ? styles.leftSidePanelGrow
                    : styles.leftSidePanelEnter),
                leftPanelState === "closing" &&
                  (mapPanelAnimation
                    ? styles.leftSidePanelShrink
                    : styles.leftSidePanelClosing),
              )}
              style={
                {
                  flexBasis: leftPanelWidth,
                  "--panel-w": `${leftPanelWidth}px`,
                } as CSSProperties
              }
              aria-label="Annotations and aligned sequences"
            >
              <div
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize side panel"
                className={styles.leftSidePanelResize}
                onPointerDown={onLeftPanelResizePointerDown}
              />
              {leftPanelMode === "align" ? (
                <>
                  {/* SnapGene "Align with:" Header (Screenshot 3!) */}
                  <div className={styles.alignPanelHeader}>
                    <span className={styles.alignPanelTitle}>Align with:</span>
                    <div className={styles.alignPanelHeaderActions}>
                      <Menu modal={false}>
                        <MenuTrigger asChild>
                          <button
                            type="button"
                            className={styles.alignHeaderBtn}
                            aria-label="Add Sequences to Align"
                            title="Add sequences or trace files to align"
                          >
                            <Plus />
                          </button>
                        </MenuTrigger>
                        <MenuContent align="start">
                          <MenuLabel>
                            Align Sequences to {record.name}
                          </MenuLabel>
                          <MenuItem
                            icon={<FolderOpen />}
                            onSelect={() => alignFileInputRef.current?.click()}
                          >
                            Align Imported Sequences / Traces… (.dna, .fa, .gb,
                            .scf, .ab1)
                          </MenuItem>
                          {documents.filter((d) => d.id !== doc.id).length >
                          0 ? (
                            <MenuSub>
                              <MenuSubTrigger icon={<FilePlus />}>
                                Align Open Document
                              </MenuSubTrigger>
                              <MenuSubContent>
                                {documents
                                  .filter((d) => d.id !== doc.id)
                                  .map((d) => (
                                    <MenuItem
                                      key={d.id}
                                      onSelect={() =>
                                        handleAlignOpenDocument(d.id)
                                      }
                                    >
                                      {d.name} ({formatInt(d.length)} bp)
                                    </MenuItem>
                                  ))}
                              </MenuSubContent>
                            </MenuSub>
                          ) : null}
                          <MenuItem
                            icon={<ClipboardPaste />}
                            onSelect={() => setPasteAlignOpen(true)}
                          >
                            Paste Sequence to Align…
                          </MenuItem>
                          <MenuSeparator />
                          <MenuItem
                            icon={<Sparkles />}
                            onSelect={() => handleSimulateSequencingReads()}
                          >
                            Simulate Forward &amp; Reverse Sequencing Reads
                          </MenuItem>
                        </MenuContent>
                      </Menu>
                      <button
                        type="button"
                        className={styles.alignHeaderBtn}
                        aria-label="Close Align Panel"
                        onClick={() => setLeftPanelOpen(false)}
                      >
                        <X />
                      </button>
                    </div>
                  </div>

                  {/* Optional inline Paste Sequence form */}
                  {pasteAlignOpen ? (
                    <div className={styles.pasteAlignBox}>
                      <input
                        type="text"
                        className={styles.pasteAlignInput}
                        placeholder="Read name (e.g. SYFP2_CAT_F)"
                        value={pasteAlignName}
                        onChange={(e) => setPasteAlignName(e.target.value)}
                      />
                      <textarea
                        className={styles.pasteAlignTextarea}
                        rows={3}
                        placeholder="Paste DNA sequence (5' -> 3')…"
                        value={pasteAlignSeq}
                        onChange={(e) => setPasteAlignSeq(e.target.value)}
                      />
                      <div className={styles.pasteAlignActions}>
                        <Button
                          size="sm"
                          onClick={() => setPasteAlignOpen(false)}
                        >
                          Cancel
                        </Button>
                        <Button
                          size="sm"
                          variant="primary"
                          onClick={handleAlignPastedSequence}
                        >
                          Align
                        </Button>
                      </div>
                    </div>
                  ) : null}

                  {/* Aligned Sequence Checkbox List (Screenshot 3!) */}
                  <div
                    className={styles.alignSeqList}
                    role="listbox"
                    aria-label="Aligned sequences"
                  >
                    {alignedList.length === 0 ? (
                      <div className={styles.alignEmptyState}>
                        <p>No sequences aligned yet.</p>
                        <button
                          type="button"
                          className={styles.alignEmptyActionBtn}
                          onClick={() => alignFileInputRef.current?.click()}
                        >
                          <Plus /> Import Files / Traces…
                        </button>
                        <button
                          type="button"
                          className={styles.alignEmptyActionBtn}
                          onClick={() => handleSimulateSequencingReads()}
                        >
                          <Sparkles /> Simulate Fwd &amp; Rev Reads
                        </button>
                      </div>
                    ) : (
                      alignedList.map((aln) => {
                        const isSelected = aln.id === selectedAlignedId;
                        const dirSymbol = aln.strand === 1 ? "→" : "←";
                        return (
                          <div
                            key={aln.id}
                            role="option"
                            aria-selected={isSelected}
                            className={cx(
                              styles.alignSeqRow,
                              isSelected && styles.alignSeqRowSelected,
                            )}
                            onClick={() => {
                              setSelectedAlignedId(aln.id);
                              if (aln.aligned && n > 0) {
                                app.selectItem(null, aln.refRange, {
                                  zoom: true,
                                });
                              }
                            }}
                          >
                            <input
                              type="checkbox"
                              className={styles.alignSeqCheckbox}
                              checked={aln.visible}
                              aria-label={`Show ${aln.name}`}
                              onClick={(e) => e.stopPropagation()}
                              onChange={() => toggleAlignedVisible(aln.id)}
                            />
                            <div className={styles.alignSeqInfo}>
                              <div className={styles.alignSeqNameRow}>
                                <span
                                  className={styles.alignSeqName}
                                  title={aln.name}
                                >
                                  {aln.name}
                                </span>
                                <span
                                  className={styles.alignSeqDir}
                                  title={
                                    aln.strand === 1
                                      ? "Forward strand"
                                      : "Reverse strand"
                                  }
                                >
                                  {dirSymbol}
                                </span>
                              </div>
                              <div className={styles.alignSeqMeta}>
                                {aln.aligned
                                  ? `${formatRange(aln.refRange, n)} · ${aln.identity}%`
                                  : "Unaligned"}
                                {aln.isTrace ? " · Trace" : ""}
                              </div>
                            </div>
                            <div className={styles.alignSeqRowActions}>
                              <button
                                type="button"
                                className={styles.alignRowIconBtn}
                                title="Remove Aligned Sequence"
                                aria-label={`Remove ${aln.name}`}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  removeAlignedSequence(aln.id);
                                }}
                              >
                                <Trash2 />
                              </button>
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>

                  {/* SnapGene Bottom Footer: Move: [↑] [↓] + "Aligned Sequences ▾" (Screenshot 3!) */}
                  <div className={styles.alignPanelFooter}>
                    <div className={styles.alignMoveBar}>
                      <span className={styles.alignMoveLabel}>Move:</span>
                      <button
                        type="button"
                        className={styles.alignMoveBtn}
                        aria-label="Move Aligned Sequence Up"
                        disabled={
                          !selectedAlignedId ||
                          alignedList.findIndex(
                            (a) => a.id === selectedAlignedId,
                          ) <= 0
                        }
                        onClick={() => moveSelectedAligned(-1)}
                      >
                        <ArrowUp />
                      </button>
                      <button
                        type="button"
                        className={styles.alignMoveBtn}
                        aria-label="Move Aligned Sequence Down"
                        disabled={
                          !selectedAlignedId ||
                          alignedList.findIndex(
                            (a) => a.id === selectedAlignedId,
                          ) < 0 ||
                          alignedList.findIndex(
                            (a) => a.id === selectedAlignedId,
                          ) >=
                            alignedList.length - 1
                        }
                        onClick={() => moveSelectedAligned(1)}
                      >
                        <ArrowDown />
                      </button>
                    </div>
                    <Menu modal={false}>
                      <MenuTrigger asChild>
                        <button
                          type="button"
                          className={styles.alignModeSelectBtn}
                        >
                          <span>Aligned Sequences</span>
                          <ChevronDown />
                        </button>
                      </MenuTrigger>
                      <MenuContent align="start">
                        <MenuRadioGroup
                          value={leftPanelMode}
                          onValueChange={(v) =>
                            setLeftPanelMode(v as "align" | "explorer")
                          }
                        >
                          <MenuRadioItem value="align">
                            Aligned Sequences ({alignedList.length})
                          </MenuRadioItem>
                          <MenuRadioItem value="explorer">
                            Explorer &amp; Annotations
                          </MenuRadioItem>
                        </MenuRadioGroup>
                      </MenuContent>
                    </Menu>
                  </div>
                </>
              ) : (
                <>
                  <div className={styles.leftSidePanelHeader}>
                    <Menu modal={false}>
                      <MenuTrigger asChild>
                        <button
                          type="button"
                          className={styles.alignModeHeaderBtn}
                        >
                          <span>Explorer &amp; Annotations</span>
                          <ChevronDown />
                        </button>
                      </MenuTrigger>
                      <MenuContent align="start">
                        <MenuRadioGroup
                          value={leftPanelMode}
                          onValueChange={(v) =>
                            setLeftPanelMode(v as "align" | "explorer")
                          }
                        >
                          <MenuRadioItem value="align">
                            Aligned Sequences ({alignedList.length})
                          </MenuRadioItem>
                          <MenuRadioItem value="explorer">
                            Explorer &amp; Annotations
                          </MenuRadioItem>
                        </MenuRadioGroup>
                      </MenuContent>
                    </Menu>
                    <button
                      type="button"
                      className={styles.docTabClose}
                      aria-label="Close Side Panel"
                      onClick={() => setLeftPanelOpen(false)}
                    >
                      <X />
                    </button>
                  </div>
                  <Sidebar
                    documents={documents}
                    activeDocumentId={doc.id}
                    onActivateDocument={app.activate}
                    onCloseDocument={(id) => requestClose(id)}
                    record={shownDoc.record}
                    enzymeSites={enzymeSites}
                    selectedItem={doc.selectedItem}
                    onSelectItem={(item) => onSelectSidebarItem(item)}
                    onActivateItem={(item) => onSelectSidebarItem(item, true)}
                  />
                </>
              )}
            </aside>
          ) : null}

          <div ref={canvasAreaRef} className={styles.canvasArea}>

            {/* Main View Content */}
            {subTab === null ? (
              <>
                <DocumentView
                  doc={shownDoc}
                  enzymeSites={enzymeSites}
                  primerSites={shownPrimerSites}
                  orfs={orfs}
                  searchHits={searchHits}
                  banner={banner}
                  mapMode={mapMode}
                  layerShow={traceShown ? traceLayerShow : layerShow}
                  sequenceLayout={
                    traceShown ? traceSequenceLayout : undefined
                  }
                  mapWidthChange={mapWidthChange}
                />
                {/* Bottom-Center Plasmid Title when in Linear Map View (Screenshot 2 & 3!) */}
                {doc.view === "map" && mapMode === "linear" ? (
                  <div className={styles.linearMapFooterTitle}>
                    <div className={styles.linearMapTitleName}>
                      {record.name}
                    </div>
                    <div className={styles.linearMapTitleLength}>
                      {formatInt(n)} bp
                    </div>
                  </div>
                ) : null}
              </>
            ) : subTab === "enzymes" ? (
              <EnzymesTableView
                rows={enzymeTableRows}
                enzymeSetName={enzymeSetName}
                filter={tableFilter}
                onFilterChange={setTableFilter}
                onSelectSite={(site) => {
                  app.selectItem(
                    { kind: "enzyme", id: site.enzyme },
                    site.range,
                  );
                  setSubTab(null);
                }}
                onChooseEnzymes={() => app.openSheet("choose-enzymes")}
                onDigest={() => app.openSheet("digest")}
              />
            ) : subTab === "features" ? (
              <FeaturesTableView
                record={shownDoc.record}
                selectedFeatureIds={doc.selectedFeatureIds}
                selectedItemId={
                  doc.selectedItem?.kind === "feature"
                    ? doc.selectedItem.id
                    : null
                }
                filter={tableFilter}
                onFilterChange={setTableFilter}
                onSelectFeature={(id, info) => {
                  if (info?.shiftKey) {
                    const anchorId =
                      doc.selectedItem?.kind === "feature"
                        ? doc.selectedItem.id
                        : doc.selectedFeatureIds?.[0];
                    if (anchorId && anchorId !== id) {
                      const f1 = record.features.find((x) => x.id === anchorId);
                      const f2 = record.features.find((x) => x.id === id);
                      if (f1 && f2 && n > 0) {
                        const ext1 = featureExtent(f1, n, record.topology);
                        const ext2 = featureExtent(f2, n, record.topology);
                        const start = Math.min(ext1.start, ext2.start);
                        const end = Math.max(ext1.end, ext2.end);
                        app.setSelection(
                          selectRange({ start, end }, n, record.topology),
                        );
                        app.setSelectedFeatureIds([anchorId, id]);
                        app.flash(
                          `Selected ${f1.name} .. ${f2.name} (${end - start} bp)`,
                        );
                        return;
                      }
                    }
                  }
                  if (info?.ctrlKey || info?.metaKey) {
                    const current = doc.selectedFeatureIds?.length
                      ? [...doc.selectedFeatureIds]
                      : doc.selectedItem?.kind === "feature"
                        ? [doc.selectedItem.id]
                        : [];
                    const next = current.includes(id)
                      ? current.filter((x) => x !== id)
                      : [...current, id];
                    app.setSelectedFeatureIds(next);
                    if (next.length > 0) {
                      const names = next.map(
                        (fid) =>
                          record.features.find((f) => f.id === fid)?.name ??
                          fid,
                      );
                      app.flash(
                        `${next.length} features selected (${names.join(", ")}) — Right-click for Gibson Assembly Calculation`,
                      );
                    } else {
                      app.flash("No features selected");
                    }
                    return;
                  }
                  const f = record.features.find((x) => x.id === id);
                  const zoom = (info?.clickCount ?? 1) > 1;
                  app.selectItem(
                    { kind: "feature", id },
                    f ? featureExtent(f, n, record.topology) : null,
                    { zoom },
                  );
                  if (zoom) {
                    app.openSheet("edit-feature", { featureId: id });
                  }
                }}
                onEditFeature={(id) =>
                  app.openSheet("edit-feature", { featureId: id })
                }
                onGibsonFeatures={(ids) =>
                  app.openSheet("clone-gibson", { featureIds: [...ids] })
                }
                onDetectCommon={() => detectCommonFeaturesCommand()}
                onAddFeature={() => app.openSheet("add-feature")}
                onDeleteFeature={(id) => deleteFeatureCommand(id)}
              />
            ) : subTab === "primers" ? (
              <PrimersTableView
                record={record}
                primerSites={primerSites}
                filter={tableFilter}
                onFilterChange={setTableFilter}
                onSelectPrimer={(id, info) => {
                  if (
                    info &&
                    (info.ctrlKey || info.metaKey || info.shiftKey) &&
                    doc.selectedItem?.kind === "primer" &&
                    doc.selectedItem.id !== id
                  ) {
                    const s1 = primerSites.find(
                      (s) => s.primerId === doc.selectedItem!.id,
                    );
                    const s2 = primerSites.find((s) => s.primerId === id);
                    if (s1 && s2 && n > 0) {
                      const fwd =
                        s1.strand === 1 && s2.strand === -1
                          ? s1
                          : s2.strand === 1 && s1.strand === -1
                            ? s2
                            : null;
                      const rev = fwd === s1 ? s2 : fwd === s2 ? s1 : null;
                      let spanRange: Range;
                      if (fwd && rev) {
                        if (rev.range.end >= fwd.range.start) {
                          spanRange = {
                            start: fwd.range.start,
                            end: rev.range.end,
                          };
                        } else if (record.topology === "circular") {
                          spanRange = {
                            start: fwd.range.start,
                            end: rev.range.end + n,
                          };
                        } else {
                          spanRange = {
                            start: Math.min(s1.range.start, s2.range.start),
                            end: Math.max(s1.range.end, s2.range.end),
                          };
                        }
                      } else {
                        spanRange = {
                          start: Math.min(s1.range.start, s2.range.start),
                          end: Math.max(s1.range.end, s2.range.end),
                        };
                      }
                      const sel = selectRange(spanRange, n, record.topology);
                      const bpLen = sel.range.end - sel.range.start;
                      const p1Name =
                        record.primers.find(
                          (p) => p.id === doc.selectedItem!.id,
                        )?.name ?? doc.selectedItem!.id;
                      const p2Name =
                        record.primers.find((p) => p.id === id)?.name ?? id;
                      app.setSelection(sel);
                      app.flash(
                        `Selected ${p1Name} .. ${p2Name} (${formatRange(sel.range, n)}, ${bpLen.toLocaleString("en-US")} bp)`,
                      );
                      return;
                    }
                  }
                  const site = primerSites.find((s) => s.primerId === id);
                  app.selectItem({ kind: "primer", id }, site?.range ?? null);
                  if ((info?.clickCount ?? 1) > 1) {
                    app.openSheet("edit-primer", { primerId: id });
                  }
                }}
                onAddPrimer={() =>
                  app.openSheet("add-primer", { direction: 1 })
                }
                onEditPrimer={(id) =>
                  app.openSheet("edit-primer", { primerId: id })
                }
                onPcr={() => app.openSheet("clone-pcr")}
                onDeletePrimer={(id) => deletePrimerCommand(id)}
                onSetPrimersHidden={setPrimersHiddenCommand}
              />
            ) : (
              <HistoryTableView doc={doc} />
            )}
          </div>

          {rightInfoOpen ? (
            <aside className={styles.rightInfoPanel} aria-label="Inspector">
              {inspector}
            </aside>
          ) : null}
        </div>
        {/* Align mode + Sequence view: the reads under the side panel and the sequence (SnapGene's "Original
            Sequence" pane); its info column is as wide as the side panel, so its columns line up with the line above */}
        {traceShown ? (
          <div
            className={cx(
              styles.traceDock,
              traceState === "opening" && styles.traceDockEnter,
              traceState === "closing" && styles.traceDockClosing,
            )}
          >
            <div
              role="separator"
              aria-orientation="horizontal"
              aria-label="Resize trace panel"
              className={styles.alignSplitHandle}
              onPointerDown={onTraceSplitPointerDown}
            />
            <AlignedReadsPanel
              className={styles.alignSplitBottom}
              record={record}
              reads={traceReads}
              infoWidth={traceInfoWidth}
              centerPosition={doc.selection?.range.start ?? null}
              highlight={doc.selection?.range ?? null}
              scrollLeft={traceScrollLeft}
              onScrollLeftChange={setTraceScrollLeft}
              onPositionClick={(p) => {
                app.setSelection({
                  range: { start: p, end: p + 1 },
                  caret: p + 1,
                });
                app.reveal(p);
              }}
            />
          </div>
        ) : null}
          {/* The floating bars and buttons: over the canvas and, in align mode, over the reads below it too;
              each can be dragged anywhere in this column (see useDraggableBar). */}
          <div ref={floatingLayerRef} className={styles.floatingLayer}>
          {/* Floating glass bars: the view tabs, the circular / linear / split switcher, and (below) the layer toggles. */}
          <div
            ref={tabsBar.ref}
            className={cx(
              styles.glassBar,
              styles.floatingTabsBar,
              tabsBar.dragging && styles.glassBarDragging,
            )}
            style={tabsBar.style}
            {...tabsBar.handlers}
          >
            <div
              className={styles.viewTabsList}
              role="tablist"
              aria-label="Document views"
            >
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === "map"}
                className={cx(
                  styles.viewTab,
                  activeTab === "map" && styles.viewTabActive,
                )}
                onClick={() => switchTab("map")}
              >
                Map
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === "sequence"}
                className={cx(
                  styles.viewTab,
                  activeTab === "sequence" && styles.viewTabActive,
                )}
                onClick={() => switchTab("sequence")}
              >
                Sequence
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === "enzymes"}
                className={cx(
                  styles.viewTab,
                  activeTab === "enzymes" && styles.viewTabActive,
                )}
                onClick={() => switchTab("enzymes")}
              >
                Enzymes
                <span className={styles.viewTabBadge}>
                  {enzymeTableRows.length}
                </span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === "features"}
                className={cx(
                  styles.viewTab,
                  activeTab === "features" && styles.viewTabActive,
                )}
                onClick={() => switchTab("features")}
              >
                Features
                <span className={styles.viewTabBadge}>
                  {shownDoc.record.features.length}
                </span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === "primers"}
                className={cx(
                  styles.viewTab,
                  activeTab === "primers" && styles.viewTabActive,
                )}
                onClick={() => switchTab("primers")}
              >
                Primers
                <span className={styles.viewTabBadge}>
                  {record.primers.length}
                </span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === "history"}
                className={cx(
                  styles.viewTab,
                  activeTab === "history" && styles.viewTabActive,
                )}
                onClick={() => switchTab("history")}
              >
                History
              </button>
            </div>

            {/* Right side of Row 4: [◯] Circular Map, [━] Linear Map, [▤] Split View */}
          </div>
          {/* circular / linear / split view: only meaningful on the Map and Sequence tabs */}
          {subTab === null ? (
            <div
              ref={modeBar.ref}
              className={cx(
                styles.glassBar,
                styles.floatingModeBar,
                modeBar.dragging && styles.glassBarDragging,
              )}
              style={modeBar.style}
              {...modeBar.handlers}
            >
              <div className={styles.viewBarRight}>
                <Tooltip
                  content={
                    alignActive
                      ? "Circular Map View (not available in Align mode)"
                      : "Circular Map View"
                  }
                >
                  <button
                    type="button"
                    disabled={alignActive}
                    className={cx(
                      styles.modeBtn,
                      mapMode === "circular" && styles.modeBtnActive,
                    )}
                    aria-label="Circular map view"
                    aria-pressed={mapMode === "circular"}
                    onClick={() => {
                      // Circular / linear is a mode of the map, always one of the two; split view stays as it is.
                      setSubTab(null);
                      if (doc.view !== "split") app.setView("map");
                      setMapMode("circular");
                    }}
                  >
                    <Circle />
                  </button>
                </Tooltip>
                <Tooltip content="Linear Map View">
                  <button
                    type="button"
                    className={cx(
                      styles.modeBtn,
                      mapMode === "linear" && styles.modeBtnActive,
                    )}
                    aria-label="Linear map view"
                    aria-pressed={mapMode === "linear"}
                    onClick={() => {
                      // Circular / linear is a mode of the map, always one of the two; split view stays as it is.
                      setSubTab(null);
                      if (doc.view !== "split") app.setView("map");
                      setMapMode("linear");
                    }}
                  >
                    <Minus />
                  </button>
                </Tooltip>
                <Tooltip content="Toggle Split View (Map + Sequence)">
                  <button
                    type="button"
                    className={cx(
                      styles.modeBtn,
                      !subTab && doc.view === "split" && styles.modeBtnActive,
                    )}
                    aria-label="Toggle Split View"
                    aria-pressed={!subTab && doc.view === "split"}
                    onClick={() => {
                      setSubTab(null);
                      app.setView(
                        !subTab && doc.view === "split" ? "map" : "split",
                      );
                    }}
                  >
                    <Rows2 />
                  </button>
                </Tooltip>
              </div>
            </div>
          ) : null}

          {/* Eight floating green-glass buttons (seven layer toggles and the search), 2 x 4 at the left edge; each one can be dragged on its own. */}
          {subTab === null ? (
            <div
              role="group"
              aria-label="Layer toggles"
              style={{ display: "contents" }}
            >
              <FloatingGlassButton index={0}>
                <Tooltip content="Show/Hide Restriction Enzymes" side="right">
                  <button
                    type="button"
                    className={cx(
                      styles.layerToggleBtn,
                      showEnzymesLayer && styles.layerToggleBtnActive,
                    )}
                    aria-label="Toggle Enzymes Layer"
                    aria-pressed={showEnzymesLayer}
                    onClick={() => setShowEnzymesLayer((v) => !v)}
                  >
                    <Scissors />
                  </button>
                </Tooltip>
              </FloatingGlassButton>
              <FloatingGlassButton index={1}>
                <Tooltip content="Show/Hide Features" side="right">
                  <button
                    type="button"
                    className={cx(
                      styles.layerToggleBtn,
                      showFeaturesLayer && styles.layerToggleBtnActive,
                    )}
                    aria-label="Toggle Features Layer"
                    aria-pressed={showFeaturesLayer}
                    onClick={() => setShowFeaturesLayer((v) => !v)}
                  >
                    <Tag />
                  </button>
                </Tooltip>
              </FloatingGlassButton>
              <FloatingGlassButton index={2}>
                <Tooltip content="Show/Hide Primers" side="right">
                  <button
                    type="button"
                    className={cx(
                      styles.layerToggleBtn,
                      showPrimersLayer && styles.layerToggleBtnActive,
                    )}
                    aria-label="Toggle Primers Layer"
                    aria-pressed={showPrimersLayer}
                    onClick={() => setShowPrimersLayer((v) => !v)}
                  >
                    <ArrowRightToLine />
                  </button>
                </Tooltip>
              </FloatingGlassButton>
              <FloatingGlassButton index={3}>
                <Tooltip
                  content="Show/Hide ORFs &amp; Translations"
                  side="right"
                >
                  <button
                    type="button"
                    className={cx(
                      styles.layerToggleBtn,
                      settings.showOrfs && styles.layerToggleBtnActive,
                    )}
                    aria-label="Toggle ORFs Layer"
                    aria-pressed={settings.showOrfs}
                    onClick={() =>
                      settings.update({ showOrfs: !settings.showOrfs })
                    }
                  >
                    <ArrowLeftRight />
                  </button>
                </Tooltip>
              </FloatingGlassButton>
              <FloatingGlassButton index={4}>
                <Tooltip
                  content="Show/Hide Feature &amp; Primer Lengths (bp)"
                  side="right"
                >
                  <button
                    type="button"
                    className={cx(
                      styles.layerToggleBtn,
                      showLengthsLayer && styles.layerToggleBtnActive,
                    )}
                    aria-label="Toggle Feature and Primer Lengths"
                    aria-pressed={showLengthsLayer}
                    onClick={() => setShowLengthsLayer((v) => !v)}
                  >
                    <Hash />
                  </button>
                </Tooltip>
              </FloatingGlassButton>
              <FloatingGlassButton index={5}>
                <Tooltip content="Show Primer Location" side="right">
                  <button
                    type="button"
                    className={cx(
                      styles.layerToggleBtn,
                      showPrimerLocationsLayer && styles.layerToggleBtnActive,
                    )}
                    aria-label="Show Primer Location"
                    aria-pressed={showPrimerLocationsLayer}
                    onClick={() => setShowPrimerLocationsLayer((v) => !v)}
                  >
                    <MapPin />
                  </button>
                </Tooltip>
              </FloatingGlassButton>
              <FloatingGlassButton index={6}>
                <Tooltip
                  content="Show/Hide Aligned Sequences (Align with:)"
                  side="right"
                >
                  <button
                    type="button"
                    className={cx(
                      styles.layerToggleBtn,
                      leftPanelOpen &&
                        leftPanelMode === "align" &&
                        showAlignmentsLayer &&
                        styles.layerToggleBtnActive,
                    )}
                    aria-label="Toggle Aligned Sequences"
                    aria-pressed={
                      leftPanelOpen &&
                      leftPanelMode === "align" &&
                      showAlignmentsLayer
                    }
                    onClick={() => {
                      if (!leftPanelOpen || leftPanelMode !== "align") {
                        setLeftPanelOpen(true);
                        setLeftPanelMode("align");
                        setShowAlignmentsLayer(true);
                      } else {
                        const next = !showAlignmentsLayer;
                        setShowAlignmentsLayer(next);
                        setLeftPanelOpen(next);
                      }
                    }}
                  >
                    <GitCompareArrows />
                  </button>
                </Tooltip>
              </FloatingGlassButton>
              <FloatingGlassButton
                index={7}
                after={
                  searchOpen ? (
                    <div className={styles.floatingSearchBox}>
                      <SearchField
                        ref={searchRef}
                        size="sm"
                        placeholder="Find DNA sequence…"
                        aria-label="Find DNA sequence"
                        value={searchQuery}
                        onValueChange={onSearchQueryChange}
                        onSubmit={onSearchSubmit}
                        status={searchStatus}
                        width={220}
                      />
                      <button
                        type="button"
                        className={styles.docTabClose}
                        aria-label="Close search"
                        onClick={() => {
                          setSearchOpen(false);
                          onSearchQueryChange("");
                        }}
                      >
                        <X />
                      </button>
                    </div>
                  ) : undefined
                }
              >
                <Tooltip content="Find DNA Sequence (Ctrl+F)" side="right">
                  <button
                    type="button"
                    className={cx(
                      styles.layerToggleBtn,
                      searchOpen && styles.layerToggleBtnActive,
                    )}
                    aria-label="Search sequence"
                    aria-pressed={searchOpen}
                    onClick={() => {
                      const next = !searchOpen;
                      setSearchOpen(next);
                      if (next)
                        setTimeout(() => searchRef.current?.focus(), 20);
                    }}
                  >
                    <Search />
                  </button>
                </Tooltip>
              </FloatingGlassButton>
            </div>
          ) : null}
          </div>
        </div>

        {/* =====================================================================
            BOTTOM STATUS BAR:
            Selection summary on left  |  Unique 6+ Cutters | Nonredundant on right
           ===================================================================== */}
        <footer className={styles.statusBar} role="status">
          <div className={styles.statusLeft}>
            {statusMessage ? (
              statusMessage
            ) : summary?.hasBases ? (
              <span>{formatSelectionStatus(summary, record.molecule)}</span>
            ) : (
              <span>
                {record.name} · {formatInt(n)} bp · {record.topology}
              </span>
            )}
          </div>
          <div className={styles.statusRight}>
            <Menu modal={false}>
              <MenuTrigger asChild>
                <button type="button" className={styles.statusEnzymeBtn}>
                  {enzymeSetName} | Nonredundant
                </button>
              </MenuTrigger>
              <MenuContent align="end">
                <MenuLabel>Restriction Enzyme Set</MenuLabel>
                <MenuRadioGroup
                  value={settings.enzymeDisplay}
                  onValueChange={(v) =>
                    settings.update({ enzymeDisplay: v as EnzymeDisplay })
                  }
                >
                  {ENZYME_DISPLAY_CHOICES.map((d) => (
                    <MenuRadioItem key={d} value={d}>
                      {ENZYME_DISPLAY_NAMES[d]}
                    </MenuRadioItem>
                  ))}
                </MenuRadioGroup>
                <MenuSeparator />
                <MenuItem onSelect={() => app.openSheet("choose-enzymes")}>
                  Choose Enzymes…
                </MenuItem>
              </MenuContent>
            </Menu>
          </div>
        </footer>
      </div>
    </TooltipProvider>
  );
}

// ---------------------------------------------------------------------------
// SnapGene Tab Sub-Views: Enzymes / Features / Primers / History
// ---------------------------------------------------------------------------

function EnzymesTableView({
  rows,
  enzymeSetName,
  filter,
  onFilterChange,
  onSelectSite,
  onChooseEnzymes,
  onDigest,
}: {
  rows: Array<{ name: string; cuts: number[]; sites: EnzymeSite[] }>;
  enzymeSetName: string;
  filter: string;
  onFilterChange: (q: string) => void;
  onSelectSite: (site: EnzymeSite) => void;
  onChooseEnzymes: () => void;
  onDigest: () => void;
}) {
  return (
    <div className={styles.tableView}>
      <div className={styles.tableToolbar}>
        <div className={styles.tableToolbarLeft}>
          <span className={styles.tableToolbarTitle}>
            Restriction Enzymes — {enzymeSetName} ({rows.length})
          </span>
          <SearchField
            size="sm"
            placeholder="Filter enzymes…"
            value={filter}
            onValueChange={onFilterChange}
            width={190}
          />
        </div>
        <div className={styles.tableToolbarRight}>
          <Button size="sm" onClick={onChooseEnzymes}>
            Choose Enzymes…
          </Button>
          <Button size="sm" variant="primary" onClick={onDigest}>
            Simulate Digest &amp; Gel…
          </Button>
        </div>
      </div>
      <div className={styles.tableScroll}>
        <table className={styles.dataTable}>
          <thead>
            <tr>
              <th>Enzyme Name</th>
              <th>Number of Cuts</th>
              <th>Positions (bp)</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.name}
                onClick={() => r.sites[0] && onSelectSite(r.sites[0])}
              >
                <td style={{ fontWeight: r.cuts.length === 1 ? 700 : 500 }}>
                  {r.name}
                </td>
                <td>{r.cuts.length}</td>
                <td className="hh-mono">{r.cuts.map(formatInt).join(", ")}</td>
                <td>
                  <Button
                    size="sm"
                    variant="plain"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (r.sites[0]) onSelectSite(r.sites[0]);
                    }}
                  >
                    Show on Map
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function FeaturesTableView({
  record,
  selectedFeatureIds,
  selectedItemId,
  filter,
  onFilterChange,
  onSelectFeature,
  onEditFeature,
  onGibsonFeatures,
  onDetectCommon,
  onAddFeature,
  onDeleteFeature,
}: {
  record: SeqRecord;
  selectedFeatureIds?: readonly string[];
  selectedItemId: string | null;
  filter: string;
  onFilterChange: (q: string) => void;
  onSelectFeature: (id: string, info?: FeatureClickInfo) => void;
  onEditFeature: (id: string) => void;
  onGibsonFeatures: (ids: readonly string[]) => void;
  onDetectCommon: () => void;
  onAddFeature: () => void;
  onDeleteFeature: (id: string) => void;
}) {
  const n = record.seq.length;
  const q = filter.trim().toLowerCase();
  const features = record.features.filter(
    (f) =>
      !q ||
      f.name.toLowerCase().includes(q) ||
      f.type.toLowerCase().includes(q),
  );
  const multiSelected =
    selectedFeatureIds && selectedFeatureIds.length >= 2
      ? selectedFeatureIds
      : null;

  return (
    <div className={styles.tableView}>
      <div className={styles.tableToolbar}>
        <div className={styles.tableToolbarLeft}>
          <span className={styles.tableToolbarTitle}>
            Features ({features.length})
          </span>
          <SearchField
            size="sm"
            placeholder="Filter features…"
            value={filter}
            onValueChange={onFilterChange}
            width={190}
          />
        </div>
        <div className={styles.tableToolbarRight}>
          {multiSelected ? (
            <Button
              size="sm"
              variant="primary"
              icon={<Combine />}
              onClick={() => onGibsonFeatures(multiSelected)}
            >
              Gibson Calculation ({multiSelected.length} selected features)…
            </Button>
          ) : null}
          <Button size="sm" icon={<Sparkles />} onClick={onDetectCommon}>
            Detect Common Features
          </Button>
          <Button
            size="sm"
            variant="primary"
            icon={<Tag />}
            onClick={onAddFeature}
          >
            Add Feature…
          </Button>
        </div>
      </div>
      <div className={styles.tableScroll}>
        <table className={styles.dataTable}>
          <thead>
            <tr>
              <th>Feature</th>
              <th>Type</th>
              <th>Direction</th>
              <th>Location</th>
              <th>Size (bp)</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {features.map((f) => {
              const ext = featureExtent(f, n, record.topology);
              const len = featureLength(f);
              const isSelected =
                selectedFeatureIds?.includes(f.id) || selectedItemId === f.id;
              return (
                <tr
                  key={f.id}
                  className={cx(isSelected && styles.dataTableRowSelected)}
                  onClick={(e) =>
                    onSelectFeature(f.id, {
                      clickCount: Math.max(1, e.detail || 1),
                      shiftKey: e.shiftKey,
                      ctrlKey: e.ctrlKey,
                      metaKey: e.metaKey,
                    })
                  }
                  onDoubleClick={() =>
                    onSelectFeature(f.id, {
                      clickCount: 2,
                      shiftKey: false,
                      ctrlKey: false,
                      metaKey: false,
                    })
                  }
                >
                  <td>
                    <span className={styles.swatchPill}>
                      <span
                        className={styles.swatchBox}
                        style={{ background: featureFill(f) }}
                      />
                      {f.name || f.type}
                    </span>
                  </td>
                  <td>{f.type}</td>
                  <td>
                    {f.strand === 1
                      ? "⇒ Forward"
                      : f.strand === -1
                        ? "⇐ Reverse"
                        : "—"}
                  </td>
                  <td className="hh-mono">{formatRange(ext, n)}</td>
                  <td className="hh-mono">{formatInt(len)} bp</td>
                  <td style={{ textAlign: "right" }}>
                    <Button
                      size="sm"
                      variant="plain"
                      icon={<Pencil />}
                      aria-label={`Edit ${f.name}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onEditFeature(f.id);
                      }}
                    />
                    <Button
                      size="sm"
                      variant="plain"
                      icon={<Trash2 />}
                      aria-label={`Delete ${f.name}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onDeleteFeature(f.id);
                      }}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** True when the half-open ranges share a base; `b` is also tried shifted by one turn of a circular sequence of length `n`. */
function rangesOverlap(a: Range, b: Range, n: number): boolean {
  return [-n, 0, n].some(
    (shift) => a.start < b.end + shift && b.start + shift < a.end,
  );
}

type PrimerSortKey =
  "name" | "sequence" | "length" | "site" | "direction" | "tm";

/** Primers sorted by a table column. Primers without a value (unbound, no Tm) stay last in both directions. */
function sortPrimers(
  primers: readonly Primer[],
  sites: readonly PrimerBindingSite[],
  key: PrimerSortKey,
  dir: "asc" | "desc",
): Primer[] {
  const value = (p: Primer): string | number | null => {
    const site = sites.find((s) => s.primerId === p.id);
    switch (key) {
      case "name":
        return p.name;
      case "sequence":
        return p.sequence;
      case "length":
        return p.sequence.length;
      case "site":
        return site ? site.range.start : null;
      case "direction":
        return site ? (site.strand === 1 ? 0 : 1) : null;
      case "tm": {
        const t = tm(p.sequence);
        return Number.isFinite(t) ? t : null;
      }
    }
  };
  const sign = dir === "asc" ? 1 : -1;
  return primers
    .map((p, index) => ({ p, index, v: value(p) }))
    .sort((a, b) => {
      if (a.v === null || b.v === null)
        return a.v === b.v ? a.index - b.index : a.v === null ? 1 : -1;
      const c =
        typeof a.v === "string"
          ? a.v.localeCompare(b.v as string, undefined, {
              numeric: true,
              sensitivity: "base",
            })
          : a.v - (b.v as number);
      return c !== 0 ? c * sign : a.index - b.index;
    })
    .map((x) => x.p);
}

/** Length of the opening and closing animation of a primer's detail panel (keep in sync with primerDetailOpen/Close in the CSS). */
const PRIMER_DETAIL_ANIMATION_MS = 180;

/** Longer primer sequences are cut after this many nucleotides in the Primers table (the full sequence is the tooltip). */
const PRIMER_SEQUENCE_PREVIEW_NT = 30;

/**
 * Mount / unmount with an animation, timed by CSS so that the animation itself needs no render: 'opening' from the
 * moment it opens until `settleMs` later (the entry animation runs then; it starts after a short CSS delay, so the
 * heavy first render does not eat its first frames), then 'open'; after it closes, 'closing' for `ms` (still drawn,
 * animating out; the heavy unmount comes after), then 'closed'. With `animate` false (e.g. only the view changed)
 * it opens and closes at once.
 */
type Presence = "opening" | "open" | "closing" | "closed";
function usePresence(
  open: boolean,
  ms: number,
  animate = true,
  settleMs = ms + 400,
): Presence {
  const [state, setState] = useState<Presence>(open ? "open" : "closed");
  // read when `open` changes: whether that change animates
  const animateRef = useRef(animate);
  animateRef.current = animate;
  useEffect(() => {
    const animate = animateRef.current;
    if (open) {
      let keep = false;
      setState((prev) => {
        keep = prev === "open" || prev === "opening";
        return keep ? prev : animate ? "opening" : "open";
      });
      // the switch to 'open' comes after the animation, so no render lands in the middle of it
      const t = window.setTimeout(
        () => setState((prev) => (prev === "opening" ? "open" : prev)),
        settleMs,
      );
      return () => window.clearTimeout(t);
    }
    if (!animate) {
      setState("closed");
      return;
    }
    setState((prev) => (prev === "closed" ? "closed" : "closing"));
    const t = window.setTimeout(() => setState("closed"), ms);
    return () => window.clearTimeout(t);
  }, [open, ms, settleMs]);
  // before the effect has caught up with a change of `open`
  if (open) {
    if (state === "closed" || state === "closing") return animate ? "opening" : "open";
    return state;
  }
  if (state === "closed" || state === "closing") return state;
  return animate ? "closing" : "closed";
}

/**
 * Makes a floating bar draggable: press anywhere on it (a button included) and move to drag it; a plain click still
 * reaches the buttons. Until it has been dragged the bar keeps the position its CSS gives it.
 */
function useDraggableBar() {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    left: number;
    top: number;
    moved: boolean;
  } | null>(null);
  /** Keeps the bar inside the canvas it floats over. */
  const clamp = (left: number, top: number) => {
    const bar = ref.current;
    const area = bar?.offsetParent as HTMLElement | null;
    if (!bar || !area) return { left, top };
    return {
      left: Math.min(
        Math.max(0, left),
        Math.max(0, area.clientWidth - bar.offsetWidth),
      ),
      top: Math.min(
        Math.max(0, top),
        Math.max(0, area.clientHeight - bar.offsetHeight),
      ),
    };
  };
  // `pos` is where the bar was put; it is shown clamped to the canvas as it is now, so a canvas that shrinks (the
  // window, or the align mode's side panel and trace panel) never pushes the bar out of sight, and it returns to its
  // place when the canvas grows again
  // (only a bar that was dragged is watched, and it redraws only when its clamped place changes: the canvas resizes
  // every frame while a side panel slides, and the bars live in the whole workspace)
  const [, setAreaTick] = useState(0);
  const posRef = useRef(pos);
  posRef.current = pos;
  const shownRef = useRef<{ left: number; top: number } | null>(null);
  const dragged = pos !== null;
  useEffect(() => {
    const area = ref.current?.offsetParent as HTMLElement | null;
    if (!dragged || !area || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      const p = posRef.current;
      if (!p) return;
      const next = clamp(p.left, p.top);
      const prev = shownRef.current;
      if (!prev || prev.left !== next.left || prev.top !== next.top) {
        setAreaTick((t) => t + 1);
      }
    });
    ro.observe(area);
    return () => ro.disconnect();
  }, [dragged]);
  const shown = pos ? clamp(pos.left, pos.top) : null;
  shownRef.current = shown;
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("input, textarea")) return; // selecting text in a field is not a drag
    const bar = e.currentTarget;
    // Where the bar is now, measured on screen: its CSS position may be anchored right / bottom or centred with a transform.
    const rect = bar.getBoundingClientRect();
    const areaRect = (
      bar.offsetParent as HTMLElement | null
    )?.getBoundingClientRect();
    const d = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      left: rect.left - (areaRect?.left ?? 0),
      top: rect.top - (areaRect?.top ?? 0),
      moved: false,
    };
    drag.current = d;
    // Listen on the window: a quick move leaves the narrow bar before the first move event arrives.
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== d.pointerId) return;
      const dx = ev.clientX - d.startX;
      const dy = ev.clientY - d.startY;
      if (!d.moved) {
        if (Math.hypot(dx, dy) < 5) return; // below this it is a click
        d.moved = true;
        setDragging(true);
        document.body.style.cursor = "grabbing";
        document.body.style.userSelect = "none";
      }
      setPos(clamp(d.left + dx, d.top + dy));
    };
    const end = (ev: PointerEvent) => {
      if (ev.pointerId !== d.pointerId) return;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      if (d.moved) {
        setDragging(false);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      }
      // `moved` stays set until the click that follows the release has been swallowed.
      window.setTimeout(() => {
        if (drag.current === d) drag.current = null;
      }, 0);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  };
  const onClickCapture = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (drag.current?.moved) {
      e.stopPropagation();
      e.preventDefault();
    }
  };
  return {
    ref,
    dragging,
    /** Inline position once dragged; it overrides a CSS position anchored right / bottom or centred with a transform. */
    style: shown
      ? ({
          left: shown.left,
          top: shown.top,
          right: "auto",
          bottom: "auto",
          transform: "none",
        } satisfies CSSProperties)
      : undefined,
    handlers: { onPointerDown, onClickCapture },
  };
}

/**
 * A floating glass button that can be dragged on its own; before that it stands in a grid of 2 columns by 4 rows at the left
 * edge (`index` = its place in it, row by row). `after` is shown beside the button and moves with it.
 */
function FloatingGlassButton({
  index,
  children,
  after,
}: {
  index: number;
  children: ReactNode;
  after?: ReactNode;
}) {
  const drag = useDraggableBar();
  return (
    <div
      ref={drag.ref}
      className={cx(
        styles.glassButton,
        drag.dragging && styles.glassBarDragging,
      )}
      style={{
        // its place in the grid, measured from the canvas's left edge (see the floating layer)
        left: `calc(var(--canvas-l, 0px) + ${10 + (index % 2) * 38}px)`,
        top: 14 + Math.floor(index / 2) * 38,
        ...drag.style,
      }}
      {...drag.handlers}
    >
      {children}
      {after}
    </div>
  );
}

/** Fixed-height flex box so a checkbox never moves the table baseline when its check mark appears. */
const checkboxCellStyle = {
  display: "flex",
  alignItems: "center",
  height: 16,
} as const;

/** Half-arrow of a primer: barb up at the right end for forward (⇀), barb down at the left end for reverse (↽). */
function PrimerDirectionArrow({ strand }: { strand: 1 | -1 }) {
  return (
    <svg
      width="16"
      height="8"
      viewBox="0 0 24 12"
      role="img"
      aria-label={strand === 1 ? "Forward" : "Reverse"}
      style={{ display: "block", margin: "0 auto" }}
    >
      <path
        d={strand === 1 ? "M2 7 H22 L17 2" : "M22 5 H2 L7 10"}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function PrimersTableView({
  record,
  primerSites,
  filter,
  onFilterChange,
  onSelectPrimer,
  onAddPrimer,
  onEditPrimer,
  onPcr,
  onDeletePrimer,
  onSetPrimersHidden,
}: {
  record: SeqRecord;
  primerSites: readonly PrimerBindingSite[];
  filter: string;
  onFilterChange: (q: string) => void;
  onSelectPrimer: (id: string, info?: FeatureClickInfo) => void;
  onAddPrimer: () => void;
  onEditPrimer: (id: string) => void;
  onPcr: () => void;
  onDeletePrimer: (id: string) => void;
  onSetPrimersHidden: (ids: readonly string[], hidden: boolean) => void;
}) {
  const n = record.seq.length;
  const q = filter.trim().toLowerCase();
  const filteredPrimers = record.primers.filter(
    (p) =>
      !q ||
      p.name.toLowerCase().includes(q) ||
      p.sequence.toLowerCase().includes(q),
  );
  // Click a column title: ascending, then descending, then back to the file order.
  const [sort, setSort] = useState<{
    key: PrimerSortKey;
    dir: "asc" | "desc";
  } | null>(null);
  const toggleSort = (key: PrimerSortKey) =>
    setSort((prev) =>
      !prev || prev.key !== key
        ? { key, dir: "asc" }
        : prev.dir === "asc"
          ? { key, dir: "desc" }
          : null,
    );
  const primers = sort
    ? sortPrimers(filteredPrimers, primerSites, sort.key, sort.dir)
    : filteredPrimers;
  const sortTh = (key: PrimerSortKey, label: ReactNode, centered = false) => {
    const active = sort?.key === key ? sort.dir : null;
    const slot = (arrow: boolean) => (
      <span style={{ display: "inline-flex", width: 12, height: 12 }}>
        {arrow && active ? (
          active === "asc" ? (
            <ArrowUp size={12} />
          ) : (
            <ArrowDown size={12} />
          )
        ) : null}
      </span>
    );
    return (
      <th
        aria-sort={
          active === "asc"
            ? "ascending"
            : active === "desc"
              ? "descending"
              : "none"
        }
        style={{
          cursor: "pointer",
          userSelect: "none",
          textAlign: centered ? "center" : undefined,
        }}
        onClick={() => toggleSort(key)}
      >
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          {centered ? slot(false) : null}
          {label}
          {slot(true)}
        </span>
      </th>
    );
  };
  // Row checkboxes only select primers; hiding is done from the right-click menu.
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const [menuIds, setMenuIds] = useState<readonly string[]>([]);
  const checkedCount = primers.filter((p) => checked.has(p.id)).length;
  // Last row clicked without Shift: the start of a Shift+click range.
  const [anchorId, setAnchorId] = useState<string | null>(null);
  // Rows whose detail panel (full sequence and all values) is open.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  // Panels that are playing their closing animation; they stay in `expanded` until it has finished.
  const [closing, setClosing] = useState<ReadonlySet<string>>(new Set());
  const closeTimers = useRef(new Map<string, number>());
  const toggleExpanded = (id: string) => {
    const without = (set: ReadonlySet<string>) => {
      const next = new Set(set);
      next.delete(id);
      return next;
    };
    if (closing.has(id)) {
      // Clicked again while closing: keep it open.
      window.clearTimeout(closeTimers.current.get(id));
      closeTimers.current.delete(id);
      setClosing(without);
    } else if (expanded.has(id)) {
      setClosing((prev) => new Set(prev).add(id));
      closeTimers.current.set(
        id,
        window.setTimeout(() => {
          closeTimers.current.delete(id);
          setExpanded(without);
          setClosing(without);
        }, PRIMER_DETAIL_ANIMATION_MS),
      );
    } else {
      setExpanded((prev) => new Set(prev).add(id));
    }
  };
  /**
   * Row selection as in a file list. `toggle` (Ctrl/Cmd, or a checkbox click) adds or removes one row;
   * `shift` checks every visible row between the anchor and `id` (added to the current checks when
   * `toggle` is also set, otherwise replacing them); a plain click checks only that row, or unchecks it
   * when it is the only checked one.
   */
  const selectRow = (
    id: string,
    { shift, toggle }: { shift: boolean; toggle: boolean },
  ) => {
    const ids = primers.map((p) => p.id);
    if (shift && anchorId !== null && ids.includes(anchorId)) {
      const [from, to] = [ids.indexOf(anchorId), ids.indexOf(id)].sort(
        (a, b) => a - b,
      );
      const range = ids.slice(from, to + 1);
      setChecked((prev) => new Set(toggle ? [...prev, ...range] : range));
      return;
    }
    setAnchorId(id);
    setChecked((prev) => {
      if (toggle) {
        const next = new Set(prev);
        if (!next.delete(id)) next.add(id);
        return next;
      }
      return prev.size === 1 && prev.has(id) ? new Set() : new Set([id]);
    });
  };
  const menuPrimers = record.primers.filter((p) => menuIds.includes(p.id));
  const menuNoun =
    menuPrimers.length > 1 ? `${menuPrimers.length} Primers` : "Primer";

  return (
    <div className={styles.tableView}>
      <div className={styles.tableToolbar}>
        <div className={styles.tableToolbarLeft}>
          <SearchField
            size="sm"
            placeholder="Find primers…"
            value={filter}
            onValueChange={onFilterChange}
            width={190}
          />
        </div>
        <div className={styles.tableToolbarRight}>
          <span
            style={{
              fontStyle: "italic",
              color: "#8a958e",
              fontSize: 12,
              whiteSpace: "nowrap",
            }}
          >
            {checkedCount > 0 ? (
              <>
                <strong style={{ color: "#16794b" }}>{checkedCount}</strong> of{" "}
                <strong style={{ color: "#16794b" }}>{primers.length}</strong>{" "}
                primers
              </>
            ) : (
              <>
                <strong style={{ color: "#16794b" }}>{primers.length}</strong>{" "}
                primers
              </>
            )}
          </span>
          <Button size="sm" onClick={onPcr}>
            Simulate PCR…
          </Button>
          <Button
            size="sm"
            variant="primary"
            icon={<ArrowRightToLine />}
            onClick={onAddPrimer}
          >
            Add Primer…
          </Button>
        </div>
      </div>
      <div className={cx(styles.tableScroll, styles.tableScrollFlush)}>
        <table className={styles.dataTable}>
          <thead>
            <tr>
              <th style={{ width: 28, paddingRight: 0 }} aria-label="Details" />
              <th style={{ width: 32 }}>
                <div style={checkboxCellStyle}>
                  <Checkbox
                    aria-label="Select all primers"
                    checked={
                      primers.length > 0 && checkedCount === primers.length
                        ? true
                        : checkedCount > 0
                          ? "indeterminate"
                          : false
                    }
                    onCheckedChange={(on) =>
                      setChecked(
                        on === true
                          ? new Set(primers.map((p) => p.id))
                          : new Set(),
                      )
                    }
                  />
                </div>
              </th>
              {sortTh("name", "Primer")}
              {sortTh("sequence", <>Sequence (5&apos; → 3&apos;)</>)}
              {sortTh("length", "Length")}
              {sortTh("site", "Binding Site")}
              {sortTh("direction", "Direction", true)}
              {sortTh("tm", "Tm")}
              <th />
            </tr>
          </thead>
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <tbody>
                {primers.map((p, index) => {
                  const isChecked = checked.has(p.id);
                  const aboveChecked =
                    index > 0 && checked.has(primers[index - 1].id);
                  const belowChecked =
                    index < primers.length - 1 &&
                    checked.has(primers[index + 1].id);
                  const site = primerSites.find((s) => s.primerId === p.id);
                  const primerTm = tm(p.sequence);
                  const gc = oligoGcContent(p.sequence) * 100;
                  const gcCount = [...p.sequence].filter(
                    (c) => c === "G" || c === "C",
                  ).length;
                  // What the primer sits on: features overlapping its binding site (primer_bind features are primers themselves)
                  // and the aligned sequences whose aligned region fully covers it.
                  const overlappedFeatures = site
                    ? [
                        ...new Set(
                          record.features
                            .filter(
                              (f) =>
                                f.type !== "primer_bind" &&
                                f.segments.some((seg) =>
                                  rangesOverlap(site.range, seg, n),
                                ),
                            )
                            .map((f) => f.name),
                        ),
                      ]
                    : [];
                  // Primer bases that line up with the template: the annealing part (without a 5' tail) minus its mismatches.
                  const alignedBases = site
                    ? site.annealedLength - site.mismatches
                    : 0;
                  const isDetailShown = expanded.has(p.id);
                  const isDetailClosing = closing.has(p.id);
                  const isExpanded = isDetailShown && !isDetailClosing;
                  const openContextMenu = () =>
                    setMenuIds(checked.has(p.id) ? [...checked] : [p.id]);
                  return (
                    <Fragment key={p.id}>
                      <tr
                        className={cx(
                          isChecked && styles.dataTableRowChecked,
                          isChecked &&
                            !aboveChecked &&
                            styles.dataTableRowCheckedTop,
                          // An open detail row below is part of the same outlined block.
                          isChecked &&
                            !belowChecked &&
                            !isDetailShown &&
                            styles.dataTableRowCheckedBottom,
                          p.hidden && styles.dataTableRowHidden,
                        )}
                        onContextMenu={openContextMenu}
                        style={{ userSelect: "none" }}
                        onClick={(e) => {
                          const multi = e.shiftKey || e.ctrlKey || e.metaKey;
                          // The second click of a double click only opens the editor; it must not undo the check.
                          if (e.detail <= 1)
                            selectRow(p.id, {
                              shift: e.shiftKey,
                              toggle: e.ctrlKey || e.metaKey,
                            });
                          if (multi) return;
                          onSelectPrimer(p.id, {
                            clickCount: Math.max(1, e.detail || 1),
                            shiftKey: false,
                            ctrlKey: false,
                            metaKey: false,
                          });
                        }}
                        onDoubleClick={() =>
                          onSelectPrimer(p.id, {
                            clickCount: 2,
                            shiftKey: false,
                            ctrlKey: false,
                            metaKey: false,
                          })
                        }
                      >
                        <td
                          style={{ paddingRight: 0 }}
                          onClick={(e) => e.stopPropagation()}
                          onDoubleClick={(e) => e.stopPropagation()}
                        >
                          <Button
                            size="sm"
                            variant="plain"
                            icon={
                              isExpanded ? <ChevronDown /> : <ChevronRight />
                            }
                            aria-label={`${isExpanded ? "Hide" : "Show"} details of ${p.name}`}
                            aria-expanded={isExpanded}
                            onClick={() => toggleExpanded(p.id)}
                          />
                        </td>
                        <td
                          onClick={(e) => e.stopPropagation()}
                          onDoubleClick={(e) => e.stopPropagation()}
                        >
                          <div style={checkboxCellStyle}>
                            <Checkbox
                              aria-label={`Select ${p.name}`}
                              checked={checked.has(p.id)}
                              onClick={(e) =>
                                selectRow(p.id, {
                                  shift: e.shiftKey,
                                  toggle: true,
                                })
                              }
                            />
                          </div>
                        </td>
                        <td className={styles.primerNameCell}>{p.name}</td>
                        <td
                          className="hh-mono"
                          title={
                            p.sequence.length > PRIMER_SEQUENCE_PREVIEW_NT
                              ? p.sequence
                              : undefined
                          }
                        >
                          {p.sequence.length > PRIMER_SEQUENCE_PREVIEW_NT
                            ? `${p.sequence.slice(0, PRIMER_SEQUENCE_PREVIEW_NT)}…`
                            : p.sequence}
                        </td>
                        <td className={cx("hh-mono", styles.noWrapCell)}>
                          {p.sequence.length} nt
                        </td>
                        <td className="hh-mono">
                          {site ? formatRange(site.range, n) : "Unbound"}
                        </td>
                        <td style={{ textAlign: "center" }}>
                          {site ? (
                            <PrimerDirectionArrow strand={site.strand} />
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className={cx("hh-mono", styles.noWrapCell)}>
                          {Number.isFinite(primerTm)
                            ? `${Math.round(primerTm)} °C`
                            : "—"}
                        </td>
                        <td
                          className={styles.rowActions}
                          style={{ textAlign: "right" }}
                        >
                          <Button
                            size="sm"
                            variant="plain"
                            icon={<Pencil />}
                            aria-label={`Edit ${p.name}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              onEditPrimer(p.id);
                            }}
                          />
                          <Button
                            size="sm"
                            variant="plain"
                            icon={<Trash2 />}
                            aria-label={`Delete ${p.name}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              onDeletePrimer(p.id);
                            }}
                          />
                        </td>
                      </tr>
                      {isDetailShown ? (
                        <tr
                          className={cx(
                            styles.primerDetailRow,
                            isChecked && styles.dataTableRowChecked,
                            isChecked &&
                              !belowChecked &&
                              styles.dataTableRowCheckedBottom,
                          )}
                          onContextMenu={openContextMenu}
                        >
                          <td colSpan={9}>
                            <div
                              className={cx(
                                styles.primerDetailAnim,
                                isDetailClosing && styles.primerDetailClosing,
                              )}
                            >
                              <div className={styles.primerDetailClip}>
                                <div className={styles.primerDetail}>
                                  <div>
                                    <div className={styles.primerDetailLabel}>
                                      Sequence (5&apos; → 3&apos;)
                                    </div>
                                    <div
                                      className={cx(
                                        "hh-mono",
                                        styles.primerDetailSequence,
                                      )}
                                    >
                                      {p.sequence}
                                    </div>
                                  </div>
                                  <dl className={styles.primerDetailGrid}>
                                    <div>
                                      <dt>GC</dt>
                                      <dd className="hh-mono">
                                        {gc.toFixed(0)}% ({gcCount}/
                                        {p.sequence.length})
                                      </dd>
                                    </div>
                                    <div>
                                      <dt>Aligned DNA</dt>
                                      <dd className="hh-mono">
                                        {site
                                          ? `${alignedBases}/${p.sequence.length}`
                                          : "—"}
                                      </dd>
                                    </div>
                                    <div className={styles.primerDetailGrow}>
                                      <dt>Features</dt>
                                      <dd>
                                        {site && overlappedFeatures.length > 0
                                          ? overlappedFeatures.join(", ")
                                          : "—"}
                                      </dd>
                                    </div>
                                    {p.description ? (
                                      <div className={styles.primerDetailWide}>
                                        <dt>Note</dt>
                                        <dd>{p.description}</dd>
                                      </div>
                                    ) : null}
                                  </dl>
                                </div>
                              </div>
                            </div>
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                })}
              </tbody>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem
                icon={<EyeOff />}
                onSelect={() => onSetPrimersHidden(menuIds, true)}
              >
                Hide {menuNoun}
              </ContextMenuItem>
              <ContextMenuItem
                icon={<Eye />}
                onSelect={() => onSetPrimersHidden(menuIds, false)}
              >
                Show {menuNoun}
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        </table>
      </div>
    </div>
  );
}

function HistoryTableView({ doc }: { doc: DocumentState }) {
  const app = useApp.getState();
  const undoSteps = doc.history.undo;
  const redoSteps = doc.history.redo;

  return (
    <div className={styles.tableView}>
      <div className={styles.tableToolbar}>
        <div className={styles.tableToolbarLeft}>
          <span className={styles.tableToolbarTitle}>
            History — {doc.record.name}
          </span>
        </div>
        <div className={styles.tableToolbarRight}>
          <Button
            size="sm"
            icon={<Undo2 />}
            disabled={undoSteps.length === 0}
            onClick={() => app.undo()}
          >
            Undo
          </Button>
          <Button
            size="sm"
            icon={<Redo2 />}
            disabled={redoSteps.length === 0}
            onClick={() => app.redo()}
          >
            Redo
          </Button>
        </div>
      </div>
      <div className={styles.tableScroll}>
        <table className={styles.dataTable}>
          <thead>
            <tr>
              <th>Step</th>
              <th>Operation</th>
              <th>Sequence Length</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            <tr className={styles.dataTableRowSelected}>
              <td style={{ fontWeight: 700 }}>Current</td>
              <td style={{ fontWeight: 600 }}>
                {doc.record.name} ({doc.record.topology})
              </td>
              <td className="hh-mono">{formatInt(doc.record.seq.length)} bp</td>
              <td>{isDirty(doc) ? "Edited (Unsaved)" : "Saved / Initial"}</td>
            </tr>
            {[...undoSteps].reverse().map((step, idx) => (
              <tr key={`u-${idx}`}>
                <td>-{idx + 1}</td>
                <td>{step.label}</td>
                <td className="hh-mono">
                  {formatInt(step.record.seq.length)} bp
                </td>
                <td>Undo available</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
