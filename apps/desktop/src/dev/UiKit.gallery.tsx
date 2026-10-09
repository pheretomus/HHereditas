/**
 * Design-system gallery: every @hhereditas/ui primitive in its states.
 * Open with ?gallery=UiKit&story=<name> (&theme=dark, &platform=mac|windows).
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  CircleDot,
  Copy,
  Dna,
  FileText,
  FlaskConical,
  FolderOpen,
  Info,
  Layers,
  Minus,
  PanelLeft,
  PanelRight,
  Plus,
  Rows2,
  Scissors,
  SlidersHorizontal,
  Sparkles,
  Tag,
  Trash2,
  Type,
} from 'lucide-react';
import {
  Badge,
  Banner,
  Button,
  Checkbox,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
  Dialog,
  Disclosure,
  EmptyState,
  Field,
  IconButton,
  Kbd,
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
  NumberField,
  Popover,
  PopoverContent,
  PopoverTrigger,
  PropertyList,
  SearchField,
  SegmentedControl,
  Select,
  Separator,
  Sheet,
  Slider,
  SourceList,
  Spinner,
  SplitPane,
  SplitView,
  Switch,
  Table,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  TextField,
  Toolbar,
  ToolbarGroup,
  ToolbarSpacer,
  ToolbarTitle,
  Tooltip,
  TooltipProvider,
  type SourceListSection,
  type TableColumn,
} from '@hhereditas/ui';
import type { GalleryStories } from './Gallery';

// ---------------------------------------------------------------------------
// Gallery layout helpers (inline styles with tokens only)
// ---------------------------------------------------------------------------

const page: CSSProperties = {
  height: '100%',
  overflow: 'auto',
  padding: '28px 32px 48px',
  background: 'var(--hh-bg-content)',
  color: 'var(--hh-text)',
};

function Page({ title, children, wide = false }: { title: string; children: ReactNode; wide?: boolean }) {
  return (
    <TooltipProvider>
      <div style={page}>
        <div style={{ maxWidth: wide ? 1400 : 1040, margin: '0 auto', display: 'grid', gap: 28 }}>
          <div style={{ fontSize: 'var(--hh-text-2xl)', fontWeight: 700, letterSpacing: '-0.01em' }}>{title}</div>
          {children}
        </div>
      </div>
    </TooltipProvider>
  );
}

function Section({ title, children, note }: { title: string; children: ReactNode; note?: string }) {
  return (
    <section style={{ display: 'grid', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <div style={{ fontSize: 'var(--hh-text-sm)', fontWeight: 700, color: 'var(--hh-text-secondary)', letterSpacing: '0.02em' }}>
          {title}
        </div>
        {note ? <div style={{ fontSize: 'var(--hh-text-sm)', color: 'var(--hh-text-tertiary)' }}>{note}</div> : null}
      </div>
      {children}
    </section>
  );
}

function Row({ children, gap = 12, align = 'center' }: { children: ReactNode; gap?: number; align?: CSSProperties['alignItems'] }) {
  return <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: align, gap }}>{children}</div>;
}

/** A light-grey "window chrome" surface, so controls are shown on the background they live on. */
function Chrome({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div
      style={{
        padding: 16,
        borderRadius: 'var(--hh-radius-lg)',
        background: 'var(--hh-bg-window)',
        boxShadow: 'inset 0 0 0 var(--hh-hairline) var(--hh-separator)',
        ...style,
      }}
    >
      {children}
    </div>
  );
}

function Caption({ children }: { children: ReactNode }) {
  return <div style={{ fontSize: 'var(--hh-text-sm)', color: 'var(--hh-text-tertiary)', marginTop: 6 }}>{children}</div>;
}

function Labeled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: 'grid', gap: 6, justifyItems: 'start' }}>
      {children}
      <div style={{ fontSize: 'var(--hh-text-xs)', color: 'var(--hh-text-tertiary)' }}>{label}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sample data
// ---------------------------------------------------------------------------

const VIEW_OPTIONS = [
  { value: 'map', label: 'Map', icon: <CircleDot /> },
  { value: 'sequence', label: 'Sequence', icon: <Type /> },
  { value: 'split', label: 'Split', icon: <Rows2 /> },
] as const;
type View = (typeof VIEW_OPTIONS)[number]['value'];

function Swatch({ color }: { color: string }) {
  return (
    <span
      style={{ width: 12, height: 12, borderRadius: 3, background: color, boxShadow: 'inset 0 0 0 var(--hh-hairline) var(--hh-separator-strong)' }}
    />
  );
}

function sourceSections(count = 7): SourceListSection[] {
  const features = [
    ['AmpR', 'var(--hh-feature-cds)', '861 bp'],
    ['ori', 'var(--hh-feature-rep-origin)', '589 bp'],
    ['lac promoter', 'var(--hh-feature-promoter)', '31 bp'],
    ['TEF terminator', 'var(--hh-feature-terminator)', '198 bp'],
    ['kanMX', 'var(--hh-feature-cds)', '810 bp'],
    ['AmpR promoter', 'var(--hh-feature-promoter)', '105 bp'],
    ['f1 ori', 'var(--hh-feature-rep-origin)', '456 bp'],
  ].slice(0, count);
  return [
    {
      id: 'docs',
      title: 'Documents',
      items: [
        { id: 'doc:1', label: 'pFA6a-kanMX6', icon: <Dna />, secondary: '3.9 kb' },
        { id: 'doc:2', label: 'pBR322', icon: <Dna />, secondary: '4.4 kb' },
        { id: 'doc:3', label: 'pBAD30', icon: <Dna />, secondary: '4.9 kb', disabled: false },
      ],
    },
    {
      id: 'features',
      title: 'Features',
      count: features.length,
      items: features.map(([name, color, len], i) => ({
        id: `f:${i}`,
        label: name,
        icon: <Swatch color={color} />,
        secondary: len,
      })),
    },
    {
      id: 'primers',
      title: 'Primers',
      count: 0,
      items: [],
      emptyText: 'No primers',
    },
    {
      id: 'enzymes',
      title: 'Enzymes',
      count: 4,
      items: [
        { id: 'e:EcoRI', label: 'EcoRI', trailing: '1' },
        { id: 'e:BamHI', label: 'BamHI', trailing: '1' },
        { id: 'e:PstI', label: 'PstI', trailing: '2' },
        { id: 'e:HindIII', label: 'HindIII', trailing: <Badge size="sm">3</Badge> },
      ],
    },
  ];
}

interface Part {
  name: string;
  type: string;
  start: number;
  end: number;
  strand: string;
  length: number;
}

const PART_TYPES = ['CDS', 'promoter', 'terminator', 'rep_origin', 'misc_feature', 'primer_bind'];
function parts(n: number): Part[] {
  const out: Part[] = [];
  let seed = 7;
  const rnd = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  for (let i = 0; i < n; i++) {
    const start = Math.floor(rnd() * 4_600_000);
    const length = 30 + Math.floor(rnd() * 2400);
    out.push({
      name: `${['yfg', 'abc', 'lac', 'tet', 'kan', 'amp'][i % 6]}${String.fromCharCode(65 + (i % 26))}${i}`,
      type: PART_TYPES[i % PART_TYPES.length],
      start: start + 1,
      end: start + length,
      strand: rnd() > 0.5 ? '+' : '−',
      length,
    });
  }
  return out;
}

const PART_COLUMNS: TableColumn<Part>[] = [
  { key: 'name', header: 'Name', width: 'minmax(120px, 1.4fr)', sortable: true },
  { key: 'type', header: 'Type', width: 'minmax(100px, 1fr)', sortable: true },
  { key: 'start', header: 'Start', width: 96, align: 'end', sortable: true, render: (r) => r.start.toLocaleString('en-US') },
  { key: 'end', header: 'End', width: 96, align: 'end', sortable: true, render: (r) => r.end.toLocaleString('en-US') },
  { key: 'strand', header: 'Strand', width: 64, align: 'center' },
  { key: 'length', header: 'Length', width: 90, align: 'end', sortable: true, render: (r) => `${r.length.toLocaleString('en-US')} bp` },
];

// ---------------------------------------------------------------------------
// Stories
// ---------------------------------------------------------------------------

function ButtonsStory() {
  return (
    <Page title="Buttons">
      <Section title="Push buttons" note="md 28 px · sm 24 px">
        <Chrome>
          <div style={{ display: 'grid', gap: 14 }}>
            {(['md', 'sm'] as const).map((size) => (
              <Row key={size}>
                <Button size={size} variant="primary">Open</Button>
                <Button size={size}>Cancel</Button>
                <Button size={size} icon={<Plus />}>New Sequence…</Button>
                <Button size={size} variant="destructive" icon={<Trash2 />}>Delete</Button>
                <Button size={size} trailingIcon={<ChevronDown />}>Unique cutters</Button>
                <Button size={size} variant="plain" icon={<Scissors />} trailingIcon={<ChevronDown />}>Enzymes</Button>
                <Button size={size} variant="primary" loading>Saving</Button>
                <Button size={size} disabled>Disabled</Button>
                <Button size={size} variant="primary" disabled>Disabled</Button>
              </Row>
            ))}
          </div>
        </Chrome>
        <Row>
          <Button variant="primary">On content</Button>
          <Button>Secondary</Button>
          <Button variant="plain" icon={<Copy />}>Copy</Button>
        </Row>
      </Section>
      <Section title="Icon buttons" note="plain (toolbar) · bordered · toggled · disabled">
        <Chrome>
          <Row gap={8}>
            <IconButton icon={<PanelLeft />} aria-label="Toggle Sidebar" shortcut="Mod+Ctrl+S" />
            <IconButton icon={<PanelRight />} aria-label="Toggle Inspector" pressed shortcut="Mod+Alt+I" />
            <IconButton icon={<Scissors />} aria-label="Enzymes" />
            <IconButton icon={<FlaskConical />} aria-label="Actions" />
            <Separator orientation="vertical" style={{ height: 20 }} />
            <IconButton variant="default" icon={<Plus />} aria-label="Add" />
            <IconButton variant="default" icon={<Minus />} aria-label="Remove" />
            <IconButton variant="default" icon={<ArrowLeft />} aria-label="Back" size="sm" />
            <IconButton variant="default" icon={<ArrowRight />} aria-label="Forward" size="sm" />
            <IconButton icon={<Trash2 />} aria-label="Delete" disabled />
            <IconButton icon={<SlidersHorizontal />} aria-label="Options" size="sm" />
          </Row>
        </Chrome>
      </Section>
      <Section title="Badges and keys">
        <Row>
          <Badge>12</Badge>
          <Badge tone="accent">Unique</Badge>
          <Badge tone="success">Ligatable</Badge>
          <Badge tone="warning">Dam-blocked</Badge>
          <Badge tone="danger">2 mismatches</Badge>
          <Badge tone="accent" solid>New</Badge>
          <Badge size="sm">3</Badge>
          <Badge size="sm" tone="danger" solid>
            9
          </Badge>
          <Kbd shortcut="Mod+Shift+F" />
          <Kbd shortcut="Mod+Alt+I" />
          <Kbd shortcut="Mod+Ctrl+S" />
          <Kbd>Esc</Kbd>
        </Row>
      </Section>
      <Section title="Spinners">
        <Row gap={20}>
          <Spinner size={12} />
          <Spinner size={16} />
          <Spinner size={24} />
          <Spinner size={32} />
        </Row>
      </Section>
    </Page>
  );
}

function SegmentedStory() {
  const [view, setView] = useState<View>('map');
  const [strand, setStrand] = useState('fwd');
  const [view2, setView2] = useState<View>('split');
  return (
    <Page title="Segmented controls and toolbars">
      <Section title="Segmented control">
        <Chrome>
          <div style={{ display: 'grid', gap: 14 }}>
            <Row>
              <SegmentedControl aria-label="View" options={VIEW_OPTIONS} value={view} onValueChange={setView} />
              <SegmentedControl aria-label="View" options={VIEW_OPTIONS} value={view2} onValueChange={setView2} iconOnly />
              <SegmentedControl
                aria-label="Strand"
                size="sm"
                options={[
                  { value: 'fwd', label: 'Forward', icon: <ArrowRight /> },
                  { value: 'rev', label: 'Reverse', icon: <ArrowLeft /> },
                  { value: 'none', label: 'None', icon: <Minus /> },
                ]}
                value={strand}
                onValueChange={setStrand}
              />
              <SegmentedControl
                aria-label="Disabled"
                size="sm"
                disabled
                options={[
                  { value: 'a', label: 'One' },
                  { value: 'b', label: 'Two' },
                ]}
                value="a"
                onValueChange={() => undefined}
              />
            </Row>
            <div style={{ width: 360 }}>
              <SegmentedControl
                aria-label="Topology"
                fill
                options={[
                  { value: 'circular', label: 'Circular' },
                  { value: 'linear', label: 'Linear' },
                ]}
                value="circular"
                onValueChange={() => undefined}
              />
            </div>
          </div>
        </Chrome>
      </Section>
      <Section title="Window toolbar" note="52 px, unified with the title bar">
        <div
          style={{
            borderRadius: 'var(--hh-radius-lg)',
            overflow: 'hidden',
            boxShadow: 'var(--hh-shadow-popover)',
          }}
        >
          <div style={{ background: 'var(--hh-bg-window)', borderBottom: 'var(--hh-hairline) solid var(--hh-separator)' }}>
            <Toolbar aria-label="Document">
              <IconButton icon={<PanelLeft />} aria-label="Toggle Sidebar" />
              <ToolbarTitle title="pFA6a-kanMX6" subtitle="3,938 bp · circular" />
              <ToolbarSpacer />
              <SegmentedControl aria-label="View" options={VIEW_OPTIONS} value={view} onValueChange={setView} />
              <ToolbarSpacer />
              <ToolbarGroup label="Tools">
                <Button variant="plain" icon={<Scissors />} trailingIcon={<ChevronDown />} aria-label="Enzymes" />
                <Button variant="plain" icon={<FlaskConical />} trailingIcon={<ChevronDown />} aria-label="Actions" />
              </ToolbarGroup>
              <SearchField placeholder="Search" width={180} />
              <IconButton icon={<PanelRight />} aria-label="Toggle Inspector" pressed />
            </Toolbar>
          </div>
          <div style={{ height: 80, background: 'var(--hh-bg-content)' }} />
        </div>
      </Section>
      <Section title="Inline toolbar" note="36 px, inside panels">
        <Chrome style={{ padding: 0 }}>
          <Toolbar size="inline" aria-label="Primers">
            <IconButton size="sm" icon={<Plus />} aria-label="Add Primer" />
            <IconButton size="sm" icon={<Minus />} aria-label="Remove Primer" disabled />
            <ToolbarSpacer />
            <SearchField size="sm" placeholder="Filter" width={160} />
          </Toolbar>
        </Chrome>
      </Section>
    </Page>
  );
}

function FieldsStory() {
  const [tm, setTm] = useState<number | null>(60);
  const [len, setLen] = useState<number | null>(1256);
  const [conc, setConc] = useState<number | null>(250);
  const [q, setQ] = useState('GAATTC');
  const [type, setType] = useState('CDS');
  return (
    <Page title="Text and value fields">
      <Section title="Text fields">
        <Chrome>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 16 }}>
            <Labeled label="default">
              <TextField placeholder="Feature name" width={220} />
            </Labeled>
            <Labeled label="filled">
              <TextField defaultValue="AmpR promoter" width={220} />
            </Labeled>
            <Labeled label="invalid">
              <TextField defaultValue="12x" invalid width={220} />
            </Labeled>
            <Labeled label="monospaced">
              <TextField mono defaultValue="ATGACCATGATTACGCCAAGC" width={220} />
            </Labeled>
            <Labeled label="small">
              <TextField size="sm" placeholder="Small field" width={220} />
            </Labeled>
            <Labeled label="disabled">
              <TextField disabled defaultValue="Read-only" width={220} />
            </Labeled>
          </div>
        </Chrome>
      </Section>
      <Section title="Search fields">
        <Chrome>
          <Row gap={16}>
            <Labeled label="empty">
              <SearchField placeholder="Search sequence" width={220} />
            </Labeled>
            <Labeled label="with text and status">
              <SearchField value={q} onValueChange={setQ} status={q ? '3 of 12' : undefined} width={240} mono />
            </Labeled>
            <Labeled label="small">
              <SearchField size="sm" placeholder="Filter" width={180} />
            </Labeled>
          </Row>
          <div style={{ marginTop: 16 }}>
            <Toolbar size="inline" aria-label="Toolbar appearance" style={{ padding: 0 }}>
              <SearchField placeholder="In a toolbar" width={220} />
              <SearchField defaultValue="lacZ" width={220} />
            </Toolbar>
          </div>
        </Chrome>
      </Section>
      <Section title="Number fields and pop-up buttons">
        <Chrome>
          <Row gap={16} align="flex-start">
            <Labeled label="unit + stepper">
              <NumberField aria-label="Tm" value={tm} onValueChange={setTm} unit="°C" min={40} max={80} step={0.5} width={120} />
            </Labeled>
            <Labeled label="thousands separators">
              <NumberField aria-label="Length" value={len} onValueChange={setLen} unit="bp" min={1} width={130} />
            </Labeled>
            <Labeled label="small, no stepper">
              <NumberField aria-label="Concentration" value={conc} onValueChange={setConc} unit="nM" size="sm" stepper={false} width={110} />
            </Labeled>
            <Labeled label="pop-up button">
              <Select
                aria-label="Feature type"
                value={type}
                onValueChange={setType}
                width={160}
                options={[
                  { value: 'CDS', label: 'CDS' },
                  { value: 'promoter', label: 'Promoter' },
                  { value: 'terminator', label: 'Terminator' },
                  { type: 'separator' },
                  { value: 'misc_feature', label: 'Misc. feature' },
                ]}
              />
            </Labeled>
            <Labeled label="small / placeholder">
              <Select
                aria-label="Enzyme set"
                size="sm"
                placeholder="Choose…"
                width={140}
                options={[
                  { value: 'unique', label: 'Unique cutters' },
                  { value: 'common', label: 'Common set' },
                ]}
              />
            </Labeled>
            <Labeled label="disabled">
              <Select aria-label="Disabled" disabled value="a" width={120} options={[{ value: 'a', label: 'Linear' }]} />
            </Labeled>
          </Row>
        </Chrome>
      </Section>
      <Section title="Form layout" note="Field: label + control + hint / error">
        <Chrome>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 28 }}>
            <div style={{ display: 'grid', gap: 12 }}>
              <Field label="Name" layout="inline" labelWidth={90}>
                <TextField defaultValue="pFA6a-kanMX6" />
              </Field>
              <Field label="Length" layout="inline" labelWidth={90} hint="Between 1 and 100,000 bp.">
                <NumberField value={len} onValueChange={setLen} unit="bp" width={140} />
              </Field>
              <Field label="Topology" layout="inline" labelWidth={90}>
                <SegmentedControl
                  aria-label="Topology"
                  size="sm"
                  options={[
                    { value: 'circular', label: 'Circular' },
                    { value: 'linear', label: 'Linear' },
                  ]}
                  value="circular"
                  onValueChange={() => undefined}
                />
              </Field>
            </div>
            <div style={{ display: 'grid', gap: 12, alignContent: 'start' }}>
              <Field label="Primer sequence (5′→3′)" hint="IUPAC codes allowed.">
                <TextField mono defaultValue="GGATCCATGACCATGATTACG" />
              </Field>
              <Field label="Annealing temperature" error="Must be between 40 and 80 °C.">
                <TextField defaultValue="92" />
              </Field>
            </div>
          </div>
        </Chrome>
      </Section>
    </Page>
  );
}

function TogglesStory() {
  const [a, setA] = useState(true);
  const [b, setB] = useState(false);
  const [s1, setS1] = useState(true);
  const [s2, setS2] = useState(false);
  const [v, setV] = useState(40);
  const [w, setW] = useState(3);
  return (
    <Page title="Checkboxes, switches, sliders">
      <Section title="Checkboxes">
        <Chrome>
          <Row gap={24} align="flex-start">
            <Checkbox label="Show enzymes" checked={a} onCheckedChange={(c) => setA(c === true)} />
            <Checkbox label="Show ORFs" checked={b} onCheckedChange={(c) => setB(c === true)} />
            <Checkbox label="Some features" checked="indeterminate" />
            <Checkbox label="Disabled" disabled />
            <Checkbox label="Disabled, on" disabled checked />
            <Checkbox
              label="Translate CDS"
              description="Show amino acids under coding features."
              defaultChecked
            />
            <Checkbox aria-label="Bare checkbox" defaultChecked />
          </Row>
        </Chrome>
      </Section>
      <Section title="Switches">
        <Chrome>
          <Row gap={24}>
            <Switch label="Circular" checked={s1} onCheckedChange={setS1} />
            <Switch label="Show complement" checked={s2} onCheckedChange={setS2} />
            <Switch label="Small" size="sm" defaultChecked />
            <Switch label="Disabled" disabled />
            <Switch label="Disabled, on" disabled checked />
            <div style={{ width: 240 }}>
              <Switch label="Label before the switch" labelPosition="start" defaultChecked style={{ width: '100%' }} />
            </div>
          </Row>
        </Chrome>
      </Section>
      <Section title="Sliders">
        <Chrome>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 280px)', gap: 24 }}>
            <Labeled label={`continuous · ${v}`}>
              <Slider aria-label="Zoom" value={v} onValueChange={setV} style={{ width: 260 }} />
            </Labeled>
            <Labeled label={`with ticks · ${w}`}>
              <Slider aria-label="Mismatches" value={w} onValueChange={setW} min={0} max={6} ticks={7} style={{ width: 260 }} />
            </Labeled>
            <Labeled label="small">
              <Slider aria-label="Small" size="sm" defaultValue={70} style={{ width: 260 }} />
            </Labeled>
            <Labeled label="disabled">
              <Slider aria-label="Disabled" disabled defaultValue={30} style={{ width: 260 }} />
            </Labeled>
          </div>
        </Chrome>
      </Section>
    </Page>
  );
}

function MenuStory() {
  const [enzymes, setEnzymes] = useState('unique');
  const [orfs, setOrfs] = useState(true);
  const [labels, setLabels] = useState(false);
  // The Clone submenu is shown open for the gallery (hovering other items closes it as usual).
  // Opened after mount: Radix closes submenus in the effect cleanup of StrictMode's re-mount.
  const [cloneOpen, setCloneOpen] = useState(false);
  useEffect(() => {
    const id = window.setTimeout(() => setCloneOpen(true), 120);
    return () => window.clearTimeout(id);
  }, []);
  return (
    <Page title="Menus">
      <Section title="Dropdown menu" note="checkbox and radio items, separators, shortcuts, submenus">
        <Chrome style={{ height: 420 }}>
          <Row>
            <Menu defaultOpen modal={false}>
              <MenuTrigger asChild>
                <Button icon={<Scissors />} trailingIcon={<ChevronDown />}>
                  Enzymes
                </Button>
              </MenuTrigger>
              <MenuContent>
                <MenuLabel>Show</MenuLabel>
                <MenuRadioGroup value={enzymes} onValueChange={setEnzymes}>
                  <MenuRadioItem value="unique">Unique cutters</MenuRadioItem>
                  <MenuRadioItem value="dual">Unique &amp; dual cutters</MenuRadioItem>
                  <MenuRadioItem value="common">Common set</MenuRadioItem>
                  <MenuRadioItem value="none">None</MenuRadioItem>
                </MenuRadioGroup>
                <MenuSeparator />
                <MenuCheckboxItem checked={orfs} onCheckedChange={setOrfs} shortcut="Mod+Shift+O">
                  Show ORFs
                </MenuCheckboxItem>
                <MenuCheckboxItem checked={labels} onCheckedChange={setLabels}>
                  Show cut positions
                </MenuCheckboxItem>
                <MenuSeparator />
                <MenuSub open={cloneOpen} onOpenChange={setCloneOpen}>
                  <MenuSubTrigger icon={<FlaskConical />}>Clone</MenuSubTrigger>
                  <MenuSubContent>
                    <MenuItem>Restriction cloning…</MenuItem>
                    <MenuItem>Gibson assembly…</MenuItem>
                    <MenuItem>Golden Gate…</MenuItem>
                    <MenuItem disabled>PCR…</MenuItem>
                  </MenuSubContent>
                </MenuSub>
                <MenuItem icon={<Scissors />} shortcut="Mod+D">
                  Digest &amp; gel…
                </MenuItem>
                <MenuItem icon={<Sparkles />}>Choose enzymes…</MenuItem>
                <MenuSeparator />
                <MenuItem icon={<Trash2 />} destructive>
                  Remove all sites
                </MenuItem>
              </MenuContent>
            </Menu>
          </Row>
        </Chrome>
      </Section>
    </Page>
  );
}

function ContextMenuStory() {
  const area = useRef<HTMLDivElement>(null);
  // Open the menu once on mount, as if the canvas had been right-clicked near its centre.
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const id = requestAnimationFrame(() =>
      el.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + r.width * 0.38, clientY: r.top + 70, button: 2 }),
      ),
    );
    return () => cancelAnimationFrame(id);
  }, []);
  return (
    <Page title="Context menu">
      <Section title="Right-click the canvas">
        <ContextMenu modal={false}>
          <ContextMenuTrigger asChild>
            <div
              ref={area}
              data-testid="context-area"
              style={{
                height: 300,
                borderRadius: 'var(--hh-radius-lg)',
                background: 'var(--hh-bg-subtle)',
                boxShadow: 'inset 0 0 0 var(--hh-hairline) var(--hh-separator)',
                display: 'grid',
                placeItems: 'center',
                color: 'var(--hh-text-tertiary)',
              }}
            >
              Right-click here
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem icon={<Copy />} shortcut="Mod+C">
              Copy
            </ContextMenuItem>
            <ContextMenuItem shortcut="Mod+Shift+C">Copy reverse complement</ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem icon={<Tag />}>Add feature…</ContextMenuItem>
            <ContextMenuSub>
              <ContextMenuSubTrigger icon={<Layers />}>Select</ContextMenuSubTrigger>
              <ContextMenuSubContent>
                <ContextMenuItem>Feature</ContextMenuItem>
                <ContextMenuItem>Everything</ContextMenuItem>
              </ContextMenuSubContent>
            </ContextMenuSub>
            <ContextMenuSeparator />
            <ContextMenuItem destructive icon={<Trash2 />} shortcut="Backspace">
              Delete bases
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      </Section>
    </Page>
  );
}

function PopoverStory() {
  return (
    <Page title="Popover and tooltip">
      <Section title="Popover" note="arrow points at the trigger; Esc or outside click closes">
        <Chrome style={{ height: 300 }}>
          <Row gap={40}>
            <Popover defaultOpen modal={false}>
              <PopoverTrigger asChild>
                <Button icon={<Info />}>Feature info</Button>
              </PopoverTrigger>
              <PopoverContent width={260}>
                <div style={{ display: 'grid', gap: 10 }}>
                  <div style={{ fontWeight: 700 }}>AmpR</div>
                  <PropertyList
                    labelWidth={64}
                    items={[
                      { label: 'Type', value: 'CDS' },
                      { label: 'Range', value: '396..1,256', copyValue: '396..1256' },
                      { label: 'Length', value: '861 bp' },
                    ]}
                  />
                  <Row gap={8}>
                    <Button size="sm">Edit…</Button>
                    <Button size="sm" variant="plain">
                      Zoom to
                    </Button>
                  </Row>
                </div>
              </PopoverContent>
            </Popover>
            <Tooltip content="Toggle Inspector" shortcut="Mod+Alt+I" open side="bottom">
              <IconButton icon={<PanelRight />} aria-label="Toggle Inspector" tooltip={false} />
            </Tooltip>
            <Tooltip content="Show the restriction enzymes that cut this sequence once" open side="right">
              <Button variant="plain" icon={<Scissors />}>
                Long tooltip
              </Button>
            </Tooltip>
          </Row>
        </Chrome>
      </Section>
    </Page>
  );
}

function WindowMock({ children }: { children?: ReactNode }) {
  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', background: 'var(--hh-bg-window)' }}>
      <div style={{ borderBottom: 'var(--hh-hairline) solid var(--hh-separator)' }}>
        <Toolbar aria-label="Window">
          <IconButton icon={<PanelLeft />} aria-label="Toggle Sidebar" />
          <ToolbarTitle title="pFA6a-kanMX6" subtitle="3,938 bp · circular" />
          <ToolbarSpacer />
          <SearchField width={180} />
        </Toolbar>
      </div>
      <div style={{ flex: 1, background: 'var(--hh-bg-content)', display: 'grid', placeItems: 'center', color: 'var(--hh-text-tertiary)' }}>
        {children}
      </div>
    </div>
  );
}

function SheetStory() {
  const [open, setOpen] = useState(true);
  const [name, setName] = useState('Untitled');
  const [len, setLen] = useState<number | null>(5000);
  return (
    <TooltipProvider>
      <WindowMock>
        <Button onClick={() => setOpen(true)}>Show sheet</Button>
      </WindowMock>
      <Sheet
        open={open}
        onOpenChange={setOpen}
        title="New Sequence"
        description="Create an empty DNA sequence. You can paste or type bases afterwards."
        primaryAction={{ label: 'Create', onAction: () => setOpen(false), disabled: !name.trim() }}
        footerStart={<Checkbox label="Open in new window" />}
      >
        <div style={{ display: 'grid', gap: 12 }}>
          <Field label="Name" layout="inline" labelWidth={80}>
            <TextField value={name} onValueChange={setName} />
          </Field>
          <Field label="Topology" layout="inline" labelWidth={80}>
            <SegmentedControl
              aria-label="Topology"
              size="sm"
              options={[
                { value: 'circular', label: 'Circular' },
                { value: 'linear', label: 'Linear' },
              ]}
              value="circular"
              onValueChange={() => undefined}
            />
          </Field>
          <Field label="Length" layout="inline" labelWidth={80}>
            <NumberField value={len} onValueChange={setLen} unit="bp" min={0} width={140} />
          </Field>
        </div>
      </Sheet>
    </TooltipProvider>
  );
}

function DialogStory() {
  const [open, setOpen] = useState(true);
  return (
    <TooltipProvider>
      <WindowMock>
        <Button onClick={() => setOpen(true)}>Show alert</Button>
      </WindowMock>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        icon={<FileText style={{ color: 'var(--hh-accent)' }} strokeWidth={1.25} />}
        title={'Do you want to save the changes made to “pFA6a-kanMX6”?'}
        message="Your changes will be lost if you don’t save them."
        primaryAction={{ label: 'Save' }}
        tertiaryAction={{ label: 'Don’t Save', destructive: true }}
        secondaryAction={{ label: 'Cancel' }}
      />
    </TooltipProvider>
  );
}

function DialogTwoButtonStory() {
  const [open, setOpen] = useState(true);
  return (
    <TooltipProvider>
      <WindowMock />
      <Dialog
        open={open}
        onOpenChange={setOpen}
        icon={<Scissors style={{ color: 'var(--hh-orange)' }} strokeWidth={1.25} />}
        title="Remove 3 enzyme sites?"
        message="The sequence is not changed; only the displayed sites are hidden."
        primaryAction={{ label: 'Remove' }}
        secondaryAction={{ label: 'Cancel' }}
      />
    </TooltipProvider>
  );
}

function SourceListStory() {
  const sections = useMemo(() => sourceSections(), []);
  const [sel, setSel] = useState<string | null>('f:0');
  const [sel2, setSel2] = useState<string | null>('doc:1');
  const panel: CSSProperties = {
    width: 248,
    height: 520,
    background: 'var(--hh-bg-sidebar)',
    borderRadius: 'var(--hh-radius-lg)',
    boxShadow: 'inset 0 0 0 var(--hh-hairline) var(--hh-separator)',
    overflow: 'hidden',
  };
  return (
    <Page title="Source list">
      <Section title="States" note="emphasized (focused) · unemphasized · collapsed section">
        <Row gap={24} align="flex-start">
          <div>
            <div style={panel}>
              <SourceList aria-label="Emphasized" sections={sections} selectedId={sel} onSelect={(i) => setSel(i.id)} emphasized />
            </div>
            <Caption>Emphasized (list has focus)</Caption>
          </div>
          <div>
            <div style={panel}>
              <SourceList aria-label="Unemphasized" sections={sections} selectedId={sel2} onSelect={(i) => setSel2(i.id)} emphasized={false} />
            </div>
            <Caption>Unemphasized (focus elsewhere / window inactive)</Caption>
          </div>
          <div>
            <div style={panel}>
              <SourceList
                aria-label="Collapsed"
                sections={sections}
                selectedId="e:PstI"
                defaultCollapsedSections={['features']}
              />
            </div>
            <Caption>Features collapsed (hover shows chevrons)</Caption>
          </div>
        </Row>
      </Section>
    </Page>
  );
}

function SourceListLargeStory() {
  const sections = useMemo<SourceListSection[]>(() => {
    const colors = ['cds', 'promoter', 'terminator', 'rep-origin', 'misc'];
    return [
      {
        id: 'features',
        title: 'Features',
        count: (5000).toLocaleString('en-US'),
        items: Array.from({ length: 5000 }, (_, i) => ({
          id: `f${i}`,
          label: `gene_${String(i + 1).padStart(4, '0')}`,
          icon: <Swatch color={`var(--hh-feature-${colors[i % colors.length]})`} />,
          secondary: `${(300 + ((i * 37) % 2400)).toLocaleString('en-US')} bp`,
        })),
      },
    ];
  }, []);
  const [sel, setSel] = useState<string | null>('f2500');
  return (
    <Page title="Source list · 5,000 rows (virtualized)">
      <div style={{ width: 260, height: 560, background: 'var(--hh-bg-sidebar)', borderRadius: 'var(--hh-radius-lg)', overflow: 'hidden' }}>
        <SourceList aria-label="Large" sections={sections} selectedId={sel} onSelect={(i) => setSel(i.id)} />
      </div>
    </Page>
  );
}

function SplitViewStory() {
  const [sidebar, setSidebar] = useState(220);
  const [inspector, setInspector] = useState(260);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [inspectorCollapsed, setInspectorCollapsed] = useState(false);
  const pane = (label: string, bg: string): ReactNode => (
    <div style={{ height: '100%', display: 'grid', placeItems: 'center', background: bg, color: 'var(--hh-text-tertiary)' }}>{label}</div>
  );
  return (
    <TooltipProvider>
      <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', background: 'var(--hh-bg-window)' }}>
        <div style={{ borderBottom: 'var(--hh-hairline) solid var(--hh-separator)' }}>
          <Toolbar aria-label="Split view demo">
            <IconButton icon={<PanelLeft />} aria-label="Toggle Sidebar" pressed={!sidebarCollapsed} onClick={() => setSidebarCollapsed((c) => !c)} />
            <ToolbarTitle title="SplitView" subtitle={`sidebar ${sidebar} px · inspector ${inspector} px`} />
            <ToolbarSpacer />
            <IconButton icon={<PanelRight />} aria-label="Toggle Inspector" pressed={!inspectorCollapsed} onClick={() => setInspectorCollapsed((c) => !c)} />
          </Toolbar>
        </div>
        <div style={{ flex: 1, minHeight: 0 }}>
          <SplitView>
            <SplitPane
              id="sidebar"
              label="Sidebar"
              size={sidebar}
              onSizeChange={setSidebar}
              minSize={180}
              maxSize={360}
              collapsible
              collapsed={sidebarCollapsed}
              onCollapsedChange={setSidebarCollapsed}
            >
              {pane('Sidebar · drag the divider, double-click to collapse', 'var(--hh-bg-sidebar)')}
            </SplitPane>
            <SplitPane id="main" minSize={320}>
              <SplitView orientation="vertical">
                <SplitPane id="map" label="Map" defaultSize={300} minSize={120}>
                  {pane('Map', 'var(--hh-bg-content)')}
                </SplitPane>
                <SplitPane id="sequence" minSize={120}>
                  {pane('Sequence', 'var(--hh-bg-content)')}
                </SplitPane>
              </SplitView>
            </SplitPane>
            <SplitPane
              id="inspector"
              label="Inspector"
              size={inspector}
              onSizeChange={setInspector}
              minSize={240}
              maxSize={420}
              collapsible
              collapsed={inspectorCollapsed}
              onCollapsedChange={setInspectorCollapsed}
            >
              {pane('Inspector', 'var(--hh-bg-inspector)')}
            </SplitPane>
          </SplitView>
        </div>
      </div>
    </TooltipProvider>
  );
}

function TableStory() {
  const rows = useMemo(() => parts(40), []);
  const [selected, setSelected] = useState<string[]>([rows[2].name]);
  return (
    <Page title="Table">
      <Section title="Sortable, selectable, zebra-striped" note="click headers · ⌘/Ctrl-click · Shift-click · arrow keys">
        <div style={{ height: 360, borderRadius: 'var(--hh-radius-lg)', overflow: 'hidden', border: 'var(--hh-hairline) solid var(--hh-separator-strong)' }}>
          <Table
            aria-label="Features"
            columns={PART_COLUMNS}
            rows={rows}
            rowKey={(r) => r.name}
            selectionMode="multiple"
            selectedKeys={selected}
            onSelectionChange={setSelected}
            defaultSort={{ key: 'start', direction: 'ascending' }}
          />
        </div>
      </Section>
      <Section title="Empty">
        <div style={{ height: 160, borderRadius: 'var(--hh-radius-lg)', overflow: 'hidden', border: 'var(--hh-hairline) solid var(--hh-separator-strong)' }}>
          <Table
            aria-label="Primers"
            columns={PART_COLUMNS.slice(0, 3)}
            rows={[] as Part[]}
            rowKey={(r) => r.name}
            emptyState={<EmptyState size="sm" title="No primers" message="Add primers to see binding sites." />}
          />
        </div>
      </Section>
    </Page>
  );
}

function VirtualTableStory() {
  const rows = useMemo(() => parts(10_000), []);
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 24,
    overscan: 12,
  });
  return (
    <Page title="Table · 10,000 rows with @tanstack/react-virtual">
      <div style={{ height: 520, borderRadius: 'var(--hh-radius-lg)', overflow: 'hidden', border: 'var(--hh-hairline) solid var(--hh-separator-strong)' }}>
        <Table
          aria-label="Genes"
          columns={PART_COLUMNS}
          rows={rows}
          rowKey={(r) => r.name}
          scrollRef={scrollRef}
          onScrollToRow={(i) => virtualizer.scrollToIndex(i, { align: 'auto' })}
          renderBody={({ renderRow }) => (
            <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
              {virtualizer.getVirtualItems().map((item) =>
                renderRow(item.index, { position: 'absolute', top: 0, left: 0, transform: `translateY(${item.start}px)` }),
              )}
            </div>
          )}
        />
      </div>
    </Page>
  );
}

function InspectorBitsStory() {
  return (
    <Page title="Tabs, disclosure, property list">
      <Row gap={24} align="flex-start">
        <div
          style={{
            width: 288,
            height: 600,
            background: 'var(--hh-bg-inspector)',
            borderRadius: 'var(--hh-radius-lg)',
            boxShadow: 'inset 0 0 0 var(--hh-hairline) var(--hh-separator)',
            overflow: 'hidden',
          }}
        >
          <Tabs defaultValue="selection" style={{ height: '100%' }}>
            <TabsList aria-label="Inspector">
              <TabsTrigger value="selection">Selection</TabsTrigger>
              <TabsTrigger value="document">Document</TabsTrigger>
            </TabsList>
            <TabsContent value="selection">
              <Disclosure title="Selection">
                <PropertyList
                  items={[
                    { label: 'Range', value: '396..1,256', copyValue: '396..1256' },
                    { label: 'Length', value: '861 bp' },
                    { label: 'GC', value: '52.3 %' },
                    { label: 'Tm', value: '—' },
                  ]}
                />
              </Disclosure>
              <Disclosure title="Feature" actions={<IconButton size="sm" icon={<SlidersHorizontal />} aria-label="Feature options" />}>
                <PropertyList
                  items={[
                    { label: 'Name', value: 'AmpR' },
                    { label: 'Type', value: 'CDS' },
                    { label: 'Product', value: 'β-lactamase' },
                    { label: 'Translation', value: 'MSIQHFRVALIPFFAAFCLPVFA…', copyValue: 'MSIQHFRVALIPFFAAFCLPVFA', mono: true },
                  ]}
                />
              </Disclosure>
              <Disclosure title="Analysis" defaultOpen={false}>
                <div>Collapsed by default</div>
              </Disclosure>
            </TabsContent>
            <TabsContent value="document">
              <EmptyState size="sm" title="Document" />
            </TabsContent>
          </Tabs>
        </div>
        <div style={{ display: 'grid', gap: 20, width: 300 }}>
          <Tabs defaultValue="map">
            <TabsList aria-label="Icon tabs">
              <TabsTrigger value="map" icon={<CircleDot />} aria-label="Map" />
              <TabsTrigger value="features" icon={<Tag />} aria-label="Features" />
              <TabsTrigger value="enzymes" icon={<Scissors />} aria-label="Enzymes" />
              <TabsTrigger value="docs" icon={<FolderOpen />} aria-label="Files" />
            </TabsList>
          </Tabs>
          <Disclosure variant="plain" title="Advanced options">
            <div style={{ display: 'grid', gap: 8 }}>
              <Checkbox label="Allow mismatches at the 5′ end" defaultChecked />
              <Checkbox label="Ignore Dam/Dcm methylation" />
            </div>
          </Disclosure>
          <Separator />
          <Disclosure variant="plain" title="Collapsed" defaultOpen={false}>
            <div>Hidden</div>
          </Disclosure>
        </div>
      </Row>
    </Page>
  );
}

function FeedbackStory() {
  return (
    <Page title="Feedback">
      <Section title="Banners">
        <div style={{ display: 'grid', gap: 10, maxWidth: 640 }}>
          <Banner tone="info" title="Read-only" actions={<Button size="sm" variant="plain">Duplicate</Button>}>
            This file was opened from a locked folder.
          </Banner>
          <Banner tone="success" title="Ligation compatible.">
            Both ends carry 4-base 5′ overhangs (AATT).
          </Banner>
          <Banner tone="warning" title="Dam methylation" onDismiss={() => undefined}>
            XbaI at 1,234 overlaps a GATC site and may be blocked.
          </Banner>
          <Banner tone="error" title="Could not read file.">
            “plasmid.dna” is not a SnapGene file.
          </Banner>
        </div>
      </Section>
      <Section title="Empty states">
        <Row gap={20} align="stretch">
          {(['sm', 'md', 'lg'] as const).map((size) => (
            <div
              key={size}
              style={{ width: size === 'lg' ? 380 : 280, height: 260, borderRadius: 'var(--hh-radius-lg)', boxShadow: 'inset 0 0 0 var(--hh-hairline) var(--hh-separator)' }}
            >
              <EmptyState
                size={size}
                icon={size === 'sm' ? <Tag /> : <Dna />}
                title={size === 'sm' ? 'No Selection' : 'No primers yet'}
                message={size === 'sm' ? 'Select bases or a feature to see details.' : 'Add a primer to see where it binds and its melting temperature.'}
                actions={size === 'sm' ? undefined : <Button size="sm" icon={<Plus />}>Add Primer…</Button>}
              />
            </div>
          ))}
        </Row>
      </Section>
      <Section title="Separators">
        <Chrome>
          <div style={{ display: 'grid', gap: 12 }}>
            <Separator />
            <Separator strong />
            <Separator inset={16} />
            <Row>
              <span>Left</span>
              <Separator orientation="vertical" style={{ height: 16 }} />
              <span>Right</span>
            </Row>
          </div>
        </Chrome>
      </Section>
    </Page>
  );
}

export default {
  buttons: () => <ButtonsStory />,
  segmented: () => <SegmentedStory />,
  fields: () => <FieldsStory />,
  toggles: () => <TogglesStory />,
  menu: () => <MenuStory />,
  'context-menu': () => <ContextMenuStory />,
  popover: () => <PopoverStory />,
  sheet: () => <SheetStory />,
  dialog: () => <DialogStory />,
  'dialog-two-buttons': () => <DialogTwoButtonStory />,
  'source-list': () => <SourceListStory />,
  'source-list-large': () => <SourceListLargeStory />,
  'split-view': () => <SplitViewStory />,
  table: () => <TableStory />,
  'table-virtual': () => <VirtualTableStory />,
  inspector: () => <InspectorBitsStory />,
  feedback: () => <FeedbackStory />,
} satisfies GalleryStories;
