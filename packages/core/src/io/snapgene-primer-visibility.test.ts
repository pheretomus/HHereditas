/** SnapGene `<Primer visible="0">`: primers hidden in SnapGene are read as `hidden` and written back. */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { makeRecord } from '../seq/features';
import { parseSnapGene, writeSnapGene } from './snapgene';

describe('primer visibility', () => {
  it('keeps `hidden` through write and read, and omits it for shown primers', () => {
    const record = makeRecord({
      name: 'vis',
      seq: 'ACGTACGTACGTACGTACGTACGT',
      primers: [
        { id: 'a', name: 'shown', sequence: 'ACGTACGTACGT' },
        { id: 'b', name: 'hidden', sequence: 'TTTTCCCCAAAA', hidden: true },
      ],
    });
    const back = parseSnapGene(writeSnapGene(record), { fileName: 'vis.dna' }).records[0];
    expect(back.primers.map(({ id, ...p }) => p)).toEqual([
      { name: 'shown', sequence: 'ACGTACGTACGT' },
      { name: 'hidden', sequence: 'TTTTCCCCAAAA', hidden: true },
    ]);
  });

  const file = new URL('../../../../test_file/TALED_Right-ND1_CseDa01_G384N-UGI.dna', import.meta.url);
  it.skipIf(!existsSync(file))('reads 12 hidden and 9 shown primers from the TALED file', () => {
    const { records } = parseSnapGene(new Uint8Array(readFileSync(file)), { fileName: 'TALED.dna' });
    const primers = records[0].primers;
    expect(primers).toHaveLength(21);
    expect(primers.filter((p) => p.hidden)).toHaveLength(12);
  });
});
