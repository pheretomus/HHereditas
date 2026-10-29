import type { Range, SeqRecord } from '@hhereditas/core';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SAMPLES } from '../fixtures';
import type { SequenceSelection } from '../selection';
import { buildCutMarkers } from './enzymeLabels';
import { syntheticGenome } from './galleryData';
import { featureEntryIndex } from './hitTest';
import type { FeatureEntry } from './layout';
import { METRICS, buildFeatureTrack, computeView, contentOffsetY, enzymeRowsToReserve, featureBarTop, featureLabelRowsToReserve } from './layout';
import { LinearMap } from './LinearMap';
import { estimateTextWidth } from './textMeasure';
import type { MapTarget } from './types';
import { clampViewport, fullViewport, makeScale } from './viewport';

const W = 1000;
const H = 520;
const PLOT_W = W - 2 * METRICS.padX;

const pFA6a = SAMPLES.pFA6a;
const L = pFA6a.record.seq.length;

/** The geometry the component computes in jsdom (same size, same text estimate). */
function geometry(record: SeqRecord, enzymeSites = pFA6a.enzymeSites, viewport: Range = fullViewport(record.seq.length)) {
  const len = record.seq.length;
  const scale = makeScale(clampViewport(viewport, len, PLOT_W), METRICS.padX, PLOT_W);
  const features = buildFeatureTrack(record.features, len, record.topology);
  const markers = enzymeSites.length ? buildCutMarkers(enzymeSites, len, record.topology) : null;
  const input = {
    record,
    width: W,
    scale,
    features,
    orfs: null,
    primers: null,
    markers,
    enzymeRows: markers ? enzymeRowsToReserve(markers, len, METRICS.padX, PLOT_W, W, estimateTextWidth) : 0,
    measure: estimateTextWidth,
  };
  // like the component: outside feature label rows reserved from the whole-record view
  const featureLabelRows = featureLabelRowsToReserve({ ...input, scale: makeScale(fullViewport(len), METRICS.padX, PLOT_W) });
  const view = computeView({ ...input, featureLabelRows });
  const offsetY = contentOffsetY(H, view.height);
  /** Client point at the middle of a feature's bar (or at a bp inside it). */
  const featurePoint = (name: string, at?: number) => {
    const f = record.features.find((x) => x.name === name)!;
    const e: FeatureEntry = features.entries[featureEntryIndex(features, f.id)];
    const bp = at ?? (e.extent.start + Math.min(e.extent.end, len)) / 2;
    return { clientX: scale.x(bp), clientY: featureBarTop(view.v, e.side, e.lane) + METRICS.featureBarHeight / 2 + offsetY, entry: e };
  };
  /** Client point on the ruler under the backbone at gap `bp`. */
  const rulerPoint = (bp: number) => ({ clientX: scale.x(bp), clientY: view.v.bottomStrandY + 10 + offsetY });
  /** Client point in empty space below everything. */
  const emptyPoint = (bp: number) => ({ clientX: scale.x(bp), clientY: view.height - 4 + offsetY });
  return { scale, view, features, featurePoint, rulerPoint, emptyPoint };
}

function svgOf(container: HTMLElement): SVGSVGElement {
  const svg = container.querySelector('svg');
  if (!svg) throw new Error('map not rendered');
  return svg;
}

function nextFrame(): Promise<void> {
  return act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
}

beforeEach(() => {
  // jsdom has no layout: every element gets the map's size at the page origin
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
  // reduced motion: viewport changes apply at once instead of gliding
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('reduce'),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('<LinearMap /> rendering', () => {
  it('describes itself to assistive technology', () => {
    render(<LinearMap record={pFA6a.record} />);
    const map = screen.getByRole('group');
    expect(map.getAttribute('aria-label')).toBe('pFA6a-kanMX6: linear map, 3,938 bp, circular, 18 features');
    expect(map.getAttribute('aria-roledescription')).toBe('linear map');
    expect(map.tabIndex).toBe(0);
  });

  it('draws features, enzyme labels and ruler numbers', () => {
    const { container } = render(<LinearMap record={pFA6a.record} enzymeSites={pFA6a.enzymeSites} />);
    const texts = [...container.querySelectorAll('text')].map((t) => t.textContent);
    expect(texts).toContain('KanR');
    expect(texts).toContain('1,000');
    // exactly the enzyme labels the layout placed (the geometry helper matches the component)
    const placed = geometry(pFA6a.record).view.enzymes.labels.map((l) => l.text);
    expect(placed.length).toBeGreaterThan(10);
    for (const t of placed) expect(texts).toContain(t);
    expect(placed.some((t) => t.startsWith('NcoI'))).toBe(true);
  });

  it('shows the empty state for an empty record', () => {
    render(<LinearMap record={{ ...pFA6a.record, seq: '', features: [] }} />);
    expect(screen.getByText('No sequence')).toBeTruthy();
  });

  it('draws base letters of both strands at high zoom (controlled viewport)', () => {
    const { container } = render(<LinearMap record={pFA6a.record} viewport={{ start: 22, end: 86 }} />);
    const texts = [...container.querySelectorAll('text')].map((t) => t.textContent ?? '');
    const seq = pFA6a.record.seq;
    expect(texts.some((t) => t.length > 30 && seq.includes(t))).toBe(true);
  });

  it('draws a selection that wraps the origin as two pieces', () => {
    const sel: SequenceSelection = { range: { start: 3700, end: L + 260 }, caret: 260 };
    render(<LinearMap record={pFA6a.record} selection={sel} />);
    const pieces = [...screen.getByTestId('selection').querySelectorAll('[data-piece]')].map((g) => g.getAttribute('data-piece'));
    expect(pieces).toEqual([`3700-${L}`, '0-260']);
  });

  it('draws a caret for an empty selection', () => {
    render(<LinearMap record={pFA6a.record} selection={{ range: { start: 1200, end: 1200 }, caret: 1200 }} />);
    expect(screen.getByTestId('caret')).toBeTruthy();
  });

  it('rings the highlighted feature and multiple selectedFeatureIds, and renders 3-tier feature labels', () => {
    const kan = pFA6a.record.features.find((f) => f.name === 'KanR')!;
    const amp = pFA6a.record.features.find((f) => f.name === 'AmpR')!;
    const { container } = render(<LinearMap record={pFA6a.record} highlightedFeatureId={kan.id} selectedFeatureIds={[kan.id, amp.id]} />);
    expect(screen.getByTestId('highlight-ring').getAttribute('d')).toMatch(/^M/);
    expect(screen.getByTestId('feature-leaders').querySelector('path')?.getAttribute('d')).toMatch(/^M/);
    expect(container.querySelectorAll('[data-label-tier="inside"]').length).toBeGreaterThan(0);
    expect(container.querySelectorAll('[data-label-tier="below"]').length).toBeGreaterThan(0);
    expect(container.querySelectorAll('[data-label-tier="outside"]').length).toBeGreaterThan(0);
  });

  it('hides layers turned off in `show`', () => {
    const { container } = render(<LinearMap record={pFA6a.record} enzymeSites={pFA6a.enzymeSites} show={{ enzymes: false, features: false }} />);
    const texts = [...container.querySelectorAll('text')].map((t) => t.textContent);
    expect(texts).not.toContain('KanR');
    expect(texts.some((t) => t?.startsWith('EcoRV'))).toBe(false);
  });

  it('keeps a 4.6 Mb genome with thousands of features to a small DOM', () => {
    const g = syntheticGenome();
    const { container } = render(<LinearMap record={g.record} enzymeSites={g.enzymeSites} />);
    const nodes = container.querySelectorAll('svg *').length;
    expect(nodes).toBeGreaterThan(20);
    expect(nodes).toBeLessThan(800);
  });
});

describe('<LinearMap /> selection', () => {
  it('selects a clicked feature and reports the click', () => {
    const onSelectionChange = vi.fn();
    const onFeatureClick = vi.fn();
    const { container } = render(<LinearMap record={pFA6a.record} enzymeSites={pFA6a.enzymeSites} onSelectionChange={onSelectionChange} onFeatureClick={onFeatureClick} />);
    const g = geometry(pFA6a.record);
    const p = g.featurePoint('KanR');
    fireEvent.click(svgOf(container), { clientX: p.clientX, clientY: p.clientY, detail: 1 });
    const kan = pFA6a.record.features.find((f) => f.name === 'KanR')!;
    expect(onFeatureClick).toHaveBeenCalledWith(kan.id, { clickCount: 1, shiftKey: false, metaKey: false, ctrlKey: false });
    expect(onSelectionChange).toHaveBeenLastCalledWith({ range: p.entry.extent, caret: p.entry.extent.end });
  });

  it('keeps its own selection when uncontrolled', () => {
    const { container } = render(<LinearMap record={pFA6a.record} />);
    const g = geometry(pFA6a.record, []);
    const p = g.featurePoint('KanR');
    expect(screen.queryByTestId('selection')).toBeNull();
    fireEvent.click(svgOf(container), { clientX: p.clientX, clientY: p.clientY, detail: 1 });
    expect(screen.getByTestId('selection')).toBeTruthy();
  });

  it('extends the selection with shift+click on another feature', () => {
    const onSelectionChange = vi.fn();
    const g = geometry(pFA6a.record);
    const kan = g.featurePoint('KanR').entry.extent;
    const ori = g.featurePoint('ori');
    const sel: SequenceSelection = { range: kan, caret: kan.end };
    const { container } = render(<LinearMap record={pFA6a.record} enzymeSites={pFA6a.enzymeSites} selection={sel} onSelectionChange={onSelectionChange} />);
    fireEvent.click(svgOf(container), { clientX: ori.clientX, clientY: ori.clientY, detail: 1, shiftKey: true });
    expect(onSelectionChange).toHaveBeenLastCalledWith({ range: { start: kan.start, end: ori.entry.extent.end }, caret: ori.entry.extent.end });
  });

  it('places the caret on the backbone and clears the selection in empty space', () => {
    const onSelectionChange = vi.fn();
    const g = geometry(pFA6a.record);
    const { container } = render(
      <LinearMap
        record={pFA6a.record}
        enzymeSites={pFA6a.enzymeSites}
        selection={{ range: { start: 10, end: 20 }, caret: 20 }}
        onSelectionChange={onSelectionChange}
      />,
    );
    const r = g.rulerPoint(2000.2);
    fireEvent.click(svgOf(container), { ...r, detail: 1 });
    expect(onSelectionChange).toHaveBeenLastCalledWith({ range: { start: 2000, end: 2000 }, caret: 2000 });
    const e = g.emptyPoint(2500);
    fireEvent.click(svgOf(container), { ...e, detail: 1 });
    expect(onSelectionChange).toHaveBeenLastCalledWith(null);
  });

  it('selects by dragging along the ruler, snapping to gaps, without a click afterwards', () => {
    const onSelectionChange = vi.fn();
    const onFeatureClick = vi.fn();
    const g = geometry(pFA6a.record);
    const { container } = render(<LinearMap record={pFA6a.record} enzymeSites={pFA6a.enzymeSites} onSelectionChange={onSelectionChange} onFeatureClick={onFeatureClick} />);
    const svg = svgOf(container);
    const a = g.rulerPoint(1000.3);
    const b = g.rulerPoint(1500.4);
    fireEvent.pointerDown(svg, { ...a, button: 0, pointerId: 1 });
    fireEvent.pointerMove(svg, { clientX: (a.clientX + b.clientX) / 2, clientY: a.clientY, buttons: 1, pointerId: 1 });
    fireEvent.pointerMove(svg, { ...b, buttons: 1, pointerId: 1 });
    fireEvent.pointerUp(svg, { ...b, button: 0, pointerId: 1 });
    fireEvent.click(svg, { ...b, detail: 1 });
    expect(onSelectionChange).toHaveBeenLastCalledWith({ range: { start: 1000, end: 1500 }, caret: 1500 });
    // the click that ends a drag does not also place a caret
    expect(onSelectionChange.mock.calls.every(([s]) => s && s.range.start === 1000)).toBe(true);
  });

  it('drags leftwards too (caret at the moving end)', () => {
    const onSelectionChange = vi.fn();
    const g = geometry(pFA6a.record);
    const { container } = render(<LinearMap record={pFA6a.record} enzymeSites={pFA6a.enzymeSites} onSelectionChange={onSelectionChange} />);
    const svg = svgOf(container);
    const a = g.rulerPoint(3000);
    const b = g.rulerPoint(2500);
    fireEvent.pointerDown(svg, { ...a, button: 0, pointerId: 1 });
    fireEvent.pointerMove(svg, { ...b, buttons: 1, pointerId: 1 });
    fireEvent.pointerUp(svg, { ...b, button: 0, pointerId: 1 });
    expect(onSelectionChange).toHaveBeenLastCalledWith({ range: { start: 2500, end: 3000 }, caret: 2500 });
  });

  it('clears the selection with Escape', () => {
    const onSelectionChange = vi.fn();
    render(<LinearMap record={pFA6a.record} selection={{ range: { start: 10, end: 20 }, caret: 20 }} onSelectionChange={onSelectionChange} />);
    fireEvent.keyDown(screen.getByRole('group'), { key: 'Escape' });
    expect(onSelectionChange).toHaveBeenCalledWith(null);
  });
});

describe('<LinearMap /> viewport', () => {
  it('zooms around the pointer with ctrl/⌘ + wheel', async () => {
    const onViewportChange = vi.fn();
    const g = geometry(pFA6a.record);
    render(<LinearMap record={pFA6a.record} enzymeSites={pFA6a.enzymeSites} onViewportChange={onViewportChange} />);
    const x = g.scale.x(1000);
    fireEvent.wheel(screen.getByRole('group'), { deltaY: -100, ctrlKey: true, clientX: x, clientY: 200 });
    await nextFrame();
    expect(onViewportChange).toHaveBeenCalledTimes(1);
    const vp: Range = onViewportChange.mock.calls[0][0];
    expect(vp.end - vp.start).toBeCloseTo(L / 1.25, 6);
    // the base under the pointer did not move
    expect(makeScale(vp, METRICS.padX, PLOT_W).x(1000)).toBeCloseTo(x, 6);
  });

  it('pans with shift + wheel and with horizontal swipes', async () => {
    const onViewportChange = vi.fn();
    render(<LinearMap record={pFA6a.record} viewport={{ start: 1000, end: 2000 }} onViewportChange={onViewportChange} />);
    const k = PLOT_W / 1000;
    fireEvent.wheel(screen.getByRole('group'), { deltaY: 100, shiftKey: true, clientX: 300, clientY: 200 });
    await nextFrame();
    expect(onViewportChange.mock.calls[0][0].start).toBeCloseTo(1000 + 100 / k, 6);
    fireEvent.wheel(screen.getByRole('group'), { deltaX: -50, deltaY: 2, clientX: 300, clientY: 200 });
    await nextFrame();
    expect(onViewportChange.mock.calls[1][0].start).toBeCloseTo(1000 - 50 / k, 6);
  });

  it('leaves plain vertical scrolling to the page', async () => {
    const onViewportChange = vi.fn();
    render(<LinearMap record={pFA6a.record} onViewportChange={onViewportChange} />);
    const ev = fireEvent.wheel(screen.getByRole('group'), { deltaY: 100, clientX: 300, clientY: 200 });
    await nextFrame();
    expect(ev).toBe(true); // not prevented
    expect(onViewportChange).not.toHaveBeenCalled();
  });

  it('zooms to fit with 0 and in with +', () => {
    const onViewportChange = vi.fn();
    render(<LinearMap record={pFA6a.record} viewport={{ start: 1000, end: 2000 }} onViewportChange={onViewportChange} />);
    const map = screen.getByRole('group');
    fireEvent.keyDown(map, { key: '0' });
    expect(onViewportChange).toHaveBeenLastCalledWith({ start: 0, end: L });
    fireEvent.keyDown(map, { key: '+' });
    expect(onViewportChange).toHaveBeenLastCalledWith({ start: 1250, end: 1750 });
  });

  it('glides, and quick zoom steps add up while gliding', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} }));
    const onViewportChange = vi.fn();
    render(<LinearMap record={pFA6a.record} onViewportChange={onViewportChange} />);
    const map = screen.getByRole('group');
    fireEvent.keyDown(map, { key: '+' });
    fireEvent.keyDown(map, { key: '+' });
    fireEvent.keyDown(map, { key: '+' });
    // nothing is committed until the glide ends, then once, at 8×
    expect(onViewportChange).not.toHaveBeenCalled();
    await waitFor(() => expect(onViewportChange).toHaveBeenCalledTimes(1), { timeout: 2000 });
    const vp: Range = onViewportChange.mock.calls[0][0];
    expect(vp.end - vp.start).toBeCloseTo(L / 8, 6);
    expect((vp.start + vp.end) / 2).toBeCloseTo(L / 2, 6);
  });

  it('zooms to a feature on double-click', () => {
    const onViewportChange = vi.fn();
    const onFeatureClick = vi.fn();
    const g = geometry(pFA6a.record);
    const { container } = render(
      <LinearMap record={pFA6a.record} enzymeSites={pFA6a.enzymeSites} onViewportChange={onViewportChange} onFeatureClick={onFeatureClick} />,
    );
    const p = g.featurePoint('KanR');
    fireEvent.click(svgOf(container), { clientX: p.clientX, clientY: p.clientY, detail: 1 });
    fireEvent.click(svgOf(container), { clientX: p.clientX, clientY: p.clientY, detail: 2 });
    expect(onFeatureClick).toHaveBeenLastCalledWith(p.entry.feature.id, expect.objectContaining({ clickCount: 2 }));
    const vp: Range = onViewportChange.mock.calls.at(-1)![0];
    expect(vp.start).toBeLessThanOrEqual(p.entry.extent.start);
    expect(vp.end).toBeGreaterThanOrEqual(p.entry.extent.end);
    expect(vp.end - vp.start).toBeLessThan((p.entry.extent.end - p.entry.extent.start) * 1.3);
  });

  it('reports a controlled viewport it had to clamp, once', () => {
    const onViewportChange = vi.fn();
    // 10 bp across a 952 px plot is deeper than the deepest zoom
    const { rerender } = render(<LinearMap record={pFA6a.record} viewport={{ start: 1000, end: 1010 }} onViewportChange={onViewportChange} />);
    expect(onViewportChange).toHaveBeenCalledTimes(1);
    const c: Range = onViewportChange.mock.calls[0][0];
    expect(c).toEqual(clampViewport({ start: 1000, end: 1010 }, L, PLOT_W));
    expect(c.end - c.start).toBeGreaterThan(10);
    // a parent that keeps its own value is not asked again; one that takes the report is in sync
    rerender(<LinearMap record={pFA6a.record} viewport={{ start: 1000, end: 1010 }} onViewportChange={onViewportChange} />);
    rerender(<LinearMap record={pFA6a.record} viewport={c} onViewportChange={onViewportChange} />);
    expect(onViewportChange).toHaveBeenCalledTimes(1);
    // windows that need no clamping are not reported
    rerender(<LinearMap record={pFA6a.record} viewport={{ start: 500, end: 1500 }} onViewportChange={onViewportChange} />);
    expect(onViewportChange).toHaveBeenCalledTimes(1);
  });

  it('follows a controlled viewport and resets an uncontrolled one for a new record', () => {
    const { container, rerender } = render(<LinearMap record={pFA6a.record} viewport={{ start: 0, end: 3938 }} />);
    const ticks = () => [...container.querySelectorAll('text')].map((t) => t.textContent);
    expect(ticks()).toContain('2,000');
    rerender(<LinearMap record={pFA6a.record} viewport={{ start: 1000, end: 1100 }} />);
    expect(ticks()).toContain('1,050');
    expect(ticks()).not.toContain('2,000');
  });
});

describe('<LinearMap /> hover and context menu', () => {
  it('reports the hovered feature and shows a card after a moment', async () => {
    const onFeatureHover = vi.fn();
    const g = geometry(pFA6a.record);
    const { container } = render(<LinearMap record={pFA6a.record} enzymeSites={pFA6a.enzymeSites} onFeatureHover={onFeatureHover} />);
    const p = g.featurePoint('KanR');
    const svg = svgOf(container);
    fireEvent.pointerMove(svg, { clientX: p.clientX, clientY: p.clientY, buttons: 0, pointerId: 1 });
    expect(onFeatureHover).toHaveBeenLastCalledWith(p.entry.feature.id);
    expect(screen.getByTestId('hover-ring')).toBeTruthy();
    const card = await screen.findByRole('tooltip', {}, { timeout: 2000 });
    expect(card.textContent).toContain('KanR');
    expect(card.textContent).toMatch(/CDS · Forward/);
    fireEvent.pointerLeave(svg);
    expect(onFeatureHover).toHaveBeenLastCalledWith(null);
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
  });

  it('reports what was right-clicked', () => {
    const onContextMenu = vi.fn<(t: MapTarget) => void>();
    const g = geometry(pFA6a.record);
    const { container } = render(<LinearMap record={pFA6a.record} enzymeSites={pFA6a.enzymeSites} onContextMenu={onContextMenu} />);
    const p = g.featurePoint('KanR');
    fireEvent.contextMenu(svgOf(container), { clientX: p.clientX, clientY: p.clientY });
    expect(onContextMenu.mock.calls[0][0]).toEqual({ kind: 'feature', id: p.entry.feature.id });
    const r = g.rulerPoint(500.5);
    fireEvent.contextMenu(svgOf(container), r);
    expect(onContextMenu.mock.calls[1][0]).toEqual({ kind: 'sequence', position: 500 });
  });

  it('reports enzyme clicks', () => {
    const onEnzymeClick = vi.fn();
    const g = geometry(pFA6a.record);
    const { container } = render(<LinearMap record={pFA6a.record} enzymeSites={pFA6a.enzymeSites} onEnzymeClick={onEnzymeClick} />);
    const label = g.view.enzymes.labels.find((l) => l.text.startsWith('NcoI'))!;
    fireEvent.click(svgOf(container), {
      clientX: (label.left + label.right) / 2,
      clientY: (label.top + label.bottom) / 2 + contentOffsetY(H, g.view.height),
      detail: 1,
    });
    expect(onEnzymeClick).toHaveBeenCalledTimes(1);
    expect(onEnzymeClick.mock.calls[0][0].enzyme).toBe('NcoI');
  });
});
