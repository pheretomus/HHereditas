import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { makeRecord } from '../seq/features';
import { reverseComplement } from '../seq/alphabet';
import { parseSnapGene, writeSnapGene } from './snapgene';
import { alignSequenceToReference, parseTraceFileBases } from './snapgene-alignments';

const SNAPGENE_ALIGN_SAMPLE =
  '/mnt/c/Program Files/SnapGene/sampleData/Sample project/3. Validating Results/2. Align to DNA Reference/KM018300 - SYFP2_CAT.dna';
const SNAPGENE_TRACE_F =
  '/mnt/c/Program Files/SnapGene/sampleData/Sample project/3. Validating Results/2. Align to DNA Reference/SYFP2_CAT_F.scf';
const SNAPGENE_TRACE_R =
  '/mnt/c/Program Files/SnapGene/sampleData/Sample project/3. Validating Results/2. Align to DNA Reference/SYFP2_CAT_R.scf';
const SNAPGENE_ASSEMBLED =
  '/mnt/c/Program Files/SnapGene/sampleData/Sample project/3. Validating Results/3. Assemble Contigs/Assembled.dna';

describe('SnapGene reference alignments (Packet 0x10, 0x11, 0x1B + trace alignment)', () => {
  it('aligns forward and reverse reads and round-trips through writeSnapGene / parseSnapGene', () => {
    const refSeq =
      'ATGGTGAGCAAGGGCGAGGAGCTGTTCACCGGGGTGGTGCCCATCCTGGTCGAGCTGGACGGCGACGTAAACGGCCACAAGTTCAGCGTGTCCGGCGAGGGCGAGGGCGATGCCACCTACGGCAAGCTGACCCTGAAGTTCATCTGCACCACCGGCAAGCTGCCCGTGCCCTGGCCCACCCTCGTGACCACCCTGAC';
    const fwdRead = 'GGTGAGCAAGGGCGAGGAGCTGTTCACCGGGGTGGTGCCCATCCTGGTCGAGCTGGACGGCGACGTAAACGGCCACAAGTTCAGC';
    const revRead = reverseComplement('ACCGGCAAGCTGCCCGTGCCCTGGCCCACCCTCGTGACCACCCTGAC');

    const alnF = alignSequenceToReference(refSeq, 'linear', {
      id: '0',
      name: 'Read_F',
      sequence: 'CCCCC' + fwdRead,
      sortOrder: 0,
    });
    const alnR = alignSequenceToReference(refSeq, 'linear', {
      id: '1',
      name: 'Read_R',
      sequence: revRead + 'AAAAA',
      sortOrder: 1,
    });

    expect(alnF.aligned).toBe(true);
    expect(alnF.strand).toBe(1);
    expect(alnF.refRange).toEqual({ start: 2, end: 2 + fwdRead.length });
    expect(alnF.leftTail).toBe(5);
    expect(alnF.identity).toBe(100);

    expect(alnR.aligned).toBe(true);
    expect(alnR.strand).toBe(-1);
    expect(alnR.refRange.end).toBe(refSeq.length);
    expect(alnR.leftTail).toBe(5);
    expect(alnR.identity).toBe(100);

    const rec = makeRecord({
      name: 'TestRef',
      seq: refSeq,
      topology: 'linear',
      alignedSequences: [alnF, alnR],
    });
    const bytes = writeSnapGene(rec);
    const parsed = parseSnapGene(bytes, { fileName: 'TestRef.dna' });
    expect(parsed.warnings).toEqual([]);
    expect(parsed.records[0].alignedSequences).toHaveLength(2);
    expect(parsed.records[0].alignedSequences?.[0].name).toBe('Read_F');
    expect(parsed.records[0].alignedSequences?.[0].strand).toBe(1);
    expect(parsed.records[0].alignedSequences?.[1].name).toBe('Read_R');
    expect(parsed.records[0].alignedSequences?.[1].strand).toBe(-1);
  });

  it.skipIf(!fs.existsSync(SNAPGENE_ALIGN_SAMPLE))(
    'parses Packet 0x11 + Packet 0x1B BGZF BAM alignments from KM018300 - SYFP2_CAT.dna',
    () => {
      const data = new Uint8Array(fs.readFileSync(SNAPGENE_ALIGN_SAMPLE));
      const res = parseSnapGene(data, { fileName: 'KM018300 - SYFP2_CAT.dna' });
      expect(res.records).toHaveLength(1);
      const rec = res.records[0];
      expect(rec.alignedSequences).toHaveLength(2);
      const [rev, fwd] = rec.alignedSequences!;
      expect(rev.name).toBe('SYFP2_CAT_R');
      expect(rev.isTrace).toBe(true);
      expect(rev.strand).toBe(-1);
      expect(rev.refRange).toEqual({ start: 924, end: 1912 });
      expect(rev.leftTail).toBe(2);

      expect(fwd.name).toBe('SYFP2_CAT_F');
      expect(fwd.isTrace).toBe(true);
      expect(fwd.strand).toBe(1);
      expect(fwd.refRange).toEqual({ start: 0, end: 864 });

      const scfF = new Uint8Array(fs.readFileSync(SNAPGENE_TRACE_F));
      const scfR = new Uint8Array(fs.readFileSync(SNAPGENE_TRACE_R));
      const basesF = parseTraceFileBases(scfF);
      const basesR = parseTraceFileBases(scfR);
      expect(basesF?.length).toBe(867);
      expect(basesR?.length).toBe(991);

      const reAlignedF = alignSequenceToReference(rec.seq, rec.topology, {
        name: 'SYFP2_CAT_F',
        sequence: basesF!,
        isTrace: true,
      });
      expect(reAlignedF.aligned).toBe(true);
      expect(reAlignedF.strand).toBe(1);
      expect(reAlignedF.refRange.start).toBe(0);

      const reAlignedR = alignSequenceToReference(rec.seq, rec.topology, {
        name: 'SYFP2_CAT_R',
        sequence: basesR!,
        isTrace: true,
      });
      expect(reAlignedR.aligned).toBe(true);
      expect(reAlignedR.strand).toBe(-1);
      expect(reAlignedR.refRange.end).toBeGreaterThan(1900);
    },
  );

  it.skipIf(!fs.existsSync(SNAPGENE_ASSEMBLED))(
    'parses Packet 0x10 + Packet 0x11 + Packet 0x1B alignments from Assembled.dna',
    () => {
      const data = new Uint8Array(fs.readFileSync(SNAPGENE_ASSEMBLED));
      const res = parseSnapGene(data, { fileName: 'Assembled.dna' });
      expect(res.records).toHaveLength(1);
      const rec = res.records[0];
      expect(rec.alignedSequences).toHaveLength(2);
      expect(rec.alignedSequences?.[0].name).toBe('COI rev read');
      expect(rec.alignedSequences?.[1].name).toBe('COI fwd read');
    },
  );
});
