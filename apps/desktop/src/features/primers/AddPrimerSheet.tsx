/** Add a primer from the selection: forward (top-strand bases) or reverse (reverse complement). */
import { addPrimer, analyzePrimer, newId, normalizeDna, reverseComplement } from '@hhereditas/core';
import { Field, SegmentedControl, Sheet, TextField } from '@hhereditas/ui';
import { useEffect, useMemo, useState } from 'react';
import { selectedText } from '../../app/commands';
import type { DocumentState } from '../../state/documents';
import { useApp } from '../../state/store';
import styles from '../dialogs/forms.module.css';

/** Selections longer than this give a primer of PRIMER_LENGTH bases at the matching end. */
const MAX_PRIMER_FROM_SELECTION = 60;
const PRIMER_LENGTH = 20;

/** Primer for a selected template: forward = its first bases, reverse = reverse complement of its last bases. */
export function primerFromTemplate(template: string, direction: 1 | -1): string {
  const t = template.length > MAX_PRIMER_FROM_SELECTION ? (direction === 1 ? template.slice(0, PRIMER_LENGTH) : template.slice(-PRIMER_LENGTH)) : template;
  return direction === -1 ? reverseComplement(t) : t;
}

export function AddPrimerSheet({ open, doc, direction }: { open: boolean; doc: DocumentState | null; direction: 1 | -1 }) {
  const [dir, setDir] = useState<'1' | '-1'>('1');
  const [name, setName] = useState('');
  const [sequence, setSequence] = useState('');
  const template = open ? selectedText(doc) : null;

  useEffect(() => {
    if (!open || !doc) return;
    setDir(direction === -1 ? '-1' : '1');
    const n = doc.record.primers.length + 1;
    setName(`${doc.record.name}-${direction === -1 ? 'R' : 'F'}${n}`);
    setSequence(primerFromTemplate(selectedText(doc) ?? '', direction));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const changeDirection = (d: '1' | '-1') => {
    setDir(d);
    if (template) setSequence(primerFromTemplate(template, d === '-1' ? -1 : 1));
    setName((cur) => cur.replace(/-(F|R)(\d+)$/, `-${d === '-1' ? 'R' : 'F'}$2`));
  };

  const clean = normalizeDna(sequence);
  const analysis = useMemo(() => {
    if (clean.seq.length < 6 || clean.seq.length > 200) return null;
    try {
      return analyzePrimer(clean.seq);
    } catch {
      return null;
    }
  }, [clean.seq]);
  const invalid = clean.invalid.length > 0;
  const valid = clean.seq.length >= 6 && !invalid && name.trim().length > 0;

  const add = () => {
    if (!valid) return;
    const primer = { id: newId('p'), name: name.trim(), sequence: clean.seq };
    const app = useApp.getState();
    app.change((r) => addPrimer(r, primer), 'Add Primer');
    app.closeSheet();
    app.selectItem({ kind: 'primer', id: primer.id });
  };

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => {
        if (!o) useApp.getState().closeSheet();
      }}
      title="Add Primer"
      description={
        (template?.length ?? 0) > MAX_PRIMER_FROM_SELECTION
          ? `Uses the ${PRIMER_LENGTH} bases at the ${dir === '1' ? 'start' : 'end'} of the selection; edit the sequence to change it.`
          : 'The primer is stored with the sequence; its binding sites are shown on the map.'
      }
      primaryAction={{ label: 'Add Primer', onAction: add, disabled: !valid }}
      width={480}
    >
      <div className={styles.form}>
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
        <Field label="Name">
          <TextField value={name} onValueChange={setName} />
        </Field>
        <Field label="Sequence (5′→3′)" error={invalid ? `Not IUPAC DNA: ${clean.invalid.join(' ')}` : undefined}>
          <TextField mono value={sequence} onValueChange={setSequence} spellCheck={false} />
        </Field>
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
              {analysis.hairpin?.found && analysis.hairpin.dG < -2 ? <span className={styles.warning}>Hairpin ΔG {analysis.hairpin.dG.toFixed(1)}</span> : null}
              {analysis.selfDimer?.found && analysis.selfDimer.dG < -6 ? <span className={styles.warning}>Self-dimer ΔG {analysis.selfDimer.dG.toFixed(1)}</span> : null}
            </>
          ) : null}
        </p>
      </div>
    </Sheet>
  );
}
