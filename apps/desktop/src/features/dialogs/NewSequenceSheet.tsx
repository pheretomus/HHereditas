/** New sequence: name, topology and (optionally) pasted bases. */
import type { Topology } from '@hhereditas/core';
import { normalizeDna } from '@hhereditas/core';
import { Field, SegmentedControl, Sheet, TextField } from '@hhereditas/ui';
import { useEffect, useState } from 'react';
import { useApp } from '../../state/store';
import styles from './forms.module.css';

export function NewSequenceSheet({ open }: { open: boolean }) {
  const [name, setName] = useState('Untitled');
  const [topology, setTopology] = useState<Topology>('circular');
  const [text, setText] = useState('');

  useEffect(() => {
    if (!open) return;
    setName('Untitled');
    setTopology('circular');
    setText('');
  }, [open]);

  // FASTA headers are allowed: everything after a '>' line is the sequence.
  const body = text.replace(/^>.*$/gm, '');
  const clean = normalizeDna(body);
  const invalid = clean.invalid.length > 0;

  const create = () => {
    if (invalid) return;
    const app = useApp.getState();
    app.newSequence({ name: name.trim() || 'Untitled', seq: clean.seq, topology });
    app.closeSheet();
  };

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => {
        if (!o) useApp.getState().closeSheet();
      }}
      title="New Sequence"
      description="Paste DNA (plain or FASTA) or start empty and type in the sequence view."
      primaryAction={{ label: 'Create', onAction: create, disabled: invalid }}
      width={520}
    >
      <div className={styles.form}>
        <div className={styles.row}>
          <Field label="Name">
            <TextField value={name} onValueChange={setName} />
          </Field>
          <Field label="Topology">
            <SegmentedControl
              aria-label="Topology"
              fill
              value={topology}
              onValueChange={setTopology}
              options={[
                { value: 'circular', label: 'Circular' },
                { value: 'linear', label: 'Linear' },
              ]}
            />
          </Field>
        </div>
        <Field label="Sequence" error={invalid ? `Not IUPAC DNA: ${clean.invalid.slice(0, 8).join(' ')}` : undefined}>
          <textarea
            className={styles.textarea}
            value={text}
            onChange={(e) => setText(e.target.value)}
            spellCheck={false}
            placeholder="ATGC…"
            aria-label="Sequence"
          />
        </Field>
        <p className={styles.hint}>{clean.seq.length.toLocaleString('en-US')} bp</p>
      </div>
    </Sheet>
  );
}
