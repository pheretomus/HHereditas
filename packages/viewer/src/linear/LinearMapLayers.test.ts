import { describe, expect, it } from 'vitest';
import { lightOutline } from './LinearMapLayers';

describe('lightOutline', () => {
  it('gives white and very light slim bars a border so they do not vanish on the white map', () => {
    expect(lightOutline('#ffffff').stroke).toBeTruthy();
    expect(lightOutline('#f5f5f5').stroke).toBeTruthy();
    expect(lightOutline('#ffffff').strokeWidth).toBeGreaterThan(0);
  });

  it('leaves coloured bars and theme colours as they are', () => {
    expect(lightOutline('#339933')).toEqual({});
    expect(lightOutline('#9b2c63')).toEqual({});
    expect(lightOutline('var(--hh-feature-cds)')).toEqual({});
  });
});
