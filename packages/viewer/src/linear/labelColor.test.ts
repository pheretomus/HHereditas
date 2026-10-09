import { describe, expect, it } from 'vitest';
import { FEATURE_LABEL_ON_FILL } from '../common/colors';
import { LABEL_ON_DARK_FILL, hexLuminance, labelColorOnFill } from './labelColor';

describe('labelColorOnFill', () => {
  it('keeps the shared near-black text on type colours (tokens)', () => {
    expect(labelColorOnFill('var(--hh-feature-cds)')).toBe(FEATURE_LABEL_ON_FILL);
  });

  it('uses dark text on light custom colours and light text on dark ones', () => {
    expect(labelColorOnFill('#f5b841')).toBe(FEATURE_LABEL_ON_FILL);
    expect(labelColorOnFill('#ffffff')).toBe(FEATURE_LABEL_ON_FILL);
    expect(labelColorOnFill('#1f3a93')).toBe(LABEL_ON_DARK_FILL);
    expect(labelColorOnFill('#000')).toBe(LABEL_ON_DARK_FILL);
    expect(labelColorOnFill('#993366')).toBe(LABEL_ON_DARK_FILL);
  });

  it('computes WCAG relative luminance of hex colours only', () => {
    expect(hexLuminance('#ffffff')).toBeCloseTo(1, 5);
    expect(hexLuminance('#000000')).toBe(0);
    expect(hexLuminance('#fff')).toBeCloseTo(1, 5);
    expect(hexLuminance('rgb(0,0,0)')).toBeNull();
    expect(hexLuminance('var(--x)')).toBeNull();
  });
});
