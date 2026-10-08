import '../../test/setup';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { compareValues, nextSelection, sortRows } from './selection';
import { Table, type TableColumn } from './Table';

describe('nextSelection', () => {
  const keys = ['a', 'b', 'c', 'd', 'e'];
  it('single mode always selects exactly the clicked row', () => {
    expect(nextSelection('single', ['a'], keys, 2, 0, { toggle: true, range: true })).toEqual(['c']);
  });
  it('multiple mode: click, toggle, range and range-add', () => {
    expect(nextSelection('multiple', ['a', 'b'], keys, 3, 0, { toggle: false, range: false })).toEqual(['d']);
    expect(nextSelection('multiple', ['a'], keys, 3, 0, { toggle: true, range: false })).toEqual(['a', 'd']);
    expect(nextSelection('multiple', ['a', 'd'], keys, 3, 0, { toggle: true, range: false })).toEqual(['a']);
    expect(nextSelection('multiple', ['a'], keys, 3, 1, { toggle: false, range: true })).toEqual(['b', 'c', 'd']);
    expect(nextSelection('multiple', ['e'], keys, 1, 3, { toggle: true, range: true })).toEqual(['b', 'c', 'd', 'e']);
  });
  it('none mode never changes the selection', () => {
    expect(nextSelection('none', ['a'], keys, 3, 0, { toggle: false, range: false })).toEqual(['a']);
  });
});

describe('sorting', () => {
  it('compares numbers numerically and strings naturally, empties last', () => {
    expect(compareValues(2, 10)).toBeLessThan(0);
    expect(compareValues('pUC8', 'pUC19')).toBeLessThan(0);
    expect(compareValues('', 'a')).toBeGreaterThan(0);
    expect(compareValues(null, null)).toBe(0);
  });
  it('sorts stably in both directions with empties last', () => {
    const rows = [
      { n: 'b', v: 2 },
      { n: 'x', v: null },
      { n: 'a', v: 2 },
      { n: 'c', v: 1 },
    ];
    expect(sortRows(rows, (r) => r.v, 'ascending').map((r) => r.n)).toEqual(['c', 'b', 'a', 'x']);
    expect(sortRows(rows, (r) => r.v, 'descending').map((r) => r.n)).toEqual(['b', 'a', 'c', 'x']);
  });
});

interface Row {
  name: string;
  start: number;
}
const ROWS: Row[] = [
  { name: 'ori', start: 2500 },
  { name: 'AmpR', start: 396 },
  { name: 'lacZα', start: 146 },
];
const COLUMNS: TableColumn<Row>[] = [
  { key: 'name', header: 'Name', sortable: true },
  { key: 'start', header: 'Start', align: 'end', sortable: true },
];

function Harness({ onSelection, onActivate }: { onSelection?: (k: string[]) => void; onActivate?: (r: Row) => void }) {
  const [selected, setSelected] = useState<string[]>([]);
  return (
    <Table
      aria-label="Features"
      columns={COLUMNS}
      rows={ROWS}
      rowKey={(r) => r.name}
      selectionMode="multiple"
      selectedKeys={selected}
      onSelectionChange={(k) => {
        setSelected(k);
        onSelection?.(k);
      }}
      onRowActivate={onActivate}
    />
  );
}

const bodyRowNames = () =>
  screen
    .getAllByRole('row')
    .slice(1)
    .map((r) => within(r).getAllByRole('gridcell')[0].textContent);

describe('Table', () => {
  it('renders a grid with a header row and zebra striping', () => {
    render(<Harness />);
    const grid = screen.getByRole('grid', { name: 'Features' });
    expect(grid.getAttribute('aria-rowcount')).toBe('4');
    expect(screen.getAllByRole('columnheader')).toHaveLength(2);
    const rows = screen.getAllByRole('row');
    expect(rows[2].hasAttribute('data-odd')).toBe(true);
    expect(rows[1].hasAttribute('data-odd')).toBe(false);
  });

  it('sorts by clicking headers (ascending, then descending)', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    expect(bodyRowNames()).toEqual(['lacZα', 'AmpR', 'ori']);
    expect(screen.getAllByRole('columnheader')[1].getAttribute('aria-sort')).toBe('ascending');
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    expect(bodyRowNames()).toEqual(['ori', 'AmpR', 'lacZα']);
  });

  it('selects with click, toggles with the platform modifier and extends with Shift', () => {
    document.documentElement.classList.add('hh-platform-mac');
    const onSelection = vi.fn();
    render(<Harness onSelection={onSelection} />);
    const rows = screen.getAllByRole('row').slice(1);
    fireEvent.click(rows[0]);
    expect(onSelection).toHaveBeenLastCalledWith(['ori']);
    fireEvent.click(rows[2], { metaKey: true });
    expect(onSelection).toHaveBeenLastCalledWith(['ori', 'lacZα']);
    fireEvent.click(rows[1], { shiftKey: true });
    expect(onSelection).toHaveBeenLastCalledWith(['AmpR', 'lacZα']);
  });

  it('navigates with the keyboard and activates with Return', () => {
    const onSelection = vi.fn();
    const onActivate = vi.fn();
    render(<Harness onSelection={onSelection} onActivate={onActivate} />);
    const grid = screen.getByRole('grid');
    fireEvent.focus(grid);
    fireEvent.keyDown(grid, { key: 'ArrowDown' });
    expect(onSelection).toHaveBeenLastCalledWith(['ori']);
    fireEvent.keyDown(grid, { key: 'ArrowDown', shiftKey: true });
    expect(onSelection).toHaveBeenLastCalledWith(['ori', 'AmpR']);
    fireEvent.keyDown(grid, { key: 'End' });
    expect(onSelection).toHaveBeenLastCalledWith(['lacZα']);
    fireEvent.keyDown(grid, { key: 'Enter' });
    expect(onActivate).toHaveBeenLastCalledWith(ROWS[2], 2);
  });

  it('renders rows through renderBody for external virtualization', () => {
    render(
      <Table
        aria-label="Virtual"
        columns={COLUMNS}
        rows={ROWS}
        rowKey={(r) => r.name}
        renderBody={({ renderRow, rowCount }) => <div data-testid="body">{renderRow(rowCount - 1, { top: 48 })}</div>}
      />,
    );
    const body = screen.getByTestId('body');
    const row = within(body).getByRole('row');
    expect(row.textContent).toContain('lacZα');
    expect(row.style.top).toBe('48px');
  });

  it('shows the empty state when there are no rows', () => {
    render(<Table aria-label="Empty" columns={COLUMNS} rows={[]} rowKey={(r) => r.name} emptyState={<span>No primers</span>} />);
    expect(screen.getByText('No primers')).toBeTruthy();
  });
});
