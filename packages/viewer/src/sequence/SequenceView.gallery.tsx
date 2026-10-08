/**
 * Gallery stories of the sequence view: /?gallery=SequenceView&story=<name> (&theme=dark).
 */
import type { EnzymeSite, Orf, PrimerBindingSite, SearchHit, SeqRecord } from '@hhereditas/core';
import { type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactNode, useCallback, useMemo, useState } from 'react';
import { formatBp, formatInt } from '../common/format';
import { SAMPLES } from '../fixtures';
import type { SequenceSelection } from '../selection';
import { SequenceView, type SequenceViewProps } from './SequenceView';
import { applyEditNaive, demoPrimersFor, findDemoOrfs, findDemoSites, findMotif, syntheticGenome } from './sequenceGalleryData';
import type { MapTarget, SequenceEdit } from './types';

type GalleryStories = Record<string, () => ReactNode>;

const statusStyle: CSSProperties = {
  height: 'var(--hh-statusbar-height)',
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--hh-space-4)',
  padding: '0 var(--hh-space-3)',
  borderTop: '1px solid var(--hh-separator)',
  background: 'var(--hh-bg-window)',
  color: 'var(--hh-text-secondary)',
  fontSize: 'var(--hh-text-sm)',
  fontVariantNumeric: 'tabular-nums',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
};

function describe(sel: SequenceSelection | null, L: number): string {
  if (!sel) return 'No selection';
  const len = sel.range.end - sel.range.start;
  if (len <= 0) return `Cursor ${formatInt(sel.caret)}`;
  const last = sel.range.end > L ? sel.range.end - L : sel.range.end;
  return `${formatInt(sel.range.start + 1)}..${formatInt(last)} · ${formatBp(len)}`;
}

interface HarnessProps extends Omit<SequenceViewProps, 'record' | 'selection' | 'onSelectionChange'> {
  record: SeqRecord;
  initialSelection?: SequenceSelection | null;
  scrollToPosition?: number;
  /** Recompute demo enzyme sites after each edit. */
  liveSites?: boolean;
  status?: boolean;
  frameWidth?: number;
}

/** Stateful wrapper: selection, hover, naive edits and a status line. */
function Harness({ record, initialSelection = null, scrollToPosition, liveSites, status, frameWidth, enzymeSites, ...rest }: HarnessProps) {
  const [rec, setRec] = useState(record);
  const [selection, setSelection] = useState<SequenceSelection | null>(initialSelection);
  const [hovered, setHovered] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const sites = useMemo(
    () => (liveSites ? findDemoSites(rec.seq, rec.topology === 'circular') : enzymeSites),
    [liveSites, rec.seq, rec.topology, enzymeSites],
  );
  const scrollTo = useMemo(
    () => (scrollToPosition !== undefined ? { position: scrollToPosition, requestId: 1 } : undefined),
    [scrollToPosition],
  );
  const onEdit = useCallback((edit: SequenceEdit) => {
    setRec((r) => applyEditNaive(r, edit));
    setMessage(
      edit.kind === 'insert'
        ? `Inserted ${edit.bases.length} bp at ${formatInt(edit.gap)}`
        : edit.kind === 'delete'
          ? `Deleted ${formatBp(edit.range.end - edit.range.start)}`
          : `Replaced ${formatBp(edit.range.end - edit.range.start)} with ${formatBp(edit.bases.length)}`,
    );
  }, []);
  const onContextMenu = useCallback((target: MapTarget, event: ReactMouseEvent) => {
    event.preventDefault();
    setMessage(`Context menu: ${target.kind}${'position' in target ? ` ${formatInt(target.position)}` : 'id' in target ? ` ${target.id}` : ''}`);
  }, []);
  const hoveredName = hovered ? rec.features.find((f) => f.id === hovered)?.name : null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', width: frameWidth ?? '100%', borderRight: frameWidth ? '1px solid var(--hh-separator)' : undefined }}>
      <div style={{ flex: 1, minHeight: 0 }}>
        <SequenceView
          record={rec}
          enzymeSites={sites}
          selection={selection}
          onSelectionChange={setSelection}
          highlightedFeatureId={hovered}
          onFeatureHover={setHovered}
          onEdit={onEdit}
          onInvalidInput={(text) => setMessage(`Not DNA: “${text.length > 24 ? `${text.slice(0, 24)}…` : text}”`)}
          onContextMenu={onContextMenu}
          scrollTo={scrollTo}
          {...rest}
        />
      </div>
      {status && (
        <div style={statusStyle}>
          <span style={{ color: 'var(--hh-text)', fontWeight: 'var(--hh-weight-medium)' as CSSProperties['fontWeight'] }}>{rec.name}</span>
          <span>{`${formatBp(rec.seq.length)} ${rec.topology}`}</span>
          <span>{describe(selection, rec.seq.length)}</span>
          {hoveredName && <span>{hoveredName}</span>}
          {message && <span style={{ color: 'var(--hh-text)' }}>{message}</span>}
        </div>
      )}
    </div>
  );
}

const pFA6aPrimers = demoPrimersFor(SAMPLES.pFA6a.record);
const pBAD30Orfs: Orf[] = findDemoOrfs(SAMPLES.pBAD30.record.seq, 100);

function sample(name: keyof typeof SAMPLES, extra: Partial<HarnessProps> = {}) {
  const s = SAMPLES[name];
  return () => <Harness record={s.record} enzymeSites={s.enzymeSites} {...extra} />;
}

let genomeSearch: SearchHit[] | null = null;

function GenomeStory() {
  const g = useMemo(() => syntheticGenome(), []);
  const hits = useMemo(() => (genomeSearch ??= findMotif(g.record.seq.slice(0, 200_000), 'GGATCC')), [g]);
  return <Harness record={g.record} enzymeSites={g.enzymeSites} searchHits={hits} status scrollToPosition={2_320_000} />;
}

const emptyRecord: SeqRecord = {
  id: 'empty',
  name: 'Untitled',
  description: '',
  seq: '',
  topology: 'linear',
  molecule: 'DNA',
  features: [],
  primers: [],
  meta: {},
};

const stickyFragment: SeqRecord = {
  ...SAMPLES.linear.record,
  id: 'fragment',
  name: 'EcoRI–BamHI fragment',
  seq: SAMPLES.linear.record.seq.slice(0, 240),
  features: SAMPLES.linear.record.features.filter((f) => f.segments.every((s) => s.end <= 240)),
  ends: { left: { kind: '5prime', length: 4 }, right: { kind: '5prime', length: 4 } },
};

const pFA6aSites: readonly EnzymeSite[] = SAMPLES.pFA6a.enzymeSites;
const pFA6aPrimerSites: readonly PrimerBindingSite[] = pFA6aPrimers.primerSites;

export default {
  pFA6a: () => <Harness record={pFA6aPrimers.record} enzymeSites={pFA6aSites} primerSites={pFA6aPrimerSites} />,
  pBAD30: sample('pBAD30'),
  pBR322: sample('pBR322'),
  linear: sample('linear'),
  editing: () => (
    <Harness
      record={SAMPLES.pFA6a.record}
      liveSites
      editable
      status
      initialSelection={{ range: { start: 470, end: 470 }, caret: 470 }}
      scrollToPosition={470}
    />
  ),
  'selection-rows': sample('pBAD30', {
    status: true,
    initialSelection: { range: { start: 2240, end: 2520 }, caret: 2520 },
    scrollToPosition: 2300,
  }),
  'selection-origin': sample('pFA6a', {
    status: true,
    initialSelection: { range: { start: 3870, end: 3938 + 75 }, caret: 75 },
    scrollToPosition: 3900,
  }),
  translations: sample('linear', {
    status: true,
    initialSelection: { range: { start: 528, end: 531 }, caret: 531 },
    scrollToPosition: 560,
  }),
  'reverse-cds': sample('pFA6a', { scrollToPosition: 3400 }),
  primers: () => (
    <Harness
      record={pFA6aPrimers.record}
      enzymeSites={pFA6aSites}
      primerSites={pFA6aPrimerSites}
      scrollToPosition={420}
      status
    />
  ),
  'primers-origin': () => (
    <Harness record={pFA6aPrimers.record} enzymeSites={pFA6aSites} primerSites={pFA6aPrimerSites} scrollToPosition={3900} />
  ),
  search: () => (
    <Harness
      record={SAMPLES.pBR322.record}
      enzymeSites={SAMPLES.pBR322.enzymeSites}
      searchHits={findMotif(SAMPLES.pBR322.record.seq, 'GCGC')}
      status
    />
  ),
  orfs: () => <Harness record={SAMPLES.pBAD30.record} enzymeSites={SAMPLES.pBAD30.enzymeSites} orfs={pBAD30Orfs} scrollToPosition={1100} />,
  narrow: sample('pFA6a', { frameWidth: 600 }),
  wide: sample('pFA6a', { frameWidth: 1600 }),
  'no-complement': sample('pBR322', { show: { complement: false } }),
  'bases-per-row-60': sample('linear', { basesPerRow: 60 }),
  'sticky-ends': () => <Harness record={stickyFragment} enzymeSites={findDemoSites(stickyFragment.seq, false)} />,
  empty: () => <Harness record={emptyRecord} editable status />,
  'genome-4.6Mb': () => <GenomeStory />,
} satisfies GalleryStories;
