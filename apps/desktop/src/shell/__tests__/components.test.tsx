import './setup';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { EnzymeSite, Feature, SeqRecord } from '@hhereditas/core';
import { AppShell } from '../AppShell';
import { INSPECTOR_PANE_ID, SIDEBAR_PANE_ID } from '../ids';
import { Inspector, type FeatureEdit } from '../Inspector';
import { MainArea } from '../MainArea';
import { summarizeSelection, summarizeSequence } from '../selectionSummary';
import { Sidebar } from '../Sidebar';
import { StatusBar } from '../StatusBar';
import { ToolbarContent, type ToolbarContentProps } from '../ToolbarContent';
import type { DocumentSummary, EnzymeDisplay, ViewMode } from '../types';
import { WelcomeScreen } from '../WelcomeScreen';

const AMPR: Feature = {
  id: 'f-amp',
  type: 'CDS',
  name: 'AmpR',
  strand: -1,
  segments: [{ start: 2610, end: 3471 }],
  qualifiers: [
    { key: 'label', value: 'AmpR' },
    { key: 'product', value: 'β-lactamase' },
    { key: 'translation', value: 'MSIQHFRVALIPFFAAFCLPVFA' },
  ],
};

const RECORD: Pick<SeqRecord, 'features' | 'primers' | 'seq' | 'topology'> = {
  seq: 'ATGC'.repeat(1000),
  topology: 'circular',
  features: [AMPR, { ...AMPR, id: 'f-ori', name: 'ori', type: 'rep_origin', strand: 1, segments: [{ start: 1850, end: 2440 }] }],
  primers: [{ id: 'p1', name: 'M13-F', sequence: 'GTAAAACGACGGCCAGT' }],
};

const SITES: EnzymeSite[] = [
  { enzyme: 'EcoRI', range: { start: 395, end: 401 }, strand: 1, cuts: [{ top: 396, bottom: 400 }] },
  { enzyme: 'PstI', range: { start: 10, end: 16 }, strand: 1, cuts: [{ top: 15, bottom: 11 }] },
  { enzyme: 'PstI', range: { start: 900, end: 906 }, strand: 1, cuts: [{ top: 905, bottom: 901 }] },
];

const DOCS: DocumentSummary[] = [
  { id: 'd1', name: 'pFA6a-kanMX6', length: 3938, topology: 'circular', edited: true },
  { id: 'd2', name: 'pBR322', length: 4361, topology: 'circular' },
];

// ---------------------------------------------------------------------------------------
// ToolbarContent
// ---------------------------------------------------------------------------------------

function ToolbarHarness(props: Partial<ToolbarContentProps>) {
  const [view, setView] = useState<ViewMode>('map');
  const [display, setDisplay] = useState<EnzymeDisplay>('unique');
  return (
    <ToolbarContent
      title="pFA6a-kanMX6"
      subtitle="3,938 bp · circular"
      edited
      sidebarVisible
      onToggleSidebar={() => undefined}
      inspectorVisible={false}
      onToggleInspector={() => undefined}
      view={view}
      onViewChange={setView}
      enzymeDisplay={display}
      onEnzymeDisplayChange={setDisplay}
      {...props}
    />
  );
}

describe('ToolbarContent', () => {
  it('shows the title, subtitle and edited state in a draggable toolbar', () => {
    render(<ToolbarHarness />);
    const toolbar = screen.getByRole('toolbar', { name: 'Document' });
    expect(toolbar.hasAttribute('data-tauri-drag-region')).toBe(true);
    expect(screen.getByText('pFA6a-kanMX6')).toBeTruthy();
    expect(screen.getByText('3,938 bp · circular')).toBeTruthy();
    expect(screen.getByText('Edited')).toBeTruthy();
  });

  it('names the pane toggles by what they will do and wires aria-controls', async () => {
    const user = userEvent.setup();
    const onToggleSidebar = vi.fn();
    const onToggleInspector = vi.fn();
    render(<ToolbarHarness onToggleSidebar={onToggleSidebar} onToggleInspector={onToggleInspector} />);
    const hide = screen.getByRole('button', { name: 'Hide Sidebar' });
    expect(hide.getAttribute('aria-controls')).toBe(SIDEBAR_PANE_ID);
    expect(hide.getAttribute('aria-expanded')).toBe('true');
    const show = screen.getByRole('button', { name: 'Show Inspector' });
    expect(show.getAttribute('aria-controls')).toBe(INSPECTOR_PANE_ID);
    await user.click(hide);
    await user.click(show);
    expect(onToggleSidebar).toHaveBeenCalledTimes(1);
    expect(onToggleInspector).toHaveBeenCalledTimes(1);
  });

  it('switches the view', async () => {
    const user = userEvent.setup();
    const onViewChange = vi.fn();
    render(<ToolbarHarness view="map" onViewChange={onViewChange} />);
    await user.click(screen.getByRole('radio', { name: 'Split' }));
    expect(onViewChange).toHaveBeenCalledWith('split');
  });

  it('chooses which enzymes are shown', async () => {
    const user = userEvent.setup();
    const onEnzymeDisplayChange = vi.fn();
    const onChooseEnzymes = vi.fn();
    render(<ToolbarHarness onEnzymeDisplayChange={onEnzymeDisplayChange} enzymeDisplay="unique" onChooseEnzymes={onChooseEnzymes} />);
    await user.click(screen.getByRole('button', { name: 'Enzymes' }));
    expect(screen.getByRole('menuitemradio', { name: 'Unique cutters' }).getAttribute('aria-checked')).toBe('true');
    await user.click(screen.getByRole('menuitemradio', { name: 'Unique & dual cutters' }));
    expect(onEnzymeDisplayChange).toHaveBeenCalledWith('unique-dual');
    await user.click(screen.getByRole('button', { name: 'Enzymes' }));
    await user.click(screen.getByRole('menuitem', { name: 'Choose…' }));
    expect(onChooseEnzymes).toHaveBeenCalled();
  });

  it('runs actions, including the Clone submenu', async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    render(<ToolbarHarness onAction={onAction} />);
    await user.click(screen.getByRole('button', { name: 'Actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'Digest & gel…' }));
    expect(onAction).toHaveBeenLastCalledWith('digest');
    await user.click(screen.getByRole('button', { name: 'Actions' }));
    const clone = screen.getByRole('menuitem', { name: 'Clone' });
    clone.focus();
    await user.keyboard('{ArrowRight}');
    await user.click(await screen.findByRole('menuitem', { name: 'Gibson assembly…' }));
    expect(onAction).toHaveBeenLastCalledWith('clone-gibson');
  });

  it('reports search input and submissions', async () => {
    const user = userEvent.setup();
    const onSearchChange = vi.fn();
    const onSearchSubmit = vi.fn();
    render(<ToolbarHarness onSearchChange={onSearchChange} onSearchSubmit={onSearchSubmit} searchStatus="1 of 3" />);
    const field = screen.getByRole('searchbox', { name: 'Search sequence' });
    await user.type(field, 'GAATTC{Enter}');
    expect(onSearchChange).toHaveBeenLastCalledWith('GAATTC');
    expect(onSearchSubmit).toHaveBeenCalledWith('GAATTC', 'next');
    expect(screen.getByText('1 of 3')).toBeTruthy();
  });

  it('can hide the pane toggles and disable document commands', () => {
    render(<ToolbarHarness onToggleSidebar={undefined} onToggleInspector={undefined} disabled />);
    expect(screen.queryByRole('button', { name: /Sidebar/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Inspector/ })).toBeNull();
    expect((screen.getByRole('button', { name: 'Enzymes' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------------------

describe('Sidebar', () => {
  it('lists open documents and the annotations of the active one, with counts', () => {
    render(<Sidebar documents={DOCS} activeDocumentId="d1" record={RECORD} enzymeSites={SITES} />);
    const docs = screen.getByRole('tree', { name: 'Open documents' });
    expect(within(docs).getByRole('treeitem', { name: 'pFA6a-kanMX6, edited' }).getAttribute('aria-selected')).toBe('true');
    const annotations = screen.getByRole('tree', { name: 'Annotations' });
    expect(within(annotations).getByRole('treeitem', { name: 'Features' }).textContent).toContain('2');
    expect(within(annotations).getByRole('treeitem', { name: 'Primers' }).textContent).toContain('1');
    expect(within(annotations).getByRole('treeitem', { name: 'Enzymes' }).textContent).toContain('2');
    const pst = within(annotations).getByRole('treeitem', { name: 'PstI' });
    expect(pst.textContent).toContain('2');
    expect(pst.getAttribute('title')).toBe('PstI: 2 sites (cuts at 15, 905)');
    expect(within(annotations).getByRole('treeitem', { name: 'EcoRI' }).getAttribute('title')).toBe('EcoRI cuts once, at 396');
  });

  it('reports annotation selection and activation as typed references', () => {
    const onSelectItem = vi.fn();
    const onActivateItem = vi.fn();
    render(<Sidebar documents={DOCS} record={RECORD} enzymeSites={SITES} onSelectItem={onSelectItem} onActivateItem={onActivateItem} />);
    fireEvent.click(screen.getByRole('treeitem', { name: 'ori' }));
    expect(onSelectItem).toHaveBeenLastCalledWith({ kind: 'feature', id: 'f-ori' });
    fireEvent.click(screen.getByRole('treeitem', { name: 'M13-F' }));
    expect(onSelectItem).toHaveBeenLastCalledWith({ kind: 'primer', id: 'p1' });
    fireEvent.doubleClick(screen.getByRole('treeitem', { name: 'EcoRI' }));
    expect(onActivateItem).toHaveBeenLastCalledWith({ kind: 'enzyme', id: 'EcoRI' });
  });

  it('highlights the selected annotation', () => {
    render(<Sidebar documents={DOCS} record={RECORD} selectedItem={{ kind: 'feature', id: 'f-amp' }} />);
    expect(screen.getByRole('treeitem', { name: 'AmpR' }).getAttribute('aria-selected')).toBe('true');
  });

  it('switches and closes documents', () => {
    const onActivateDocument = vi.fn();
    const onCloseDocument = vi.fn();
    render(
      <Sidebar
        documents={DOCS}
        activeDocumentId="d1"
        record={RECORD}
        onActivateDocument={onActivateDocument}
        onCloseDocument={onCloseDocument}
      />,
    );
    fireEvent.click(screen.getByRole('treeitem', { name: 'pBR322' }));
    expect(onActivateDocument).toHaveBeenCalledWith('d2');
    onActivateDocument.mockClear();
    const close = screen.getByRole('button', { name: 'Close pBR322', hidden: true });
    expect(close.tabIndex).toBe(-1);
    fireEvent.click(close);
    expect(onCloseDocument).toHaveBeenCalledWith('d2');
    expect(onActivateDocument).not.toHaveBeenCalled();
  });

  it('filters annotations by name, expanding collapsed sections while filtering', async () => {
    const user = userEvent.setup();
    render(<Sidebar documents={DOCS} record={RECORD} enzymeSites={SITES} defaultCollapsedSections={['features']} />);
    expect(screen.queryByRole('treeitem', { name: 'AmpR' })).toBeNull();
    await user.type(screen.getByRole('searchbox', { name: 'Filter annotations' }), 'amp');
    expect(screen.getByRole('treeitem', { name: 'AmpR' })).toBeTruthy();
    expect(screen.queryByRole('treeitem', { name: 'ori' })).toBeNull();
    expect(screen.getByRole('treeitem', { name: 'Features' }).textContent).toContain('1 of 2');
    expect(screen.getAllByText('No matches')).toHaveLength(2);
    await user.clear(screen.getByRole('searchbox', { name: 'Filter annotations' }));
    expect(screen.queryByRole('treeitem', { name: 'AmpR' })).toBeNull();
  });

  it('shows an empty state without a document', () => {
    render(<Sidebar documents={[]} record={null} />);
    expect(screen.getByText('No Document')).toBeTruthy();
    expect(screen.queryByRole('searchbox')).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------
// Inspector
// ---------------------------------------------------------------------------------------

const SEQ = { seq: 'ATGC'.repeat(1000), topology: 'circular' as const };

describe('Inspector', () => {
  it('shows "No Document" without a selection summary', () => {
    render(<Inspector selection={null} />);
    expect(screen.getByText('No Document')).toBeTruthy();
  });

  it('describes the caret when no bases are selected', () => {
    const summary = summarizeSelection(SEQ, { range: { start: 1256, end: 1256 }, caret: 1256 });
    render(<Inspector selection={summary} sequenceComposition={summarizeSequence(SEQ)} />);
    expect(screen.getByText('Cursor')).toBeTruthy();
    expect(screen.getByText('After base 1,256')).toBeTruthy();
    // without selected bases, Analysis describes the whole sequence
    expect(screen.getByText('Whole sequence')).toBeTruthy();
  });

  it('shows the selection range, length, GC and a Tm placeholder', () => {
    const summary = summarizeSelection(SEQ, { range: { start: 395, end: 1256 }, caret: 1256 });
    render(<Inspector selection={summary} />);
    expect(screen.getByText('396..1,256')).toBeTruthy();
    expect(screen.getByText('861 bp')).toBeTruthy();
    expect(screen.getByText('50.1 %')).toBeTruthy(); // 431 G+C of 861 bases
    expect(screen.getByText('Tm').nextElementSibling!.textContent).toContain('—');
    expect(screen.getByRole('img', { name: /Base composition: A 25\.\d %/ })).toBeTruthy();
  });

  it('edits the feature name (Return commits, Escape reverts)', async () => {
    const user = userEvent.setup();
    const onFeatureChange = vi.fn<(id: string, edit: FeatureEdit) => void>();
    const summary = summarizeSelection(SEQ, { range: { start: 2610, end: 3471 }, caret: 3471 });
    render(<Inspector selection={summary} feature={AMPR} sequenceLength={4000} onFeatureChange={onFeatureChange} />);
    const name = screen.getByRole('textbox', { name: 'Name' });
    await user.clear(name);
    await user.type(name, 'bla{Escape}');
    expect((name as HTMLInputElement).value).toBe('AmpR');
    expect(onFeatureChange).not.toHaveBeenCalled();
    await user.clear(name);
    await user.type(name, 'bla{Enter}');
    expect(onFeatureChange).toHaveBeenCalledWith('f-amp', { name: 'bla' });
  });

  it('edits strand and colour', async () => {
    const user = userEvent.setup();
    const onFeatureChange = vi.fn<(id: string, edit: FeatureEdit) => void>();
    const summary = summarizeSelection(SEQ, { range: { start: 2610, end: 3471 }, caret: 3471 });
    render(<Inspector selection={summary} feature={{ ...AMPR, color: '#e5584f' }} sequenceLength={4000} onFeatureChange={onFeatureChange} />);
    expect(screen.getByRole('radio', { name: 'Reverse' }).getAttribute('aria-checked')).toBe('true');
    await user.click(screen.getByRole('radio', { name: 'Forward' }));
    expect(onFeatureChange).toHaveBeenLastCalledWith('f-amp', { strand: 1 });
    await user.click(screen.getByRole('button', { name: /Colour/ }));
    await user.click(screen.getByRole('button', { name: /Automatic/, pressed: false }));
    expect(onFeatureChange).toHaveBeenLastCalledWith('f-amp', { color: null });
  });

  it('shows location, length and qualifiers (without repeating the label)', () => {
    const summary = summarizeSelection(SEQ, { range: { start: 2610, end: 3471 }, caret: 3471 });
    render(<Inspector selection={summary} feature={AMPR} sequenceLength={4000} />);
    // once as the selection range, once as the feature location
    expect(screen.getAllByText('2,611..3,471')).toHaveLength(2);
    expect(screen.getByText('Product')).toBeTruthy();
    expect(screen.getByText('β-lactamase')).toBeTruthy();
    expect(screen.queryByText('Label')).toBeNull();
    // read-only without onFeatureChange
    expect((screen.getByRole('textbox', { name: 'Name' }) as HTMLInputElement).readOnly).toBe(true);
  });

  it('offers feature actions when callbacks are given', async () => {
    const user = userEvent.setup();
    const onDeleteFeature = vi.fn();
    const summary = summarizeSelection(SEQ, { range: { start: 2610, end: 3471 }, caret: 3471 });
    render(<Inspector selection={summary} feature={AMPR} onDeleteFeature={onDeleteFeature} onZoomToFeature={() => undefined} />);
    await user.click(screen.getByRole('button', { name: 'Feature actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'Delete Feature' }));
    expect(onDeleteFeature).toHaveBeenCalledWith('f-amp');
  });

  it('collapses cards (controlled)', async () => {
    const user = userEvent.setup();
    const onCollapsedCardsChange = vi.fn();
    const summary = summarizeSelection(SEQ, { range: { start: 0, end: 10 }, caret: 10 });
    render(<Inspector selection={summary} collapsedCards={['analysis']} onCollapsedCardsChange={onCollapsedCardsChange} />);
    expect(screen.getByRole('button', { name: 'Analysis' }).getAttribute('aria-expanded')).toBe('false');
    await user.click(screen.getByRole('button', { name: 'Selection' }));
    expect(onCollapsedCardsChange).toHaveBeenCalledWith(['analysis', 'selection']);
  });
});

// ---------------------------------------------------------------------------------------
// StatusBar, MainArea, AppShell, WelcomeScreen
// ---------------------------------------------------------------------------------------

describe('StatusBar', () => {
  it('shows the selection and the document length', () => {
    const summary = summarizeSelection(SEQ, { range: { start: 395, end: 1256 }, caret: 1256 });
    const { rerender } = render(<StatusBar selection={summary} length={4000} topology="circular" />);
    expect(screen.getByRole('status').textContent).toBe('Selection 396..1,256 · 861 bp · GC 50.1 %');
    expect(screen.getByText('4,000 bp · circular')).toBeTruthy();
    rerender(<StatusBar selection={summary} message="Copied 861 bp" length={4000} topology="circular" />);
    expect(screen.getByRole('status').textContent).toBe('Copied 861 bp');
  });
});

describe('MainArea', () => {
  const panes = (container: HTMLElement) => ({
    map: container.querySelector('[data-split-pane="map"]')!,
    sequence: container.querySelector('[data-split-pane="sequence"]')!,
  });

  it('shows the map, the sequence, or both', () => {
    const { container, rerender } = render(<MainArea view="map" />);
    expect(panes(container).map.hasAttribute('aria-hidden')).toBe(false);
    expect(panes(container).sequence.getAttribute('aria-hidden')).toBe('true');
    rerender(<MainArea view="sequence" />);
    expect(panes(container).map.getAttribute('aria-hidden')).toBe('true');
    expect(panes(container).sequence.hasAttribute('aria-hidden')).toBe(false);
    rerender(<MainArea view="split" />);
    expect(panes(container).map.hasAttribute('aria-hidden')).toBe(false);
    expect(panes(container).sequence.hasAttribute('aria-hidden')).toBe(false);
    expect(screen.getByRole('separator', { name: 'Resize Map' })).toBeTruthy();
  });

  it('hosts the given visualizations and keeps them mounted across views', () => {
    const { rerender } = render(<MainArea view="map" map={<div>real map</div>} sequence={<div>real sequence</div>} />);
    expect(screen.getByText('real map')).toBeTruthy();
    expect(screen.getByText('real sequence')).toBeTruthy();
    rerender(<MainArea view="sequence" map={<div>real map</div>} sequence={<div>real sequence</div>} />);
    expect(screen.getByText('real map')).toBeTruthy();
  });

  it('draws placeholders where visualizations are missing', () => {
    render(<MainArea view="split" placeholderTitle="pUC19" />);
    expect(screen.getByRole('img', { name: 'Map (placeholder)' })).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Sequence (placeholder)' })).toBeTruthy();
    expect(screen.getByText('pUC19')).toBeTruthy();
  });
});

describe('AppShell', () => {
  it('lays out toolbar, sidebar, content, inspector and status bar with drag regions', () => {
    const { container } = render(
      <AppShell
        platform="mac"
        toolbar={<span>toolbar</span>}
        sidebar={<span>sidebar</span>}
        inspector={<span>inspector</span>}
        statusBar={<span>status</span>}
      >
        <span>content</span>
      </AppShell>,
    );
    expect(document.getElementById(SIDEBAR_PANE_ID)!.textContent).toContain('sidebar');
    expect(document.getElementById(INSPECTOR_PANE_ID)!.textContent).toContain('inspector');
    expect(screen.getByRole('main').textContent).toBe('content');
    const window = container.firstElementChild!;
    expect(window.getAttribute('data-platform')).toBe('mac');
    const titlebar = screen.getByText('toolbar').parentElement!;
    expect(titlebar.hasAttribute('data-tauri-drag-region')).toBe(true);
    // the sidebar is open, so the toolbar needs no traffic-light inset
    expect(titlebar.hasAttribute('data-inset')).toBe(false);
    expect(container.querySelectorAll('[data-tauri-drag-region]').length).toBeGreaterThanOrEqual(2);
  });

  it('insets the toolbar for the traffic lights when the sidebar is hidden', () => {
    const onSidebarVisibleChange = vi.fn();
    const { rerender } = render(
      <AppShell sidebar={<span>sidebar</span>} sidebarVisible={false} onSidebarVisibleChange={onSidebarVisibleChange} toolbar={<span>tb</span>} />,
    );
    expect(screen.getByText('tb').parentElement!.hasAttribute('data-inset')).toBe(true);
    expect(document.querySelector('[data-split-pane="sidebar"]')!.getAttribute('aria-hidden')).toBe('true');
    rerender(<AppShell toolbar={<span>tb</span>} />);
    expect(screen.getByText('tb').parentElement!.hasAttribute('data-inset')).toBe(true);
  });

  it('reports collapsing a pane from its divider', () => {
    const onInspectorVisibleChange = vi.fn();
    render(<AppShell inspector={<span>i</span>} onInspectorVisibleChange={onInspectorVisibleChange} />);
    fireEvent.doubleClick(screen.getByRole('separator', { name: 'Resize Inspector' }));
    expect(onInspectorVisibleChange).toHaveBeenCalledWith(false);
  });

  it('marks inactive windows', () => {
    const { container } = render(<AppShell windowActive={false} />);
    expect(container.firstElementChild!.hasAttribute('data-inactive')).toBe(true);
  });
});

describe('WelcomeScreen', () => {
  it('offers Open and New Sequence with their shortcuts', async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    const onNewSequence = vi.fn();
    render(<WelcomeScreen onOpen={onOpen} onNewSequence={onNewSequence} version="0.1.0" />);
    expect(screen.getByRole('heading', { name: 'HHereditas', level: 1 })).toBeTruthy();
    expect(screen.getByText('Version 0.1.0')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /Open…/ }));
    await user.click(screen.getByRole('button', { name: /New Sequence…/ }));
    expect(onOpen).toHaveBeenCalled();
    expect(onNewSequence).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /Open…/ }).getAttribute('aria-keyshortcuts')).toMatch(/^(Meta|Control)\+O$/);
  });

  it('lists recent files and samples', async () => {
    const user = userEvent.setup();
    const onOpenRecent = vi.fn();
    const onOpenSample = vi.fn();
    const onClearRecent = vi.fn();
    render(
      <WelcomeScreen
        recentFiles={[{ id: '/a/pUC19.dna', name: 'pUC19.dna', location: '~/Plasmids', modified: 'Today', topology: 'circular' }]}
        onOpenRecent={onOpenRecent}
        onClearRecent={onClearRecent}
        samples={[{ id: 's1', name: 'pBR322', description: 'Classic vector', length: 4361, topology: 'circular' }]}
        onOpenSample={onOpenSample}
      />,
    );
    await user.click(screen.getByRole('button', { name: /pUC19\.dna/ }));
    expect(onOpenRecent).toHaveBeenCalledWith(expect.objectContaining({ id: '/a/pUC19.dna' }));
    await user.click(screen.getByRole('button', { name: /pBR322/ }));
    expect(onOpenSample).toHaveBeenCalledWith(expect.objectContaining({ id: 's1' }));
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    expect(onClearRecent).toHaveBeenCalled();
  });

  it('explains the empty recent list', () => {
    render(<WelcomeScreen />);
    expect(screen.getByText('Documents you open will appear here.')).toBeTruthy();
  });

  it('shows the drop target while files are dragged and reports dropped files', () => {
    const onDropFiles = vi.fn();
    const { container, rerender } = render(<WelcomeScreen dropActive />);
    expect(screen.getByText('Drop to open')).toBeTruthy();
    rerender(<WelcomeScreen onDropFiles={onDropFiles} />);
    expect(screen.queryByText('Drop to open')).toBeNull();
    const file = new File(['LOCUS'], 'pUC19.gb');
    const dataTransfer = { types: ['Files'], files: [file], dropEffect: 'none' };
    const root = container.firstElementChild!;
    fireEvent.dragEnter(root, { dataTransfer });
    expect(screen.getByText('Drop to open')).toBeTruthy();
    act(() => {
      fireEvent.drop(root, { dataTransfer });
    });
    expect(onDropFiles).toHaveBeenCalledWith([file]);
    expect(screen.queryByText('Drop to open')).toBeNull();
  });
});
