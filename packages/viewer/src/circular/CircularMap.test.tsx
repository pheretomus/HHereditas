import type { EnzymeSite, SeqRecord } from '@hhereditas/core';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SAMPLES } from '../fixtures';
import type { SequenceSelection } from '../selection';
import { CircularMap, type CircularMapProps, extendOffset, selectionFromOffset } from './CircularMap';
import styles from './CircularMap.module.css';
import { polarToCartesian, positionToAngle } from './geometry';
import { type MapGeometry, buildMapModel, computeGeometry } from './layout';
import { estimateTextWidth } from './measure';

const W = 900;
const H = 700;

beforeEach(() => {
  // jsdom has no layout: give the map container its size at the page origin
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

const pFA6a = SAMPLES.pFA6a;
const L = pFA6a.record.seq.length;

/** The geometry the component computes in jsdom (same size, same text estimate). */
function geometryOf(props: Pick<CircularMapProps, 'record' | 'enzymeSites' | 'rotation' | 'orfs' | 'primerSites'>): MapGeometry {
  const model = buildMapModel({
    record: props.record,
    enzymeSites: props.enzymeSites,
    primerSites: props.primerSites,
    orfs: props.orfs,
  });
  return computeGeometry(model, { width: W, height: H, rotation: props.rotation ?? 0, measure: estimateTextWidth })!;
}

function svg(): SVGSVGElement {
  return screen.getByTestId('circular-map-svg') as unknown as SVGSVGElement;
}

/** Client point at a sequence position (fractional) and radius. */
function at(g: MapGeometry, position: number, r: number) {
  const p = polarToCartesian(g.cx, g.cy, r, positionToAngle(g.scale, position));
  return { clientX: p.x, clientY: p.y };
}

/** Client point in the middle of a feature's band. */
function onFeature(g: MapGeometry, name: string) {
  const f = g.features.find((s) => s.item.feature.name === name)!;
  const seg = f.segments.reduce((m, s) => (s.a1 - s.a0 > m.a1 - m.a0 ? s : m));
  const p = polarToCartesian(g.cx, g.cy, (f.rIn + f.rOut) / 2, (seg.a0 + seg.a1) / 2);
  return { clientX: p.x, clientY: p.y, feature: f.item.feature };
}

function drag(points: Array<{ clientX: number; clientY: number }>, init: { shiftKey?: boolean } = {}) {
  const target = svg();
  fireEvent.pointerDown(target, { ...points[0], pointerId: 1, button: 0, ...init });
  for (const p of points.slice(1)) fireEvent.pointerMove(target, { ...p, pointerId: 1, ...init });
  const last = points[points.length - 1];
  fireEvent.pointerUp(target, { ...last, pointerId: 1, ...init });
  fireEvent.click(target, { ...last, detail: 1, ...init });
}

function click(p: { clientX: number; clientY: number }, init: { shiftKey?: boolean; detail?: number } = {}) {
  const target = svg();
  fireEvent.pointerDown(target, { ...p, pointerId: 1, button: 0, shiftKey: init.shiftKey });
  fireEvent.pointerUp(target, { ...p, pointerId: 1, shiftKey: init.shiftKey });
  fireEvent.click(target, { ...p, detail: init.detail ?? 1, shiftKey: init.shiftKey });
}

/** Controlled wrapper that records every selection change. */
function Harness(props: Omit<CircularMapProps, 'selection' | 'onSelectionChange'> & { initial?: SequenceSelection | null; log: Array<SequenceSelection | null> }) {
  const { initial = null, log, ...rest } = props;
  const [selection, setSelection] = useState<SequenceSelection | null>(initial);
  return (
    <CircularMap
      {...rest}
      selection={selection}
      onSelectionChange={(s) => {
        log.push(s);
        setSelection(s);
      }}
    />
  );
}

describe('CircularMap rendering', () => {
  it('renders an accessible plasmid map with features, labels and the record name', () => {
    render(<CircularMap record={pFA6a.record} enzymeSites={pFA6a.enzymeSites} />);
    const group = screen.getByRole('group', { name: 'Plasmid map of pFA6a-kanMX6, 3,938 bp, 18 features' });
    expect(group.getAttribute('tabindex')).toBe('0');
    expect(svg().querySelectorAll('[data-feature-id]')).toHaveLength(18);
    expect(svg().textContent).toContain('pFA6a-kanMX6');
    expect(svg().textContent).toContain('3,938 bp');
    // inside (curved) and outside labels
    expect(svg().querySelectorAll('textPath').length).toBeGreaterThan(0);
    expect(svg().querySelector('[data-label-key="e:0"]')?.textContent).toBe('NotI (6)');
  });

  it('emphasises unique cutters', () => {
    render(<CircularMap record={pFA6a.record} enzymeSites={pFA6a.enzymeSites} />);
    const g = geometryOf({ record: pFA6a.record, enzymeSites: pFA6a.enzymeSites });
    const unique = g.basePlacement.labels.find((l) => l.candidate.tone === 'enzymeUnique')!;
    const multi = g.basePlacement.labels.find((l) => l.candidate.tone === 'enzyme')!;
    const u = svg().querySelector(`[data-label-key="${unique.candidate.key}"]`) as SVGTextElement;
    const m = svg().querySelector(`[data-label-key="${multi.candidate.key}"]`) as SVGTextElement;
    expect(u.style.fontWeight).toBe('600');
    expect(m.style.fontWeight).toBe('400');
    expect(u.textContent).toMatch(/^\w+ \([\d,]+\)$/);
  });

  it('draws a wedge for a selection that wraps the origin, and a caret for an empty one', () => {
    const { rerender } = render(
      <CircularMap record={pFA6a.record} selection={{ range: { start: 3700, end: L + 260 }, caret: 260 }} />,
    );
    const wedge = screen.getByTestId('circular-selection');
    expect(wedge.getAttribute('d')).toMatch(/^M /);
    expect(screen.getByTestId('circular-selection-arc')).toBeTruthy();
    expect(screen.queryByTestId('circular-caret')).toBeNull();
    rerender(<CircularMap record={pFA6a.record} selection={{ range: { start: 1200, end: 1200 }, caret: 1200 }} />);
    expect(screen.queryByTestId('circular-selection')).toBeNull();
    expect(screen.getByTestId('circular-caret')).toBeTruthy();
  });

  it('emphasises the highlighted feature', () => {
    const amp = pFA6a.record.features.find((f) => f.name === 'AmpR')!;
    render(<CircularMap record={pFA6a.record} highlightedFeatureId={amp.id} />);
    expect(svg().querySelectorAll(`.${styles.highlightFeature}`)).toHaveLength(1);
  });

  it('honours the show switches', () => {
    render(<CircularMap record={pFA6a.record} enzymeSites={pFA6a.enzymeSites} show={{ enzymes: false, features: false }} />);
    expect(svg().querySelector('[data-label-key^="e:"]')).toBeNull();
    expect(svg().querySelectorAll('[data-feature-id]')).toHaveLength(0);
  });

  it('shows sensible empty states', () => {
    const empty: SeqRecord = { ...pFA6a.record, id: 'e', name: '', seq: '', features: [] };
    const { rerender } = render(<CircularMap record={empty} />);
    expect(svg().textContent).toContain('Empty sequence');
    expect(svg().textContent).toContain('Untitled');
    rerender(<CircularMap record={{ ...pFA6a.record, features: [] }} />);
    expect(svg().textContent).toContain('No features');
  });
});

describe('CircularMap interaction', () => {
  it('selects a feature on click and reports the click', () => {
    const log: Array<SequenceSelection | null> = [];
    const onFeatureClick = vi.fn();
    render(<Harness record={pFA6a.record} enzymeSites={pFA6a.enzymeSites} log={log} onFeatureClick={onFeatureClick} />);
    const g = geometryOf({ record: pFA6a.record, enzymeSites: pFA6a.enzymeSites });
    const amp = onFeature(g, 'AmpR');
    click(amp);
    expect(log.at(-1)).toEqual({ range: { start: 2610, end: 3471 }, caret: 3471 });
    expect(onFeatureClick).toHaveBeenCalledWith(amp.feature.id, { clickCount: 1, shiftKey: false, metaKey: false, ctrlKey: false });
    click(amp, { detail: 2 });
    expect(onFeatureClick).toHaveBeenLastCalledWith(amp.feature.id, { clickCount: 2, shiftKey: false, metaKey: false, ctrlKey: false });
  });

  it('selects the feature that wraps the origin with its wrapping extent', () => {
    const log: Array<SequenceSelection | null> = [];
    render(<Harness record={pFA6a.record} log={log} />);
    const g = geometryOf({ record: pFA6a.record });
    click(onFeature(g, 'SP6 promoter'));
    expect(log.at(-1)).toEqual({ range: { start: 3921, end: 3940 }, caret: 2 });
  });

  it('extends the selection to cover another feature on shift+click', () => {
    const log: Array<SequenceSelection | null> = [];
    const onFeatureClick = vi.fn();
    render(<Harness record={pFA6a.record} log={log} onFeatureClick={onFeatureClick} />);
    const g = geometryOf({ record: pFA6a.record });
    click(onFeature(g, 'TEF promoter'));
    click(onFeature(g, 'TEF terminator'), { shiftKey: true });
    expect(log.at(-1)?.range).toEqual({ start: 114, end: 1471 });
    expect(onFeatureClick.mock.calls.at(-1)?.[1]).toMatchObject({ shiftKey: true });
  });

  it('drags a selection clockwise across the origin', () => {
    const log: Array<SequenceSelection | null> = [];
    render(<Harness record={pFA6a.record} log={log} />);
    const g = geometryOf({ record: pFA6a.record });
    const r = g.radius * 0.5; // inside the ring area, away from annotations
    const from = Math.round(L * (1 - 20 / 360));
    const to = Math.round(L * (25 / 360));
    const steps = [-20, -14, -8, -2, 4, 10, 16, 25].map((deg) => at(g, (deg / 360) * L, r));
    drag(steps);
    expect(log.at(-1)).toEqual({ range: { start: from, end: L + to }, caret: to });
    // the click that ends a drag does not also place a caret
    expect(log.filter((s) => s && s.range.start === s.range.end && s.range.start === to)).toHaveLength(0);
  });

  it('drags a selection counter-clockwise across the origin', () => {
    const log: Array<SequenceSelection | null> = [];
    render(<Harness record={pFA6a.record} log={log} />);
    const g = geometryOf({ record: pFA6a.record });
    const r = g.radius * 0.5;
    const from = Math.round(L * (15 / 360));
    const to = Math.round(L * (1 - 30 / 360));
    const steps = [15, 9, 3, -3, -9, -15, -21, -30].map((deg) => at(g, (deg / 360) * L, r));
    drag(steps);
    expect(log.at(-1)).toEqual({ range: { start: to, end: L + from }, caret: to });
  });

  it('keeps the drag direction when the pointer passes the anchor again (cumulative angle)', () => {
    const log: Array<SequenceSelection | null> = [];
    render(<Harness record={pFA6a.record} log={log} />);
    const g = geometryOf({ record: pFA6a.record });
    const r = g.radius * 0.5;
    // clockwise almost all the way round: the selection is the long arc, not the short one
    const degs = [10, 60, 120, 180, 240, 300, 350];
    drag(degs.map((d) => at(g, (d / 360) * L, r)));
    const sel = log.at(-1)!;
    expect(sel.range.start).toBe(Math.round((10 / 360) * L));
    expect(sel.range.end - sel.range.start).toBe(Math.round((350 / 360) * L) - Math.round((10 / 360) * L));
    // and back again past the start, counter-clockwise: now it extends the other way
    log.length = 0;
    drag([10, 0, -10, -20].map((d) => at(g, (d / 360) * L, r)));
    expect(log.at(-1)).toEqual({ range: { start: Math.round(L * (1 - 20 / 360)), end: L + Math.round((10 / 360) * L) }, caret: Math.round(L * (1 - 20 / 360)) });
  });

  it('can start a drag on top of a feature', () => {
    const log: Array<SequenceSelection | null> = [];
    const onFeatureClick = vi.fn();
    render(<Harness record={pFA6a.record} log={log} onFeatureClick={onFeatureClick} />);
    const g = geometryOf({ record: pFA6a.record });
    const amp = onFeature(g, 'AmpR');
    const f = g.features.find((s) => s.item.feature.name === 'AmpR')!;
    const rMid = (f.rIn + f.rOut) / 2;
    drag([amp, at(g, 2900, rMid), at(g, 2800, rMid)]);
    expect(onFeatureClick).not.toHaveBeenCalled();
    const sel = log.at(-1)!;
    expect(sel.range.end - sel.range.start).toBeGreaterThan(50);
    expect(sel.caret).toBe(2800);
  });

  it('places a caret on click, extends on shift+click and clears on Escape', () => {
    const log: Array<SequenceSelection | null> = [];
    render(<Harness record={pFA6a.record} log={log} />);
    const g = geometryOf({ record: pFA6a.record });
    const r = g.radius * 0.5;
    click(at(g, 1000, r));
    expect(log.at(-1)).toEqual({ range: { start: 1000, end: 1000 }, caret: 1000 });
    expect(screen.getByTestId('circular-caret')).toBeTruthy();
    click(at(g, 1500, r), { shiftKey: true });
    expect(log.at(-1)).toEqual({ range: { start: 1000, end: 1500 }, caret: 1500 });
    // shift+click behind the anchor on a short selection flips it backwards (shorter arc)
    click(at(g, 900, r), { shiftKey: true });
    expect(log.at(-1)).toEqual({ range: { start: 900, end: 1000 }, caret: 900 });
    fireEvent.keyDown(screen.getByRole('group'), { key: 'Escape' });
    expect(log.at(-1)).toBeNull();
  });

  it('shows a tooltip and reports hover for features', () => {
    const onFeatureHover = vi.fn();
    render(<CircularMap record={pFA6a.record} onFeatureHover={onFeatureHover} />);
    const g = geometryOf({ record: pFA6a.record });
    const amp = onFeature(g, 'AmpR');
    fireEvent.pointerMove(svg(), { ...amp, pointerId: 1 });
    const tip = screen.getByRole('tooltip');
    expect(tip.textContent).toContain('AmpR');
    expect(tip.textContent).toContain('CDS · Reverse');
    expect(tip.textContent).toContain('2,611..3,471');
    expect(tip.textContent).toContain('861 bp');
    expect(onFeatureHover).toHaveBeenCalledWith(amp.feature.id);
    expect(svg().querySelectorAll(`.${styles.hoverFeature}`)).toHaveLength(1);
    // moving within the same feature does not re-report it
    fireEvent.pointerMove(svg(), { clientX: amp.clientX + 1, clientY: amp.clientY, pointerId: 1 });
    expect(onFeatureHover).toHaveBeenCalledTimes(1);
    fireEvent.pointerLeave(svg(), { pointerId: 1 });
    expect(onFeatureHover).toHaveBeenLastCalledWith(null);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('reports enzyme clicks from labels and cut ticks', () => {
    const onEnzymeClick = vi.fn();
    const log: Array<SequenceSelection | null> = [];
    render(<Harness record={pFA6a.record} enzymeSites={pFA6a.enzymeSites} log={log} onEnzymeClick={onEnzymeClick} />);
    const g = geometryOf({ record: pFA6a.record, enzymeSites: pFA6a.enzymeSites });
    const label = g.basePlacement.labels.find((l) => l.candidate.ref.kind === 'enzyme')!;
    const b = label.box;
    click({ clientX: (b.x0 + b.x1) / 2, clientY: (b.y0 + b.y1) / 2 });
    const site: EnzymeSite = g.enzymes[label.candidate.ref.index].item.site;
    expect(onEnzymeClick).toHaveBeenCalledWith(site);
    // the tick across the backbone
    const tick = g.enzymes.find((e) => e.item.site.enzyme === 'PmeI')!;
    const p = polarToCartesian(g.cx, g.cy, g.radius + 2, tick.angle);
    click({ clientX: p.x, clientY: p.y });
    expect(onEnzymeClick).toHaveBeenLastCalledWith(tick.item.site);
    expect(log).toHaveLength(0); // enzyme clicks leave the selection alone
  });

  it('reports what is under the pointer on context menu', () => {
    const onContextMenu = vi.fn();
    render(<CircularMap record={pFA6a.record} enzymeSites={pFA6a.enzymeSites} onContextMenu={onContextMenu} />);
    const g = geometryOf({ record: pFA6a.record, enzymeSites: pFA6a.enzymeSites });
    const amp = onFeature(g, 'AmpR');
    fireEvent.contextMenu(svg(), amp);
    expect(onContextMenu.mock.calls[0][0]).toEqual({ kind: 'feature', id: amp.feature.id });
    fireEvent.contextMenu(svg(), at(g, 1000.5, g.radius * 0.5));
    expect(onContextMenu.mock.calls[1][0]).toEqual({ kind: 'sequence', position: 1000 });
    fireEvent.contextMenu(svg(), { clientX: 3, clientY: H - 3 });
    expect(onContextMenu.mock.calls[2][0].kind).toBe('background');
    expect(onContextMenu.mock.calls[2][0].position).toBeGreaterThanOrEqual(0);
    expect(onContextMenu.mock.calls[2][0].position).toBeLessThan(L);
  });

  it('works uncontrolled', () => {
    render(<CircularMap record={pFA6a.record} />);
    const g = geometryOf({ record: pFA6a.record });
    click(onFeature(g, 'AmpR'));
    expect(screen.getByTestId('circular-selection')).toBeTruthy();
    expect(screen.getByText(/Selected 2,611\.\.3,471, 861 bp/)).toBeTruthy(); // screen-reader announcement
    act(() => {
      fireEvent.keyDown(screen.getByRole('group'), { key: 'Escape' });
    });
    expect(screen.queryByTestId('circular-selection')).toBeNull();
  });

  it('never wraps a drag on a linear record', () => {
    const lin = SAMPLES.linear.record;
    const log: Array<SequenceSelection | null> = [];
    render(<Harness record={lin} log={log} />);
    const g = geometryOf({ record: lin });
    const r = g.radius * 0.5;
    const n = lin.seq.length;
    drag([20, 10, 5, 0, -5, -10, -20].map((d) => ({ ...polarToCartesian(g.cx, g.cy, r, d), })).map((p) => ({ clientX: p.x, clientY: p.y })));
    const sel = log.at(-1)!;
    expect(sel.range.start).toBe(0);
    expect(sel.range.end).toBeLessThan(n / 10);
    expect(sel.range.end).toBeLessThanOrEqual(n);
  });

  it('selects a primer binding site on click and reports it', () => {
    const record: SeqRecord = { ...pFA6a.record, primers: [{ id: 'p1', name: 'M13-F', sequence: 'GTAAAACGACGGCCAGT' }] };
    const primerSites = [{ primerId: 'p1', strand: 1 as const, range: { start: 2000, end: 2017 }, annealedLength: 17, mismatches: 0, tailLength: 0 }];
    const onPrimerClick = vi.fn();
    const log: Array<SequenceSelection | null> = [];
    render(<Harness record={record} primerSites={primerSites} log={log} onPrimerClick={onPrimerClick} />);
    const g = geometryOf({ record, primerSites });
    const p = g.primers[0];
    const pt = polarToCartesian(g.cx, g.cy, (p.rIn + p.rOut) / 2, (p.a0 + p.a1) / 2);
    click({ clientX: pt.x, clientY: pt.y });
    expect(onPrimerClick).toHaveBeenCalledWith('p1');
    expect(log.at(-1)?.range).toEqual({ start: 2000, end: 2017 });
  });
});

describe('selection helpers', () => {
  it('continue the selection direction when extending', () => {
    const fwd: SequenceSelection = { range: { start: 100, end: 3000 }, caret: 3000 };
    expect(extendOffset(fwd, 100, 3100, L)).toBe(3000); // keeps going forwards (not the short way round)
    // just behind the anchor: the caret (at 3,000) is closer going on forwards than flipping back
    expect(extendOffset(fwd, 100, 50, L)).toBe(L - 50);
    const short: SequenceSelection = { range: { start: 100, end: 300 }, caret: 300 };
    expect(extendOffset(short, 100, 50, L)).toBe(-50); // a short selection flips instead
    const back: SequenceSelection = { range: { start: 50, end: 200 }, caret: 50 };
    expect(extendOffset(back, 200, 20, L)).toBe(-180);
    expect(extendOffset(null, 100, 3900, L)).toBe(3900 - 100 - L); // caret only: shorter arc
  });

  it('build wrapping and full-circle selections from a signed travel', () => {
    expect(selectionFromOffset(3900, 100, L)).toEqual({ range: { start: 3900, end: 4000 }, caret: 62 });
    expect(selectionFromOffset(50, -100, L)).toEqual({ range: { start: 3888, end: L + 50 }, caret: 3888 });
    expect(selectionFromOffset(50, 0, L)).toEqual({ range: { start: 50, end: 50 }, caret: 50 });
    expect(selectionFromOffset(50, L, L)).toEqual({ range: { start: 50, end: 50 + L }, caret: 50 });
  });
});
