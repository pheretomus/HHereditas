/** Add a feature over the selected bases. */
import type { Strand } from '@hhereditas/core';
import { formatRange, makeFeature, normalizeRange } from '@hhereditas/core';
import { hasSelectedBases } from '@hhereditas/viewer';
import { Field, SegmentedControl, Select, Sheet, TextField } from '@hhereditas/ui';
import { useEffect, useState } from 'react';
import { featureTypeOptions } from '../../shell';
import type { DocumentState } from '../../state/documents';
import { useApp } from '../../state/store';
import styles from '../dialogs/forms.module.css';

export function AddFeatureSheet({ open, doc }: { open: boolean; doc: DocumentState | null }) {
  const [name, setName] = useState('');
  const [type, setType] = useState('misc_feature');
  const [strand, setStrand] = useState<'1' | '-1' | '0'>('1');

  useEffect(() => {
    if (!open) return;
    setName('');
    setType('misc_feature');
    setStrand('1');
  }, [open]);

  const sel = doc?.selection;
  const range = doc && hasSelectedBases(sel) ? normalizeRange(sel.range, doc.record.seq.length, doc.record.topology) : null;
  const valid = !!range && name.trim().length > 0;

  const add = () => {
    if (!valid || !range) return;
    const feature = makeFeature({ type, name: name.trim(), strand: Number(strand) as Strand, segments: [range] });
    const app = useApp.getState();
    app.change((r) => ({ ...r, features: [...r.features, feature] }), 'Add Feature');
    app.closeSheet();
    app.selectItem({ kind: 'feature', id: feature.id });
  };

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => {
        if (!o) useApp.getState().closeSheet();
      }}
      title="Add Feature"
      description={range && doc ? `Bases ${formatRange(range, doc.record.seq.length)} (${(range.end - range.start).toLocaleString('en-US')} bp)` : 'Select bases first.'}
      primaryAction={{ label: 'Add Feature', onAction: add, disabled: !valid }}
      width={440}
    >
      <div className={styles.form}>
        <Field label="Name">
          <TextField value={name} onValueChange={setName} placeholder="e.g. lacZα" />
        </Field>
        <div className={styles.row}>
          <Field label="Type">
            <Select value={type} onValueChange={setType} options={featureTypeOptions(type).map((o) => ({ value: o.value, label: o.label }))} width="100%" />
          </Field>
          <Field label="Strand">
            <SegmentedControl
              aria-label="Strand"
              fill
              value={strand}
              onValueChange={setStrand}
              options={[
                { value: '1', label: 'Forward' },
                { value: '-1', label: 'Reverse' },
                { value: '0', label: 'None' },
              ]}
            />
          </Field>
        </div>
      </div>
    </Sheet>
  );
}
