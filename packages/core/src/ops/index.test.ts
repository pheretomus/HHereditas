/**
 * The module barrel exposes exactly the public API (no internal or test helpers).
 */
import { describe, expect, it } from 'vitest';
import * as ops from './index';

describe('ops/index', () => {
  it('exports the public functions and nothing else', () => {
    expect(Object.keys(ops).sort()).toEqual(
      [
        'addFeature',
        'addPrimer',
        'concatRecords',
        'deleteRange',
        'extractRange',
        'insertBases',
        'planEdit',
        'remapFeatures',
        'remapGap',
        'remapRange',
        'removeFeature',
        'removePrimer',
        'replaceRange',
        'reverseComplementRecord',
        'rotateOrigin',
        'setTopology',
        'updateFeature',
        'updatePrimer',
      ].sort(),
    );
    for (const value of Object.values(ops)) expect(typeof value).toBe('function');
  });
});
