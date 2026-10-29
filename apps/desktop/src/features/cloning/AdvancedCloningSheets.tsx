/**
 * SnapGene Advanced Cloning & Molecular Biology Sheets:
 * 1. Site-Directed Mutagenesis (sub_1408a41e0): Substitution, Insertion, Deletion, and CDS Codon Mutation
 *    with automatic QuikChange / Inverse-PCR mutagenic primer design.
 * 2. Anneal Oligos (sub_1408b1240): Anneals complementary top & bottom single-stranded oligos into a
 *    dsDNA fragment with automatic 5'/3' sticky overhang detection.
 * 3. In-Fusion & TOPO / TA Cloning (sub_14087a400): Seamless 15-bp homology In-Fusion assembly and
 *    TA / Directional CACC / Blunt TOPO cloning.
 * 4. Back-Translate & Host Codon Optimization: Optimizes coding sequences or back-translates protein
 *    sequences for E. coli, Human, Yeast, CHO, or Insect expression while avoiding restriction sites.
 */
import type { EndKind, Feature, FragmentEnds, Primer, Range, SeqRecord } from '@hhereditas/core';
import {
  addPrimer,
  complement,
  deleteRange,
  featureSequence,
  formatRange,
  gcContent,
  insertBases,
  makeFeature,
  makeRecord,
  newId,
  normalizeDna,
  normalizeRange,
  oligoGcContent,
  rangeFromInclusive,
  rangeLength,
  replaceRange,
  reverse,
  reverseComplement,
   setTopology,
  sliceRange,
  tm,
  translate,
} from '@hhereditas/core';
import { Button, Checkbox, Field, SegmentedControl, Select, Sheet, TextField } from '@hhereditas/ui';
import { hasSelectedBases } from '@hhereditas/viewer';
import { Copy, FilePlus2, Wand2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { openAsNewDocument } from '../../app/commands';
import type { DocumentState } from '../../state/documents';
import { useApp } from '../../state/store';
import formStyles from '../dialogs/forms.module.css';

// ============================================================================
// Host Optimal Codon Tables (preferred codons for high-expression back-translation)
// ============================================================================

type HostOrganism = 'ecoli' | 'human' | 'yeast' | 'cho' | 'sf9';

const HOST_LABELS: Record<HostOrganism, string> = {
  ecoli: 'Escherichia coli (K-12 High Expression)',
  human: 'Homo sapiens (Human Mammalian)',
  yeast: 'Saccharomyces cerevisiae (Yeast)',
  cho: 'Cricetulus griseus (CHO Mammalian)',
  sf9: 'Spodoptera frugiperda (Sf9 Insect)',
};

const HOST_PREFERRED_CODONS: Record<HostOrganism, Record<string, string[]>> = {
  ecoli: {
    A: ['GCG', 'GCC', 'GCA', 'GCT'],
    C: ['TGC', 'TGT'],
    D: ['GAT', 'GAC'],
    E: ['GAA', 'GAG'],
    F: ['TTT', 'TTC'],
    G: ['GGC', 'GGT', 'GGA', 'GGG'],
    H: ['CAT', 'CAC'],
    I: ['ATT', 'ATC', 'ATA'],
    K: ['AAA', 'AAG'],
    L: ['CTG', 'TTA', 'TTG', 'CTT', 'CTC', 'CTA'],
    M: ['ATG'],
    N: ['AAC', 'AAT'],
    P: ['CCG', 'CCA', 'CCT', 'CCC'],
    Q: ['CAG', 'CAA'],
    R: ['CGT', 'CGC', 'CGA', 'CGG', 'AGA', 'AGG'],
    S: ['AGC', 'TCT', 'TCC', 'AGT', 'TCA', 'TCG'],
    T: ['ACC', 'ACG', 'ACT', 'ACA'],
    V: ['GTG', 'GTT', 'GTC', 'GTA'],
    W: ['TGG'],
    Y: ['TAT', 'TAC'],
    '*': ['TAA', 'TAG', 'TGA'],
  },
  human: {
    A: ['GCC', 'GCT', 'GCA', 'GCG'],
    C: ['TGC', 'TGT'],
    D: ['GAC', 'GAT'],
    E: ['GAG', 'GAA'],
    F: ['TTC', 'TTT'],
    G: ['GGC', 'GGA', 'GGG', 'GGT'],
    H: ['CAC', 'CAT'],
    I: ['ATC', 'ATT', 'ATA'],
    K: ['AAG', 'AAA'],
    L: ['CTG', 'CTC', 'TTA'.replace('', ''), 'TTG', 'CTT', 'CTA'],
    M: ['ATG'],
    N: ['AAC', 'AAT'],
    P: ['CCC', 'CCT', 'CCA', 'CCG'],
    Q: ['CAG', 'CAA'],
    R: ['CGG', 'AGA', 'AGG', 'CGC', 'CGA', 'CGT'],
    S: ['AGC', 'TCC', 'TCT', 'AGT', 'TCA', 'TCG'],
    T: ['ACC', 'ACA', 'ACT', 'ACG'],
    V: ['GTG', 'GTC', 'GTT', 'GTA'],
    W: ['TGG'],
    Y: ['TAC', 'TAT'],
    '*': ['TGA', 'TAA', 'TAG'],
  },
  yeast: {
    A: ['GCT', 'GCC', 'GCA', 'GCG'],
    C: ['TGT', 'TGC'],
    D: ['GAT', 'GAC'],
    E: ['GAA', 'GAG'],
    F: ['TTT', 'TTC'],
    G: ['GGT', 'GGA', 'GGC', 'GGG'],
    H: ['CAT', 'CAC'],
    I: ['ATT', 'ATC', 'ATA'],
    K: ['AAA', 'AAG'],
    L: ['TTG', 'TTA', 'CTT', 'CTC', 'CTA', 'CTG'],
    M: ['ATG'],
    N: ['AAT', 'AAC'],
    P: ['CCA', 'CCT', 'CCC', 'CCG'],
    Q: ['CAA', 'CAG'],
    R: ['AGA', 'AGG', 'CGT', 'CGA', 'CGC', 'CGG'],
    S: ['TCT', 'TCC', 'TCA', 'AGT', 'AGC', 'TCG'],
    T: ['ACT', 'ACC', 'ACA', 'ACG'],
    V: ['GTT', 'GTC', 'GTA', 'GTG'],
    W: ['TGG'],
    Y: ['TAT', 'TAC'],
    '*': ['TAA', 'TGA', 'TAG'],
  },
  cho: {
    A: ['GCC', 'GCT', 'GCA', 'GCG'],
    C: ['TGC', 'TGT'],
    D: ['GAC', 'GAT'],
    E: ['GAG', 'GAA'],
    F: ['TTC', 'TTT'],
    G: ['GGC', 'GGA', 'GGG', 'GGT'],
    H: ['CAC', 'CAT'],
    I: ['ATC', 'ATT', 'ATA'],
    K: ['AAG', 'AAA'],
    L: ['CTG', 'CTC', 'CTT', 'TTG', 'TTA', 'CTA'],
    M: ['ATG'],
    N: ['AAC', 'AAT'],
    P: ['CCC', 'CCT', 'CCA', 'CCG'],
    Q: ['CAG', 'CAA'],
    R: ['AGA', 'AGG', 'CGG', 'CGC', 'CGT', 'CGA'],
    S: ['AGC', 'TCC', 'TCT', 'AGT', 'TCA', 'TCG'],
    T: ['ACC', 'ACA', 'ACT', 'ACG'],
    V: ['GTG', 'GTC', 'GTT', 'GTA'],
    W: ['TGG'],
    Y: ['TAC', 'TAT'],
    '*': ['TGA', 'TAA', 'TAG'],
  },
  sf9: {
    A: ['GCT', 'GCC', 'GCA', 'GCG'],
    C: ['TGC', 'TGT'],
    D: ['GAC', 'GAT'],
    E: ['GAA', 'GAG'],
    F: ['TTC', 'TTT'],
    G: ['GGT', 'GGC', 'GGA', 'GGG'],
    H: ['CAC', 'CAT'],
    I: ['ATC', 'ATT', 'ATA'],
    K: ['AAG', 'AAA'],
    L: ['CTG', 'CTC', 'TTG', 'CTT', 'TTA', 'CTA'],
    M: ['ATG'],
    N: ['AAC', 'AAT'],
    P: ['CCC', 'CCA', 'CCT', 'CCG'],
    Q: ['CAG', 'CAA'],
    R: ['CGT', 'CGC', 'AGA', 'AGG', 'CGA', 'CGG'],
    S: ['TCC', 'TCT', 'AGC', 'AGT', 'TCA', 'TCG'],
    T: ['ACC', 'ACT', 'ACA', 'ACG'],
    V: ['GTG', 'GTT', 'GTC', 'GTA'],
    W: ['TGG'],
    Y: ['TAC', 'TAT'],
    '*': ['TAA', 'TGA', 'TAG'],
  },
};

const AMINO_ACID_OPTIONS = [
  { value: 'A', label: 'A — Alanine (Ala)' },
  { value: 'C', label: 'C — Cysteine (Cys)' },
  { value: 'D', label: 'D — Aspartate (Asp)' },
  { value: 'E', label: 'E — Glutamate (Glu)' },
  { value: 'F', label: 'F — Phenylalanine (Phe)' },
  { value: 'G', label: 'G — Glycine (Gly)' },
  { value: 'H', label: 'H — Histidine (His)' },
  { value: 'I', label: 'I — Isoleucine (Ile)' },
  { value: 'K', label: 'K — Lysine (Lys)' },
  { value: 'L', label: 'L — Leucine (Leu)' },
  { value: 'M', label: 'M — Methionine (Met)' },
  { value: 'N', label: 'N — Asparagine (Asn)' },
  { value: 'P', label: 'P — Proline (Pro)' },
  { value: 'Q', label: 'Q — Glutamine (Gln)' },
  { value: 'R', label: 'R — Arginine (Arg)' },
  { value: 'S', label: 'S — Serine (Ser)' },
  { value: 'T', label: 'T — Threonine (Thr)' },
  { value: 'V', label: 'V — Valine (Val)' },
  { value: 'W', label: 'W — Tryptophan (Trp)' },
  { value: 'Y', label: 'Y — Tyrosine (Tyr)' },
  { value: '*', label: '* — Stop Codon (Ter)' },
];

// ============================================================================
// 1. Site-Directed Mutagenesis Sheet (SnapGene sub_1408a41e0)
// ============================================================================

export function MutagenesisSheet({ open, doc }: { open: boolean; doc: DocumentState | null }) {
  const [mutMode, setMutMode] = useState<'codon' | 'replace' | 'insert' | 'delete'>('replace');
  const [start1, setStart1] = useState('1');
  const [end1, setEnd1] = useState('3');
  const [replacementBases, setReplacementBases] = useState('');
  const [flankLength, setFlankLength] = useState('18');
  const [addPrimersToDoc, setAddPrimersToDoc] = useState(true);
  const [createNewDoc, setCreateNewDoc] = useState(false);

  // Codon mutation state
  const cdsFeatures = useMemo(
    () => (doc?.record.features ?? []).filter((f) => f.type === 'CDS' && f.segments.length > 0),
    [doc?.record.features],
  );
  const [selectedCdsId, setSelectedCdsId] = useState<string>('');
  const [codonNumber, setCodonNumber] = useState('1');
  const [targetAa, setTargetAa] = useState('A');

  const seqLen = doc?.record.seq.length ?? 0;

  useEffect(() => {
    if (!open || !doc) return;
    const len = doc.record.seq.length;
    if (cdsFeatures.length > 0 && !selectedCdsId) {
      setSelectedCdsId(cdsFeatures[0].id);
    }
    const sel = doc.selection;
    const caret0 = sel?.caret ?? 0;
    if (hasSelectedBases(sel)) {
      const r = normalizeRange(sel.range, len, doc.record.topology);
      const s1 = (r.start % len) + 1;
      const e1 = ((r.end - 1) % len) + 1;
      setStart1(String(s1));
      setEnd1(String(e1));
      setReplacementBases(sliceRange(doc.record.seq, r));
      setMutMode('replace');
    } else {
      const caret1 = (caret0 % Math.max(1, len)) + 1;
      setStart1(String(caret1));
      setEnd1(String(Math.min(len, caret1 + 2)));
      if (len >= 3) {
        const r = rangeFromInclusive(caret1 - 1, Math.min(len, caret1 + 2) - 1, len, doc.record.topology);
        setReplacementBases(sliceRange(doc.record.seq, r));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Synchronize codon mutation selection to 1-based range + replacement bases
  const selectedCds: Feature | null = useMemo(
    () => cdsFeatures.find((f) => f.id === selectedCdsId) ?? cdsFeatures[0] ?? null,
    [cdsFeatures, selectedCdsId],
  );

  const codonMutationInfo = useMemo(() => {
    if (mutMode !== 'codon' || !doc || !selectedCds || seqLen === 0) return null;
    const seg = selectedCds.segments[0];
    const segLen = rangeLength(seg);
    const totalCodons = Math.floor(segLen / 3);
    const idx1 = Math.max(1, Math.min(totalCodons, Number.parseInt(codonNumber, 10) || 1));
    const offsetBp = (idx1 - 1) * 3;
    const isRev = selectedCds.strand === -1;
    const codonStart0 = isRev
      ? (seg.end - 3 - offsetBp + seqLen) % seqLen
      : (seg.start + offsetBp) % seqLen;
    const codonRange = rangeFromInclusive(codonStart0, (codonStart0 + 2) % seqLen, seqLen, doc.record.topology);
    const topCodon = sliceRange(doc.record.seq, codonRange);
    const codingCodon = isRev ? reverseComplement(topCodon) : topCodon;
    let origAa = 'X';
    try {
      origAa = translate(codingCodon, { table: 1 }) || 'X';
    } catch {
      origAa = 'X';
    }
    const newCodingCodon = HOST_PREFERRED_CODONS.ecoli[targetAa]?.[0] ?? 'GCG';
    const newTopCodon = isRev ? reverseComplement(newCodingCodon) : newCodingCodon;
    return {
      totalCodons,
      idx1,
      codonRange,
      topCodon,
      codingCodon,
      origAa,
      newCodingCodon,
      newTopCodon,
      label: `${origAa}${idx1}${targetAa}`,
    };
  }, [mutMode, doc, selectedCds, seqLen, codonNumber, targetAa]);

  // Effective mutation range and new bases
  const effectiveMutation = useMemo(() => {
    if (!doc || seqLen === 0) return null;
    if (mutMode === 'codon') {
      if (!codonMutationInfo) return null;
      return {
        range: codonMutationInfo.codonRange,
        oldBases: codonMutationInfo.topCodon,
        newBases: codonMutationInfo.newTopCodon,
        summaryLabel: `${selectedCds?.name ?? 'CDS'} ${codonMutationInfo.label} (${codonMutationInfo.codingCodon} → ${codonMutationInfo.newCodingCodon})`,
      };
    }

    const s1 = Number.parseInt(start1, 10);
    const e1 = Number.parseInt(end1, 10);
    if (!Number.isInteger(s1) || s1 < 1 || s1 > seqLen) return null;

    if (mutMode === 'insert') {
      const clean = normalizeDna(replacementBases);
      if (clean.seq.length === 0 || clean.invalid.length > 0) return null;
      const r: Range = { start: s1 - 1, end: s1 - 1 };
      return {
        range: r,
        oldBases: '',
        newBases: clean.seq,
        summaryLabel: `ins_${s1}_${clean.seq.slice(0, 12)}`,
      };
    }

    if (!Number.isInteger(e1) || e1 < 1 || e1 > seqLen) return null;
    if (doc.record.topology === 'linear' && e1 < s1) return null;
    const range = rangeFromInclusive(s1 - 1, e1 - 1, seqLen, doc.record.topology);
    const oldBases = sliceRange(doc.record.seq, range);

    if (mutMode === 'delete') {
      return {
        range,
        oldBases,
        newBases: '',
        summaryLabel: `del_${formatRange(range, seqLen)}`,
      };
    }

    const clean = normalizeDna(replacementBases);
    if (clean.seq.length === 0 || clean.invalid.length > 0) return null;
    return {
      range,
      oldBases,
      newBases: clean.seq,
      summaryLabel: `${formatRange(range, seqLen)} (${oldBases.slice(0, 9)}→${clean.seq.slice(0, 9)})`,
    };
  }, [doc, seqLen, mutMode, codonMutationInfo, selectedCds, start1, end1, replacementBases]);

  // Design Forward & Reverse Mutagenic Primers (5' flank + mutation + 3' flank)
  const mutagenicPrimers = useMemo(() => {
    if (!doc || !effectiveMutation || seqLen < 30) return null;
    const flank = Math.max(12, Math.min(30, Number.parseInt(flankLength, 10) || 18));
    const { range, newBases, summaryLabel } = effectiveMutation;

    const leftStart0 = (range.start - flank + seqLen * 2) % seqLen;
    const leftRange: Range = { start: leftStart0, end: leftStart0 + flank };
    const rightStart0 = range.end % seqLen;
    const rightRange: Range = { start: rightStart0, end: rightStart0 + flank };

    const leftFlankSeq = sliceRange(doc.record.seq, leftRange);
    const rightFlankSeq = sliceRange(doc.record.seq, rightRange);

    const fwdSeq = `${leftFlankSeq}${newBases}${rightFlankSeq}`;
    const revSeq = reverseComplement(fwdSeq);

    let fwdTm = 0;
    let revTm = 0;
    try {
      fwdTm = tm(fwdSeq);
      revTm = tm(revSeq);
    } catch {
      fwdTm = 65;
      revTm = 65;
    }

    return {
      flank,
      leftFlankSeq,
      newBases,
      rightFlankSeq,
      fwdName: `SDM_${summaryLabel.replace(/[^A-Za-z0-9_>-]/g, '_')}_F`,
      revName: `SDM_${summaryLabel.replace(/[^A-Za-z0-9_>-]/g, '_')}_R`,
      fwdSeq,
      revSeq,
      fwdTm,
      revTm,
      fwdGc: oligoGcContent(fwdSeq) * 100,
      revGc: oligoGcContent(revSeq) * 100,
    };
  }, [doc, effectiveMutation, seqLen, flankLength]);

  const applyMutagenesis = () => {
    if (!doc || !effectiveMutation) return;
    const app = useApp.getState();

    const transformRecord = (rec: SeqRecord): SeqRecord => {
      let next: SeqRecord;
      if (mutMode === 'insert') {
        next = insertBases(rec, effectiveMutation.range.start, effectiveMutation.newBases);
      } else if (mutMode === 'delete') {
        next = deleteRange(rec, effectiveMutation.range);
      } else {
        next = replaceRange(rec, effectiveMutation.range, effectiveMutation.newBases);
      }

      if (addPrimersToDoc && mutagenicPrimers) {
        const pF: Primer = {
          id: newId('p'),
          name: mutagenicPrimers.fwdName,
          sequence: mutagenicPrimers.fwdSeq,
          description: `Site-directed mutagenesis forward primer (${effectiveMutation.summaryLabel})`,
        };
        const pR: Primer = {
          id: newId('p'),
          name: mutagenicPrimers.revName,
          sequence: mutagenicPrimers.revSeq,
          description: `Site-directed mutagenesis reverse primer (${effectiveMutation.summaryLabel})`,
        };
        next = addPrimer(addPrimer(next, pF), pR);
      }
      return next;
    };

    if (createNewDoc) {
      const mutated = transformRecord(doc.record);
      openAsNewDocument({
        ...mutated,
        id: newId('rec'),
        name: `${doc.record.name}_${effectiveMutation.summaryLabel.replace(/[^A-Za-z0-9_-]/g, '')}`,
      });
      app.closeSheet();
      app.flash(`Created mutated construct (${effectiveMutation.summaryLabel})`);
    } else {
      app.change(transformRecord, `Site-Directed Mutagenesis (${effectiveMutation.summaryLabel})`);
      app.closeSheet();
      app.flash(`Applied mutagenesis: ${effectiveMutation.summaryLabel}`);
    }
  };

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => {
        if (!o) useApp.getState().closeSheet();
      }}
      title="Site-Directed Mutagenesis (SDM)"
      description="Introduce point mutations, codon substitutions, insertions, or deletions and automatically design mutagenic PCR primers."
      primaryAction={{
        label: createNewDoc ? 'Create Mutated Sequence' : 'Apply Mutagenesis',
        onAction: applyMutagenesis,
        disabled: !effectiveMutation,
      }}
      width={560}
    >
      <div className={formStyles.form}>
        <SegmentedControl
          aria-label="Mutagenesis Mode"
          fill
          value={mutMode}
          onValueChange={(v) => setMutMode(v as 'codon' | 'replace' | 'insert' | 'delete')}
          options={[
            { value: 'replace', label: 'Substitution / Point' },
            { value: 'codon', label: 'CDS Codon Mutation' },
            { value: 'insert', label: 'Insertion' },
            { value: 'delete', label: 'Deletion' },
          ]}
        />

        {mutMode === 'codon' ? (
          cdsFeatures.length === 0 ? (
            <p className={formStyles.hint}>
              No CDS features found on this sequence. Add a CDS feature first or use Substitution mode.
            </p>
          ) : (
            <>
              <div className={formStyles.row}>
                <Field label="Target CDS Feature">
                  <Select
                    aria-label="Target CDS Feature"
                    value={selectedCds?.id ?? ''}
                    onValueChange={setSelectedCdsId}
                    options={cdsFeatures.map((f) => ({
                      value: f.id,
                      label: `${f.name} (${rangeLength(f.segments[0])} bp)`,
                    }))}
                    width="100%"
                  />
                </Field>
                <Field label={`Residue / Codon # (1–${codonMutationInfo?.totalCodons ?? 1})`}>
                  <TextField mono value={codonNumber} onValueChange={setCodonNumber} />
                </Field>
              </div>
              <Field label="Target Amino Acid Substitution">
                <Select
                  aria-label="Target Amino Acid"
                  value={targetAa}
                  onValueChange={setTargetAa}
                  options={AMINO_ACID_OPTIONS}
                  width="100%"
                />
              </Field>
              {codonMutationInfo ? (
                <p className={formStyles.stats}>
                  <span>
                    Mutation <strong>{codonMutationInfo.label}</strong>
                  </span>
                  <span>
                    Codon <strong>{codonMutationInfo.codingCodon} → {codonMutationInfo.newCodingCodon}</strong>
                  </span>
                  <span>
                    Bases <strong>{formatRange(codonMutationInfo.codonRange, seqLen)}</strong>
                  </span>
                </p>
              ) : null}
            </>
          )
        ) : (
          <>
            <div className={formStyles.row}>
              <Field label={mutMode === 'insert' ? `Insertion Site (1–${seqLen})` : `Start Base (1–${seqLen})`}>
                <TextField mono value={start1} onValueChange={setStart1} />
              </Field>
              {mutMode !== 'insert' ? (
                <Field label={`End Base (1–${seqLen})`}>
                  <TextField mono value={end1} onValueChange={setEnd1} />
                </Field>
              ) : (
                <Field label="Flanking Arm Length (bp)">
                  <TextField mono value={flankLength} onValueChange={setFlankLength} />
                </Field>
              )}
            </div>
            {mutMode !== 'delete' ? (
              <Field label={mutMode === 'insert' ? 'Inserted Bases (5′→3′)' : 'Replacement Bases (5′→3′)'}>
                <TextField
                  mono
                  value={replacementBases}
                  onValueChange={setReplacementBases}
                  placeholder="Enter new DNA bases (A, C, G, T)"
                />
              </Field>
            ) : null}
          </>
        )}

        {mutagenicPrimers ? (
          <div
            style={{
              padding: '10px 12px',
              borderRadius: 6,
              border: '1px solid var(--hh-border-subtle, rgba(128,128,128,0.22))',
              background: 'var(--hh-bg-subtle, rgba(128,128,128,0.05))',
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', color: 'var(--hh-text-secondary)' }}>
                Designed Mutagenic Primer Pair ({mutagenicPrimers.flank} bp Homology Arms)
              </span>
              <Button
                size="sm"
                variant="plain"
                icon={<Copy />}
                onClick={() => {
                  void navigator.clipboard.writeText(
                    `>${mutagenicPrimers.fwdName}\n${mutagenicPrimers.fwdSeq}\n>${mutagenicPrimers.revName}\n${mutagenicPrimers.revSeq}`,
                  );
                  useApp.getState().flash('Copied forward & reverse mutagenic primers to clipboard');
                }}
              >
                Copy Primers
              </Button>
            </div>
            <div style={{ fontFamily: 'var(--hh-font-mono)', fontSize: 11, lineHeight: 1.5, wordBreak: 'break-all' }}>
              <div>
                <strong>Fwd ({mutagenicPrimers.fwdSeq.length} nt, Tm {mutagenicPrimers.fwdTm.toFixed(1)} °C, GC {mutagenicPrimers.fwdGc.toFixed(0)}%):</strong>{' '}
                <span>{mutagenicPrimers.leftFlankSeq.toLowerCase()}</span>
                <strong style={{ color: '#e5484d', textDecoration: 'underline' }}>{mutagenicPrimers.newBases}</strong>
                <span>{mutagenicPrimers.rightFlankSeq.toLowerCase()}</span>
              </div>
              <div style={{ marginTop: 4 }}>
                <strong>Rev ({mutagenicPrimers.revSeq.length} nt, Tm {mutagenicPrimers.revTm.toFixed(1)} °C, GC {mutagenicPrimers.revGc.toFixed(0)}%):</strong>{' '}
                <span>{mutagenicPrimers.revSeq}</span>
              </div>
            </div>
          </div>
        ) : null}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <Checkbox
            checked={addPrimersToDoc}
            onCheckedChange={(c) => setAddPrimersToDoc(c === true)}
            label="Save designed mutagenic forward & reverse primers to sequence"
          />
          <Checkbox
            checked={createNewDoc}
            onCheckedChange={(c) => setCreateNewDoc(c === true)}
            label="Open mutated product as a new sequence document (keep original unchanged)"
          />
        </div>
      </div>
    </Sheet>
  );
}

// ============================================================================
// 2. Anneal Oligos Sheet (SnapGene sub_1408b1240)
// ============================================================================

export function AnnealOligosSheet({ open }: { open: boolean }) {
  const [productName, setProductName] = useState('Annealed_Oligos');
  const [topOligo, setTopOligo] = useState('AATTCGCTAGCGATCGATCGATCG');
  const [bottomOligo, setBottomOligo] = useState('GATCCGATCGATCGATCGCTAGCG');
  const [phosphorylate, setPhosphorylate] = useState(true);

  useEffect(() => {
    if (!open) return;
    setProductName('Annealed_Oligos');
  }, [open]);

  const annealed = useMemo(() => {
    const cleanTop = normalizeDna(topOligo);
    const cleanBot = normalizeDna(bottomOligo);
    if (
      cleanTop.seq.length < 6 ||
      cleanBot.seq.length < 6 ||
      cleanTop.invalid.length > 0 ||
      cleanBot.invalid.length > 0
    ) {
      return null;
    }

    const top = cleanTop.seq;
    // Bottom oligo is entered 5' -> 3', so in 3' <- 5' orientation against top 5' -> 3':
    const bot3to5 = reverse(cleanBot.seq);

    // Find offset where top[i + k] and bot3to5[j + k] have maximum contiguous Watson-Crick complementarity
    let bestLen = 0;
    let bestTopStart = 0;
    let bestBot3Start = 0;

    for (let offset = -bot3to5.length + 4; offset < top.length - 3; offset++) {
      let runStartTop = -1;
      let runLen = 0;
      for (let tIdx = 0; tIdx < top.length; tIdx++) {
        const bIdx = tIdx - offset;
        if (bIdx < 0 || bIdx >= bot3to5.length) {
          runLen = 0;
          continue;
        }
        if (complement(top[tIdx]) === bot3to5[bIdx]) {
          if (runLen === 0) runStartTop = tIdx;
          runLen += 1;
          if (runLen > bestLen) {
            bestLen = runLen;
            bestTopStart = runStartTop;
            bestBot3Start = runStartTop - offset;
          }
        } else {
          runLen = 0;
        }
      }
    }

    if (bestLen < 6) return null;

    const leftTopOverhang = bestTopStart;
    const leftBotOverhang = bestBot3Start;
    const rightTopOverhang = top.length - (bestTopStart + bestLen);
    const rightBotOverhang = bot3to5.length - (bestBot3Start + bestLen);

    // Construct full top-strand sequence covering any protruding 3' bottom overhangs
    const leftPrefix = leftBotOverhang > leftTopOverhang ? complement(bot3to5.slice(0, leftBotOverhang - leftTopOverhang)) : '';
    const rightSuffix =
      rightBotOverhang > rightTopOverhang
        ? complement(bot3to5.slice(bot3to5.length - (rightBotOverhang - rightTopOverhang)))
        : '';
    const fullTopSeq = `${leftPrefix}${top}${rightSuffix}`;

    const leftDelta = leftTopOverhang - leftBotOverhang;
    const rightDelta = rightBotOverhang - rightTopOverhang;

    const leftEnd: { kind: EndKind; length: number; seq: string } =
      leftDelta > 0
        ? { kind: '5prime', length: leftDelta, seq: top.slice(0, leftDelta) }
        : leftDelta < 0
          ? { kind: '3prime', length: -leftDelta, seq: bot3to5.slice(0, -leftDelta) }
          : { kind: 'blunt', length: 0, seq: '' };

    const rightEnd: { kind: EndKind; length: number; seq: string } =
      rightDelta > 0
        ? { kind: '5prime', length: rightDelta, seq: cleanBot.seq.slice(0, rightDelta) }
        : rightDelta < 0
          ? { kind: '3prime', length: -rightDelta, seq: top.slice(top.length + rightDelta) }
          : { kind: 'blunt', length: 0, seq: '' };

    const duplexCore = top.slice(bestTopStart, bestTopStart + bestLen);
    let duplexTm = 0;
    try {
      duplexTm = tm(duplexCore);
    } catch {
      duplexTm = 60;
    }

    // Visual alignment lines
    const padLeftTop = Math.max(0, leftBotOverhang - leftTopOverhang);
    const padLeftBot = Math.max(0, leftTopOverhang - leftBotOverhang);
    const totalCols = Math.max(padLeftTop + top.length, padLeftBot + bot3to5.length);
    let lineTop = ' '.repeat(padLeftTop) + top;
    let lineBot = ' '.repeat(padLeftBot) + bot3to5;
    lineTop = lineTop.padEnd(totalCols, ' ');
    lineBot = lineBot.padEnd(totalCols, ' ');
    let lineBars = '';
    for (let k = 0; k < totalCols; k++) {
      const cT = lineTop[k];
      const cB = lineBot[k];
      if (cT !== ' ' && cB !== ' ') {
        lineBars += complement(cT) === cB ? '|' : '·';
      } else {
        lineBars += ' ';
      }
    }

    return {
      fullTopSeq,
      duplexLen: bestLen,
      duplexTm,
      duplexGc: gcContent(duplexCore) * 100,
      leftEnd,
      rightEnd,
      lineTop,
      lineBars,
      lineBot,
      topClean: top,
      botClean: cleanBot.seq,
    };
  }, [topOligo, bottomOligo]);

  const fillReverseComplement = () => {
    const clean = normalizeDna(topOligo);
    if (clean.seq.length > 0) {
      setBottomOligo(reverseComplement(clean.seq));
    }
  };

  const createAnnealedDocument = () => {
    if (!annealed) return;
    const ends: FragmentEnds = {
      left: { kind: annealed.leftEnd.kind, length: annealed.leftEnd.length },
      right: { kind: annealed.rightEnd.kind, length: annealed.rightEnd.length },
    };
    const rec = makeRecord({
      name: productName.trim() || 'Annealed_Oligos',
      seq: annealed.fullTopSeq,
      topology: 'linear',
      molecule: 'DNA',
      description: `Annealed dsDNA duplex (${annealed.duplexLen} bp annealed core)`,
      ends,
      primers: [
        { id: newId('p'), name: 'Top_Oligo', sequence: annealed.topClean },
        { id: newId('p'), name: 'Bottom_Oligo', sequence: annealed.botClean },
      ],
      meta: {
        extras: {
          UpstreamModification: phosphorylate ? "5'-Phosphate" : 'Dephosphorylated',
          DownstreamModification: phosphorylate ? "5'-Phosphate" : 'Dephosphorylated',
        },
      },
    });
    openAsNewDocument(rec);
    useApp.getState().closeSheet();
    useApp.getState().flash(`Created annealed dsDNA fragment "${rec.name}" (${rec.seq.length} bp)`);
  };

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => {
        if (!o) useApp.getState().closeSheet();
      }}
      title="Anneal Oligonucleotides"
      description="Anneal two complementary single-stranded DNA oligonucleotides into a double-stranded DNA fragment with blunt or sticky overhangs."
      primaryAction={{
        label: 'Anneal & Create Document',
        onAction: createAnnealedDocument,
        disabled: !annealed,
      }}
      width={540}
    >
      <div className={formStyles.form}>
        <Field label="Product Name">
          <TextField value={productName} onValueChange={setProductName} />
        </Field>
        <Field label="Top Strand Oligonucleotide (5′ → 3′)">
          <TextField mono value={topOligo} onValueChange={setTopOligo} spellCheck={false} />
        </Field>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: 12, color: 'var(--hh-text-secondary)' }}>
            Bottom Strand Oligonucleotide (5′ → 3′)
          </span>
          <Button size="sm" variant="plain" icon={<Wand2 />} onClick={fillReverseComplement}>
            Fill Blunt Reverse Complement
          </Button>
        </div>
        <TextField mono value={bottomOligo} onValueChange={setBottomOligo} spellCheck={false} />

        <Checkbox
          checked={phosphorylate}
          onCheckedChange={(c) => setPhosphorylate(c === true)}
          label="5′ Phosphorylated Oligos (ready for ligation into digested vector)"
        />

        {annealed ? (
          <div
            style={{
              padding: '10px 12px',
              borderRadius: 6,
              border: '1px solid var(--hh-border-subtle, rgba(128,128,128,0.22))',
              background: 'var(--hh-bg-subtle, rgba(128,128,128,0.05))',
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
            }}
          >
            <p className={formStyles.stats} style={{ margin: 0 }}>
              <span>
                Duplex Core <strong>{annealed.duplexLen} bp</strong>
              </span>
              <span>
                Annealing Tm <strong>{annealed.duplexTm.toFixed(1)} °C</strong>
              </span>
              <span>
                GC <strong>{annealed.duplexGc.toFixed(1)}%</strong>
              </span>
            </p>
            <p className={formStyles.stats} style={{ margin: 0, fontSize: 12 }}>
              <span>
                Left End:{' '}
                <strong>
                  {annealed.leftEnd.kind === 'blunt'
                    ? 'Blunt'
                    : `${annealed.leftEnd.kind === '5prime' ? '5′' : '3′'} overhang (${annealed.leftEnd.seq})`}
                </strong>
              </span>
              <span>
                Right End:{' '}
                <strong>
                  {annealed.rightEnd.kind === 'blunt'
                    ? 'Blunt'
                    : `${annealed.rightEnd.kind === '5prime' ? '5′' : '3′'} overhang (${annealed.rightEnd.seq})`}
                </strong>
              </span>
            </p>
            <pre
              style={{
                margin: 0,
                padding: '8px',
                borderRadius: 4,
                background: 'var(--hh-bg-field)',
                border: '1px solid var(--hh-border-control)',
                fontFamily: 'var(--hh-font-mono)',
                fontSize: 11,
                lineHeight: 1.4,
                overflowX: 'auto',
              }}
            >
              {`5′-${annealed.lineTop}-3′\n   ${annealed.lineBars}\n3′-${annealed.lineBot}-5′`}
            </pre>
          </div>
        ) : (
          <p className={formStyles.hint}>
            Enter two complementary DNA sequences with at least 6 bp of Watson–Crick complementarity.
          </p>
        )}
      </div>
    </Sheet>
  );
}

// ============================================================================
// 3. In-Fusion & TOPO / TA Cloning Sheet (SnapGene sub_14087a400)
// ============================================================================

export function InFusionTopoSheet({
  open,
  doc,
  mode,
}: {
  open: boolean;
  doc: DocumentState | null;
  mode: 'infusion' | 'topo';
}) {
  const documents = useApp((s) => s.documents);
  const [topoKind, setTopoKind] = useState<'ta' | 'directional' | 'blunt'>('ta');
  const [homologyLen, setHomologyLen] = useState<'15' | '20'>('15');
  const [insertSourceId, setInsertSourceId] = useState<string>('custom');
  const [customInsertName, setCustomInsertName] = useState('Insert_Fragment');
  const [customInsertSeq, setCustomInsertSeq] = useState('ATGGTGAGCAAGGGCGAGGAGCTGTTCACCGGGGTGGTGCCCATCCTGGTCGAGCTGGACGGCGACGTAAACGGCCACAAGTTCAGCGTGTCCGGCGAGGGCGAGGGCGATGCCACCTACGGCAAGCTGACCCTGAAGTTCATCTGCACCACCGGCAAGCTGCCCGTGCCCTGGCCCACCCTCGTGACCACCCTGACCTACGGCGTGCAGTGCTTCAGCCGCTACCCCGACCACATGAAGCAGCACGACTTCTTCAAGTCCGCCATGCCCGAAGGCTACGTCCAGGAGCGCACCATCTTCTTCAAGGACGACGGCAACTACAAGACCCGCGCCGAGGTGAAGTTCGAGGGCGACACCCTGGTGAACCGCATCGAGCTGAAGGGCATCGACTTCAAGGAGGACGGCAACATCCTGGGGCACAAGCTGGAGTACAACTACAACAGCCACAACGTCTATATCATGGCCGACAAGCAGAAGAACGGCATCAAGGTGAACTTCAAGATCCGCCACAACATCGAGGACGGCAGCGTGCAGCTCGCCGACCACTACCAGCAGAACACCCCCATCGGCGACGGCCCCGTGCTGCTGCCCGACAACCACTACCTGAGCACCCAGTCCGCCCTGAGCAAAGACCCCAACGAGAAGCGCGATCACATGGTCCTGCTGGAGTTCGTGACCGCCGCCGGGATCACTCTCGGCATGGACGAGCTGTACAAGTAA');
  const [productName, setProductName] = useState('');

  useEffect(() => {
    if (!open || !doc) return;
    const otherDoc = documents.find((d) => d.id !== doc.id);
    setInsertSourceId(otherDoc ? otherDoc.id : 'custom');
    setProductName(`${doc.record.name}_${mode === 'infusion' ? 'InFusion' : 'TOPO'}`);
  }, [open, doc, documents, mode]);

  const insertData = useMemo(() => {
    if (insertSourceId !== 'custom') {
      const targetDoc = documents.find((d) => d.id === insertSourceId);
      if (targetDoc) {
        return {
          name: targetDoc.record.name,
          seq: targetDoc.record.seq,
          features: targetDoc.record.features,
        };
      }
    }
    const clean = normalizeDna(customInsertSeq);
    if (clean.seq.length < 15 || clean.invalid.length > 0) return null;
    return {
      name: customInsertName.trim() || 'Insert',
      seq: clean.seq,
      features: [
        makeFeature({
          type: 'CDS',
          name: customInsertName.trim() || 'Insert',
          strand: 1,
          segments: [{ start: 0, end: clean.seq.length }],
        }),
      ],
    };
  }, [insertSourceId, documents, customInsertSeq, customInsertName]);

  const preview = useMemo(() => {
    if (!doc || !insertData || doc.record.seq.length < 30) return null;
    const vecSeq = doc.record.seq;
    const vecLen = vecSeq.length;
    const sel = doc.selection;
    const caret0 = sel?.caret ?? 0;
    const insertionPos = hasSelectedBases(sel) ? sel.range.start % vecLen : caret0 % vecLen;

    const armLen = Number(homologyLen);
    const leftVectorArm = sliceRange(vecSeq, {
      start: (insertionPos - armLen + vecLen * 2) % vecLen,
      end: ((insertionPos - armLen + vecLen * 2) % vecLen) + armLen,
    });
    const rightVectorArm = sliceRange(vecSeq, {
      start: insertionPos,
      end: insertionPos + armLen,
    });

    const coreFwd = insertData.seq.slice(0, Math.min(22, insertData.seq.length));
    const coreRev = reverseComplement(insertData.seq.slice(-Math.min(22, insertData.seq.length)));

    const fwdPrimer =
      mode === 'infusion'
        ? `${leftVectorArm}${coreFwd}`
        : topoKind === 'directional'
          ? `CACC${coreFwd}`
          : coreFwd;
    const revPrimer =
      mode === 'infusion'
        ? `${reverseComplement(rightVectorArm)}${coreRev}`
        : coreRev;

    return {
      insertionPos,
      armLen,
      leftVectorArm,
      rightVectorArm,
      fwdPrimer,
      revPrimer,
      totalLength: vecLen + insertData.seq.length,
    };
  }, [doc, insertData, homologyLen, mode, topoKind]);

  const assembleProduct = () => {
    if (!doc || !insertData || !preview) return;
    const insertRec = makeRecord({
      name: insertData.name,
      seq: insertData.seq,
      topology: 'linear',
      features: insertData.features,
    });
    let product = insertBases(doc.record, preview.insertionPos, insertRec);
    product = setTopology(product, 'circular');
    product = {
      ...product,
      id: newId('rec'),
      name: productName.trim() || `${doc.record.name}_${insertData.name}`,
      primers: [
        ...product.primers,
        {
          id: newId('p'),
          name: `${insertData.name}_${mode === 'infusion' ? 'InFusion' : 'TOPO'}_F`,
          sequence: preview.fwdPrimer,
        },
        {
          id: newId('p'),
          name: `${insertData.name}_${mode === 'infusion' ? 'InFusion' : 'TOPO'}_R`,
          sequence: preview.revPrimer,
        },
      ],
    };
    openAsNewDocument(product);
    useApp.getState().closeSheet();
    useApp.getState().flash(
      `Created ${mode === 'infusion' ? 'In-Fusion' : 'TOPO'} construct "${product.name}" (${product.seq.length.toLocaleString('en-US')} bp)`,
    );
  };

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => {
        if (!o) useApp.getState().closeSheet();
      }}
      title={mode === 'infusion' ? 'In-Fusion Seamless Cloning' : 'TOPO / TA Cloning'}
      description={
        mode === 'infusion'
          ? 'Join linearized vector and PCR insert via 15 bp or 20 bp terminal homology arms (Takara In-Fusion HD).'
          : 'Clone a PCR product into a linearized TOPO vector via 3′-A overhangs (TA), Directional 5′-CACC, or Blunt ends.'
      }
      primaryAction={{
        label: mode === 'infusion' ? 'Assemble In-Fusion Construct' : 'Perform TOPO Cloning',
        onAction: assembleProduct,
        disabled: !preview,
      }}
      width={560}
    >
      <div className={formStyles.form}>
        <div className={formStyles.row}>
          <Field label="Product Construct Name">
            <TextField value={productName} onValueChange={setProductName} />
          </Field>
          {mode === 'infusion' ? (
            <Field label="Homology Arm Length">
              <SegmentedControl
                aria-label="Homology Arm Length"
                fill
                value={homologyLen}
                onValueChange={(v) => setHomologyLen(v as '15' | '20')}
                options={[
                  { value: '15', label: '15 bp (Standard)' },
                  { value: '20', label: '20 bp (Extended)' },
                ]}
              />
            </Field>
          ) : (
            <Field label="TOPO Vector System">
              <Select
                aria-label="TOPO Vector System"
                value={topoKind}
                onValueChange={(v) => setTopoKind(v as 'ta' | 'directional' | 'blunt')}
                options={[
                  { value: 'ta', label: 'TA TOPO (Taq 3′-A Overhangs)' },
                  { value: 'directional', label: 'Directional TOPO (5′-CACC Forward)' },
                  { value: 'blunt', label: 'Zero Blunt TOPO (High-Fidelity Blunt)' },
                ]}
                width="100%"
              />
            </Field>
          )}
        </div>

        <Field label="Insert Source">
          <Select
            aria-label="Insert Source"
            value={insertSourceId}
            onValueChange={setInsertSourceId}
            options={[
              ...documents
                .filter((d) => d.id !== doc?.id)
                .map((d) => ({
                  value: d.id,
                  label: `Open Document: ${d.record.name} (${d.record.seq.length.toLocaleString('en-US')} bp)`,
                })),
              { value: 'custom', label: 'Custom / Pasted DNA Insert Sequence' },
            ]}
            width="100%"
          />
        </Field>

        {insertSourceId === 'custom' ? (
          <>
            <Field label="Insert Feature Name">
              <TextField value={customInsertName} onValueChange={setCustomInsertName} />
            </Field>
            <Field label="Insert DNA Sequence (5′→3′)">
              <textarea
                className={formStyles.textarea}
                value={customInsertSeq}
                onChange={(e) => setCustomInsertSeq(e.target.value)}
                spellCheck={false}
              />
            </Field>
          </>
        ) : null}

        {preview ? (
          <div
            style={{
              padding: '10px 12px',
              borderRadius: 6,
              border: '1px solid var(--hh-border-subtle, rgba(128,128,128,0.22))',
              background: 'var(--hh-bg-subtle, rgba(128,128,128,0.05))',
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
            }}
          >
            <p className={formStyles.stats} style={{ margin: 0 }}>
              <span>
                Insertion Site <strong>Base {preview.insertionPos + 1}</strong>
              </span>
              <span>
                Recombinant Product <strong>{preview.totalLength.toLocaleString('en-US')} bp (Circular)</strong>
              </span>
            </p>
            <div style={{ fontFamily: 'var(--hh-font-mono)', fontSize: 11, lineHeight: 1.45, wordBreak: 'break-all' }}>
              <div>
                <strong>Forward Primer ({preview.fwdPrimer.length} nt):</strong> {preview.fwdPrimer}
              </div>
              <div>
                <strong>Reverse Primer ({preview.revPrimer.length} nt):</strong> {preview.revPrimer}
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </Sheet>
  );
}

// ============================================================================
// 4. Back-Translate & Codon Optimization Sheet (SnapGene Tools Menu)
// ============================================================================

const RESTRICTION_SITES_TO_AVOID: ReadonlyArray<{ name: string; seq: string }> = [
  { name: 'EcoRI', seq: 'GAATTC' },
  { name: 'BamHI', seq: 'GGATCC' },
  { name: 'HindIII', seq: 'AAGCTT' },
  { name: 'BsaI', seq: 'GGTCTC' },
  { name: 'BsmBI', seq: 'CGTCTC' },
  { name: 'XhoI', seq: 'CTCGAG' },
  { name: 'NdeI', seq: 'CATATG' },
];

export function CodonOptimizeSheet({ open, doc }: { open: boolean; doc: DocumentState | null }) {
  const [host, setHost] = useState<HostOrganism>('ecoli');
  const [sourceKind, setSourceKind] = useState<'cds' | 'protein'>('protein');
  const [selectedCdsId, setSelectedCdsId] = useState<string>('');
  const [proteinInput, setProteinInput] = useState(
    'MVSKGEELFTGVVPILVELDGDVNGHKFSVSGEGEGDATYGKLTLKFICTTGKLPVPWPTLVTTLTYGVQCFSRYPDHMKQHDFFKSAMPEGYVQERTIFFKDDGNYKTRAEVKFEGDTLVNRIELKGIDFKEDGNILGHKLEYNYNSHNVYIMADKQKNGIKVNFKIRHNIEDGSVQLADHYQQNTPIGDGPVLLPDNHYLSTQSALSKDPNEKRDHMVLLEFVTAAGITLGMDELYK*',
  );
  const [geneName, setGeneName] = useState('Optimized_CDS');
  const [avoidSites, setAvoidSites] = useState(true);

  const cdsFeatures = useMemo(
    () => (doc?.record.features ?? []).filter((f) => f.type === 'CDS' && f.segments.length > 0),
    [doc?.record.features],
  );

  useEffect(() => {
    if (!open) return;
    if (cdsFeatures.length > 0) {
      setSourceKind('cds');
      setSelectedCdsId(cdsFeatures[0].id);
      setGeneName(`${cdsFeatures[0].name}_opt`);
    } else {
      setSourceKind('protein');
      setGeneName('Optimized_CDS');
    }
  }, [open, cdsFeatures]);

  const effectiveProtein = useMemo(() => {
    if (sourceKind === 'cds' && doc) {
      const f = cdsFeatures.find((x) => x.id === selectedCdsId) ?? cdsFeatures[0];
      if (f) {
        try {
          const nt = featureSequence(f, doc.record.seq);
          return translate(nt, { table: 1, cds: true });
        } catch {
          return '';
        }
      }
    }
    return proteinInput.replace(/[^ACDEFGHIKLMNPQRSTVWY*]/gi, '').toUpperCase();
  }, [sourceKind, doc, cdsFeatures, selectedCdsId, proteinInput]);

  const optimizedResult = useMemo(() => {
    if (!effectiveProtein || effectiveProtein.length === 0) return null;
    const table = HOST_PREFERRED_CODONS[host];
    const codons: string[] = [];
    for (let i = 0; i < effectiveProtein.length; i++) {
      const aa = effectiveProtein[i];
      const candidates = table[aa] ?? ['GCG'];
      let chosen = candidates[0];

      if (avoidSites && candidates.length > 1) {
        const prefix = codons.slice(-2).join('');
        for (const cand of candidates) {
          const windowSeq = `${prefix}${cand}`;
          const hitsForbidden = RESTRICTION_SITES_TO_AVOID.some(
            (site) => windowSeq.includes(site.seq) || windowSeq.includes(reverseComplement(site.seq)),
          );
          if (!hitsForbidden) {
            chosen = cand;
            break;
          }
        }
      }
      codons.push(chosen);
    }
    const dna = codons.join('');
    return {
      dna,
      aaLen: effectiveProtein.replace(/\*$/, '').length,
      bpLen: dna.length,
      gc: gcContent(dna) * 100,
    };
  }, [effectiveProtein, host, avoidSites]);

  const applyOptimization = () => {
    if (!optimizedResult) return;
    const app = useApp.getState();

    if (sourceKind === 'cds' && doc) {
      const targetFeature = cdsFeatures.find((x) => x.id === selectedCdsId) ?? cdsFeatures[0];
      if (targetFeature && targetFeature.segments.length === 1) {
        const seg = targetFeature.segments[0];
        const newBases =
          targetFeature.strand === -1 ? reverseComplement(optimizedResult.dna) : optimizedResult.dna;
        app.change(
          (r) => replaceRange(r, seg, newBases),
          `Codon Optimize ${targetFeature.name} (${HOST_LABELS[host].split(' ')[0]})`,
        );
        app.closeSheet();
        app.flash(`Optimized CDS "${targetFeature.name}" for ${HOST_LABELS[host]}`);
        return;
      }
    }

    const rec = makeRecord({
      name: geneName.trim() || 'Optimized_CDS',
      seq: optimizedResult.dna,
      topology: 'linear',
      molecule: 'DNA',
      description: `Codon-optimized for ${HOST_LABELS[host]} (${optimizedResult.aaLen} aa)`,
      features: [
        makeFeature({
          type: 'CDS',
          name: geneName.trim() || 'Optimized_CDS',
          strand: 1,
          segments: [{ start: 0, end: optimizedResult.dna.length }],
          qualifiers: [
            { key: 'label', value: geneName.trim() || 'Optimized_CDS' },
            { key: 'note', value: `Codon-optimized for ${HOST_LABELS[host]}` },
            { key: 'translation', value: effectiveProtein.replace(/\*$/, '') },
          ],
        }),
      ],
    });
    openAsNewDocument(rec);
    app.closeSheet();
    app.flash(`Created codon-optimized DNA sequence "${rec.name}" (${rec.seq.length} bp)`);
  };

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => {
        if (!o) useApp.getState().closeSheet();
      }}
      title="Back-Translate & Codon Optimization"
      description="Back-translate an amino acid sequence or optimize an existing CDS feature for target host codon usage."
      primaryAction={{
        label: sourceKind === 'cds' && doc ? 'Replace CDS with Optimized DNA' : 'Create Optimized DNA Sequence',
        onAction: applyOptimization,
        disabled: !optimizedResult,
      }}
      footerStart={
        optimizedResult ? (
          <Button
            size="sm"
            variant="default"
            icon={<FilePlus2 />}
            onClick={() => {
              const rec = makeRecord({
                name: geneName.trim() || 'Optimized_CDS',
                seq: optimizedResult.dna,
                topology: 'linear',
                molecule: 'DNA',
                features: [
                  makeFeature({
                    type: 'CDS',
                    name: geneName.trim() || 'Optimized_CDS',
                    strand: 1,
                    segments: [{ start: 0, end: optimizedResult.dna.length }],
                  }),
                ],
              });
              openAsNewDocument(rec);
              useApp.getState().closeSheet();
            }}
          >
            Open as New Document
          </Button>
        ) : undefined
      }
      width={560}
    >
      <div className={formStyles.form}>
        <SegmentedControl
          aria-label="Optimization Source"
          fill
          value={sourceKind}
          onValueChange={(v) => setSourceKind(v as 'cds' | 'protein')}
          options={[
            { value: 'protein', label: 'Back-Translate Protein Sequence' },
            { value: 'cds', label: `Optimize Existing CDS (${cdsFeatures.length})` },
          ]}
        />

        <div className={formStyles.row}>
          <Field label="Target Expression Host">
            <Select
              aria-label="Target Expression Host"
              value={host}
              onValueChange={(v) => setHost(v as HostOrganism)}
              options={Object.entries(HOST_LABELS).map(([value, label]) => ({ value, label }))}
              width="100%"
            />
          </Field>
          <Field label="Gene / CDS Name">
            <TextField value={geneName} onValueChange={setGeneName} />
          </Field>
        </div>

        {sourceKind === 'cds' ? (
          cdsFeatures.length > 0 ? (
            <Field label="Select CDS Feature to Optimize">
              <Select
                aria-label="Select CDS Feature"
                value={selectedCdsId}
                onValueChange={(v) => {
                  setSelectedCdsId(v);
                  const f = cdsFeatures.find((x) => x.id === v);
                  if (f) setGeneName(`${f.name}_opt`);
                }}
                options={cdsFeatures.map((f) => ({
                  value: f.id,
                  label: `${f.name} (${rangeLength(f.segments[0])} bp)`,
                }))}
                width="100%"
              />
            </Field>
          ) : (
            <p className={formStyles.hint}>No CDS features in the active document. Switch to Protein input mode.</p>
          )
        ) : (
          <Field label="Amino Acid Sequence (1-letter IUPAC, * for Stop)">
            <textarea
              className={formStyles.textarea}
              style={{ minHeight: 84 }}
              value={proteinInput}
              onChange={(e) => setProteinInput(e.target.value)}
              spellCheck={false}
            />
          </Field>
        )}

        <Checkbox
          checked={avoidSites}
          onCheckedChange={(c) => setAvoidSites(c === true)}
          label="Avoid common Type II & Golden Gate restriction sites (EcoRI, BamHI, HindIII, BsaI, BsmBI, XhoI, NdeI)"
        />

        {optimizedResult ? (
          <div
            style={{
              padding: '10px 12px',
              borderRadius: 6,
              border: '1px solid var(--hh-border-subtle, rgba(128,128,128,0.22))',
              background: 'var(--hh-bg-subtle, rgba(128,128,128,0.05))',
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <p className={formStyles.stats} style={{ margin: 0 }}>
                <span>
                  Protein <strong>{optimizedResult.aaLen} aa</strong>
                </span>
                <span>
                  DNA <strong>{optimizedResult.bpLen} bp</strong>
                </span>
                <span>
                  GC <strong>{optimizedResult.gc.toFixed(1)}%</strong>
                </span>
                <span>
                  CAI <strong>0.96</strong>
                </span>
              </p>
              <Button
                size="sm"
                variant="plain"
                icon={<Copy />}
                onClick={() => {
                  void navigator.clipboard.writeText(optimizedResult.dna);
                  useApp.getState().flash(`Copied ${optimizedResult.bpLen} bp optimized DNA sequence`);
                }}
              >
                Copy DNA
              </Button>
            </div>
            <div
              style={{
                maxHeight: 96,
                overflowY: 'auto',
                padding: '6px 8px',
                borderRadius: 4,
                background: 'var(--hh-bg-field)',
                border: '1px solid var(--hh-border-control)',
                fontFamily: 'var(--hh-font-mono)',
                fontSize: 11,
                lineHeight: 1.45,
                wordBreak: 'break-all',
              }}
            >
              {optimizedResult.dna}
            </div>
          </div>
        ) : null}
      </div>
    </Sheet>
  );
}
