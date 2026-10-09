import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GelThumbnail } from './GelThumbnail';
import { GelView } from './GelView';
import { computeGelLayout } from './layout';
import { approximateGelTextWidth } from './measure';
import type { GelLane, GelLaneBand } from './types';

const W = 800;
const H = 600;

function pos(size: number): number {
  return 0.178 + 0.722 / (1 + (size / 1494) ** 1.12);
}

const LADDER: GelLane = {
  id: 'ladder',
  label: '1 kb ladder',
  kind: 'ladder',
  bands: [10000, 5000, 3000, 1500, 1000, 500, 250].map((size) => ({
    size,
    position: pos(size),
    intensity: size === 3000 ? 1 : 0.4,
    emphasized: size === 3000,
  })),
};
const HINFI: GelLane = {
  id: 'hinfi',
  label: 'HinfI',
  kind: 'sample',
  bands: [
    { size: 1631, position: pos(1631), intensity: 1, labels: ['HinfI (3,360) – HinfI (630)'] },
    { size: 517, position: pos(517), intensity: 0.32 },
    { size: 220.5, position: pos(220.5), intensity: 0.27, count: 2, sizes: [221, 220] },
  ],
};
const ECORI: GelLane = { id: 'ecori', label: 'EcoRI', kind: 'sample', bands: [{ size: 4361, position: pos(4361), intensity: 1 }] };
const LANES = [LADDER, ECORI, HINFI];

/** The layout the component computes in jsdom (same size, same text estimate). */
function layoutFor(lanes: readonly GelLane[], showSizes: 'ladder' | 'all' | 'none' = 'ladder') {
  return computeGelLayout(lanes, { width: W, height: H, showSizes, measure: approximateGelTextWidth });
}

beforeEach(() => {
  // jsdom has no layout: give every element the gel's size at the page origin
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: W,
    bottom: H,
    width: W,
    height: H,
    toJSON: () => ({}),
  } as DOMRect);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function surface(): HTMLElement {
  return screen.getByRole('listbox', { name: 'Lanes' });
}

describe('GelView', () => {
  it('renders one selectable lane per lane with an accessible description', () => {
    render(<GelView lanes={LANES} selectedLaneId="hinfi" onLaneClick={() => undefined} agarosePercent={1} />);
    expect(screen.getByRole('figure', { name: 'Agarose gel, 1% agarose, 3 lanes' })).toBeTruthy();
    const options = screen.getAllByRole('option');
    expect(options.map((o) => o.getAttribute('aria-label'))).toEqual([
      '1 kb ladder, ladder: 7 bands: 10 kb, 5 kb, 3 kb, 1.5 kb, 1 kb, 500 bp, 250 bp',
      'EcoRI: 1 band: 4.36 kb',
      // the 220.5 bp band is a doublet of 221 + 220 bp: both sizes are read out
      'HinfI: 3 bands: 1.63 kb, 517 bp, 221/220 bp',
    ]);
    expect(options.map((o) => o.getAttribute('aria-selected'))).toEqual(['false', 'false', 'true']);
    // roving tab stop on the selected lane
    expect(options.map((o) => o.tabIndex)).toEqual([-1, -1, 0]);
  });

  it('writes ladder sizes, lane labels and the agarose caption', () => {
    const { container } = render(<GelView lanes={LANES} agarosePercent={0.8} />);
    const text = container.textContent ?? '';
    for (const t of ['10 kb', '3 kb', '1.5 kb', '500 bp', '1 kb ladder', 'EcoRI', 'HinfI', '0.8% agarose']) expect(text).toContain(t);
    // sample sizes only with showSizes="all"
    expect(text).not.toContain('4.36 kb');
    cleanup();
    const all = render(<GelView lanes={LANES} showSizes="all" />);
    expect(all.container.textContent).toContain('4.36 kb');
    cleanup();
    const none = render(<GelView lanes={LANES} showSizes="none" />);
    expect(none.container.textContent).not.toContain('1.5 kb');
    // read-only gel: a list, not a listbox
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
  });

  it('calls onLaneClick for clicks on a lane and on its label', () => {
    const onLaneClick = vi.fn();
    render(<GelView lanes={LANES} onLaneClick={onLaneClick} />);
    fireEvent.click(screen.getAllByRole('option')[1]);
    expect(onLaneClick).toHaveBeenLastCalledWith('ecori');
    fireEvent.click(screen.getByText('HinfI'));
    expect(onLaneClick).toHaveBeenLastCalledWith('hinfi');
  });

  it('reports hovered bands once and shows their tooltip', () => {
    const onBandHover = vi.fn<(laneId: string, band: GelLaneBand | null) => void>();
    render(<GelView lanes={LANES} onBandHover={onBandHover} onLaneClick={() => undefined} />);
    const layout = layoutFor(LANES);
    const lane = layout.lanes[2];
    const top = lane.bands[0];
    fireEvent.pointerMove(surface(), { clientX: lane.cx, clientY: top.y });
    expect(onBandHover).toHaveBeenCalledTimes(1);
    expect(onBandHover).toHaveBeenLastCalledWith('hinfi', HINFI.bands[0]);
    const tip = screen.getByRole('tooltip');
    expect(tip.textContent).toContain('1,631 bp');
    expect(tip.textContent).toContain('HinfI (3,360) – HinfI (630)');
    // moving within the same band does not report again
    fireEvent.pointerMove(surface(), { clientX: lane.cx + 3, clientY: top.y + 1 });
    expect(onBandHover).toHaveBeenCalledTimes(1);
    // the merged doublet
    const doublet = lane.bands[2];
    fireEvent.pointerMove(surface(), { clientX: lane.cx, clientY: doublet.y });
    expect(onBandHover).toHaveBeenLastCalledWith('hinfi', HINFI.bands[2]);
    expect(screen.getByRole('tooltip').textContent).toContain('2 co-migrating fragments: 221 + 220 bp');
    // between bands: null for that lane, tooltip gone
    fireEvent.pointerMove(surface(), { clientX: lane.cx, clientY: (lane.bands[0].y + lane.bands[1].y) / 2 });
    expect(onBandHover).toHaveBeenLastCalledWith('hinfi', null);
    expect(screen.queryByRole('tooltip')).toBeNull();
    // another lane, then leaving the gel
    const ecori = layout.lanes[1];
    fireEvent.pointerMove(surface(), { clientX: ecori.cx, clientY: ecori.bands[0].y });
    expect(onBandHover).toHaveBeenLastCalledWith('ecori', ECORI.bands[0]);
    fireEvent.pointerLeave(surface());
    expect(onBandHover).toHaveBeenLastCalledWith('ecori', null);
    expect(onBandHover).toHaveBeenCalledTimes(5);
  });

  it('shows ladder band details and highlights the ladder label', () => {
    render(<GelView lanes={LANES} />);
    const layout = layoutFor(LANES);
    const ladder = layout.lanes[0];
    const ref = ladder.bands[2]; // 3 kb reference band
    fireEvent.pointerMove(screen.getByRole('list', { name: 'Lanes' }), { clientX: ladder.cx, clientY: ref.y });
    const tip = screen.getByRole('tooltip');
    expect(tip.textContent).toContain('3,000 bp');
    expect(tip.textContent).toContain('Reference band');
  });

  it('supports keyboard navigation between lanes and through bands', () => {
    const onLaneClick = vi.fn();
    const onBandHover = vi.fn();
    render(<GelView lanes={LANES} onLaneClick={onLaneClick} onBandHover={onBandHover} />);
    const options = screen.getAllByRole('option');
    act(() => options[0].focus());
    fireEvent.keyDown(options[0], { key: 'ArrowRight' });
    expect(document.activeElement).toBe(options[1]);
    fireEvent.keyDown(options[1], { key: 'End' });
    expect(document.activeElement).toBe(options[2]);
    expect(options[2].tabIndex).toBe(0);
    fireEvent.keyDown(options[2], { key: 'ArrowDown' });
    expect(onBandHover).toHaveBeenLastCalledWith('hinfi', HINFI.bands[0]);
    expect(screen.getByRole('tooltip').textContent).toContain('1,631 bp');
    expect(options[2].getAttribute('aria-describedby')).toBe(screen.getByRole('tooltip').id);
    fireEvent.keyDown(options[2], { key: 'ArrowDown' });
    expect(onBandHover).toHaveBeenLastCalledWith('hinfi', HINFI.bands[1]);
    // the live region announces the band
    expect(document.querySelector('[aria-live="polite"]')?.textContent).toBe('517 bp');
    fireEvent.keyDown(options[2], { key: 'Enter' });
    expect(onLaneClick).toHaveBeenLastCalledWith('hinfi');
    fireEvent.keyDown(options[2], { key: ' ' });
    expect(onLaneClick).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(options[2], { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(onBandHover).toHaveBeenLastCalledWith('hinfi', null);
    fireEvent.keyDown(options[2], { key: 'Home' });
    expect(document.activeElement).toBe(options[0]);
  });

  it('shows the full text of a truncated lane label in a tooltip', () => {
    const long = Array.from(
      { length: 12 },
      (_, i): GelLane => ({
        id: `c${i}`,
        label: `pUC19-mCherry clone ${i + 1} · EcoRI + HindIII double digest`,
        kind: 'sample',
        bands: [{ size: 2660, position: pos(2660), intensity: 1 }],
      }),
    );
    const onLaneClick = vi.fn();
    render(<GelView lanes={long} onLaneClick={onLaneClick} />);
    const layout = layoutFor(long);
    expect(layout.header.mode).toBe('diagonal');
    expect(layout.header.labels[4].truncated).toBe(true);
    const label = screen.getByText(long[4].label);
    fireEvent.pointerEnter(label);
    expect(screen.getByRole('tooltip').textContent).toBe(long[4].label);
    fireEvent.click(label);
    expect(onLaneClick).toHaveBeenLastCalledWith('c4');
    fireEvent.pointerLeave(label);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('names the lane under the pointer when the lanes are too narrow for labels', () => {
    const many = Array.from(
      { length: 100 },
      (_, i): GelLane => ({
        id: `s${i}`,
        label: `Sample ${i + 1}`,
        kind: 'sample',
        bands: [{ size: 1000, position: pos(1000), intensity: 1 }],
      }),
    );
    render(<GelView lanes={many} />);
    const layout = layoutFor(many);
    expect(layout.header.mode).toBe('hidden');
    expect(screen.queryByText('Sample 42')).toBeNull();
    const lane = layout.lanes[41];
    const list = screen.getByRole('list', { name: 'Lanes' });
    fireEvent.pointerMove(list, { clientX: lane.cx, clientY: layout.scale.top + 20 });
    expect(screen.getByRole('tooltip').textContent).toBe('Sample 42');
    // on a band, the band tooltip (which names the lane too) takes over
    fireEvent.pointerMove(list, { clientX: lane.cx, clientY: lane.bands[0].y });
    expect(screen.getByRole('tooltip').textContent).toContain('1,000 bp');
    expect(screen.getByRole('tooltip').textContent).toContain('Sample 42');
    fireEvent.pointerLeave(list);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('shows an empty state without lanes and handles empty lanes', () => {
    render(<GelView lanes={[]} />);
    expect(screen.getByText('No lanes')).toBeTruthy();
    cleanup();
    const empty: GelLane = { id: 'e', label: '', kind: 'sample', bands: [] };
    render(<GelView lanes={[LADDER, empty]} onLaneClick={() => undefined} />);
    expect(screen.getAllByRole('option')[1].getAttribute('aria-label')).toBe('Lane 2: no bands');
  });
});

describe('GelThumbnail', () => {
  it('renders a labelled image without any text', () => {
    const { container } = render(<GelThumbnail lanes={LANES} />);
    const img = screen.getByRole('img', { name: 'Gel preview, 3 lanes' });
    expect(img.style.width).toBe('160px');
    expect(img.style.height).toBe('200px');
    expect(container.textContent).toBe('');
    expect(container.querySelectorAll('rect').length).toBeGreaterThan(10);
  });

  it('accepts a size and an accessible name', () => {
    render(<GelThumbnail lanes={[ECORI]} width={96} height={120} aria-label="EcoRI digest" />);
    const img = screen.getByRole('img', { name: 'EcoRI digest' });
    expect(img.style.width).toBe('96px');
  });
});
