/**
 * Restriction cloning: the active document is the vector, the insert is another open document
 * (or its selection, or a file opened here). Choose one or two enzymes (with how often each cuts
 * the vector and the insert), optionally the fragments and the orientation; preview the
 * circular product with its junctions and create it.
 */
import type { SeqRecord } from '@hhereditas/core';
import { findSites } from '@hhereditas/core';
import { Checkbox, Disclosure, SearchField, SegmentedControl, Select, Sheet } from '@hhereditas/ui';
import { X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { enzymesByName } from '../../state/analysis';
import type { DocumentState } from '../../state/documents';
import { useApp } from '../../state/store';
import { formatBp, resolveSource, type MoleculeSource } from './model/common';
import {
  cloningEnzymes,
  fragmentChoices,
  junctionSummary,
  restrictionProductRecord,
  runRestriction,
  suggestEnzymes,
  type Orientation,
  type RestrictionInputs,
} from './model/restriction';
import { MoleculePicker, sourceOptions } from './MoleculePicker';
import { Issues, ProductPreview } from './ProductPreview';
import styles from './CloningSheet.module.css';

const MAX_ENZYMES = 2;

function cutsLabel(n: number): string {
  return n === 0 ? '—' : `${n}×`;
}

export function RestrictionSheet({ open, doc }: { open: boolean; doc: DocumentState | null }) {
  const documents = useApp((s) => s.documents);
  // The vector is the document that was active when the sheet opened (files opened here do not replace it).
  const [vectorId, setVectorId] = useState<string | null>(null);
  const [insert, setInsert] = useState<MoleculeSource | null>(null);
  const [enzymes, setEnzymes] = useState<string[]>([]);
  const [filter, setFilter] = useState('');
  const [vectorFragment, setVectorFragment] = useState<'largest' | number>('largest');
  const [insertFragment, setInsertFragment] = useState<'auto' | number>('auto');
  const [orientation, setOrientation] = useState<Orientation>('both');
  const [productIndex, setProductIndex] = useState(0);

  useEffect(() => {
    if (!open || !doc) return;
    setVectorId(doc.id);
    const first = sourceOptions(useApp.getState().documents, { exclude: doc.id, selections: false })[0];
    setInsert(first ? first.source : null);
    setFilter('');
    setOrientation('both');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const vectorDoc = documents.find((d) => d.id === vectorId) ?? null;
  const vector = vectorDoc?.record ?? null;
  // Keyed on the insert's document record: opening other files must not reset the choices.
  const insertDocRecord = insert ? documents.find((d) => d.id === insert.docId)?.record : undefined;
  const insertRecord: SeqRecord | null = useMemo(
    () => (open && insert && insertDocRecord ? resolveSource(documents, insert) : null),
    [open, insert, insertDocRecord], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const candidates = useMemo(() => (open && vector ? cloningEnzymes(vector, insertRecord) : []), [open, vector, insertRecord]);

  // A new insert: start from a suggested enzyme pair and the default fragments.
  useEffect(() => {
    if (!open || !vector) return;
    setEnzymes(insertRecord ? suggestEnzymes(vector, insertRecord, candidates) : []);
    setVectorFragment('largest');
    setInsertFragment('auto');
    setProductIndex(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, vector, insertRecord]);

  const toggle = (name: string, on: boolean) => {
    setEnzymes((cur) => (on ? [...cur.filter((n) => n !== name), name].slice(-MAX_ENZYMES) : cur.filter((n) => n !== name)));
    setVectorFragment('largest');
    setInsertFragment('auto');
    setProductIndex(0);
  };

  const inputs: RestrictionInputs | null =
    vector && insertRecord ? { vector, insert: insertRecord, enzymes, vectorFragment, insertFragment, orientation } : null;
  const result = useMemo(() => (inputs ? runRestriction(inputs) : null), [inputs?.vector, inputs?.insert, enzymes, vectorFragment, insertFragment, orientation]); // eslint-disable-line react-hooks/exhaustive-deps
  const count = result?.products.length ?? 0;
  const index = Math.min(productIndex, Math.max(0, count - 1));
  const product = result?.products[index] ?? null;
  const sites = useMemo(() => (product ? findSites(product.seq, product.topology, enzymesByName(enzymes)) : []), [product, enzymes]);

  const vectorFragments = useMemo(() => (vector ? fragmentChoices(vector, enzymes) : []), [vector, enzymes]);
  const insertFragments = useMemo(() => (insertRecord ? fragmentChoices(insertRecord, enzymes) : []), [insertRecord, enzymes]);

  const q = filter.trim().toLowerCase();
  const visible = q ? candidates.filter((c) => c.name.toLowerCase().includes(q)) : candidates;

  const close = () => useApp.getState().closeSheet();
  const create = () => {
    if (!inputs || !result) return;
    const rec = restrictionProductRecord(inputs, result, index);
    if (!rec) return;
    const app = useApp.getState();
    close();
    app.openRecords([rec]);
    app.flash(`Created ${rec.name} (${formatBp(rec.seq.length)})`);
  };

  const orientationOf = (i: number) => result?.details[i]?.orientation ?? 'forward';
  const emptyMessage = !insertRecord
    ? 'Choose an insert: another open document, a selection, or a file.'
    : enzymes.length === 0
      ? 'Choose one or two enzymes that cut both molecules.'
      : undefined;

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => {
        if (!o) close();
      }}
      title="Restriction Cloning"
      description={vector ? `Ligate an insert into ${vector.name} (${formatBp(vector.seq.length)}, ${vector.topology}) cut with the same enzymes.` : undefined}
      width={920}
      primaryAction={{ label: 'Create Product', onAction: create, disabled: !product }}
    >
      {vector && vectorDoc ? (
        <div className={styles.layout}>
          <div className={styles.inputs}>
            <div className={styles.group}>
              <h3 className={styles.groupTitle}>Insert</h3>
              <MoleculePicker aria-label="Insert" documents={documents} exclude={vectorDoc.id} value={insert} onChange={setInsert} placeholder="Choose the insert…" />
            </div>
            <div className={styles.group} style={{ flex: '1 1 auto', minHeight: 200 }}>
              <h3 className={styles.groupTitle}>Enzymes</h3>
              <div className={styles.chosen} aria-label="Chosen enzymes">
                {enzymes.length === 0 ? <span className={styles.hint}>Choose one or two.</span> : null}
                {enzymes.map((name) => (
                  <button key={name} type="button" className={styles.chip} onClick={() => toggle(name, false)} aria-label={`Remove ${name}`}>
                    {name}
                    <X aria-hidden />
                  </button>
                ))}
              </div>
              <SearchField size="sm" placeholder="Filter enzymes" aria-label="Filter enzymes" value={filter} onValueChange={setFilter} />
              <div className={styles.enzymeList} role="group" aria-label="Enzymes that cut the vector">
                <div className={styles.enzymeHeader} aria-hidden>
                  <span>Enzyme</span>
                  <span>Vector</span>
                  <span>Insert</span>
                </div>
                {visible.length === 0 ? <div className={styles.hint}>&nbsp;&nbsp;No enzyme found.</div> : null}
                {visible.map((c) => (
                  <div key={c.name} className={styles.enzymeOption}>
                    <Checkbox label={c.name} checked={enzymes.includes(c.name)} onCheckedChange={(v) => toggle(c.name, v === true)} />
                    <span className={styles.cuts} data-good={c.vectorCuts === 1} title={`${c.vectorCuts} cut${c.vectorCuts === 1 ? '' : 's'} in ${vector.name}`}>
                      {cutsLabel(c.vectorCuts)}
                    </span>
                    <span className={styles.cuts} data-none={c.insertCuts === 0} title={`${c.insertCuts} cut${c.insertCuts === 1 ? '' : 's'} in the insert`}>
                      {insertRecord ? cutsLabel(c.insertCuts) : ''}
                    </span>
                  </div>
                ))}
              </div>
            </div>
            <Disclosure title="Fragments and orientation" variant="plain" defaultOpen={false}>
              <div className={styles.group}>
                <div className={styles.row}>
                  <span className={styles.inlineLabel}>Vector</span>
                  <div className={styles.grow}>
                    <Select
                      aria-label="Vector fragment"
                      size="sm"
                      width="100%"
                      value={String(vectorFragment)}
                      onValueChange={(v) => setVectorFragment(v === 'largest' ? 'largest' : Number(v))}
                      options={[
                        { value: 'largest', label: 'Largest fragment' },
                        ...vectorFragments.map((f) => ({ value: String(f.index), label: f.label, textValue: f.label })),
                      ]}
                    />
                  </div>
                </div>
                <div className={styles.row}>
                  <span className={styles.inlineLabel}>Insert</span>
                  <div className={styles.grow}>
                    <Select
                      aria-label="Insert fragment"
                      size="sm"
                      width="100%"
                      value={String(insertFragment)}
                      onValueChange={(v) => setInsertFragment(v === 'auto' ? 'auto' : Number(v))}
                      options={[
                        { value: 'auto', label: 'Fragment that fits' },
                        ...insertFragments.map((f) => ({ value: String(f.index), label: f.label, textValue: f.label })),
                      ]}
                    />
                  </div>
                </div>
                <SegmentedControl
                  aria-label="Orientation"
                  size="sm"
                  fill
                  value={orientation}
                  onValueChange={(v) => {
                    setOrientation(v);
                    setProductIndex(0);
                  }}
                  options={[
                    { value: 'both', label: 'Any' },
                    { value: 'forward', label: 'Forward' },
                    { value: 'reverse', label: 'Reverse' },
                  ]}
                />
              </div>
            </Disclosure>
          </div>
          <div className={styles.preview}>
            <ProductPreview
              product={product}
              enzymeSites={sites}
              emptyMessage={result?.error ? undefined : emptyMessage}
              headerAccessory={
                count > 1 ? (
                  <SegmentedControl
                    aria-label="Product orientation"
                    size="sm"
                    value={String(index)}
                    onValueChange={(v) => setProductIndex(Number(v))}
                    options={result!.products.map((_, i) => ({ value: String(i), label: orientationOf(i) === 'forward' ? 'Forward' : 'Reverse' }))}
                  />
                ) : null
              }
            />
            {product && result ? (
              <p className={styles.stats} data-testid="junctions">
                <span>
                  Insert <strong>{orientationOf(index)}</strong>
                </span>
                <span>
                  Junctions <strong>{junctionSummary(result, index)}</strong>
                </span>
              </p>
            ) : null}
            <Issues error={result?.error} warnings={result?.warnings} />
          </div>
        </div>
      ) : null}
    </Sheet>
  );
}
