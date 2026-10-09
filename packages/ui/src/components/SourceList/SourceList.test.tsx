import '../../test/setup';
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { buildSourceListRows, DEFAULT_METRICS, scrollToReveal, visibleRowRange } from './layout';
import { SourceList, type SourceListSection } from './SourceList';

const sections: SourceListSection[] = [
  {
    id: 'features',
    title: 'Features',
    count: 3,
    items: [
      { id: 'f:amp', label: 'AmpR', secondary: '861 bp' },
      { id: 'f:ori', label: 'ori', secondary: '589 bp' },
      { id: 'f:lac', label: 'lacZα', secondary: '324 bp' },
    ],
  },
  { id: 'primers', title: 'Primers', count: 0, items: [], emptyText: 'No primers' },
  {
    id: 'enzymes',
    title: 'Enzymes',
    items: [
      { id: 'e:EcoRI', label: 'EcoRI', trailing: '1' },
      { id: 'e:BamHI', label: 'BamHI', trailing: '1', disabled: true },
      { id: 'e:PstI', label: 'PstI', trailing: '2' },
    ],
  },
];

describe('buildSourceListRows', () => {
  it('lays out headers, items and empty placeholders top to bottom', () => {
    const { rows, height } = buildSourceListRows(sections, new Set());
    expect(rows.map((r) => r.kind)).toEqual(['header', 'item', 'item', 'item', 'header', 'empty', 'header', 'item', 'item', 'item']);
    const m = DEFAULT_METRICS;
    expect(rows[0].top).toBe(m.paddingTop);
    // the second header carries the section gap above it
    expect(rows[4]).toMatchObject({ kind: 'header', gap: m.sectionGap, height: m.headerHeight + m.sectionGap });
    for (let i = 1; i < rows.length; i++) expect(rows[i].top).toBe(rows[i - 1].top + rows[i - 1].height);
    const last = rows[rows.length - 1];
    expect(height).toBe(last.top + last.height + m.paddingBottom);
  });

  it('drops the items of collapsed sections but keeps their header', () => {
    const { rows } = buildSourceListRows(sections, new Set(['features']));
    expect(rows[0]).toMatchObject({ kind: 'header', expanded: false });
    expect(rows[1]).toMatchObject({ kind: 'header', key: 'h:primers' });
  });

  it('never collapses untitled sections', () => {
    const { rows } = buildSourceListRows([{ id: 'docs', items: [{ id: 'd1' }] }], new Set(['docs']));
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('item');
  });
});

describe('visibleRowRange', () => {
  const rows = Array.from({ length: 1000 }, (_, i) => ({ top: i * 28, height: 28 }));
  it('returns only the rows intersecting the viewport (plus overscan)', () => {
    expect(visibleRowRange(rows, 0, 280)).toEqual([0, 10]);
    expect(visibleRowRange(rows, 28 * 500 + 10, 280)).toEqual([500, 511]);
    expect(visibleRowRange(rows, 28 * 500, 280, 56)).toEqual([498, 512]);
  });
  it('handles the ends', () => {
    expect(visibleRowRange(rows, 28 * 995, 1000)).toEqual([995, 1000]);
    expect(visibleRowRange([], 0, 100)).toEqual([0, 0]);
  });
});

describe('scrollToReveal', () => {
  it('scrolls the minimum amount', () => {
    expect(scrollToReveal(100, 200, 150, 28)).toBe(100); // already visible
    expect(scrollToReveal(100, 200, 60, 28)).toBe(56); // above: align to top (minus margin)
    expect(scrollToReveal(100, 200, 290, 28)).toBe(122); // below: align to bottom (plus margin)
    expect(scrollToReveal(0, 200, 0, 28)).toBe(0);
  });
});

function Harness({ onSelect, onActivate }: { onSelect?: (id: string) => void; onActivate?: (id: string) => void }) {
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <SourceList
      aria-label="Sidebar"
      sections={sections}
      selectedId={selected}
      onSelect={(item) => {
        setSelected(item.id);
        onSelect?.(item.id);
      }}
      onActivate={(item) => onActivate?.(item.id)}
    />
  );
}

describe('SourceList', () => {
  it('renders a tree with sections, counts and rows', () => {
    render(<Harness />);
    const tree = screen.getByRole('tree', { name: 'Sidebar' });
    expect(tree).toBeTruthy();
    const header = screen.getByRole('treeitem', { name: 'Features' });
    expect(header.getAttribute('aria-expanded')).toBe('true');
    expect(header.textContent).toContain('3');
    expect(screen.getByRole('treeitem', { name: 'AmpR' }).getAttribute('aria-level')).toBe('2');
    expect(screen.getByText('No primers')).toBeTruthy();
  });

  it('selects on click and activates on double-click', () => {
    const onSelect = vi.fn();
    const onActivate = vi.fn();
    render(<Harness onSelect={onSelect} onActivate={onActivate} />);
    const row = screen.getByRole('treeitem', { name: 'ori' });
    fireEvent.click(row);
    expect(onSelect).toHaveBeenLastCalledWith('f:ori');
    expect(row.getAttribute('aria-selected')).toBe('true');
    fireEvent.doubleClick(row);
    expect(onActivate).toHaveBeenLastCalledWith('f:ori');
  });

  it('reports right-clicks and outlines the row whose context menu is open, without selecting it', () => {
    const onItemContextMenu = vi.fn();
    const { rerender } = render(
      <SourceList aria-label="Sidebar" sections={sections} selectedId="f:ori" onItemContextMenu={(item) => onItemContextMenu(item.id)} />,
    );
    fireEvent.contextMenu(screen.getByRole('treeitem', { name: 'AmpR' }));
    expect(onItemContextMenu).toHaveBeenCalledWith('f:amp');
    rerender(<SourceList aria-label="Sidebar" sections={sections} selectedId="f:ori" contextMenuItemId="f:amp" />);
    const row = screen.getByRole('treeitem', { name: 'AmpR' });
    expect(row.hasAttribute('data-context-target')).toBe(true);
    expect(row.getAttribute('aria-selected')).toBe('false');
    expect(screen.getByRole('treeitem', { name: 'ori' }).hasAttribute('data-context-target')).toBe(false);
  });

  it('does not select disabled rows', () => {
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    fireEvent.click(screen.getByRole('treeitem', { name: 'BamHI' }));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('collapses and expands a section from its header', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('treeitem', { name: 'Features' }));
    expect(screen.queryByRole('treeitem', { name: 'AmpR' })).toBeNull();
    expect(screen.getByRole('treeitem', { name: 'Features' }).getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(screen.getByRole('treeitem', { name: 'Features' }));
    expect(screen.getByRole('treeitem', { name: 'AmpR' })).toBeTruthy();
  });

  it('moves the selection with the arrow keys, skipping disabled rows', () => {
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    const tree = screen.getByRole('tree');
    fireEvent.focus(tree);
    // focus lands on the first navigable row (the Features header)
    fireEvent.keyDown(tree, { key: 'ArrowDown' });
    expect(onSelect).toHaveBeenLastCalledWith('f:amp');
    fireEvent.keyDown(tree, { key: 'End' });
    expect(onSelect).toHaveBeenLastCalledWith('e:PstI');
    fireEvent.keyDown(tree, { key: 'ArrowUp' });
    // BamHI is disabled: the Up arrow jumps to EcoRI
    expect(onSelect).toHaveBeenLastCalledWith('e:EcoRI');
    fireEvent.keyDown(tree, { key: 'Home' });
    expect(tree.getAttribute('aria-activedescendant')).toContain('h:features');
  });

  it('collapses with ArrowLeft on a header and expands with ArrowRight', () => {
    render(<Harness />);
    const tree = screen.getByRole('tree');
    fireEvent.focus(tree);
    fireEvent.keyDown(tree, { key: 'ArrowLeft' });
    expect(screen.getByRole('treeitem', { name: 'Features' }).getAttribute('aria-expanded')).toBe('false');
    fireEvent.keyDown(tree, { key: 'ArrowRight' });
    expect(screen.getByRole('treeitem', { name: 'Features' }).getAttribute('aria-expanded')).toBe('true');
  });

  it('ArrowLeft on a row moves to its section header; Return activates rows', () => {
    const onActivate = vi.fn();
    render(<Harness onActivate={onActivate} />);
    const tree = screen.getByRole('tree');
    fireEvent.focus(tree);
    fireEvent.keyDown(tree, { key: 'ArrowDown' });
    fireEvent.keyDown(tree, { key: 'ArrowDown' });
    fireEvent.keyDown(tree, { key: 'Enter' });
    expect(onActivate).toHaveBeenLastCalledWith('f:ori');
    fireEvent.keyDown(tree, { key: 'ArrowLeft' });
    expect(tree.getAttribute('aria-activedescendant')).toContain('h:features');
  });

  it('jumps to rows by typing their first letters', () => {
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    const tree = screen.getByRole('tree');
    fireEvent.focus(tree);
    fireEvent.keyDown(tree, { key: 'p' });
    expect(onSelect).toHaveBeenLastCalledWith('e:PstI');
    fireEvent.keyDown(tree, { key: 'e' });
    // "pe" matches nothing; selection stays
    expect(onSelect).toHaveBeenLastCalledWith('e:PstI');
  });

  it('shows hover actions without selecting the row when they are clicked', () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(
      <SourceList
        aria-label="Docs"
        sections={[
          {
            id: 'docs',
            items: [
              {
                id: 'd1',
                label: 'pUC19',
                actions: (
                  <button type="button" onClick={onClose}>
                    Close
                  </button>
                ),
              },
            ],
          },
        ]}
        onSelect={(item) => onSelect(item.id)}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('virtualizes long lists', () => {
    const big: SourceListSection[] = [
      {
        id: 'many',
        title: 'Features',
        items: Array.from({ length: 5000 }, (_, i) => ({ id: `f${i}`, label: `gene ${i}` })),
      },
    ];
    render(<SourceList aria-label="Big" sections={big} />);
    const rendered = screen.getAllByRole('treeitem');
    expect(rendered.length).toBeLessThan(80);
    expect(rendered.length).toBeGreaterThan(10);
  });
});
