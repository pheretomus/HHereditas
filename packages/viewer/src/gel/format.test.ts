import { describe, expect, it } from 'vitest';
import {
  describeGelBand,
  describeGelSmear,
  formatAgarose,
  formatGelSize,
  formatGelSizeRange,
  gelDescriptionText,
  gelLaneAriaLabel,
  gelLaneName,
} from './format';

describe('formatGelSize', () => {
  it('writes ladder sizes like a marker legend, rounding only when nothing is lost', () => {
    expect(formatGelSize(500, 'ladder')).toBe('500 bp');
    expect(formatGelSize(1500, 'ladder')).toBe('1.5 kb');
    expect(formatGelSize(1000, 'ladder')).toBe('1 kb');
    expect(formatGelSize(48500, 'ladder')).toBe('48.5 kb');
    expect(formatGelSize(145000, 'ladder')).toBe('145 kb');
    expect(formatGelSize(2_500_000, 'ladder')).toBe('2.5 Mb');
    // vendor sizes are kept exact (review finding: "1,517" must not read "1.5 kb")
    expect(formatGelSize(1517, 'ladder')).toBe('1,517 bp');
    expect(formatGelSize(10002, 'ladder')).toBe('10,002 bp');
    expect(formatGelSize(23130, 'ladder')).toBe('23,130 bp');
    expect(formatGelSize(4641652, 'ladder')).toBe('4,641,652 bp');
  });

  it('writes band sizes with 3 significant digits, and exact sizes with separators', () => {
    expect(formatGelSize(856)).toBe('856 bp');
    expect(formatGelSize(4361)).toBe('4.36 kb');
    expect(formatGelSize(2300)).toBe('2.3 kb');
    expect(formatGelSize(12345)).toBe('12.3 kb');
    expect(formatGelSize(511.6)).toBe('512 bp');
    expect(formatGelSize(4361, 'exact')).toBe('4,361 bp');
    expect(formatGelSize(Number.NaN)).toBe('–');
  });

  it('writes size ranges with one unit when both ends share it', () => {
    expect(formatGelSizeRange(2050, 2400)).toBe('2.05–2.4 kb');
    expect(formatGelSizeRange(850, 1200)).toBe('850 bp–1.2 kb');
    expect(formatGelSizeRange(562, 618)).toBe('562–618 bp');
    expect(formatGelSizeRange(500, 500)).toBe('500 bp');
  });

  it('writes the agarose caption', () => {
    expect(formatAgarose(1)).toBe('1% agarose');
    expect(formatAgarose(0.8)).toBe('0.8% agarose');
    expect(formatAgarose(1.25)).toBe('1.25% agarose');
    expect(formatAgarose(undefined)).toBeUndefined();
    expect(formatAgarose(0)).toBeUndefined();
  });
});

describe('band descriptions', () => {
  it('describes a single fragment', () => {
    const d = describeGelBand({ size: 1631, position: 0.5, intensity: 1, labels: ['HinfI (3,360) – HinfI (630)'] });
    expect(d).toEqual({ title: '1,631 bp', details: [], labels: ['HinfI (3,360) – HinfI (630)'], moreLabels: 0 });
  });

  it('lists the sizes of co-migrating fragments', () => {
    const d = describeGelBand({ size: 220.5, position: 0.8, intensity: 0.3, count: 2, sizes: [221, 220] });
    expect(d.title).toBe('≈ 221 bp');
    expect(d.details).toEqual(['2 co-migrating fragments: 221 + 220 bp']);
    const many = describeGelBand({ size: 150, position: 0.8, intensity: 1, count: 6, sizes: [190, 180, 160, 160, 147, 123] });
    expect(many.details).toEqual(['6 co-migrating fragments, 123–190 bp']);
    expect(describeGelBand({ size: 500, position: 0.7, intensity: 1, count: 3 }).details).toEqual(['3 co-migrating fragments']);
  });

  it('mentions reference bands and masses, and caps long label lists', () => {
    const d = describeGelBand({
      size: 1500,
      position: 0.5,
      intensity: 1,
      emphasized: true,
      massNg: 80,
      labels: ['a', 'b', 'c', 'd', 'e', 'f', 'g', ' '],
    });
    expect(d.details).toEqual(['Reference band', '80 ng']);
    expect(d.labels).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(d.moreLabels).toBe(2);
    expect(gelDescriptionText(d)).toBe('1,500 bp. Reference band. 80 ng. a, b, c, d, e, and 2 more');
  });

  it('summarises smears', () => {
    expect(describeGelSmear(451, 562, 618)).toEqual({
      title: '451 fragments',
      details: ['562–618 bp', 'Unresolved smear'],
      labels: [],
      moreLabels: 0,
    });
  });

  it('names lanes for screen readers', () => {
    const lane = { id: 'h', label: 'HinfI', kind: 'sample' as const, bands: [] };
    expect(gelLaneName(lane, 3)).toBe('HinfI');
    expect(gelLaneName({ ...lane, label: '  ' }, 3)).toBe('Lane 4');
    expect(gelLaneAriaLabel(lane, 0)).toBe('HinfI: no bands');
    const bands = Array.from({ length: 14 }, (_, i) => ({ size: 1000 - i * 50, position: 0.5, intensity: 1 }));
    expect(gelLaneAriaLabel({ ...lane, kind: 'ladder', bands }, 0)).toBe(
      'HinfI, ladder: 14 bands: 1 kb, 950 bp, 900 bp, 850 bp, 800 bp, 750 bp, 700 bp, 650 bp, 600 bp, 550 bp, 500 bp, 450 bp, and 2 more',
    );
    expect(gelLaneAriaLabel({ ...lane, bands: bands.slice(0, 1) }, 0)).toBe('HinfI: 1 band: 1 kb');
  });
});
