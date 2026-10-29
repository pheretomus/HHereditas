/**
 * SnapGene-style Sequence Properties, Methylation (Dam / Dcm / EcoKI),
 * Sticky Ends (AdditionalSequenceProperties), and Circular Origin Rotation ("Set Origin") dialog.
 *
 * Reconstructs SnapGene.exe sub_140292580 (Packet 0x00 / 0x08 AdditionalSequenceProperties & methylation)
 * and sub_1404c1820 (Set Origin / circular origin rotation).
 */
import type { EndKind, FragmentEnds, MoleculeType, SeqRecord, Topology } from '@hhereditas/core';
import {
  baseCounts,
  dnaMolecularWeight,
  gcContent,
  reverseComplementRecord,
  rotateOrigin,
  searchSequence,
  setTopology,
} from '@hhereditas/core';
import { Button, Checkbox, Field, SegmentedControl, Select, Sheet, TextField } from '@hhereditas/ui';
import { hasSelectedBases } from '@hhereditas/viewer';
import { Crosshair, FlipHorizontal2, RotateCw } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { DocumentState } from '../../state/documents';
import { useApp } from '../../state/store';
import styles from './forms.module.css';

export interface SequencePropertiesSheetProps {
  open: boolean;
  doc: DocumentState | null;
  initialTab?: 'properties' | 'methylation' | 'origin';
}

export function SequencePropertiesSheet({ open, doc, initialTab = 'properties' }: SequencePropertiesSheetProps) {
  const [tab, setTab] = useState<'properties' | 'methylation' | 'origin'>(initialTab);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [organism, setOrganism] = useState('');
  const [topology, setTopologyState] = useState<Topology>('circular');
  const [molecule, setMolecule] = useState<MoleculeType>('DNA');
  const [strandedness, setStrandedness] = useState<'double' | 'single'>('double');

  // Methylation flags (SnapGene Packet 0x00 bits 0x04 Dam, 0x08 Dcm, 0x10 EcoKI)
  const [dam, setDam] = useState(true);
  const [dcm, setDcm] = useState(true);
  const [ecoki, setEcoki] = useState(false);

  // Sticky ends & 5' phosphorylation (SnapGene Packet 0x08 <AdditionalSequenceProperties>)
  const [leftEndKind, setLeftEndKind] = useState<EndKind>('blunt');
  const [leftEndLen, setLeftEndLen] = useState('0');
  const [rightEndKind, setRightEndKind] = useState<EndKind>('blunt');
  const [rightEndLen, setRightEndLen] = useState('0');
  const [fivePrimePhosphorylated, setFivePrimePhosphorylated] = useState(true);

  // Circular Origin Rotation ("Set Origin")
  const [newOrigin1, setNewOrigin1] = useState('1');
  const [flipOnApply, setFlipOnApply] = useState(false);

  const seqLen = doc?.record.seq.length ?? 0;

  useEffect(() => {
    if (!open || !doc) return;
    setTab(initialTab);
    const rec = doc.record;
    const extras = rec.meta.extras ?? {};
    setName(rec.name);
    setDescription(rec.description ?? '');
    setOrganism(rec.meta.organism ?? '');
    setTopologyState(rec.topology);
    setMolecule(rec.molecule === 'RNA' ? 'RNA' : 'DNA');
    setStrandedness(extras.SingleStranded === '1' ? 'single' : 'double');

    setDam(extras.DamMethylated !== '0');
    setDcm(extras.DcmMethylated !== '0');
    setEcoki(extras.EcoKIMethylated === '1');

    setLeftEndKind(rec.ends?.left.kind ?? 'blunt');
    setLeftEndLen(String(rec.ends?.left.length ?? 0));
    setRightEndKind(rec.ends?.right.kind ?? 'blunt');
    setRightEndLen(String(rec.ends?.right.length ?? 0));
    setFivePrimePhosphorylated(extras.UpstreamModification !== 'Dephosphorylated');

    const sel = doc.selection;
    const caret0 = sel?.caret ?? 0;
    if (sel) {
      const pos0 = hasSelectedBases(sel)
        ? sel.range.start % Math.max(1, rec.seq.length)
        : caret0 % Math.max(1, rec.seq.length);
      setNewOrigin1(String(pos0 + 1));
    } else {
      setNewOrigin1('1');
    }
    setFlipOnApply(false);
  }, [open, doc, initialTab]);

  // Sequence statistics & methylation site counts
  const stats = useMemo(() => {
    if (!doc || seqLen === 0) return null;
    const seq = doc.record.seq;
    const gc = gcContent(seq) * 100;
    const counts = baseCounts(seq);
    let dsMwKda = 0;
    let ssMwKda = 0;
    try {
      dsMwKda =
        dnaMolecularWeight(seq, {
          doubleStranded: true,
          circular: topology === 'circular',
          molecule: molecule === 'RNA' ? 'RNA' : 'DNA',
        }) / 1000;
      ssMwKda =
        dnaMolecularWeight(seq, {
          doubleStranded: false,
          circular: topology === 'circular',
          molecule: molecule === 'RNA' ? 'RNA' : 'DNA',
        }) / 1000;
    } catch {
      // Ambiguous bases fallback
      dsMwKda = (seqLen * 617.96) / 1000;
      ssMwKda = (seqLen * 308.98) / 1000;
    }

    const damHits = searchSequence(seq, topology, 'GATC', { strands: 'top' }).length;
    const dcmHits = searchSequence(seq, topology, 'CCWGG', { strands: 'top' }).length;
    const ecokiHits = searchSequence(seq, topology, 'AACNNNNNNGTGC', { strands: 'both' }).length;

    return {
      gc,
      counts,
      dsMwKda,
      ssMwKda,
      damHits,
      dcmHits,
      ecokiHits,
    };
  }, [doc, seqLen, topology, molecule]);

  const parsedOrigin1 = Number(newOrigin1.replace(/,/g, '').trim());
  const originValid = Number.isInteger(parsedOrigin1) && parsedOrigin1 >= 1 && parsedOrigin1 <= Math.max(1, seqLen);

  const setOriginFromCaret = () => {
    if (!doc || seqLen === 0) return;
    const sel = doc.selection;
    const caret0 = sel?.caret ?? 0;
    const pos0 = hasSelectedBases(sel) ? sel.range.start % seqLen : caret0 % seqLen;
    setNewOrigin1(String(pos0 + 1));
  };

  const applyChanges = () => {
    if (!doc) return;
    const app = useApp.getState();

    app.change((rec) => {
      let updated: SeqRecord = {
        ...rec,
        name: name.trim() || rec.name,
        description: description.trim(),
        molecule,
        meta: {
          ...rec.meta,
          ...(organism.trim() ? { organism: organism.trim() } : {}),
          extras: {
            ...(rec.meta.extras ?? {}),
            DamMethylated: dam ? '1' : '0',
            DcmMethylated: dcm ? '1' : '0',
            EcoKIMethylated: ecoki ? '1' : '0',
            SingleStranded: strandedness === 'single' ? '1' : '0',
            UpstreamModification: fivePrimePhosphorylated ? "5'-Phosphate" : 'Dephosphorylated',
            DownstreamModification: fivePrimePhosphorylated ? "5'-Phosphate" : 'Dephosphorylated',
          },
        },
      };

      if (updated.topology !== topology) {
        updated = setTopology(updated, topology);
      }

      if (topology === 'linear') {
        const lLen = Math.max(0, Math.min(30, Number.parseInt(leftEndLen, 10) || 0));
        const rLen = Math.max(0, Math.min(30, Number.parseInt(rightEndLen, 10) || 0));
        const ends: FragmentEnds = {
          left: { kind: lLen === 0 ? 'blunt' : leftEndKind, length: leftEndKind === 'blunt' ? 0 : lLen },
          right: { kind: rLen === 0 ? 'blunt' : rightEndKind, length: rightEndKind === 'blunt' ? 0 : rLen },
        };
        updated = { ...updated, ends };
      }

      if (updated.topology === 'circular' && originValid && parsedOrigin1 !== 1 && seqLen > 0) {
        updated = rotateOrigin(updated, parsedOrigin1 - 1);
      }

      if (flipOnApply && seqLen > 0) {
        updated = reverseComplementRecord(updated);
      }

      return updated;
    }, tab === 'origin' ? 'Set Origin' : 'Edit Sequence Properties');

    app.closeSheet();
    app.flash(
      tab === 'origin' && parsedOrigin1 !== 1
        ? `Rotated circular origin to base ${parsedOrigin1.toLocaleString('en-US')}`
        : `Updated properties for ${name.trim() || doc.record.name}`,
    );
  };

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => {
        if (!o) useApp.getState().closeSheet();
      }}
      title="Sequence Properties, Methylation & Origin"
      description={
        doc
          ? `${doc.record.name} · ${seqLen.toLocaleString('en-US')} bp · ${topology === 'circular' ? 'Circular' : 'Linear'} ${strandedness === 'single' ? 'ss' : 'ds'}${molecule}`
          : 'Configure sequence topology, Dam/Dcm/EcoKI methylation, sticky overhangs, and origin coordinate.'
      }
      primaryAction={{
        label: 'Apply Properties',
        onAction: applyChanges,
        disabled: !doc || !originValid,
      }}
      width={540}
    >
      <div className={styles.form}>
        <SegmentedControl
          aria-label="Sequence Properties Section"
          fill
          value={tab}
          onValueChange={(v) => setTab(v as 'properties' | 'methylation' | 'origin')}
          options={[
            { value: 'properties', label: 'General & Topology' },
            { value: 'methylation', label: 'Methylation & Ends' },
            { value: 'origin', label: 'Set Origin & Flip' },
          ]}
        />

        {tab === 'properties' ? (
          <>
            <Field label="Sequence Name">
              <TextField value={name} onValueChange={setName} placeholder="Plasmid or sequence name" />
            </Field>
            <div className={styles.row}>
              <Field label="Topology">
                <SegmentedControl
                  aria-label="Topology"
                  fill
                  value={topology}
                  onValueChange={(v) => setTopologyState(v as Topology)}
                  options={[
                    { value: 'circular', label: '◯ Circular' },
                    { value: 'linear', label: '━ Linear' },
                  ]}
                />
              </Field>
              <Field label="Strandedness">
                <SegmentedControl
                  aria-label="Strandedness"
                  fill
                  value={strandedness}
                  onValueChange={(v) => setStrandedness(v as 'double' | 'single')}
                  options={[
                    { value: 'double', label: 'Double (ds)' },
                    { value: 'single', label: 'Single (ss)' },
                  ]}
                />
              </Field>
            </div>
            <div className={styles.row}>
              <Field label="Molecule Type">
                <Select
                  aria-label="Molecule Type"
                  value={molecule}
                  onValueChange={(v) => setMolecule(v as MoleculeType)}
                  options={[
                    { value: 'DNA', label: 'DNA (Deoxyribonucleic Acid)' },
                    { value: 'RNA', label: 'RNA (Ribonucleic Acid)' },
                  ]}
                  width="100%"
                />
              </Field>
              <Field label="Source Organism">
                <TextField
                  value={organism}
                  onValueChange={setOrganism}
                  placeholder="e.g. Escherichia coli, synthetic construct"
                />
              </Field>
            </div>
            <Field label="Description / Notes">
              <TextField
                value={description}
                onValueChange={setDescription}
                placeholder="Summary or cloning vector description"
              />
            </Field>

            {stats ? (
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
                <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', color: 'var(--hh-text-secondary)' }}>
                  Biophysical &amp; Base Composition Statistics
                </div>
                <p className={styles.stats} style={{ margin: 0 }}>
                  <span>
                    Length <strong>{seqLen.toLocaleString('en-US')} bp</strong>
                  </span>
                  <span>
                    GC <strong>{stats.gc.toFixed(1)}%</strong>
                  </span>
                  <span>
                    dsMW <strong>{stats.dsMwKda.toFixed(2)} kDa</strong>
                  </span>
                  <span>
                    ssMW <strong>{stats.ssMwKda.toFixed(2)} kDa</strong>
                  </span>
                </p>
                <p className={styles.stats} style={{ margin: 0, fontSize: 12 }}>
                  <span>
                    A: <strong>{(stats.counts.A ?? 0).toLocaleString('en-US')}</strong>
                  </span>
                  <span>
                    T/U: <strong>{((stats.counts.T ?? 0) + (stats.counts.U ?? 0)).toLocaleString('en-US')}</strong>
                  </span>
                  <span>
                    G: <strong>{(stats.counts.G ?? 0).toLocaleString('en-US')}</strong>
                  </span>
                  <span>
                    C: <strong>{(stats.counts.C ?? 0).toLocaleString('en-US')}</strong>
                  </span>
                </p>
              </div>
            ) : null}
          </>
        ) : null}

        {tab === 'methylation' ? (
          <>
            <div
              style={{
                padding: '10px 12px',
                borderRadius: 6,
                border: '1px solid var(--hh-border-subtle, rgba(128,128,128,0.22))',
                background: 'var(--hh-bg-subtle, rgba(128,128,128,0.05))',
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
              }}
            >
              <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', color: 'var(--hh-text-secondary)' }}>
                Host Methylation Status (SnapGene Dam / Dcm / EcoKI)
              </div>
              <Checkbox
                checked={dam}
                onCheckedChange={(c) => setDam(c === true)}
                label={`Dam methylase (G^m6ATC) — ${stats?.damHits ?? 0} recognition site${stats?.damHits === 1 ? '' : 's'} (enables DpnI; blocks BclI, ClaI, MboI, XbaI overlaps)`}
              />
              <Checkbox
                checked={dcm}
                onCheckedChange={(c) => setDcm(c === true)}
                label={`Dcm methylase (C^m5CWGG) — ${stats?.dcmHits ?? 0} recognition site${stats?.dcmHits === 1 ? '' : 's'} (blocks ApaI, AvaII, EcoO109I, StuI overlaps)`}
              />
              <Checkbox
                checked={ecoki}
                onCheckedChange={(c) => setEcoki(c === true)}
                label={`EcoKI methylase (AACN6GTGC / GCACN6GTT) — ${stats?.ecokiHits ?? 0} recognition site${stats?.ecokiHits === 1 ? '' : 's'}`}
              />
            </div>

            <div
              style={{
                padding: '10px 12px',
                borderRadius: 6,
                border: '1px solid var(--hh-border-subtle, rgba(128,128,128,0.22))',
                background: 'var(--hh-bg-subtle, rgba(128,128,128,0.05))',
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
              }}
            >
              <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', color: 'var(--hh-text-secondary)' }}>
                Linear Termini / Sticky Overhangs (AdditionalSequenceProperties)
              </div>
              {topology === 'circular' ? (
                <p className={styles.hint}>
                  Switch topology to <strong>Linear</strong> on the General tab to configure 5′/3′ sticky overhangs.
                </p>
              ) : null}
              <div className={styles.row}>
                <Field label="Left (Upstream) End Type">
                  <Select
                    aria-label="Left End Type"
                    value={leftEndKind}
                    onValueChange={(v) => setLeftEndKind(v as EndKind)}
                    disabled={topology === 'circular'}
                    options={[
                      { value: 'blunt', label: 'Blunt End' },
                      { value: '5prime', label: '5′ Protruding Overhang' },
                      { value: '3prime', label: '3′ Protruding Overhang' },
                    ]}
                    width="100%"
                  />
                </Field>
                <Field label="Left Overhang Length (nt)">
                  <TextField
                    mono
                    value={leftEndLen}
                    onValueChange={setLeftEndLen}
                    disabled={topology === 'circular' || leftEndKind === 'blunt'}
                  />
                </Field>
              </div>
              <div className={styles.row}>
                <Field label="Right (Downstream) End Type">
                  <Select
                    aria-label="Right End Type"
                    value={rightEndKind}
                    onValueChange={(v) => setRightEndKind(v as EndKind)}
                    disabled={topology === 'circular'}
                    options={[
                      { value: 'blunt', label: 'Blunt End' },
                      { value: '5prime', label: '5′ Protruding Overhang' },
                      { value: '3prime', label: '3′ Protruding Overhang' },
                    ]}
                    width="100%"
                  />
                </Field>
                <Field label="Right Overhang Length (nt)">
                  <TextField
                    mono
                    value={rightEndLen}
                    onValueChange={setRightEndLen}
                    disabled={topology === 'circular' || rightEndKind === 'blunt'}
                  />
                </Field>
              </div>
              <Checkbox
                checked={fivePrimePhosphorylated}
                onCheckedChange={(c) => setFivePrimePhosphorylated(c === true)}
                disabled={topology === 'circular'}
                label="5′ Ends Phosphorylated (required for T4 DNA Ligase ligation)"
              />
            </div>
          </>
        ) : null}

        {tab === 'origin' ? (
          <>
            <div
              style={{
                padding: '10px 12px',
                borderRadius: 6,
                border: '1px solid var(--hh-border-subtle, rgba(128,128,128,0.22))',
                background: 'var(--hh-bg-subtle, rgba(128,128,128,0.05))',
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
              }}
            >
              <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', color: 'var(--hh-text-secondary)' }}>
                Set Circular Origin (Rotate Base 1 Coordinate)
              </div>
              {topology !== 'circular' ? (
                <p className={styles.hint}>
                  Origin rotation applies to circular plasmids. Switch Topology to <strong>Circular</strong> to rotate base 1.
                </p>
              ) : (
                <p className={styles.hint}>
                  Rotates the circular sequence so the specified 1-based coordinate becomes base <strong>1</strong>. All
                  features and primers are automatically shifted across the new origin.
                </p>
              )}
              <div className={styles.row} style={{ alignItems: 'end' }}>
                <Field
                  label={`New Origin Position (1–${seqLen.toLocaleString('en-US')})`}
                  error={!originValid ? `Enter a base between 1 and ${seqLen.toLocaleString('en-US')}` : undefined}
                >
                  <TextField
                    mono
                    value={newOrigin1}
                    onValueChange={setNewOrigin1}
                    disabled={topology !== 'circular'}
                  />
                </Field>
                <Button
                  size="sm"
                  variant="default"
                  icon={<Crosshair />}
                  disabled={topology !== 'circular'}
                  onClick={setOriginFromCaret}
                >
                  Use Current Caret / Selection
                </Button>
              </div>
            </div>

            <div
              style={{
                padding: '10px 12px',
                borderRadius: 6,
                border: '1px solid var(--hh-border-subtle, rgba(128,128,128,0.22))',
                background: 'var(--hh-bg-subtle, rgba(128,128,128,0.05))',
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
              }}
            >
              <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', color: 'var(--hh-text-secondary)' }}>
                Flip Sequence (Reverse Complement Molecule)
              </div>
              <Checkbox
                checked={flipOnApply}
                onCheckedChange={(c) => setFlipOnApply(c === true)}
                label="Flip entire sequence (swap top & bottom strands and invert all feature/primer coordinates)"
              />
              <div style={{ display: 'flex', gap: 8 }}>
                <Button
                  size="sm"
                  variant="default"
                  icon={<FlipHorizontal2 />}
                  onClick={() => {
                    if (!doc) return;
                    const app = useApp.getState();
                    app.change((r) => reverseComplementRecord(r), 'Flip Sequence');
                    app.closeSheet();
                    app.flash(`Flipped sequence ${doc.record.name} (reverse complement)`);
                  }}
                >
                  Flip Sequence Immediately
                </Button>
                {topology === 'circular' && originValid && parsedOrigin1 !== 1 ? (
                  <Button
                    size="sm"
                    variant="default"
                    icon={<RotateCw />}
                    onClick={() => {
                      if (!doc) return;
                      const app = useApp.getState();
                      app.change((r) => rotateOrigin(r, parsedOrigin1 - 1), 'Set Origin');
                      app.closeSheet();
                      app.flash(`Set origin of ${doc.record.name} to base ${parsedOrigin1.toLocaleString('en-US')}`);
                    }}
                  >
                    Rotate Origin to {parsedOrigin1.toLocaleString('en-US')} Now
                  </Button>
                ) : null}
              </div>
            </div>
          </>
        ) : null}
      </div>
    </Sheet>
  );
}
