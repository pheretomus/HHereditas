/**
 * Feature dialog laid out the way SnapGene's "Edit Feature" window is: a Feature name row with a Greek-letter
 * button, a Type row with the directionality arrows, the "Translate this feature in Sequence view" checkbox
 * with its "Feature Translation Options…" panel, a segment map ("105 bp / 1 segment") with Split / Merge / Delete
 * beside it, a segment table (#, Segment, Location, Size, Color), and the qualifier list (/key = value) with
 * + / − buttons. Handles both Add Feature and Edit Feature.
 */
import type { Feature, Qualifier, Range, Strand, Topology } from '@hhereditas/core';
import {
  GENETIC_CODES,
  formatRange,
  getGeneticCode,
  getQualifier,
  makeFeature,
  normalizeRange,
  proteinIsoelectricPoint,
  proteinMolecularWeight,
  rangeFromInclusive,
  rangeLength,
  reverseComplement,
  sliceRange,
  translate,
} from '@hhereditas/core';
import { featureTypeColor, hasSelectedBases } from '@hhereditas/viewer';
import {
  Button,
  Checkbox,
  Field,
  IconButton,
  Popover,
  PopoverContent,
  PopoverTrigger,
  SegmentedControl,
  Select,
  Sheet,
  TextField,
} from '@hhereditas/ui';
import { ArrowLeft, ArrowRight, Copy, Crosshair, Minus, MoveHorizontal, Plus, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { deleteFeatureCommand } from '../../app/commands';
import { featureTypeOptions } from '../../shell';
import type { DocumentState } from '../../state/documents';
import { useApp } from '../../state/store';
import styles from './FeatureSheet.module.css';

export interface AddFeatureSheetProps {
  open: boolean;
  doc: DocumentState | null;
  mode?: 'add' | 'edit';
  featureId?: string;
}

interface SegmentDraft {
  id: number;
  start: string;
  end: string;
}

interface QualifierRow {
  id: number;
  key: string;
  value: string;
  /** An empty field stands for "no value" (a flag such as /pseudo) rather than an empty string. */
  wasNull: boolean;
}

const cx = (...names: Array<string | false | undefined>) => names.filter(Boolean).join(' ');

function rangeToSegmentDraft(id: number, r: Range, seqLen: number): SegmentDraft {
  const first1 = r.start + 1;
  const last1 = r.end <= r.start ? first1 : seqLen > 0 && r.end > seqLen ? r.end - seqLen : r.end;
  return { id, start: String(first1), end: String(last1) };
}

function parseSegmentDraft(
  draft: SegmentDraft,
  seqLen: number,
  topology: Topology,
): { range: Range | null; error?: string } {
  if (seqLen <= 0) return { range: null, error: 'Sequence is empty.' };
  const sText = draft.start.replace(/,/g, '').trim();
  const eText = draft.end.replace(/,/g, '').trim();
  if (!/^\d+$/.test(sText) || !/^\d+$/.test(eText)) {
    return { range: null, error: 'Start and end must be positive whole numbers.' };
  }
  const s1 = Number(sText);
  const e1 = Number(eText);
  if (s1 < 1 || s1 > seqLen || e1 < 1 || e1 > seqLen) {
    return { range: null, error: `Coordinates must be between 1 and ${seqLen.toLocaleString('en-US')}.` };
  }
  if (topology === 'linear' && e1 < s1) {
    return { range: null, error: 'Start cannot exceed end on a linear sequence.' };
  }
  return { range: rangeFromInclusive(s1 - 1, e1 - 1, seqLen, topology) };
}

/** 1-based, unwrapped (end may run past the sequence length on a circular sequence) ends of a range. */
function unwrapped(r: Range): { s: number; e: number } {
  const s = r.start + 1;
  return { s, e: r.end <= r.start ? s : r.end };
}

/** GenBank qualifier keys offered in the key pop-up, with the common ones first. */
const QUALIFIER_KEYS = [
  'note',
  'gene',
  'product',
  'label',
  'locus_tag',
  'standard_name',
  'function',
  'db_xref',
  'protein_id',
  'EC_number',
  'allele',
  'citation',
  'codon_start',
  'transl_table',
  'translation',
  'transl_except',
  'experiment',
  'inference',
  'map',
  'mol_type',
  'old_locus_tag',
  'organism',
  'pseudo',
  'regulatory_class',
  'ribosomal_slippage',
  'bound_moiety',
  'direction',
  'rpt_type',
];

function qualifierKeyOptions(current: string) {
  const keys = QUALIFIER_KEYS.includes(current) || !current ? QUALIFIER_KEYS : [current, ...QUALIFIER_KEYS];
  return keys.map((k) => ({ value: k, label: `/${k}` }));
}

const GREEK_LETTERS = [
  ...'αβγδεζηθικλμνξοπρστυφχψω',
  ...'ΓΔΘΛΞΠΣΦΨΩ',
  '′',
  '″',
  '→',
  '←',
  '×',
  '±',
  '°',
  'µ',
];

const GENETIC_CODE_OPTIONS = GENETIC_CODES.map((c) => ({
  value: String(c.id),
  label: `${c.id} — ${c.name}`,
}));

/** Features made here have no colour of their own: a plain grey, the same whatever the type. */
const DEFAULT_FEATURE_COLOR = '#cccccc';

/** The arrow choices beside the type: a strand, or a marker pointed both ways (no strand). */
type Direction = '1' | '-1' | '0' | 'both';

/** The strand and the both-ends flag a direction stands for. */
function directionToStrand(d: Direction): { strand: Strand; bidirectional: boolean } {
  return { strand: d === '1' ? 1 : d === '-1' ? -1 : 0, bidirectional: d === 'both' };
}

/** The minimum number of rows the segment table shows (empty rows pad it out, as in SnapGene). */
const MIN_TABLE_ROWS = 4;

interface SegmentMapProps {
  ranges: Range[] | null;
  seqLen: number;
  direction: Direction;
  color: string;
  totalBp: number;
  selected: number;
  onSelect: (idx: number) => void;
}

/** The map above the segment table: every segment drawn as an arrow over the span the feature covers. */
function SegmentMap({ ranges, seqLen, direction, color, totalBp, selected, onSelect }: SegmentMapProps) {
  const W = 560;
  const H = 40;
  const PAD = 10;
  const spans = (ranges ?? []).map(unwrapped);
  const minS = spans.length ? Math.min(...spans.map((x) => x.s)) : 0;
  const maxE = spans.length ? Math.max(...spans.map((x) => x.e)) : 0;
  const total = Math.max(1, maxE - minS + 1);
  const scale = (W - 2 * PAD) / total;
  const x = (pos: number) => PAD + (pos - minS) * scale;
  const wrap1 = (n: number) => (seqLen > 0 && n > seqLen ? n - seqLen : n);

  const arrow = (x1: number, x2: number): string => {
    const top = 11;
    const bottom = 29;
    const mid = 20;
    const head = Math.min(14, (x2 - x1) / 2);
    switch (direction) {
      case '1':
        return `${x1},${top} ${x2 - head},${top} ${x2},${mid} ${x2 - head},${bottom} ${x1},${bottom}`;
      case '-1':
        return `${x2},${top} ${x1 + head},${top} ${x1},${mid} ${x1 + head},${bottom} ${x2},${bottom}`;
      case 'both':
        return `${x1 + head},${top} ${x2 - head},${top} ${x2},${mid} ${x2 - head},${bottom} ${x1 + head},${bottom} ${x1},${mid}`;
      default:
        return `${x1},${top} ${x2},${top} ${x2},${bottom} ${x1},${bottom}`;
    }
  };

  const n = spans.length;
  return (
    <div className={styles.mapBox}>
      <div className={styles.mapTitle}>
        {totalBp.toLocaleString('en-US')} bp&nbsp;/&nbsp;{n} segment{n === 1 ? '' : 's'}
      </div>
      <div className={styles.mapCoords}>
        <span>{n ? wrap1(minS).toLocaleString('en-US') : ''}</span>
        <span>{n ? wrap1(maxE).toLocaleString('en-US') : ''}</span>
      </div>
      <svg
        className={styles.mapSvg}
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height={H}
        preserveAspectRatio="none"
        role="img"
        aria-label="Feature segment map"
      >
        {n ? (
          <>
            <line x1={x(minS)} x2={x(minS)} y1={2} y2={38} className={styles.mapTick} />
            <line x1={x(maxE + 1)} x2={x(maxE + 1)} y1={2} y2={38} className={styles.mapTick} />
          </>
        ) : null}
        {spans.map((sp, idx) => {
          const x1 = x(sp.s);
          const x2 = Math.max(x1 + 2, x(sp.e + 1));
          return (
            <polygon
              key={idx}
              points={arrow(x1, x2)}
              className={cx(styles.mapSegment, idx === selected && styles.mapSegmentSelected)}
              style={{ fill: color, stroke: color }}
              onClick={() => onSelect(idx)}
            >
              <title>Segment {idx + 1}</title>
            </polygon>
          );
        })}
      </svg>
    </div>
  );
}

export function AddFeatureSheet({ open, doc, mode = 'add', featureId }: AddFeatureSheetProps) {
  const nextSegId = useRef(1);
  const nextQualId = useRef(1);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState('');
  const [type, setType] = useState('misc_feature');
  // What the arrows beside the type show: a strand, or 'both' (no strand, drawn pointed at both ends).
  const [direction, setDirection] = useState<Direction>('1');
  // The colour of a feature a file brought along is kept; one made or edited here that has none is given the plain
  // grey. The colour swatch in the table changes it (the whole feature: segments share one colour in this model).
  const [color, setColor] = useState<string | undefined>(undefined);
  const [segments, setSegments] = useState<SegmentDraft[]>([{ id: 1, start: '1', end: '100' }]);
  const [selectedSeg, setSelectedSeg] = useState(0);
  const [qualRows, setQualRows] = useState<QualifierRow[]>([]);
  const [selectedQual, setSelectedQual] = useState<number | null>(null);

  // Coding Sequence (CDS) & Translation state
  const [isTranslated, setIsTranslated] = useState(false);
  const [codonStart, setCodonStart] = useState<'1' | '2' | '3'>('1');
  const [translTable, setTranslTable] = useState<string>('1');
  const [partialStart, setPartialStart] = useState(false);
  const [partialEnd, setPartialEnd] = useState(false);
  const [autoTranslate, setAutoTranslate] = useState(true);
  const [translationViewMode, setTranslationViewMode] = useState<'aa' | 'codons'>('aa');
  const [translationOptionsOpen, setTranslationOptionsOpen] = useState(false);

  // Small popovers
  const [greekOpen, setGreekOpen] = useState(false);
  const [splitOpen, setSplitOpen] = useState(false);
  const [splitAt, setSplitAt] = useState('');

  const targetFeatureId =
    featureId ?? (doc?.selectedItem?.kind === 'feature' ? doc.selectedItem.id : doc?.selectedFeatureIds?.[0]);
  const existingFeature: Feature | null = useMemo(() => {
    if (mode !== 'edit' || !doc || !targetFeatureId) return null;
    return doc.record.features.find((f) => f.id === targetFeatureId) ?? null;
  }, [mode, doc, targetFeatureId]);

  const seqLen = doc?.record.seq.length ?? 0;
  const topology: Topology = doc?.record.topology ?? 'circular';
  const hasSelection = !!doc && hasSelectedBases(doc.selection);

  useEffect(() => {
    if (!open || !doc) return;
    const len = doc.record.seq.length;
    setSelectedSeg(0);
    setSelectedQual(null);
    setTranslationOptionsOpen(false);
    setGreekOpen(false);
    setSplitOpen(false);
    if (mode === 'edit' && existingFeature) {
      setName(existingFeature.name);
      setType(existingFeature.type);
      setDirection(
        existingFeature.strand === 0 && existingFeature.bidirectional ? 'both' : (String(existingFeature.strand) as Direction),
      );
      setColor(existingFeature.color);
      const segs =
        existingFeature.segments.length > 0
          ? existingFeature.segments.map((r) => rangeToSegmentDraft(nextSegId.current++, r, len))
          : [{ id: nextSegId.current++, start: '1', end: String(Math.max(1, Math.min(100, len))) }];
      setSegments(segs);
      // The /label that only repeats the name is the name field; every other qualifier is listed.
      setQualRows(
        existingFeature.qualifiers
          .filter((q) => !(q.key === 'label' && q.value === existingFeature.name))
          .map((q) => ({ id: nextQualId.current++, key: q.key, value: q.value ?? '', wasNull: q.value === null })),
      );

      const hasTranslationQualifiers = existingFeature.qualifiers.some(
        (q) => q.key === 'translation' || q.key === 'codon_start' || q.key === 'transl_table',
      );
      const shouldTranslate = existingFeature.type === 'CDS' || hasTranslationQualifiers;
      setIsTranslated(shouldTranslate);

      const cs = getQualifier(existingFeature.qualifiers, 'codon_start')?.trim();
      setCodonStart(cs === '2' || cs === '3' ? cs : '1');

      const tt = getQualifier(existingFeature.qualifiers, 'transl_table')?.trim();
      const validTt = tt && GENETIC_CODES.some((c) => String(c.id) === tt) ? tt : '1';
      setTranslTable(validTt);

      setPartialStart(existingFeature.partialStart === true);
      setPartialEnd(existingFeature.partialEnd === true);

      setAutoTranslate(
        shouldTranslate
          ? existingFeature.qualifiers.some((q) => q.key === 'translation') || existingFeature.qualifiers.length <= 2
          : true,
      );
      return;
    }

    // Add mode defaults
    setName('');
    setType('misc_feature');
    setDirection('1');
    setColor(undefined);
    setQualRows([]);
    setIsTranslated(false);
    setCodonStart('1');
    setTranslTable('1');
    setPartialStart(false);
    setPartialEnd(false);
    setAutoTranslate(true);

    const sel = doc.selection;
    if (hasSelectedBases(sel)) {
      const r = normalizeRange(sel.range, len, doc.record.topology);
      setSegments([rangeToSegmentDraft(nextSegId.current++, r, len)]);
    } else {
      const endDefault = len > 0 ? Math.min(100, len) : 1;
      setSegments([{ id: nextSegId.current++, start: '1', end: String(endDefault) }]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mode, existingFeature?.id]);

  const handleTypeChange = (nextType: string) => {
    setType(nextType);
    if (nextType === 'CDS') {
      setIsTranslated(true);
      // a CDS is read 5'->3' along one strand: a direction-less marker becomes a forward one
      setDirection((d) => (d === '1' || d === '-1' ? d : '1'));
    }
  };

  const handleTranslatedToggle = (checked: boolean) => {
    setIsTranslated(checked);
    if (checked && type === 'misc_feature') setType('CDS');
    if (!checked) setTranslationOptionsOpen(false);
  };

  const parsedSegments = useMemo(
    () => segments.map((s) => parseSegmentDraft(s, seqLen, topology)),
    [segments, seqLen, topology],
  );

  const segmentError = parsedSegments.find((p) => p.error)?.error;
  const validRanges: Range[] | null = useMemo(() => {
    if (parsedSegments.length === 0 || parsedSegments.some((p) => !p.range)) return null;
    return parsedSegments.map((p) => p.range!);
  }, [parsedSegments]);

  const totalBp = useMemo(() => (validRanges ? validRanges.reduce((sum, r) => sum + rangeLength(r), 0) : 0), [validRanges]);

  // Spliced DNA sequence on top strand and feature strand (what gets translated)
  const topDnaSeq = useMemo(() => {
    if (!doc || !validRanges) return '';
    return validRanges.map((r) => sliceRange(doc.record.seq, r)).join('');
  }, [doc, validRanges]);

  const featureDnaSeq = useMemo(
    () => (topDnaSeq && direction === '-1' ? reverseComplement(topDnaSeq) : topDnaSeq),
    [topDnaSeq, direction],
  );

  // Live translation & protein statistics
  const rawTranslation = useMemo(() => {
    if (!isTranslated || !featureDnaSeq || totalBp < 3) return '';
    try {
      const frame = (Number(codonStart) - 1) as 0 | 1 | 2;
      return translate(featureDnaSeq, { table: Number(translTable) || 1, frame, cds: !partialStart });
    } catch {
      return '';
    }
  }, [isTranslated, featureDnaSeq, totalBp, codonStart, translTable, partialStart]);

  const translatedAa = useMemo(() => rawTranslation.replace(/\*$/, ''), [rawTranslation]);

  const proteinStats = useMemo(() => {
    const cleanProtein = rawTranslation.replace(/\*/g, '');
    const frameSeq = featureDnaSeq.slice(Number(codonStart) - 1);
    const numCodons = Math.floor(frameSeq.length / 3);
    const firstCodon = numCodons >= 1 ? frameSeq.slice(0, 3).toUpperCase() : null;
    const lastCodon = numCodons >= 1 ? frameSeq.slice((numCodons - 1) * 3, numCodons * 3).toUpperCase() : null;

    let isValidStart = false;
    let isValidStop = false;
    try {
      const code = getGeneticCode(Number(translTable) || 1);
      if (firstCodon) isValidStart = code.startCodons.includes(firstCodon);
      if (lastCodon) isValidStop = code.stopCodons.includes(lastCodon);
    } catch {
      // unknown table: no start/stop check
    }

    let mwKda: string | null = null;
    let piText: string | null = null;
    if (cleanProtein.length > 0) {
      try {
        const mwDa = proteinMolecularWeight(cleanProtein);
        if (Number.isFinite(mwDa) && mwDa > 0) mwKda = `${(mwDa / 1000).toFixed(2)} kDa`;
      } catch {
        mwKda = null;
      }
      try {
        const pi = proteinIsoelectricPoint(cleanProtein, { interval: 'unbounded' });
        if (Number.isFinite(pi)) piText = `pI ${pi.toFixed(2)}`;
      } catch {
        piText = null;
      }
    }

    const codons: Array<{ index1: number; triplet: string; aa: string }> = [];
    for (let k = 0; k < numCodons; k++) {
      codons.push({ index1: k + 1, triplet: frameSeq.slice(k * 3, k * 3 + 3).toUpperCase(), aa: rawTranslation[k] ?? '?' });
    }
    return { aaLength: cleanProtein.length, mwKda, piText, firstCodon, lastCodon, isValidStart, isValidStop, codons };
  }, [rawTranslation, codonStart, featureDnaSeq, translTable]);

  const valid = !!doc && seqLen > 0 && !!validRanges && name.trim().length > 0;

  // ----- segments -----
  const selIdx = Math.min(selectedSeg, Math.max(0, segments.length - 1));
  const wrap1 = (n: number) => (seqLen > 0 ? ((n - 1) % seqLen) + 1 : n);

  const updateSegment = (id: number, patch: Partial<Pick<SegmentDraft, 'start' | 'end'>>) => {
    setSegments((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  };

  const openSplit = () => {
    const parsed = parsedSegments[selIdx];
    if (!parsed?.range) return;
    const { s } = unwrapped(parsed.range);
    const len = rangeLength(parsed.range);
    setSplitAt(String(wrap1(s + Math.max(0, Math.floor(len / 2) - 1))));
    setSplitOpen(true);
  };

  /** The unwrapped 1-based position the Split field names, when it leaves at least one base on each side. */
  const splitPosition = useMemo((): number | null => {
    const parsed = parsedSegments[selIdx];
    if (!parsed?.range) return null;
    const text = splitAt.replace(/,/g, '').trim();
    if (!/^\d+$/.test(text)) return null;
    const { s, e } = unwrapped(parsed.range);
    let pos = Number(text);
    if (pos < s && e > seqLen) pos += seqLen; // the segment wraps past the origin
    return pos >= s && pos < e ? pos : null;
  }, [parsedSegments, selIdx, splitAt, seqLen]);

  const doSplit = () => {
    const parsed = parsedSegments[selIdx];
    if (!parsed?.range || splitPosition === null) return;
    const { s, e } = unwrapped(parsed.range);
    const a: SegmentDraft = { id: nextSegId.current++, start: String(wrap1(s)), end: String(wrap1(splitPosition)) };
    const b: SegmentDraft = { id: nextSegId.current++, start: String(wrap1(splitPosition + 1)), end: String(wrap1(e)) };
    setSegments((prev) => [...prev.slice(0, selIdx), a, b, ...prev.slice(selIdx + 1)]);
    setSplitOpen(false);
  };

  const mergeSegments = () => {
    if (segments.length < 2) return;
    const a = Math.min(selIdx, segments.length - 2);
    setSegments((prev) => {
      const merged: SegmentDraft = { id: prev[a].id, start: prev[a].start, end: prev[a + 1].end };
      return [...prev.slice(0, a), merged, ...prev.slice(a + 2)];
    });
    setSelectedSeg(a);
  };

  const deleteSegment = () => {
    if (segments.length < 2) return;
    setSegments((prev) => prev.filter((_, i) => i !== selIdx));
    setSelectedSeg(Math.max(0, selIdx - 1));
  };

  const addSegment = () => {
    const last = validRanges?.[validRanges.length - 1];
    const nextStart1 =
      last && seqLen > 0 ? Math.min(seqLen, ((last.end > seqLen ? last.end - seqLen : last.end) % seqLen) + 1) : 1;
    const nextEnd1 = seqLen > 0 ? Math.min(seqLen, nextStart1 + Math.min(99, Math.max(0, seqLen - nextStart1))) : 1;
    setSegments((prev) => [...prev, { id: nextSegId.current++, start: String(nextStart1), end: String(nextEnd1) }]);
    setSelectedSeg(segments.length);
  };

  const handleUseSelection = () => {
    if (!doc || !hasSelectedBases(doc.selection)) return;
    const r = normalizeRange(doc.selection.range, seqLen, topology);
    const draft = rangeToSegmentDraft(nextSegId.current++, r, seqLen);
    setSegments((prev) => prev.map((s, i) => (i === selIdx ? { ...draft, id: s.id } : s)));
  };

  // ----- qualifiers -----
  const selQualIdx = qualRows.length === 0 ? null : Math.min(selectedQual ?? qualRows.length - 1, qualRows.length - 1);

  const updateQual = (id: number, patch: Partial<Pick<QualifierRow, 'key' | 'value'>>) => {
    setQualRows((prev) => prev.map((q) => (q.id === id ? { ...q, ...patch } : q)));
  };

  const addQual = () => {
    const at = selQualIdx === null ? qualRows.length : selQualIdx + 1;
    const row: QualifierRow = { id: nextQualId.current++, key: 'note', value: '', wasNull: true };
    setQualRows((prev) => [...prev.slice(0, at), row, ...prev.slice(at)]);
    setSelectedQual(at);
  };

  const removeQual = () => {
    if (selQualIdx === null) return;
    setQualRows((prev) => prev.filter((_, i) => i !== selQualIdx));
    setSelectedQual(selQualIdx > 0 ? selQualIdx - 1 : null);
  };

  const buildFinalQualifiers = (featureName: string): Qualifier[] => {
    const out: Qualifier[] = [];
    let hasLabel = false;
    for (const r of qualRows) {
      const key = r.key.trim();
      if (!key) continue;
      if (key === 'label') {
        if (!hasLabel) {
          out.push({ key: 'label', value: featureName });
          hasLabel = true;
        }
        continue;
      }
      if (isTranslated && (key === 'codon_start' || key === 'transl_table' || (autoTranslate && key === 'translation'))) {
        continue;
      }
      out.push({ key, value: r.value === '' && r.wasNull ? null : r.value });
    }
    if (!hasLabel) out.unshift({ key: 'label', value: featureName });
    if (isTranslated) {
      if (codonStart !== '1' || qualRows.some((q) => q.key === 'codon_start')) {
        out.push({ key: 'codon_start', value: codonStart });
      }
      if (translTable !== '1' || qualRows.some((q) => q.key === 'transl_table')) {
        out.push({ key: 'transl_table', value: translTable });
      }
      if (autoTranslate && translatedAa.length > 0) out.push({ key: 'translation', value: translatedAa });
    }
    return out;
  };

  // ----- name helpers -----
  const insertIntoName = (ch: string) => {
    const el = nameInputRef.current;
    const start = el?.selectionStart ?? name.length;
    const end = el?.selectionEnd ?? name.length;
    setName(name.slice(0, start) + ch + name.slice(end));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + ch.length, start + ch.length);
    });
  };

  const handleCopyProtein = () => {
    if (!translatedAa) return;
    void navigator.clipboard?.writeText(translatedAa);
    useApp.getState().flash(`Copied ${translatedAa.length.toLocaleString('en-US')} aa protein sequence`);
  };

  // ----- save / delete / duplicate -----
  const save = () => {
    if (!valid || !validRanges) return;
    const trimmedName = name.trim();
    const finalQualifiers = buildFinalQualifiers(trimmedName);
    const app = useApp.getState();

    if (mode === 'edit' && existingFeature) {
      const updated: Feature = {
        ...existingFeature,
        type,
        name: trimmedName,
        ...directionToStrand(direction),
        segments: validRanges,
        qualifiers: finalQualifiers,
        color: color ?? DEFAULT_FEATURE_COLOR,
      };
      if (partialStart) updated.partialStart = true;
      else delete updated.partialStart;
      if (partialEnd) updated.partialEnd = true;
      else delete updated.partialEnd;

      app.change(
        (r) => ({ ...r, features: r.features.map((f) => (f.id === existingFeature.id ? updated : f)) }),
        'Edit Feature',
      );
      app.closeSheet();
      app.selectItem({ kind: 'feature', id: existingFeature.id });
      return;
    }

    const feature: Feature = {
      ...makeFeature({
        type,
        name: trimmedName,
        ...directionToStrand(direction),
        segments: validRanges,
        qualifiers: finalQualifiers,
        color: color ?? DEFAULT_FEATURE_COLOR,
      }),
      ...(partialStart ? { partialStart: true } : {}),
      ...(partialEnd ? { partialEnd: true } : {}),
    };
    app.change((r) => ({ ...r, features: [...r.features, feature] }), 'Add Feature');
    app.closeSheet();
    app.selectItem({ kind: 'feature', id: feature.id });
  };

  const handleDelete = () => {
    if (!existingFeature) return;
    const app = useApp.getState();
    deleteFeatureCommand(existingFeature.id);
    app.closeSheet();
    app.flash(`Deleted feature "${existingFeature.name}"`);
  };

  const handleDuplicate = () => {
    if (!valid || !validRanges) return;
    const dupName = `${name.trim() || existingFeature?.name || 'Feature'} (copy)`;
    const dup: Feature = {
      ...makeFeature({
        type,
        name: dupName,
        ...directionToStrand(direction),
        segments: validRanges,
        qualifiers: buildFinalQualifiers(dupName),
        color: color ?? DEFAULT_FEATURE_COLOR,
      }),
      ...(partialStart ? { partialStart: true } : {}),
      ...(partialEnd ? { partialEnd: true } : {}),
    };
    const app = useApp.getState();
    app.change((r) => ({ ...r, features: [...r.features, dup] }), 'Duplicate Feature');
    app.closeSheet();
    app.selectItem({ kind: 'feature', id: dup.id });
    app.flash(`Duplicated feature as "${dupName}"`);
  };

  const isEditMode = mode === 'edit' && !!existingFeature;
  const docName = doc?.record.name?.trim() || 'Untitled';
  const swatchColor = color ?? featureTypeColor(type);
  const mapColor = color ?? DEFAULT_FEATURE_COLOR;
  const padRows = Math.max(0, MIN_TABLE_ROWS - segments.length);

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => {
        if (!o) useApp.getState().closeSheet();
      }}
      title={isEditMode ? `Edit Feature in ${docName}` : `Add Feature to ${docName}`}
      primaryAction={{ label: 'OK', onAction: save, disabled: !valid }}
      footerStart={
        isEditMode ? (
          <div className={styles.footerActions}>
            <Button variant="destructive" size="sm" icon={<Trash2 />} onClick={handleDelete}>
              Delete Feature
            </Button>
            <Button variant="default" size="sm" icon={<Copy />} onClick={handleDuplicate} disabled={!valid}>
              Duplicate
            </Button>
          </div>
        ) : undefined
      }
      width={680}
    >
      <div className={styles.sheetBody}>
        {/* Feature: [name] [αβ] */}
        <div className={styles.formRow}>
          <label className={styles.rowLabel} htmlFor="feature-name">
            Feature:
          </label>
          <TextField
            id="feature-name"
            ref={nameInputRef}
            value={name}
            onValueChange={setName}
            placeholder="e.g. lacZα, AmpR, CMV promoter"
            autoComplete="off"
          />
          <Popover open={greekOpen} onOpenChange={setGreekOpen}>
            <PopoverTrigger asChild>
              <Button size="sm" variant="default" aria-label="Insert Greek letter or symbol" className={styles.greekButton}>
                αβ
              </Button>
            </PopoverTrigger>
            <PopoverContent padding="sm" width={248} align="end">
              <div className={styles.greekGrid}>
                {GREEK_LETTERS.map((ch) => (
                  <button
                    key={ch}
                    type="button"
                    className={styles.greekKey}
                    onClick={() => {
                      insertIntoName(ch);
                      setGreekOpen(false);
                    }}
                  >
                    {ch}
                  </button>
                ))}
              </div>
            </PopoverContent>
          </Popover>
        </div>

        {/* Type: [pop-up]            ⊢⊣ → ← ↔ */}
        <div className={styles.formRow}>
          <span className={styles.rowLabel} id="feature-type-label">
            Type:
          </span>
          <div className={styles.typeCell}>
            <Select
              aria-label="Type"
              value={type}
              onValueChange={handleTypeChange}
              options={featureTypeOptions(type).map((o) => ({ value: o.value, label: o.label }))}
              placement="below"
              width={220}
            />
          </div>
          <SegmentedControl
            aria-label="Directionality"
            iconOnly
            value={direction}
            onValueChange={setDirection}
            options={[
              // a CDS is read in one direction, so only those two are open to it
              { value: '0', label: 'No direction', icon: <Minus />, disabled: type === 'CDS' },
              { value: '1', label: 'Forward', icon: <ArrowRight /> },
              { value: '-1', label: 'Reverse', icon: <ArrowLeft /> },
              { value: 'both', label: 'Both directions', icon: <MoveHorizontal />, disabled: type === 'CDS' },
            ]}
          />
        </div>

        {/* [ ] Translate this feature in Sequence view   [Feature Translation Options…] */}
        <div className={cx(styles.formRow, styles.translateRow)}>
          <span className={styles.rowLabel} />
          <Checkbox
            checked={isTranslated}
            onCheckedChange={(c) => handleTranslatedToggle(c === true)}
            label="Translate this feature in Sequence view"
          />
          <Popover open={translationOptionsOpen} onOpenChange={setTranslationOptionsOpen}>
            <PopoverTrigger asChild>
              <Button size="sm" variant="default" disabled={!isTranslated}>
                Feature Translation Options…
              </Button>
            </PopoverTrigger>
            <PopoverContent width={420} align="end" collisionPadding={12}>
              <div className={styles.optionsPanel}>
                <div className={styles.optionsRow}>
                  <span className={styles.optionsLabel}>Codon start:</span>
                  <SegmentedControl
                    aria-label="Codon start"
                    size="sm"
                    value={codonStart}
                    onValueChange={setCodonStart}
                    options={[
                      { value: '1', label: 'Frame 1' },
                      { value: '2', label: 'Frame 2' },
                      { value: '3', label: 'Frame 3' },
                    ]}
                  />
                </div>
                <Field label="Genetic code (/transl_table)">
                  <Select
                    aria-label="Genetic code"
                    size="sm"
                    value={translTable}
                    onValueChange={setTranslTable}
                    options={GENETIC_CODE_OPTIONS}
                    width="100%"
                  />
                </Field>
                <Checkbox
                  checked={autoTranslate}
                  onCheckedChange={(c) => setAutoTranslate(c === true)}
                  label="Automatically generate /translation"
                />
                <div className={styles.statsBadgesRow}>
                  <span className={styles.statBadge}>{proteinStats.aaLength.toLocaleString('en-US')} aa</span>
                  {proteinStats.mwKda ? <span className={styles.statBadge}>{proteinStats.mwKda}</span> : null}
                  {proteinStats.piText ? <span className={styles.statBadge}>{proteinStats.piText}</span> : null}
                  {proteinStats.firstCodon ? (
                    <span className={cx(styles.statBadge, styles.statBadgeMuted)}>
                      Start: {partialStart ? `<${proteinStats.firstCodon}` : proteinStats.firstCodon}
                      {proteinStats.isValidStart && !partialStart ? ' ✓' : ''}
                    </span>
                  ) : null}
                  {proteinStats.lastCodon ? (
                    <span className={cx(styles.statBadge, styles.statBadgeMuted)}>
                      Stop: {partialEnd ? `${proteinStats.lastCodon}>` : proteinStats.lastCodon}
                      {proteinStats.isValidStop && !partialEnd ? ' (*) ✓' : ''}
                    </span>
                  ) : null}
                </div>
                {translatedAa ? (
                  <>
                    <div className={styles.previewToolbar}>
                      <SegmentedControl
                        aria-label="Translation preview mode"
                        size="sm"
                        value={translationViewMode}
                        onValueChange={setTranslationViewMode}
                        options={[
                          { value: 'aa', label: 'Amino Acids' },
                          { value: 'codons', label: 'Codon Alignment' },
                        ]}
                      />
                      <Button size="sm" variant="plain" icon={<Copy />} onClick={handleCopyProtein}>
                        Copy Protein
                      </Button>
                    </div>
                    {translationViewMode === 'aa' ? (
                      <p className={styles.translationPreview} title="Translated protein sequence">
                        {translatedAa}
                      </p>
                    ) : (
                      <div className={styles.codonAlignmentBox} title="Codon alignment preview">
                        {proteinStats.codons.map((c) => (
                          <span key={c.index1} className={styles.codonChip}>
                            <span className={styles.codonIndex}>{c.index1}</span>
                            <span className={styles.codonTriplet}>{c.triplet}</span>
                            <span className={styles.codonAa}>({c.aa})</span>
                          </span>
                        ))}
                      </div>
                    )}
                  </>
                ) : (
                  <p className={styles.hint}>Valid segment coordinates are required to translate.</p>
                )}
              </div>
            </PopoverContent>
          </Popover>
        </div>

        {/* Segment map with Split / Merge / Delete beside it */}
        <div className={styles.mapRow}>
          <SegmentMap
            ranges={validRanges}
            seqLen={seqLen}
            direction={direction}
            color={mapColor}
            totalBp={totalBp}
            selected={selIdx}
            onSelect={setSelectedSeg}
          />
          <div className={styles.mapButtons}>
            <Popover open={splitOpen} onOpenChange={setSplitOpen}>
              <PopoverTrigger asChild>
                <Button size="sm" variant="default" disabled={!parsedSegments[selIdx]?.range} onClick={openSplit}>
                  Split Feature…
                </Button>
              </PopoverTrigger>
              <PopoverContent width={240} align="end">
                <div className={styles.splitPanel}>
                  <Field label={`Split segment ${selIdx + 1} after base`}>
                    <TextField
                      size="sm"
                      mono
                      aria-label="Split position"
                      value={splitAt}
                      onValueChange={setSplitAt}
                      invalid={splitAt.trim() !== '' && splitPosition === null}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          e.stopPropagation();
                          doSplit();
                        }
                      }}
                    />
                  </Field>
                  <p className={styles.hint}>The first part ends at this base; the second starts right after it.</p>
                  <div className={styles.splitActions}>
                    <Button size="sm" variant="primary" disabled={splitPosition === null} onClick={doSplit}>
                      Split
                    </Button>
                  </div>
                </div>
              </PopoverContent>
            </Popover>
            <Button size="sm" variant="default" disabled={segments.length < 2} onClick={mergeSegments}>
              Merge Segments
            </Button>
            <Button size="sm" variant="default" disabled={segments.length < 2} onClick={deleteSegment}>
              Delete Segment
            </Button>
          </div>
        </div>

        {/* Segment table */}
        <div className={styles.tableBox}>
          <table className={styles.segmentTable}>
            <thead>
              <tr>
                <th className={styles.colIndex} />
                <th className={styles.colName}>Segment</th>
                <th className={styles.colLocation}>Location</th>
                <th className={styles.colSize}>Size (bp)</th>
                <th className={styles.colColor}>Color</th>
              </tr>
            </thead>
            <tbody>
              {segments.map((seg, idx) => {
                const parsed = parsedSegments[idx];
                const segLen = parsed?.range ? rangeLength(parsed.range) : null;
                const segName = segments.length > 1 ? `${name.trim() || 'Feature'} (${idx + 1})` : name.trim() || '—';
                return (
                  <tr
                    key={seg.id}
                    className={cx(styles.segmentRow, idx === selIdx && styles.segmentRowSelected)}
                    onClick={() => setSelectedSeg(idx)}
                    onFocusCapture={() => setSelectedSeg(idx)}
                    aria-selected={idx === selIdx}
                  >
                    <td className={styles.colIndex}>{idx + 1}</td>
                    <td className={styles.colName} title={segName}>
                      {segName}
                    </td>
                    <td className={styles.colLocation}>
                      <div className={styles.locationCell}>
                        <TextField
                          size="sm"
                          mono
                          aria-label={`Segment ${idx + 1} Start`}
                          value={seg.start}
                          invalid={!!parsed?.error}
                          onValueChange={(v) => updateSegment(seg.id, { start: v })}
                          className={styles.coordField}
                        />
                        <span className={styles.rangeDots}>..</span>
                        <TextField
                          size="sm"
                          mono
                          aria-label={`Segment ${idx + 1} End`}
                          value={seg.end}
                          invalid={!!parsed?.error}
                          onValueChange={(v) => updateSegment(seg.id, { end: v })}
                          className={styles.coordField}
                        />
                      </div>
                    </td>
                    <td className={styles.colSize}>{segLen !== null ? segLen.toLocaleString('en-US') : '—'}</td>
                    <td className={styles.colColor}>
                      <label className={styles.swatch} style={{ background: swatchColor }} title="Feature color">
                        <input
                          type="color"
                          className={styles.colorInput}
                          aria-label="Feature color"
                          value={color ?? DEFAULT_FEATURE_COLOR}
                          onChange={(e) => setColor(e.target.value)}
                        />
                      </label>
                    </td>
                  </tr>
                );
              })}
              {Array.from({ length: padRows }, (_, i) => (
                <tr key={`pad-${i}`} className={styles.padRow} aria-hidden="true">
                  <td className={styles.colIndex} />
                  <td colSpan={4} />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className={styles.tableFooter}>
          <div className={styles.tableFooterStart}>
            <Button size="sm" variant="plain" icon={<Plus />} onClick={addSegment}>
              Add Segment
            </Button>
            <Button size="sm" variant="plain" icon={<Crosshair />} disabled={!hasSelection} onClick={handleUseSelection}>
              Use Selection
            </Button>
          </div>
          <div className={styles.partialRow}>
            <Checkbox checked={partialStart} onCheckedChange={(c) => setPartialStart(c === true)} label="5′ partial (<)" />
            <Checkbox checked={partialEnd} onCheckedChange={(c) => setPartialEnd(c === true)} label="3′ partial (>)" />
          </div>
        </div>
        {segmentError ? <p className={styles.errorText}>{segmentError}</p> : null}
        {validRanges && seqLen > 0 ? (
          <p className={styles.locationSummary}>{validRanges.map((r) => formatRange(r, seqLen)).join(', ')}</p>
        ) : null}

        {/* Qualifiers: /key = value, with + / − */}
        <div className={styles.qualSection}>
          <div className={styles.qualList}>
            {qualRows.map((row, idx) => (
              <div
                key={row.id}
                className={cx(styles.qualRow, idx === selQualIdx && styles.qualRowSelected)}
                onClick={() => setSelectedQual(idx)}
                onFocusCapture={() => setSelectedQual(idx)}
              >
                <div className={styles.qualKeyRow}>
                  <Select
                    aria-label={`Qualifier ${idx + 1} key`}
                    size="sm"
                    value={row.key}
                    onValueChange={(k) => updateQual(row.id, { key: k })}
                    options={qualifierKeyOptions(row.key)}
                    placement="below"
                    width={150}
                  />
                  <span className={styles.equals}>=</span>
                </div>
                <textarea
                  className={styles.qualValue}
                  aria-label={`Qualifier ${idx + 1} value`}
                  value={row.value}
                  rows={row.key === 'translation' ? 4 : 3}
                  spellCheck={false}
                  onChange={(e) => updateQual(row.id, { value: e.target.value })}
                />
              </div>
            ))}
            {qualRows.length === 0 ? (
              <p className={styles.qualEmpty}>No qualifiers. Click + to add a GenBank qualifier (/note, /gene, /product…).</p>
            ) : null}
          </div>
          <div className={styles.qualButtons}>
            <IconButton size="sm" variant="default" icon={<Plus />} aria-label="Add qualifier" onClick={addQual} />
            <IconButton
              size="sm"
              variant="default"
              icon={<Minus />}
              aria-label="Remove qualifier"
              disabled={qualRows.length === 0}
              onClick={removeQual}
            />
          </div>
        </div>
      </div>
    </Sheet>
  );
}
