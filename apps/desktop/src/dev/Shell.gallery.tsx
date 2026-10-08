/**
 * Application-shell gallery: full windows built from the shell components with real sample
 * records. Open with ?gallery=Shell&story=<name> (&theme=dark, &platform=mac|windows).
 * The map and sequence areas are neutral placeholders until the visualizations land.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { BookOpenText, ScanSearch } from 'lucide-react';
import type { EnzymeSite, Feature, Range, SeqRecord } from '@hhereditas/core';
import { featureExtent } from '@hhereditas/core';
import { selectRange, type SequenceSelection } from '@hhereditas/viewer';
import { Button } from '@hhereditas/ui';
import { SAMPLES, type SampleName } from '../../../../packages/viewer/src/fixtures';
import {
  AppShell,
  Inspector,
  MainArea,
  Sidebar,
  StatusBar,
  ToolbarContent,
  WelcomeScreen,
  enzymeRows,
  formatDocumentSubtitle,
  formatLength,
  summarizeSequence,
  useSelectionSummary,
  useSequenceIndex,
  type DocumentSummary,
  type EnzymeDisplay,
  type FeatureEdit,
  type RecentFile,
  type SampleSequence,
  type SidebarItemRef,
  type ViewMode,
} from '../shell';
import type { GalleryStories } from './Gallery';

// ---------------------------------------------------------------------------
// Sample data
// ---------------------------------------------------------------------------

const DOC_ORDER: SampleName[] = ['pFA6a', 'pBR322', 'pBAD30', 'linear'];

const EXTRA_PRIMERS: SeqRecord['primers'] = [
  { id: 'p1', name: 'kanMX-F', sequence: 'CGGATCCCCGGGTTAATTAA' },
  { id: 'p2', name: 'kanMX-R', sequence: 'GAATTCGAGCTCGTTTAAAC' },
  { id: 'p3', name: 'TEF-seq', sequence: 'GGAAGTTTGAGCAGATTCAGC' },
];

function sampleRecord(name: SampleName): SeqRecord {
  const record = SAMPLES[name].record;
  return name === 'pFA6a' ? { ...record, primers: EXTRA_PRIMERS } : record;
}

/** The sites the enzyme menu choice displays (the real filtering lives in the app). */
function sitesFor(sites: readonly EnzymeSite[], display: EnzymeDisplay): EnzymeSite[] {
  if (display === 'none') return [];
  if (display === 'common' || display === 'custom') return [...sites];
  const counts = new Map(enzymeRows(sites).map((r) => [r.name, r.count]));
  const limit = display === 'unique' ? 1 : 2;
  return sites.filter((s) => (counts.get(s.enzyme) ?? 0) <= limit);
}

function countMatches(seq: string, query: string): number {
  const q = query.trim().toUpperCase();
  if (q.length < 2) return 0;
  let n = 0;
  for (let i = seq.indexOf(q); i >= 0; i = seq.indexOf(q, i + 1)) n++;
  return n;
}

/** A synthetic 4.6 Mb genome with ~4,500 features (performance check). */
function syntheticGenome(): { record: SeqRecord; enzymeSites: EnzymeSite[] } {
  const length = 4_641_652;
  let seed = 42;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const chunk: string[] = [];
  const bases = 'ACGT';
  for (let i = 0; i < 65_536; i++) chunk.push(bases[Math.floor(rnd() * 4)]);
  const block = chunk.join('');
  const seq = block.repeat(Math.ceil(length / block.length)).slice(0, length);
  const features: Feature[] = [];
  const types = ['CDS', 'gene', 'promoter', 'terminator', 'misc_feature', 'rep_origin', 'ncRNA'];
  let pos = 190;
  for (let i = 0; pos < length - 3000; i++) {
    const len = 240 + Math.floor(rnd() * 1800);
    const type = i % 9 === 0 ? types[2 + (i % 5)] : 'CDS';
    const strand = rnd() > 0.5 ? 1 : -1;
    features.push({
      id: `g${i}`,
      type,
      name: type === 'CDS' ? `b${String(i).padStart(4, '0')}` : `${type.replace('_', ' ')} ${i}`,
      strand,
      segments: [{ start: pos, end: pos + len }],
      qualifiers: [
        { key: 'locus_tag', value: `b${String(i).padStart(4, '0')}` },
        { key: 'product', value: type === 'CDS' ? 'hypothetical protein' : type },
      ],
    });
    pos += len + 40 + Math.floor(rnd() * 400);
  }
  const enzymeSites: EnzymeSite[] = [];
  const enzymes = ['NotI', 'AscI', 'PacI', 'SfiI', 'SwaI', 'PmeI', 'SbfI', 'FseI'];
  enzymes.forEach((enzyme, k) => {
    const count = 1 + (k % 4);
    for (let j = 0; j < count; j++) {
      const at = Math.floor(rnd() * (length - 10));
      enzymeSites.push({ enzyme, range: { start: at, end: at + 8 }, strand: 1, cuts: [{ top: at + 2, bottom: at + 6 }] });
    }
  });
  return {
    record: {
      id: 'ecoli',
      name: 'E. coli K-12 MG1655 (synthetic)',
      description: 'Synthetic 4.6 Mb test genome',
      seq,
      topology: 'circular',
      molecule: 'DNA',
      features,
      primers: [],
      meta: {},
    },
    enzymeSites,
  };
}

const RECENT: RecentFile[] = [
  { id: '/u/plasmids/pFA6a-kanMX6.gb', name: 'pFA6a-kanMX6.gb', location: '~/Documents/Plasmids', modified: 'Today', topology: 'circular' },
  { id: '/u/plasmids/pUC19.dna', name: 'pUC19.dna', location: '~/Documents/Plasmids', modified: 'Yesterday', topology: 'circular' },
  { id: '/u/lab/lenti/pLKO.1-puro.gb', name: 'pLKO.1-puro.gb', location: '~/Lab/Lentivirus', modified: '12 Mar', topology: 'circular' },
  { id: '/u/lab/primers/amplicon-7.fasta', name: 'amplicon-7.fasta', location: '~/Lab/PCR', modified: '3 Mar', topology: 'linear' },
  { id: '/u/downloads/NC_000913.3.gb', name: 'NC_000913.3.gb', location: '~/Downloads', modified: 'Feb 2026' },
];

const SAMPLE_LIST: SampleSequence[] = [
  { id: 'pFA6a', name: 'pFA6a-kanMX6', description: 'Yeast gene deletion cassette', length: 3938, topology: 'circular' },
  { id: 'pBR322', name: 'pBR322', description: 'Classic E. coli cloning vector', length: 4361, topology: 'circular' },
  { id: 'pBAD30', name: 'pBAD30', description: 'Arabinose-inducible expression', length: 4923, topology: 'circular' },
  { id: 'linear', name: 'pPRIME-CMV-dsRed', description: 'Lentiviral transfer vector (linear)', length: 8596, topology: 'linear' },
];

// ---------------------------------------------------------------------------
// Window frame: on macOS the system draws the traffic lights over the title bar; the gallery
// mocks them (decoration only) so title-bar spacing can be judged in screenshots.
// ---------------------------------------------------------------------------

const LIGHTS = ['var(--hh-red)', 'var(--hh-yellow)', 'var(--hh-green)'];

function Frame({ children }: { children: ReactNode }) {
  const mac = document.documentElement.classList.contains('hh-platform-mac');
  return (
    <div style={{ position: 'relative', height: '100%' }}>
      {children}
      {mac ? (
        <div
          aria-hidden
          style={{
            position: 'absolute',
            top: 'calc(var(--hh-toolbar-height) / 2 - 6px)',
            left: 20,
            zIndex: 100,
            display: 'flex',
            gap: 8,
            pointerEvents: 'none',
          }}
        >
          {LIGHTS.map((c) => (
            <span
              key={c}
              style={{
                width: 12,
                height: 12,
                borderRadius: '50%',
                background: c,
                boxShadow: 'inset 0 0 0 0.5px var(--hh-separator-strong)',
              }}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// An interactive document window
// ---------------------------------------------------------------------------

interface WindowOptions {
  sample?: SampleName;
  view?: ViewMode;
  sidebar?: boolean;
  inspector?: boolean;
  /** Name of the feature selected at start (null: caret only). */
  select?: string | null;
  windowActive?: boolean;
  search?: string;
  /** Use the synthetic 4.6 Mb genome. */
  genome?: boolean;
}

function DocumentWindow({
  sample: initialSample = 'pFA6a',
  view: initialView = 'map',
  sidebar: initialSidebar = true,
  inspector: initialInspector = true,
  select = 'AmpR',
  windowActive = true,
  search: initialSearch = '',
  genome = false,
}: WindowOptions) {
  const big = useMemo(() => (genome ? syntheticGenome() : null), [genome]);
  const [active, setActive] = useState<SampleName>(initialSample);
  const [edits, setEdits] = useState<Record<string, Feature[]>>({});
  const base = big ? big.record : sampleRecord(active);
  const record = useMemo<SeqRecord>(() => ({ ...base, features: edits[base.id] ?? base.features }), [base, edits]);
  const allSites = big ? big.enzymeSites : SAMPLES[active].enzymeSites;
  const n = record.seq.length;

  const [view, setView] = useState<ViewMode>(initialView);
  const [sidebarVisible, setSidebarVisible] = useState(initialSidebar);
  const [inspectorVisible, setInspectorVisible] = useState(initialInspector);
  const [enzymeDisplay, setEnzymeDisplay] = useState<EnzymeDisplay>('unique');
  const [search, setSearch] = useState(initialSearch);
  const [selectedItem, setSelectedItem] = useState<SidebarItemRef | null>(() => {
    const f = select ? record.features.find((x) => x.name === select) : undefined;
    return f ? { kind: 'feature', id: f.id } : null;
  });
  const [selection, setSelection] = useState<SequenceSelection>(() => {
    const f = select ? record.features.find((x) => x.name === select) : undefined;
    if (f) return selectRange(featureExtent(f, n, record.topology), n, record.topology);
    if (genome) return selectRange({ start: 120_000, end: 1_820_000 }, n, record.topology);
    return { range: { start: 1256, end: 1256 }, caret: 1256 };
  });

  const index = useSequenceIndex(record.seq);
  const summary = useSelectionSummary(record, selection);
  const wholeComposition = useMemo(() => summarizeSequence(record, index ?? undefined), [record, index]);
  const sites = useMemo(() => sitesFor(allSites, enzymeDisplay), [allSites, enzymeDisplay]);
  const feature = selectedItem?.kind === 'feature' ? (record.features.find((f) => f.id === selectedItem.id) ?? null) : null;
  const matches = useMemo(() => countMatches(record.seq, search), [record.seq, search]);

  const documents: DocumentSummary[] = big
    ? [{ id: 'ecoli', name: big.record.name, length: n, topology: 'circular' }]
    : DOC_ORDER.map((name) => {
        const r = SAMPLES[name].record;
        return { id: name, name: r.name, length: r.seq.length, topology: r.topology, edited: name === 'pFA6a' };
      });

  const selectItem = (item: SidebarItemRef) => {
    setSelectedItem(item);
    let range: Range | null = null;
    if (item.kind === 'feature') {
      const f = record.features.find((x) => x.id === item.id);
      if (f) range = featureExtent(f, n, record.topology);
    } else if (item.kind === 'enzyme') {
      const site = sites.find((s) => s.enzyme === item.id);
      if (site) range = site.range;
    }
    if (range) setSelection(selectRange(range, n, record.topology));
  };

  const editFeature = (id: string, edit: FeatureEdit) => {
    setEdits((all) => ({
      ...all,
      [record.id]: record.features.map((f) => {
        if (f.id !== id) return f;
        const next: Feature = { ...f };
        if (edit.name !== undefined) next.name = edit.name;
        if (edit.type !== undefined) next.type = edit.type;
        if (edit.strand !== undefined) next.strand = edit.strand;
        if (edit.color !== undefined) next.color = edit.color ?? undefined;
        return next;
      }),
    }));
  };

  return (
    <AppShell
      windowActive={windowActive}
      sidebarVisible={sidebarVisible}
      onSidebarVisibleChange={setSidebarVisible}
      inspectorVisible={inspectorVisible}
      onInspectorVisibleChange={setInspectorVisible}
      toolbar={
        <ToolbarContent
          title={record.name}
          subtitle={formatDocumentSubtitle(n, record.topology)}
          edited={!big && active === 'pFA6a'}
          sidebarVisible={sidebarVisible}
          onToggleSidebar={() => setSidebarVisible((v) => !v)}
          inspectorVisible={inspectorVisible}
          onToggleInspector={() => setInspectorVisible((v) => !v)}
          view={view}
          onViewChange={setView}
          enzymeDisplay={enzymeDisplay}
          onEnzymeDisplayChange={setEnzymeDisplay}
          onChooseEnzymes={() => setEnzymeDisplay('custom')}
          onAction={() => undefined}
          searchValue={search}
          onSearchChange={setSearch}
          searchStatus={search.trim().length >= 2 ? (matches > 0 ? `1 of ${matches}` : 'None') : undefined}
        />
      }
      sidebar={
        <Sidebar
          documents={documents}
          activeDocumentId={big ? 'ecoli' : active}
          onActivateDocument={(id) => {
            if (big) return;
            setActive(id as SampleName);
            setSelectedItem(null);
            setSelection({ range: { start: 0, end: 0 }, caret: 0 });
          }}
          onCloseDocument={() => undefined}
          record={record}
          enzymeSites={sites}
          selectedItem={selectedItem}
          onSelectItem={selectItem}
          emphasized={windowActive ? undefined : false}
        />
      }
      inspector={
        <Inspector
          selection={summary}
          sequenceComposition={wholeComposition}
          feature={feature}
          sequenceLength={n}
          topology={record.topology}
          onFeatureChange={editFeature}
          onZoomToFeature={() => undefined}
          onDeleteFeature={() => undefined}
          analysisActions={
            <>
              <Button size="sm" icon={<ScanSearch />}>
                Find ORFs
              </Button>
              <Button size="sm" icon={<BookOpenText />}>
                Translate
              </Button>
            </>
          }
        />
      }
      statusBar={<StatusBar selection={summary} length={n} topology={record.topology} />}
    >
      <MainArea
        view={view}
        topology={record.topology}
        placeholderTitle={record.name}
        placeholderSubtitle={formatLength(n)}
      />
    </AppShell>
  );
}

function Welcome({ recent = true, drop = false }: { recent?: boolean; drop?: boolean }) {
  return (
    <WelcomeScreen
      version="0.1.0"
      recentFiles={recent ? RECENT : []}
      samples={SAMPLE_LIST}
      onOpen={() => undefined}
      onNewSequence={() => undefined}
      onOpenRecent={() => undefined}
      onClearRecent={() => undefined}
      onOpenSample={() => undefined}
      onDropFiles={() => undefined}
      dropActive={drop || undefined}
    />
  );
}

const story = (node: ReactNode) => () => <Frame>{node}</Frame>;

export default {
  welcome: story(<Welcome />),
  'welcome-first-run': story(<Welcome recent={false} />),
  'welcome-drop': story(<Welcome drop />),
  document: story(<DocumentWindow />),
  split: story(<DocumentWindow view="split" select="KanR" />),
  sequence: story(<DocumentWindow view="sequence" select="TEF promoter" />),
  'no-selection': story(<DocumentWindow select={null} />),
  'focus-mode': story(<DocumentWindow sidebar={false} inspector={false} />),
  narrow: story(<DocumentWindow view="split" />),
  'linear-record': story(<DocumentWindow sample="linear" select="DsRed-Express" />),
  'dense-annotations': story(<DocumentWindow sample="pBR322" select={null} />),
  searching: story(<DocumentWindow search="GAATTC" select={null} />),
  'inactive-window': story(<DocumentWindow windowActive={false} />),
  'large-genome': story(<DocumentWindow genome select={null} />),
} satisfies GalleryStories;
