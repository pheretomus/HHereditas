import { expect, it } from 'vitest';
import { suggestEnzymes } from '../model/restriction';
import { sample } from './fixtures';

it('suggests MCS enzymes for pBR322 into pUC19, quickly', () => {
  const t = performance.now();
  const names = suggestEnzymes(sample('pUC19'), sample('pBR322'));
  const ms = performance.now() - t;
  expect([...names].sort()).toEqual(['BamHI', 'EcoRI']);
  expect(ms).toBeLessThan(1500);
});
