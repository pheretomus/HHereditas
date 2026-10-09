/**
 * Gibson assembly. Two ways in:
 *  - Design primers: insert fragments into the active (circular) document at its selection; the
 *    primers that give every fragment its overlaps are designed and checked by simulation.
 *  - Join fragments: assemble fragments that already share terminal overlaps, in the given order.
 * The preview shows the product and its junctions (overlap, Tm, GC), the designed primers (with
 * a copyable order list) and NEBuilder-style DNA amounts.
 */
import type { AssemblyJunction, Primer, SeqRecord } from '@hhereditas/core';
import { addPrimer, GIBSON_OVERLAP_TM_RANGE } from '@hhereditas/core';
import { Button, Checkbox, NumberField, SegmentedControl, Select, Sheet, Switch, Table, type TableColumn } from '@hhereditas/ui';
import { Copy } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { DocumentState } from '../../state/documents';
import { useApp } from '../../state/store';
import { formatBp, formatRange, selectionRange } from './model/common';
import {
  amountsFor,
  assemblyProductRecord,
  DEFAULT_OVERLAP,
  designProductRecord,
  likelyVector,
  MIN_OVERLAP,
  newEntry,
  primerOrderList,
  primersForTemplates,
  resolveEntries,
  runAssembly,
  runDesign,
  type FragmentEntry,
} from './model/gibson';
import { FragmentList } from './FragmentList';
import { sourceOptions } from './MoleculePicker';
import { Issues, ProductPreview } from './ProductPreview';
import styles from './CloningSheet.module.css';

type Mode = 'design' | 'join';
type Panel = 'product' | 'primers' | 'amounts';

function fmt(n: number, digits: number): string {
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }) : '—';
}

function JunctionTable({ junctions, names }: { junctions: readonly AssemblyJunction[]; names: readonly string[] }) {
  const columns: TableColumn<AssemblyJunction & { key: string }>[] = [
    { key: 'j', header: 'Junction', render: (j) => `${names[j.leftFragment] ?? j.leftFragment + 1} → ${names[j.rightFragment] ?? j.rightFragment + 1}` },
    { key: 'len', header: 'Overlap', width: 70, align: 'end', mono: true, render: (j) => `${j.overlapLength} bp` },
    {
      key: 'tm',
      header: 'Tm',
      width: 70,
      align: 'end',
      mono: true,
      render: (j) => {
        const off = Number.isFinite(j.tm) && (j.tm < GIBSON_OVERLAP_TM_RANGE.min || j.tm > GIBSON_OVERLAP_TM_RANGE.max);
        return <span className={off ? styles.problem : undefined}>{fmt(j.tm, 1)} °C</span>;
      },
    },
    { key: 'gc', header: 'GC', width: 56, align: 'end', mono: true, render: (j) => `${Math.round(j.gc * 100)} %` },
    { key: 'seq', header: 'Overlap sequence', mono: true, render: (j) => <span title={j.overlapSeq}>{j.overlapSeq}</span> },
  ];
  const rows = junctions.map((j, i) => ({ ...j, key: String(i) }));
  return (
    <div className={styles.tableBox} style={{ height: Math.min(30 + rows.length * 24, 150) }}>
      <Table aria-label="Junctions" columns={columns} rows={rows} rowKey={(r) => r.key} rowHeight={24} selectionMode="none" />
    </div>
  );
}

function PrimerTable({ primers }: { primers: readonly Primer[] }) {
  const columns: TableColumn<Primer>[] = [
    { key: 'name', header: 'Name', width: 150 },
    { key: 'sequence', header: 'Sequence (5′→3′)', mono: true, render: (p) => <span title={p.description}>{p.sequence}</span> },
    { key: 'length', header: 'Length', width: 64, align: 'end', mono: true, render: (p) => `${p.sequence.length}` },
  ];
  return (
    <div className={styles.tableBox} style={{ height: Math.min(30 + primers.length * 24, 320) }}>
      <Table aria-label="Designed primers" columns={columns} rows={primers} rowKey={(p) => p.id} rowHeight={24} selectionMode="none" />
    </div>
  );
}

export function GibsonSheet({ open, doc }: { open: boolean; doc: DocumentState | null }) {
  const documents = useApp((s) => s.documents);
  const [vectorId, setVectorId] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>('design');
  const [panel, setPanel] = useState<Panel>('product');
  const [entries, setEntries] = useState<FragmentEntry[]>([]);
  const [overlap, setOverlap] = useState<number | null>(DEFAULT_OVERLAP);
  const [minOverlap, setMinOverlap] = useState<number | null>(MIN_OVERLAP);
  const [circular, setCircular] = useState(true);
  const [addPrimers, setAddPrimers] = useState(true);
  const [vectorNg, setVectorNg] = useState<number | null>(null);
  const [ratio, setRatio] = useState<number | null>(null);
  const [amountVector, setAmountVector] = useState<number | null>(null);

  useEffect(() => {
    if (!open || !doc) return;
    setVectorId(doc.id);
    const design = doc.record.topology === 'circular';
    setMode(design ? 'design' : 'join');
    setPanel('product');
    // Start with the first other document (its selection when it has one).
    const others = sourceOptions(useApp.getState().documents, { exclude: doc.id });
    const pick = others.find((o) => o.source.range) ?? others[0];
    setEntries(design && pick ? [newEntry(pick.source)] : []);
    setAmountVector(null);
    setVectorNg(null);
    setRatio(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const vectorDoc = documents.find((d) => d.id === vectorId) ?? null;
  const vector = vectorDoc?.record ?? null;
  // The insertion site: the vector's selection (replaced) or its caret (insert there).
  const insertion = useMemo(() => {
    if (!vectorDoc) return null;
    const r = selectionRange(vectorDoc);
    if (r) return r;
    const caret = vectorDoc.selection?.caret ?? 0;
    return { start: caret, end: caret };
  }, [vectorDoc]);

  const records = useMemo(() => resolveEntries(documents, entries), [documents, entries]);
  const fragments = useMemo(() => records.filter((r): r is SeqRecord => !!r), [records]);

  const ov = overlap ?? DEFAULT_OVERLAP;
  const minOv = minOverlap ?? MIN_OVERLAP;
  const design = useMemo(
    () => (open && mode === 'design' && vector && insertion ? runDesign({ vector, insertion, inserts: fragments, overlapLength: ov }) : null),
    [open, mode, vector, insertion, fragments, ov],
  );
  const assembly = useMemo(() => (open && mode === 'join' ? runAssembly({ fragments, minOverlap: minOv, circular }) : null), [open, mode, fragments, minOv, circular]);
  const outcome = mode === 'design' ? design : assembly;
  const product = outcome?.product ?? null;

  // Fragments as they go into the tube: designed PCR products, or the given fragments.
  const tubeFragments = mode === 'design' ? (design?.fragments ?? []) : fragments;
  const tubeNames = tubeFragments.map((f) => f.name.replace(/ PCR \(Gibson\)$/, ''));
  const amountRows = tubeFragments.map((f, i) => ({ name: tubeNames[i], lengthBp: f.seq.length }));
  const vIndex = mode === 'design' ? 0 : Math.min(amountVector ?? likelyVector(amountRows), Math.max(0, amountRows.length - 1));
  const amounts = useMemo(
    () => amountsFor({ fragments: amountRows, vectorIndex: vIndex, vectorNg, ratio }),
    [JSON.stringify(amountRows), vIndex, vectorNg, ratio], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const close = () => useApp.getState().closeSheet();
  const create = () => {
    const app = useApp.getState();
    if (mode === 'design' && design && vector && vectorDoc) {
      const rec = designProductRecord(design, vector, fragments);
      if (!rec) return;
      if (addPrimers) {
        const insertDocs = entries.filter((_, i) => records[i]).map((e) => e.docId);
        for (const { docId, primers } of primersForTemplates(design, vectorDoc.id, insertDocs, documents)) {
          app.activate(docId);
          app.change((r) => primers.reduce((acc, p) => addPrimer(acc, p), r), 'Add Gibson Primers');
        }
      }
      close();
      app.openRecords([rec]);
      app.flash(`Created ${rec.name} (${formatBp(rec.seq.length)})`);
    } else if (mode === 'join' && assembly) {
      const rec = assemblyProductRecord(assembly, fragments);
      if (!rec) return;
      close();
      app.openRecords([rec]);
      app.flash(`Created ${rec.name} (${formatBp(rec.seq.length)})`);
    }
  };

  const copyOrderList = async () => {
    if (!design) return;
    try {
      await navigator.clipboard.writeText(primerOrderList(design.primers));
      useApp.getState().flash(`Copied ${design.primers.length} primers`);
    } catch {
      useApp.getState().flash('Could not copy to the clipboard', 'error');
    }
  };

  const L = vector?.seq.length ?? 0;
  const insertionText =
    insertion && vector
      ? insertion.end > insertion.start
        ? `replaces ${formatRange(insertion, L)} (${formatBp(insertion.end - insertion.start)})`
        : `inserts after base ${insertion.start.toLocaleString('en-US')}`
      : '';

  const emptyMessage =
    mode === 'design'
      ? fragments.length === 0
        ? 'Add the fragments to insert: open documents, their selections, or files.'
        : undefined
      : fragments.length < 2 && !(fragments.length === 1 && circular)
        ? 'Add the fragments in assembly order. Neighbours must share their end sequences.'
        : undefined;

  const panels = [
    { value: 'product' as const, label: 'Product' },
    ...(mode === 'design' ? [{ value: 'primers' as const, label: `Primers${design?.primers.length ? ` (${design.primers.length})` : ''}` }] : []),
    { value: 'amounts' as const, label: 'DNA Amounts' },
  ];
  const shownPanel = panels.some((p) => p.value === panel) ? panel : 'product';

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => {
        if (!o) close();
      }}
      title="Gibson Assembly"
      description={
        mode === 'design' && vector
          ? `Insert fragments into ${vector.name}: primers add the overlaps.`
          : 'Join fragments that share terminal overlaps (e.g. PCR products made with overlap primers).'
      }
      width={980}
      primaryAction={{ label: 'Create Product', onAction: create, disabled: !product }}
      footerStart={
        mode === 'design' ? (
          <Checkbox label="Add the primers to the template documents" checked={addPrimers} onCheckedChange={(v) => setAddPrimers(v === true)} />
        ) : null
      }
    >
      {vector && vectorDoc ? (
        <div className={styles.layout}>
          <div className={styles.inputs}>
            <SegmentedControl
              aria-label="Mode"
              fill
              size="sm"
              value={mode}
              onValueChange={setMode}
              options={[
                { value: 'design', label: 'Design Primers', disabled: vector.topology !== 'circular', tooltip: vector.topology !== 'circular' ? 'Needs a circular vector' : undefined },
                { value: 'join', label: 'Join Fragments' },
              ]}
            />
            {mode === 'design' ? (
              <div className={styles.group}>
                <h3 className={styles.groupTitle}>Vector</h3>
                <p className={styles.hint}>
                  <strong>{vector.name}</strong> · {insertionText}
                  <br />
                  Select a region of the vector before opening this sheet to replace it.
                </p>
              </div>
            ) : null}
            <div className={styles.group}>
              <h3 className={styles.groupTitle}>{mode === 'design' ? 'Inserts, in order' : 'Fragments, in order'}</h3>
              <FragmentList
                aria-label={mode === 'design' ? 'Inserts' : 'Fragments'}
                documents={documents}
                entries={entries}
                onChange={setEntries}
                allowReverse
                emptyText={mode === 'design' ? 'No inserts yet' : 'No fragments yet'}
                addLabel={mode === 'design' ? 'Add insert' : 'Add fragment'}
              />
            </div>
            <div className={styles.group}>
              <div className={styles.row}>
                <span className={styles.inlineLabel} style={{ width: 'auto', flex: '1 1 auto', whiteSpace: 'nowrap' }}>
                  {mode === 'design' ? 'Overlap length' : 'Minimum overlap'}
                </span>
                {mode === 'design' ? (
                  <NumberField size="sm" width={96} aria-label="Overlap length" value={overlap} onValueChange={setOverlap} min={15} max={60} step={1} unit="bp" />
                ) : (
                  <NumberField size="sm" width={96} aria-label="Minimum overlap" value={minOverlap} onValueChange={setMinOverlap} min={10} max={60} step={1} unit="bp" />
                )}
              </div>
              {mode === 'join' ? <Switch label="Circular product" checked={circular} onCheckedChange={setCircular} /> : null}
            </div>
          </div>
          <div className={styles.preview}>
            <SegmentedControl aria-label="Preview" size="sm" value={shownPanel} onValueChange={setPanel} options={panels} />
            {shownPanel === 'product' ? (
              <>
                <ProductPreview product={product} emptyMessage={outcome?.error ? undefined : emptyMessage} />
                {outcome && outcome.junctions.length ? (
                  <JunctionTable junctions={outcome.junctions} names={mode === 'design' ? tubeNames : fragments.map((f) => f.name)} />
                ) : null}
              </>
            ) : null}
            {shownPanel === 'primers' ? (
              design && design.primers.length ? (
                <>
                  <div className={styles.copyRow}>
                    <p className={styles.hint}>Each primer is an overlap tail followed by the annealing part (target Tm 60 °C).</p>
                    <Button size="sm" icon={<Copy />} onClick={() => void copyOrderList()}>
                      Copy Order List
                    </Button>
                  </div>
                  <PrimerTable primers={design.primers} />
                </>
              ) : (
                <p className={styles.hint}>Primers appear here once the design works.</p>
              )
            ) : null}
            {shownPanel === 'amounts' ? (
              amounts.amounts ? (
                <>
                  <div className={styles.amountGrid}>
                    <span className={styles.hint}>Vector amount</span>
                    <NumberField size="sm" aria-label="Vector amount" value={vectorNg ?? Number(amounts.amounts.rows[0].ng.toFixed(1))} onValueChange={setVectorNg} min={1} max={1000} step={5} precision={1} unit="ng" />
                    <span className={styles.hint}>Insert : vector</span>
                    <NumberField
                      size="sm"
                      aria-label="Insert to vector ratio"
                      value={ratio ?? (amounts.amounts.rows[1]?.ratio ?? 2)}
                      onValueChange={setRatio}
                      min={0.5}
                      max={20}
                      step={0.5}
                      precision={1}
                      unit=": 1"
                    />
                    {mode === 'join' ? (
                      <>
                        <span className={styles.hint}>Vector</span>
                        <div style={{ gridColumn: 'span 3' }}>
                          <Select
                            aria-label="Vector fragment"
                            size="sm"
                            width="100%"
                            value={String(vIndex)}
                            onValueChange={(v) => setAmountVector(Number(v))}
                            options={amountRows.map((r, i) => ({ value: String(i), label: `${r.name} · ${formatBp(r.lengthBp)}`, textValue: r.name }))}
                          />
                        </div>
                      </>
                    ) : null}
                  </div>
                  <div className={styles.tableBox} style={{ height: Math.min(30 + amounts.amounts.rows.length * 24, 320) }}>
                    <Table
                      aria-label="DNA amounts"
                      rowHeight={24}
                      selectionMode="none"
                      rows={amounts.amounts.rows.map((r, i) => ({ ...r, key: String(i) }))}
                      rowKey={(r) => r.key}
                      columns={[
                        { key: 'name', header: 'Fragment' },
                        { key: 'role', header: 'Role', width: 70, render: (r) => (r.role === 'vector' ? 'Vector' : 'Insert') },
                        { key: 'len', header: 'Length', width: 90, align: 'end', mono: true, render: (r) => formatBp(r.lengthBp) },
                        { key: 'ratio', header: 'Ratio', width: 56, align: 'end', mono: true, render: (r) => `${fmt(r.ratio, r.ratio % 1 ? 1 : 0)}×` },
                        { key: 'ng', header: 'Mass', width: 80, align: 'end', mono: true, render: (r) => `${fmt(r.ng, 1)} ng` },
                        { key: 'pmol', header: 'Amount', width: 96, align: 'end', mono: true, render: (r) => `${fmt(r.pmol, 3)} pmol` },
                      ]}
                    />
                  </div>
                  <p className={styles.stats}>
                    <span>
                      Total <strong>{fmt(amounts.amounts.totalPmol, 3)} pmol</strong>
                    </span>
                    <span>
                      NEBuilder recommends{' '}
                      <strong>
                        {amounts.amounts.recommendedTotalPmol.min}–{amounts.amounts.recommendedTotalPmol.max} pmol
                      </strong>{' '}
                      in total
                    </span>
                  </p>
                  <Issues warnings={amounts.amounts.warnings} />
                </>
              ) : (
                <p className={styles.hint}>{amounts.error ?? 'Amounts appear once there are at least two fragments.'}</p>
              )
            ) : null}
            {shownPanel !== 'amounts' ? <Issues error={outcome?.error} warnings={outcome?.warnings} /> : null}
          </div>
        </div>
      ) : null}
    </Sheet>
  );
}
