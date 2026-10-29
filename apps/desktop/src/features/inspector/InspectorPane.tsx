/**
 * The inspector wired to the active document: selection statistics (GC, Tm for primer-length
 * selections, molecular weight, translation), the editable Feature card, a Primer card, and
 * quick actions for the selection.
 */
import type { Feature, PrimerBindingSite } from '@hhereditas/core';
import { analyzePrimer, dnaMolecularWeight, featureExtent, normalizeRange, tm as meltingTemperature, translate, translateFeature } from '@hhereditas/core';
import { Button, Disclosure, PropertyList, type PropertyItem } from '@hhereditas/ui';
import { ArrowLeftToLine, ArrowRightToLine, Pencil, Scissors, Tag, Trash2 } from 'lucide-react';
import { useMemo } from 'react';
import { Inspector, summarizeSequence, useSequenceIndex, type FeatureEdit, type SelectionSummary } from '../../shell';
import { selectedText, deleteFeatureCommand, deletePrimerCommand } from '../../app/commands';
import type { DocumentState } from '../../state/documents';
import { useApp } from '../../state/store';
import styles from './InspectorPane.module.css';

/** Tm is shown for selections up to this length (nearest-neighbour model range for oligos). */
export const TM_MAX_LENGTH = 60;
export const TM_MIN_LENGTH = 10;
const TRANSLATION_MAX = 3000;

export interface InspectorPaneProps {
  doc: DocumentState | null;
  summary: SelectionSummary | null;
  primerSites: readonly PrimerBindingSite[];
  primerFailures: readonly { primerId: string; message: string }[];
}

function applyFeatureEdit(f: Feature, edit: FeatureEdit): Feature {
  const next: Feature = { ...f };
  if (edit.name !== undefined) next.name = edit.name;
  if (edit.type !== undefined) next.type = edit.type;
  if (edit.strand !== undefined) next.strand = edit.strand;
  if (edit.color !== undefined) {
    if (edit.color === null) delete next.color;
    else next.color = edit.color;
  }
  if (edit.qualifiers !== undefined) next.qualifiers = edit.qualifiers;
  return next;
}

function editLabel(edit: FeatureEdit): string {
  if (edit.name !== undefined) return 'Rename Feature';
  if (edit.color !== undefined) return 'Feature Colour';
  if (edit.type !== undefined) return 'Feature Type';
  if (edit.strand !== undefined) return 'Feature Strand';
  return 'Edit Feature';
}

export function InspectorPane({ doc, summary, primerSites, primerFailures }: InspectorPaneProps) {
  const record = doc?.record ?? null;
  const index = useSequenceIndex(record?.seq);
  const composition = useMemo(() => (record ? summarizeSequence(record, index ?? undefined) : null), [record, index]);
  const text = summary?.hasBases && doc ? selectedText(doc) : null;
  const protein = record?.molecule === 'protein';

  // The selected CDS, when the selection is exactly its extent.
  const cdsFeature = useMemo(() => {
    const item = doc?.selectedItem;
    if (!record || !summary?.hasBases || item?.kind !== 'feature') return null;
    const f = record.features.find((x) => x.id === item.id);
    if (!f || f.type !== 'CDS') return null;
    const e = normalizeRange(featureExtent(f, record.seq.length, record.topology), record.seq.length, record.topology);
    return e.start === summary.range.start && e.end === summary.range.end ? f : null;
  }, [record, summary, doc?.selectedItem]);

  const tm = useMemo(() => {
    if (!text || protein || text.length < TM_MIN_LENGTH || text.length > TM_MAX_LENGTH) return null;
    try {
      const v = meltingTemperature(text);
      return Number.isFinite(v) ? v : null;
    } catch {
      return null;
    }
  }, [text, protein]);

  const details = useMemo<PropertyItem[]>(() => {
    if (!text || protein) return [];
    const items: PropertyItem[] = [];
    try {
      const mw = dnaMolecularWeight(text, { doubleStranded: true });
      if (Number.isFinite(mw)) {
        items.push({ label: 'MW', value: mw >= 1e6 ? `${(mw / 1e6).toFixed(2)} MDa` : `${(mw / 1e3).toFixed(1)} kDa`, title: 'Double-stranded, 5′-phosphate' });
      }
    } catch {
      // ambiguous bases: no weight
    }
    if (text.length >= 3 && text.length <= TRANSLATION_MAX) {
      try {
        // A selected CDS is translated as annotated (strand, codon start, table); other selections top strand, frame 1.
        const cds = cdsFeature && record ? translateFeature(record, cdsFeature) : null;
        const aa = cds ?? translate(text);
        items.push({
          label: 'Protein',
          value: aa,
          mono: true,
          maxLines: 4,
          copyValue: aa,
          title: cds ? `Translation of ${cdsFeature!.name}` : 'Translation of the top strand, frame 1',
        });
      } catch {
        // not translatable
      }
    }
    return items;
  }, [text, protein, cdsFeature, record]);

  const app = useApp.getState();
  const selectedItem = doc?.selectedItem ?? null;
  const feature = selectedItem?.kind === 'feature' ? (record?.features.find((f) => f.id === selectedItem.id) ?? null) : null;
  const primer = selectedItem?.kind === 'primer' ? (record?.primers.find((p) => p.id === selectedItem.id) ?? null) : null;

  return (
    <Inspector
      selection={summary}
      tm={tm}
      selectionDetails={details}
      sequenceComposition={composition}
      feature={feature}
      sequenceLength={record?.seq.length}
      topology={record?.topology}
      molecule={record?.molecule}
      onFeatureChange={(id, edit) =>
        app.change((r) => ({ ...r, features: r.features.map((f) => (f.id === id ? applyFeatureEdit(f, edit) : f)) }), editLabel(edit))
      }
      onZoomToFeature={(id) => {
        const f = record?.features.find((x) => x.id === id);
        if (f && record) app.selectItem({ kind: 'feature', id }, featureExtent(f, record.seq.length, record.topology), { zoom: true });
      }}
      onDeleteFeature={deleteFeatureCommand}
      analysisActions={
        record && !protein ? (
          <Button size="sm" icon={<Scissors />} onClick={() => app.openSheet('digest')}>
            Digest &amp; Gel…
          </Button>
        ) : undefined
      }
    >
      {primer ? <PrimerCard primerId={primer.id} name={primer.name} sequence={primer.sequence} sites={primerSites} failures={primerFailures} /> : null}
      {summary?.hasBases && !protein ? (
        <Disclosure title="Annotate">
          <div className={styles.actions}>
            <Button size="sm" icon={<Tag />} onClick={() => app.openSheet('add-feature')}>
              Add Feature…
            </Button>
            <Button size="sm" icon={<ArrowRightToLine />} onClick={() => app.openSheet('add-primer', { direction: 1 })}>
              Forward Primer…
            </Button>
            <Button size="sm" icon={<ArrowLeftToLine />} onClick={() => app.openSheet('add-primer', { direction: -1 })}>
              Reverse Primer…
            </Button>
          </div>
        </Disclosure>
      ) : null}
    </Inspector>
  );
}

function PrimerCard({
  primerId,
  name,
  sequence,
  sites,
  failures,
}: {
  primerId: string;
  name: string;
  sequence: string;
  sites: readonly PrimerBindingSite[];
  failures: readonly { primerId: string; message: string }[];
}) {
  const analysis = useMemo(() => {
    try {
      return analyzePrimer(sequence);
    } catch {
      return null;
    }
  }, [sequence]);
  const own = sites.filter((s) => s.primerId === primerId);
  const failure = failures.find((f) => f.primerId === primerId);
  const items: PropertyItem[] = [
    { label: 'Name', value: name },
    { label: 'Sequence', value: sequence, mono: true, maxLines: 3, copyValue: sequence },
    { label: 'Length', value: `${sequence.length} nt` },
  ];
  if (analysis) {
    items.push({ label: 'GC', value: `${(analysis.gc * 100).toFixed(1)} %` });
    if (Number.isFinite(analysis.tm)) items.push({ label: 'Tm', value: `${analysis.tm.toFixed(1)} °C` });
    if (analysis.hairpin?.found && analysis.hairpin.dG < -2) items.push({ label: 'Hairpin', value: `ΔG ${analysis.hairpin.dG.toFixed(1)} kcal/mol` });
    if (analysis.selfDimer?.found && analysis.selfDimer.dG < -5) items.push({ label: 'Self-dimer', value: `ΔG ${analysis.selfDimer.dG.toFixed(1)} kcal/mol` });
  }
  items.push({
    label: 'Binds',
    value: failure
      ? failure.message
      : own.length === 0
        ? 'No binding site'
        : own
            .slice(0, 4)
            .map((s) => `${s.strand === 1 ? '→' : '←'} ${(s.range.start + 1).toLocaleString('en-US')}..${s.range.end.toLocaleString('en-US')}`)
            .join(', ') + (own.length > 4 ? ` +${own.length - 4}` : ''),
    copyable: false,
  });
  return (
    <Disclosure title="Primer">
      <div className={styles.stack}>
        <PropertyList labelWidth={76} items={items} />
        <div className={styles.actions}>
          <Button size="sm" icon={<Pencil />} onClick={() => useApp.getState().openSheet('edit-primer', { primerId })}>
            Edit Primer…
          </Button>
          <Button size="sm" variant="destructive" icon={<Trash2 />} onClick={() => deletePrimerCommand(primerId)}>
            Delete Primer
          </Button>
        </div>
      </div>
    </Disclosure>
  );
}
