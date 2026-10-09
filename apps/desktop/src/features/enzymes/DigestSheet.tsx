/**
 * Digest & gel sheet: choose enzymes (those that cut the sequence, searchable), see the
 * fragments and a virtual agarose gel next to a ladder, open a fragment as a new document.
 */
import { LADDERS, getLadder } from '@hhereditas/core';
import { Badge, Banner, Button, Checkbox, NumberField, SearchField, Select, Sheet, Table, type TableColumn } from '@hhereditas/ui';
import { GelView } from '@hhereditas/viewer';
import { FilePlus2, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { openAsNewDocument } from '../../app/commands';
import type { DocumentState } from '../../state/documents';
import { useApp } from '../../state/store';
import { digestCandidates, fragmentRecord, gelLanes, runDigest, type FragmentRow } from './digest';
import styles from './DigestSheet.module.css';

const DEFAULT_LADDER = 'neb-1kb-plus';

export interface DigestSheetProps {
  open: boolean;
  doc: DocumentState | null;
  /** Enzymes chosen when the sheet opens (e.g. from a context menu), else the selected enzyme. */
  initialEnzymes?: readonly string[];
}

export function DigestSheet({ open, doc, initialEnzymes }: DigestSheetProps) {
  const record = doc?.record ?? null;
  const candidates = useMemo(() => (open && record ? digestCandidates(record) : []), [open, record]);
  const [chosen, setChosen] = useState<string[]>([]);
  const [filter, setFilter] = useState('');
  const [ladderId, setLadderId] = useState(DEFAULT_LADDER);
  const [agarose, setAgarose] = useState<number | null>(1);
  const [selectedRow, setSelectedRow] = useState<string | null>(null);

  // Start from the requested enzymes, the selected enzyme, or the first unique cutter.
  useEffect(() => {
    if (!open) return;
    const fromItem = doc?.selectedItem?.kind === 'enzyme' ? [doc.selectedItem.id] : [];
    const start = initialEnzymes?.length ? [...initialEnzymes] : fromItem.length ? fromItem : candidates.slice(0, 1).map((c) => c.name);
    setChosen(start);
    setFilter('');
    setSelectedRow(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const result = useMemo(() => (record ? runDigest(record, chosen) : { rows: [], warnings: [] }), [record, chosen]);
  const ladder = getLadder(ladderId) ?? LADDERS[0];
  const pct = agarose ?? 1;
  const lanes = useMemo(() => (record ? gelLanes(record, chosen, ladder, pct) : []), [record, chosen, ladder, pct]);

  const q = filter.trim().toLowerCase();
  const visible = useMemo(() => (q ? candidates.filter((c) => c.name.toLowerCase().includes(q)) : candidates), [candidates, q]);
  const toggle = (name: string, on: boolean) => setChosen((cur) => (on ? [...cur.filter((n) => n !== name), name] : cur.filter((n) => n !== name)));

  const columns: TableColumn<FragmentRow>[] = [
    { key: 'index', header: '#', width: 36, align: 'end', mono: true },
    { key: 'size', header: 'Size', width: 92, align: 'end', mono: true, sortable: true, render: (r) => `${r.size.toLocaleString('en-US')} bp` },
    { key: 'ends', header: 'Ends', render: (r) => `${r.left} – ${r.right}`, sortValue: (r) => `${r.left} ${r.right}` },
    { key: 'range', header: 'Position', width: 130, align: 'end', mono: true, render: (r) => `${r.first.toLocaleString('en-US')}..${r.last.toLocaleString('en-US')}` },
  ];

  const row = result.rows.find((r) => r.key === selectedRow) ?? null;
  const openFragment = (r: FragmentRow | null) => {
    if (!r || !record) return;
    openAsNewDocument(fragmentRecord(record, r));
    useApp.getState().closeSheet();
  };

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => {
        if (!o) useApp.getState().closeSheet();
      }}
      title="Digest & Gel"
      description={record ? `Simulated restriction digest of ${record.name}` : undefined}
      width={860}
      primaryAction={{ label: 'Done', onAction: () => useApp.getState().closeSheet() }}
      secondaryAction={null}
      footerStart={
        <Button icon={<FilePlus2 />} disabled={!row} onClick={() => openFragment(row)}>
          Open Fragment
        </Button>
      }
    >
      <div className={styles.layout}>
        <section className={styles.enzymes} aria-label="Enzymes">
          <SearchField placeholder="Filter enzymes" aria-label="Filter enzymes" value={filter} onValueChange={setFilter} />
          <div className={styles.chosen} aria-label="Chosen enzymes">
            {chosen.length === 0 ? <span className={styles.hint}>Choose one or more enzymes.</span> : null}
            {chosen.map((name) => (
              <button key={name} type="button" className={styles.chip} onClick={() => toggle(name, false)} aria-label={`Remove ${name}`}>
                {name}
                <X aria-hidden />
              </button>
            ))}
          </div>
          <div className={styles.list} role="group" aria-label="Enzymes that cut">
            {visible.length === 0 ? <div className={styles.hint}>No enzyme found.</div> : null}
            {visible.map((c) => (
              <div key={c.name} className={styles.option}>
                <Checkbox label={c.name} checked={chosen.includes(c.name)} onCheckedChange={(v) => toggle(c.name, v === true)} />
                <Badge size="sm" tone={c.cuts === 1 ? 'accent' : 'neutral'}>
                  {c.cuts === 1 ? '1 cut' : `${c.cuts} cuts`}
                </Badge>
              </div>
            ))}
          </div>
        </section>
        <section className={styles.results}>
          <div className={styles.gelRow}>
            <div className={styles.gel}>
              <GelView lanes={lanes} agarosePercent={pct} showSizes="ladder" />
            </div>
            <div className={styles.gelOptions}>
              <label className={styles.optionLabel}>
                Ladder
                <Select
                  aria-label="Ladder"
                  size="sm"
                  value={ladder.id}
                  onValueChange={setLadderId}
                  options={LADDERS.map((l) => ({ value: l.id, label: `${l.name}`, textValue: l.name }))}
                  width="100%"
                />
              </label>
              <label className={styles.optionLabel}>
                Agarose
                <NumberField size="sm" aria-label="Agarose percent" value={agarose} onValueChange={setAgarose} min={0.5} max={3} step={0.1} precision={1} unit="%" />
              </label>
              <p className={styles.note}>{ladder.vendor}</p>
            </div>
          </div>
          {result.warnings.length ? (
            <Banner tone="warning" title="Ambiguous digest">
              {result.warnings[0]}
              {result.warnings.length > 1 ? ` (+${result.warnings.length - 1} more)` : ''}
            </Banner>
          ) : null}
          <div className={styles.table}>
            <Table
              aria-label="Fragments"
              columns={columns}
              rows={result.rows}
              rowKey={(r) => r.key}
              selectedKeys={selectedRow ? [selectedRow] : []}
              onSelectionChange={(keys) => setSelectedRow(keys[0] ?? null)}
              onRowActivate={(r) => openFragment(r)}
              rowHeight={24}
            />
          </div>
        </section>
      </div>
    </Sheet>
  );
}
