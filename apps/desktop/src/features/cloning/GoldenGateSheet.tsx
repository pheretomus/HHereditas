/**
 * Golden Gate assembly: parts (donor plasmids or PCR products: open documents, selections or
 * files) cut with one Type IIS enzyme; the engine finds the order and orientation from the
 * overhangs. The preview shows the product, the order with each part's overhangs, and errors
 * such as palindromic or duplicated overhangs.
 */
import { findSites } from '@hhereditas/core';
import { Select, Sheet, Switch, Table, type TableColumn } from '@hhereditas/ui';
import { useEffect, useMemo, useState } from 'react';
import { enzymesByName } from '../../state/analysis';
import type { DocumentState } from '../../state/documents';
import { useApp } from '../../state/store';
import { formatBp } from './model/common';
import { newEntry, resolveEntries, type FragmentEntry } from './model/gibson';
import { GOLDEN_GATE_ENZYMES, goldenGateProductRecord, orderRows, runGoldenGate, type OrderRow } from './model/goldenGate';
import { FragmentList } from './FragmentList';
import { sourceOptions } from './MoleculePicker';
import { Issues, ProductPreview } from './ProductPreview';
import styles from './CloningSheet.module.css';

const columns: TableColumn<OrderRow>[] = [
  { key: 'position', header: '#', width: 36, align: 'end', mono: true },
  { key: 'name', header: 'Part' },
  { key: 'orientation', header: 'Orientation', width: 96, render: (r) => (r.orientation === 'forward' ? 'Forward' : 'Reverse') },
  { key: 'left', header: '5′ overhang', width: 96, mono: true },
  { key: 'right', header: '3′ overhang', width: 96, mono: true },
  { key: 'size', header: 'Fragment', width: 90, align: 'end', mono: true, render: (r) => formatBp(r.size) },
];

export function GoldenGateSheet({ open, doc }: { open: boolean; doc: DocumentState | null }) {
  const documents = useApp((s) => s.documents);
  const [entries, setEntries] = useState<FragmentEntry[]>([]);
  const [enzyme, setEnzyme] = useState('BsaI');
  const [circular, setCircular] = useState(true);

  // Start with every open document, the active one first (often the destination vector).
  useEffect(() => {
    if (!open || !doc) return;
    const all = useApp.getState().documents;
    const ordered = [doc, ...all.filter((d) => d.id !== doc.id)];
    setEntries(sourceOptions(ordered, { selections: false }).map((o) => newEntry(o.source)));
    setCircular(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const parts = useMemo(() => resolveEntries(documents, entries).filter((r): r is NonNullable<typeof r> => !!r), [documents, entries]);
  const result = useMemo(() => (open ? runGoldenGate({ parts, enzyme, circular }) : null), [open, parts, enzyme, circular]);
  const product = result?.product ?? null;
  const rows = useMemo(() => (result ? orderRows(result, parts) : []), [result, parts]);
  // Leftover sites of the enzyme would be recut: show them on the product.
  const sites = useMemo(() => (product ? findSites(product.seq, product.topology, enzymesByName([enzyme])) : []), [product, enzyme]);

  const close = () => useApp.getState().closeSheet();
  const create = () => {
    if (!result) return;
    const rec = goldenGateProductRecord(result, parts, enzyme);
    if (!rec) return;
    const app = useApp.getState();
    close();
    app.openRecords([rec]);
    app.flash(`Created ${rec.name} (${formatBp(rec.seq.length)})`);
  };

  const info = GOLDEN_GATE_ENZYMES.find((e) => e.name === enzyme);

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => {
        if (!o) close();
      }}
      title="Golden Gate Assembly"
      description="Parts are cut with a Type IIS enzyme and joined by their overhangs; the order is found automatically."
      width={920}
      primaryAction={{ label: 'Create Product', onAction: create, disabled: !product }}
    >
      {doc ? (
        <div className={styles.layout}>
          <div className={styles.inputs}>
            <div className={styles.group}>
              <h3 className={styles.groupTitle}>Enzyme</h3>
              <Select
                aria-label="Enzyme"
                size="sm"
                width="100%"
                value={enzyme}
                onValueChange={setEnzyme}
                options={GOLDEN_GATE_ENZYMES.map((e) => ({ value: e.name, label: e.name, textValue: e.name }))}
              />
              {info ? <p className={styles.stats}>{info.note}</p> : null}
            </div>
            <div className={styles.group}>
              <h3 className={styles.groupTitle}>Parts</h3>
              <FragmentList aria-label="Parts" documents={documents} entries={entries} onChange={setEntries} emptyText="No parts yet" addLabel="Add part" />
              <p className={styles.hint}>Order does not matter. Each part must release one fragment cut at both ends.</p>
            </div>
            <Switch label="Circular product" checked={circular} onCheckedChange={setCircular} />
          </div>
          <div className={styles.preview}>
            <ProductPreview
              product={product}
              enzymeSites={sites}
              emptyMessage={result?.error ? undefined : 'Add the parts: donor plasmids or PCR products with flanking sites.'}
            />
            {rows.length ? (
              <div className={styles.tableBox} style={{ height: Math.min(30 + rows.length * 24, 180) }}>
                <Table aria-label="Assembly order" columns={columns} rows={rows} rowKey={(r) => r.key} rowHeight={24} selectionMode="none" />
              </div>
            ) : null}
            <Issues error={result?.error} warnings={result?.warnings} />
          </div>
        </div>
      ) : null}
    </Sheet>
  );
}
