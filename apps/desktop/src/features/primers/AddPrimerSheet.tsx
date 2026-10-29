/**
 * SnapGene-style Primer Dialog: handles both Add Primer and Edit Primer.
 * Supports forward/reverse direction, 5′ extension / tail addition (restriction sites with leader clamps
 * and common cloning tags/motifs), live template binding site search, annealing vs full-oligo
 * thermodynamics (Tm, GC%, hairpin ΔG, self-dimer ΔG, 3′ end ΔG), 3-line nucleotide alignment preview,
 * description/notes, and Delete / Duplicate in Edit mode.
 */
import type { Primer, PrimerBindingSite } from '@hhereditas/core';
import {
  COMMON_ENZYMES,
  addPrimer,
  analyzePrimer,
  complementBase,
  findBindingSites,
  formatRange,
  iupacMatches,
  newId,
  normalizeDna,
  oligoGcContent,
  reverseComplement,
  sliceRange,
  updatePrimer,
} from '@hhereditas/core';
import { Badge, Button, Field, SegmentedControl, Select, Sheet, TextField } from '@hhereditas/ui';
import { Copy, Plus, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { deletePrimerCommand, selectedText } from '../../app/commands';
import type { DocumentState } from '../../state/documents';
import { useApp } from '../../state/store';
import styles from '../dialogs/forms.module.css';
import sheetStyles from './PrimerSheet.module.css';

/** Selections longer than this give a primer of PRIMER_LENGTH bases at the matching end. */
const MAX_PRIMER_FROM_SELECTION = 60;
const PRIMER_LENGTH = 20;

const LEADER_CLAMP_OPTIONS = [
  { value: 'none', label: 'None', bases: '' },
  { value: 'GC', label: '+2 bp (GC)', bases: 'GC' },
  { value: 'GCTA', label: '+4 bp (GCTA)', bases: 'GCTA' },
  { value: 'GCGATC', label: '+6 bp (GCGATC)', bases: 'GCGATC' },
] as const;

const COMMON_TAIL_MOTIFS = [
  { label: 'Kozak (GCCACCATGG)', seq: 'GCCACCATGG' },
  { label: '6×His (CATCACCATCACCATCAC)', seq: 'CATCACCATCACCATCAC' },
  { label: 'Start (ATG)', seq: 'ATG' },
  { label: 'Stop (TAA)', seq: 'TAA' },
  { label: 'attB1', seq: 'ACAAGTTTGTACAAAAAAGCAGGCT' },
  { label: 'attB2', seq: 'ACCACTTTGTACAAGAAAGCTGGGT' },
] as const;

export interface AddPrimerSheetProps {
  open: boolean;
  doc: DocumentState | null;
  direction?: 1 | -1;
  mode?: 'add' | 'edit';
  primerId?: string;
}

/** Primer for a selected template: forward = its first bases, reverse = reverse complement of its last bases. */
export function primerFromTemplate(template: string, direction: 1 | -1): string {
  const t =
    template.length > MAX_PRIMER_FROM_SELECTION
      ? direction === 1
        ? template.slice(0, PRIMER_LENGTH)
        : template.slice(-PRIMER_LENGTH)
      : template;
  return direction === -1 ? reverseComplement(t) : t;
}

function formatDeltaG(structure: { found: boolean; dG: number } | undefined): string {
  if (!structure) return '—';
  if (!structure.found) return '0.0 kcal/mol';
  return `${structure.dG.toFixed(1)} kcal/mol`;
}

export function AddPrimerSheet({ open, doc, direction = 1, mode = 'add', primerId }: AddPrimerSheetProps) {
  const [dir, setDir] = useState<'1' | '-1'>('1');
  const [name, setName] = useState('');
  const [sequence, setSequence] = useState('');
  const [description, setDescription] = useState('');
  const [selectedEnzymeName, setSelectedEnzymeName] = useState<string>(COMMON_ENZYMES[0]?.name ?? 'EcoRI');
  const [leaderClamp, setLeaderClamp] = useState<string>('none');

  const targetPrimerId = primerId ?? (doc?.selectedItem?.kind === 'primer' ? doc.selectedItem.id : undefined);
  const existingPrimer: Primer | null = useMemo(() => {
    if (mode !== 'edit' || !doc || !targetPrimerId) return null;
    return doc.record.primers.find((p) => p.id === targetPrimerId) ?? null;
  }, [mode, doc, targetPrimerId]);

  const isEditMode = mode === 'edit' && !!existingPrimer;
  const template = open ? selectedText(doc) : null;

  useEffect(() => {
    if (!open || !doc) return;
    if (mode === 'edit' && existingPrimer) {
      setName(existingPrimer.name);
      setSequence(existingPrimer.sequence);
      setDescription(existingPrimer.description ?? '');
      let inferredDir: '1' | '-1' = direction === -1 ? '-1' : '1';
      try {
        const sites = findBindingSites(doc.record.seq, doc.record.topology, existingPrimer);
        if (sites.length > 0) {
          inferredDir = sites[0].strand === -1 ? '-1' : '1';
        }
      } catch {
        // ignore binding errors when inferring direction
      }
      setDir(inferredDir);
      return;
    }

    const d: 1 | -1 = direction === -1 ? -1 : 1;
    setDir(d === -1 ? '-1' : '1');
    const n = doc.record.primers.length + 1;
    setName(`${doc.record.name}-${d === -1 ? 'R' : 'F'}${n}`);
    setSequence(primerFromTemplate(selectedText(doc) ?? '', d));
    setDescription('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mode, existingPrimer?.id]);

  const changeDirection = (d: '1' | '-1') => {
    setDir(d);
    if (!isEditMode && template) {
      setSequence(primerFromTemplate(template, d === '-1' ? -1 : 1));
    }
    if (!isEditMode) {
      setName((cur) => cur.replace(/-(F|R)(\d+)$/, `-${d === '-1' ? 'R' : 'F'}$2`));
    }
  };

  const clean = normalizeDna(sequence);
  const invalid = clean.invalid.length > 0;

  const analysis = useMemo(() => {
    if (clean.seq.length < 6 || clean.seq.length > 200 || invalid) return null;
    try {
      return analyzePrimer(clean.seq);
    } catch {
      return null;
    }
  }, [clean.seq, invalid]);

  const bindingSites = useMemo<PrimerBindingSite[]>(() => {
    if (!doc || clean.seq.length < 10 || invalid || doc.record.seq.length === 0) return [];
    const previewPrimer: Primer = {
      id: 'preview',
      name: name.trim() || 'Primer',
      sequence: clean.seq,
    };
    try {
      const exactSites = findBindingSites(doc.record.seq, doc.record.topology, previewPrimer);
      if (exactSites.length > 0) return exactSites;
      return findBindingSites(doc.record.seq, doc.record.topology, previewPrimer, {
        minAnneal: Math.min(15, clean.seq.length),
        maxMismatches: 2,
      });
    } catch {
      return [];
    }
  }, [doc, clean.seq, invalid, name]);

  const primarySite = useMemo<PrimerBindingSite | null>(() => {
    if (bindingSites.length === 0) return null;
    const preferredStrand = dir === '-1' ? -1 : 1;
    const sorted = [...bindingSites].sort(
      (a, b) =>
        b.annealedLength - a.annealedLength ||
        a.mismatches - b.mismatches ||
        (b.strand === preferredStrand ? 1 : 0) - (a.strand === preferredStrand ? 1 : 0) ||
        a.range.start - b.range.start,
    );
    return sorted[0] ?? null;
  }, [bindingSites, dir]);

  const annealingInfo = useMemo(() => {
    if (!doc || !primarySite) return null;
    const seqLen = doc.record.seq.length;
    const tailSeq = clean.seq.slice(0, primarySite.tailLength);
    const annealedSeq = clean.seq.slice(primarySite.tailLength);
    const topTemplate = sliceRange(doc.record.seq, primarySite.range);
    const k = primarySite.annealedLength;

    let pairingChars = '';
    let template3to5 = '';
    const mismatchIndices = new Set<number>();

    for (let j = 0; j < k; j++) {
      const pb = annealedSeq[j] ?? '';
      const topBase = primarySite.strand === 1 ? (topTemplate[j] ?? '') : (topTemplate[k - 1 - j] ?? '');
      const compBase = primarySite.strand === 1 ? complementBase(topBase) : topBase;
      const isMatch =
        primarySite.strand === 1 ? iupacMatches(pb, topBase) : iupacMatches(complementBase(pb), topBase);
      pairingChars += isMatch ? '|' : '·';
      if (!isMatch) mismatchIndices.add(j);
      template3to5 += compBase;
    }

    let annealTm = primarySite.tm;
    let annealGc = oligoGcContent(annealedSeq);
    if (annealTm === undefined && annealedSeq.length >= 6) {
      try {
        const a = analyzePrimer(annealedSeq);
        annealTm = a.tm;
        annealGc = a.gc;
      } catch {
        // ignore
      }
    }

    const coordText = formatRange(primarySite.range, seqLen);
    return {
      tailSeq,
      annealedSeq,
      pairingChars,
      template3to5,
      mismatchIndices,
      annealTm,
      annealGc,
      coordText,
    };
  }, [doc, primarySite, clean.seq]);

  const enzymeOptions = useMemo(
    () =>
      COMMON_ENZYMES.map((e) => ({
        value: e.name,
        label: `${e.name} (${e.site})`,
      })),
    [],
  );

  const clampOptions = useMemo(
    () =>
      LEADER_CLAMP_OPTIONS.map((c) => ({
        value: c.value,
        label: c.label,
      })),
    [],
  );

  const prependRestrictionSite = () => {
    const enzyme = COMMON_ENZYMES.find((e) => e.name === selectedEnzymeName) ?? COMMON_ENZYMES[0];
    if (!enzyme) return;
    const clampObj = LEADER_CLAMP_OPTIONS.find((c) => c.value === leaderClamp);
    const clampBases = clampObj ? clampObj.bases : '';
    setSequence((prev) => `${clampBases}${enzyme.site}${prev}`);
  };

  const prependMotif = (motifSeq: string) => {
    setSequence((prev) => `${motifSeq}${prev}`);
  };

  const valid = clean.seq.length >= 6 && !invalid && name.trim().length > 0;

  const save = () => {
    if (!valid) return;
    const trimmedName = name.trim();
    const trimmedDesc = description.trim();
    const app = useApp.getState();

    if (isEditMode && existingPrimer) {
      app.change(
        (r) =>
          updatePrimer(r, existingPrimer.id, {
            name: trimmedName,
            sequence: clean.seq,
            description: trimmedDesc ? trimmedDesc : undefined,
          }),
        'Edit Primer',
      );
      app.closeSheet();
      app.selectItem({ kind: 'primer', id: existingPrimer.id });
      return;
    }

    const primer: Primer = {
      id: newId('p'),
      name: trimmedName,
      sequence: clean.seq,
      ...(trimmedDesc ? { description: trimmedDesc } : {}),
    };
    app.change((r) => addPrimer(r, primer), 'Add Primer');
    app.closeSheet();
    app.selectItem({ kind: 'primer', id: primer.id });
  };

  const handleDelete = () => {
    if (!existingPrimer) return;
    const app = useApp.getState();
    deletePrimerCommand(existingPrimer.id);
    app.closeSheet();
    app.flash(`Deleted primer "${existingPrimer.name}"`);
  };

  const handleDuplicate = () => {
    if (!valid) return;
    const dupName = `${name.trim() || existingPrimer?.name || 'Primer'} (copy)`;
    const trimmedDesc = description.trim();
    const dup: Primer = {
      id: newId('p'),
      name: dupName,
      sequence: clean.seq,
      ...(trimmedDesc ? { description: trimmedDesc } : {}),
    };
    const app = useApp.getState();
    app.change((r) => addPrimer(r, dup), 'Duplicate Primer');
    app.closeSheet();
    app.selectItem({ kind: 'primer', id: dup.id });
    app.flash(`Duplicated primer as "${dupName}"`);
  };

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => {
        if (!o) useApp.getState().closeSheet();
      }}
      title={isEditMode ? 'Edit Primer' : 'Add Primer'}
      description={
        !isEditMode && (template?.length ?? 0) > MAX_PRIMER_FROM_SELECTION
          ? `Uses the ${PRIMER_LENGTH} bases at the ${dir === '1' ? 'start' : 'end'} of the selection; edit the sequence to change it.`
          : 'The primer is stored with the sequence; its binding sites are shown on the map.'
      }
      primaryAction={{
        label: isEditMode ? 'Save Primer' : 'Add Primer',
        onAction: save,
        disabled: !valid,
      }}
      footerStart={
        isEditMode ? (
          <div className={sheetStyles.footerActions}>
            <Button variant="destructive" size="sm" icon={<Trash2 />} onClick={handleDelete}>
              Delete Primer
            </Button>
            <Button variant="default" size="sm" icon={<Copy />} onClick={handleDuplicate} disabled={!valid}>
              Duplicate Primer
            </Button>
          </div>
        ) : undefined
      }
      width={560}
    >
      <div className={sheetStyles.sheetBody}>
        <SegmentedControl
          aria-label="Direction"
          fill
          value={dir}
          onValueChange={changeDirection}
          options={[
            { value: '1', label: 'Forward (top strand)' },
            { value: '-1', label: 'Reverse (bottom strand)' },
          ]}
        />

        <div className={sheetStyles.topRow}>
          <Field label="Name">
            <TextField value={name} onValueChange={setName} placeholder="e.g. pUC19-F1, T7-Fwd" />
          </Field>
          <Field label="Description / Notes">
            <TextField
              value={description}
              onValueChange={setDescription}
              placeholder="Optional notes, purpose, or target"
            />
          </Field>
        </div>

        <Field label="Sequence (5′→3′)" error={invalid ? `Not IUPAC DNA: ${clean.invalid.join(' ')}` : undefined}>
          <TextField
            mono
            value={sequence}
            onValueChange={setSequence}
            spellCheck={false}
            placeholder="Paste or type 5′→3′ oligonucleotide sequence"
          />
        </Field>

        <div className={sheetStyles.sectionBox}>
          <div className={sheetStyles.sectionHeader}>
            <span className={sheetStyles.sectionTitle}>5′ Extension / Tail Addition</span>
            {primarySite && primarySite.tailLength > 0 ? (
              <Badge tone="warning" size="sm">
                5′ Tail: {primarySite.tailLength} nt
              </Badge>
            ) : null}
          </div>
          <div className={sheetStyles.tailRow}>
            <Field label="Insert Restriction Site">
              <Select
                aria-label="Insert Restriction Site"
                size="sm"
                value={selectedEnzymeName}
                onValueChange={setSelectedEnzymeName}
                options={enzymeOptions}
                width="100%"
              />
            </Field>
            <Field label="5′ Leader Clamp">
              <Select
                aria-label="5′ Leader Clamp"
                size="sm"
                value={leaderClamp}
                onValueChange={setLeaderClamp}
                options={clampOptions}
                width="100%"
              />
            </Field>
            <Button size="sm" icon={<Plus />} onClick={prependRestrictionSite}>
              Prepend to 5′ End
            </Button>
          </div>
          <div className={sheetStyles.motifRow}>
            <span className={sheetStyles.motifLabel}>Insert Common Tag / Motif:</span>
            {COMMON_TAIL_MOTIFS.map((m) => (
              <Button key={m.label} size="sm" variant="plain" onClick={() => prependMotif(m.seq)}>
                +{m.label}
              </Button>
            ))}
          </div>
        </div>

        <p className={styles.stats} aria-live="polite">
          <span>
            Length <strong>{clean.seq.length} nt</strong>
          </span>
          {analysis ? (
            <>
              <span>
                GC <strong>{(analysis.gc * 100).toFixed(1)} %</strong>
              </span>
              <span>
                Tm <strong>{Number.isFinite(analysis.tm) ? `${analysis.tm.toFixed(1)} °C` : '—'}</strong>
              </span>
              {analysis.hairpin?.found && analysis.hairpin.dG < -2 ? (
                <span className={styles.warning}>Hairpin ΔG {analysis.hairpin.dG.toFixed(1)}</span>
              ) : null}
              {analysis.selfDimer?.found && analysis.selfDimer.dG < -6 ? (
                <span className={styles.warning}>Self-dimer ΔG {analysis.selfDimer.dG.toFixed(1)}</span>
              ) : null}
            </>
          ) : null}
        </p>

        {doc && clean.seq.length >= 10 && !invalid ? (
          <div className={sheetStyles.sectionBox}>
            <div className={sheetStyles.sectionHeader}>
              <span className={sheetStyles.sectionTitle}>Template Binding &amp; Thermodynamics</span>
              <div className={sheetStyles.bindingBadges}>
                <Badge tone={bindingSites.length > 0 ? 'accent' : 'neutral'} size="sm">
                  {bindingSites.length === 0
                    ? `0 binding sites on ${doc.record.name}`
                    : `${bindingSites.length} binding site${bindingSites.length > 1 ? 's' : ''} on ${doc.record.name}`}
                </Badge>
                {primarySite && annealingInfo ? (
                  <>
                    <Badge tone="neutral" size="sm">
                      {annealingInfo.coordText}
                    </Badge>
                    <Badge tone="neutral" size="sm">
                      {primarySite.strand === 1 ? 'Top Strand ⇒' : 'Bottom Strand ⇐'}
                    </Badge>
                    <Badge tone="success" size="sm">
                      Annealed: {primarySite.annealedLength} nt
                    </Badge>
                    <Badge tone={primarySite.tailLength > 0 ? 'warning' : 'neutral'} size="sm">
                      5′ Tail: {primarySite.tailLength} nt
                    </Badge>
                    <Badge tone={primarySite.mismatches > 0 ? 'danger' : 'neutral'} size="sm">
                      Mismatches: {primarySite.mismatches}
                    </Badge>
                  </>
                ) : null}
              </div>
            </div>

            <div className={sheetStyles.thermoGrid}>
              <div className={sheetStyles.thermoCard}>
                <span className={sheetStyles.thermoCardTitle}>Annealing Region</span>
                {primarySite && annealingInfo ? (
                  <div className={sheetStyles.thermoMetrics}>
                    <span>
                      Length <strong>{primarySite.annealedLength} nt</strong>
                    </span>
                    <span>
                      Annealing Tm{' '}
                      <strong>
                        {annealingInfo.annealTm !== undefined && Number.isFinite(annealingInfo.annealTm)
                          ? `${annealingInfo.annealTm.toFixed(1)} °C`
                          : '—'}
                      </strong>
                    </span>
                    <span>
                      Annealing GC% <strong>{(annealingInfo.annealGc * 100).toFixed(1)} %</strong>
                    </span>
                  </div>
                ) : (
                  <div className={sheetStyles.thermoMetrics}>
                    <span>No template binding site found (min 15 nt / 3′ anchor)</span>
                  </div>
                )}
              </div>

              <div className={sheetStyles.thermoCard}>
                <span className={sheetStyles.thermoCardTitle}>Full Primer</span>
                <div className={sheetStyles.thermoMetrics}>
                  <span>
                    Total Length <strong>{clean.seq.length} nt</strong>
                  </span>
                  <span>
                    Full Tm{' '}
                    <strong>{analysis && Number.isFinite(analysis.tm) ? `${analysis.tm.toFixed(1)} °C` : '—'}</strong>
                  </span>
                  <span>
                    Full GC% <strong>{analysis ? `${(analysis.gc * 100).toFixed(1)} %` : '—'}</strong>
                  </span>
                  <span>
                    Hairpin ΔG <strong>{formatDeltaG(analysis?.hairpin)}</strong>
                  </span>
                  <span>
                    Self-Dimer ΔG <strong>{formatDeltaG(analysis?.selfDimer)}</strong>
                  </span>
                  <span>
                    3′ ΔG <strong>{formatDeltaG(analysis?.selfEndDimer)}</strong>
                  </span>
                </div>
              </div>
            </div>

            {primarySite && annealingInfo ? (
              <div className={sheetStyles.alignmentBox} aria-label="Primer-template nucleotide alignment">
                <div className={sheetStyles.alignmentHeader}>
                  <span>
                    Hybridization on <strong>{doc.record.name}</strong> ({annealingInfo.coordText},{' '}
                    {primarySite.strand === 1 ? 'Top Strand ⇒' : 'Bottom Strand ⇐'})
                  </span>
                  {primarySite.tailLength > 0 ? (
                    <span>[5′ tail: {annealingInfo.tailSeq}]</span>
                  ) : (
                    <span>Full-length annealing (no 5′ overhang)</span>
                  )}
                </div>
                <div className={sheetStyles.alignmentLine}>
                  <span className={sheetStyles.alignmentLabel}>Primer 5′→3′</span>
                  <span className={sheetStyles.alignmentSeq}>
                    {'5′-'}
                    {primarySite.tailLength > 0 ? (
                      <span className={sheetStyles.tailBases} title={`5′ non-annealing tail: ${annealingInfo.tailSeq}`}>
                        {annealingInfo.tailSeq}
                      </span>
                    ) : null}
                    <span className={sheetStyles.annealedBases}>
                      {annealingInfo.annealedSeq.split('').map((base, idx) =>
                        annealingInfo.mismatchIndices.has(idx) ? (
                          <span key={idx} className={sheetStyles.mismatchBase} title="Mismatch with template">
                            {base}
                          </span>
                        ) : (
                          base
                        ),
                      )}
                    </span>
                    {'-3′'}
                  </span>
                </div>
                <div className={sheetStyles.alignmentLine}>
                  <span className={sheetStyles.alignmentLabel}>Pairing</span>
                  <span className={sheetStyles.pairingLine}>
                    {'   '}
                    {' '.repeat(primarySite.tailLength)}
                    {annealingInfo.pairingChars}
                  </span>
                </div>
                <div className={sheetStyles.alignmentLine}>
                  <span className={sheetStyles.alignmentLabel}>Template 3′←5′</span>
                  <span className={sheetStyles.templateLine}>
                    {' '.repeat(primarySite.tailLength)}
                    {'3′-'}
                    {annealingInfo.template3to5}
                    {'-5′'}
                    <span className={sheetStyles.coordTag}>({annealingInfo.coordText})</span>
                  </span>
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </Sheet>
  );
}
