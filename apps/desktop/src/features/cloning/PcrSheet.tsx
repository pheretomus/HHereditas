/**
 * PCR: amplify part of the active document with two primers (stored with the document or
 * typed), see the product, a gel lane next to a ladder and the engine's warnings, then open
 * the product as a new document.
 */
import type { PrimerBindingSite, SeqRecord } from '@hhereditas/core';
import { addPrimer, getLadder, LADDERS, newId } from '@hhereditas/core';
import { Checkbox, Select, Sheet, TextField, type SelectEntry } from '@hhereditas/ui';
import { GelThumbnail } from '@hhereditas/viewer';
import { useEffect, useMemo, useState } from 'react';
import { selectedText } from '../../app/commands';
import type { DocumentState } from '../../state/documents';
import { useApp } from '../../state/store';
import { formatBp, formatRange, productGelLanes } from './model/common';
import { defaultPrimers, pcrProductRecord, runPcr, type PrimerChoice } from './model/pcr';
import { Issues, ProductPreview } from './ProductPreview';
import styles from './CloningSheet.module.css';

const CUSTOM = '__custom__';
const LADDER_ID = 'neb-1kb-plus';

interface PrimerInputProps {
  label: string;
  record: SeqRecord;
  choice: PrimerChoice;
  onChange: (choice: PrimerChoice) => void;
  site: PrimerBindingSite | null;
}

function PrimerInput({ label, record, choice, onChange, site }: PrimerInputProps) {
  const options: SelectEntry[] = [
    ...record.primers.map((p) => ({ value: p.id, label: p.name, textValue: p.name })),
    ...(record.primers.length ? [{ type: 'separator' as const }] : []),
    { value: CUSTOM, label: 'Type a sequence', textValue: 'Type a sequence' },
  ];
  const saved = choice.kind === 'saved' ? record.primers.find((p) => p.id === choice.primerId) : undefined;
  const L = record.seq.length;
  return (
    <div className={styles.group}>
      <h3 className={styles.groupTitle}>{label}</h3>
      <Select
        aria-label={`${label} source`}
        size="sm"
        width="100%"
        value={choice.kind === 'saved' ? choice.primerId : CUSTOM}
        options={options}
        onValueChange={(v) => onChange(v === CUSTOM ? { kind: 'custom', sequence: saved?.sequence ?? '' } : { kind: 'saved', primerId: v })}
      />
      {choice.kind === 'custom' ? (
        <TextField
          aria-label={`${label} sequence`}
          mono
          size="sm"
          placeholder="5′-…-3′"
          spellCheck={false}
          value={choice.sequence}
          onValueChange={(sequence) => onChange({ kind: 'custom', sequence })}
        />
      ) : saved ? (
        <p className={styles.mono} title={saved.sequence}>
          {saved.sequence}
        </p>
      ) : null}
      {site ? (
        <p className={styles.stats}>
          <span>
            Anneals <strong>{site.annealedLength} nt</strong> at <strong>{formatRange(site.range, L)}</strong>
          </span>
          {site.tm !== undefined && Number.isFinite(site.tm) ? (
            <span>
              Tm <strong>{site.tm.toFixed(1)} °C</strong>
            </span>
          ) : null}
          {site.tailLength > 0 ? (
            <span>
              Tail <strong>{site.tailLength} nt</strong>
            </span>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}

export function PcrSheet({ open, doc }: { open: boolean; doc: DocumentState | null }) {
  const record = doc?.record ?? null;
  const [forward, setForward] = useState<PrimerChoice>({ kind: 'custom', sequence: '' });
  const [reverse, setReverse] = useState<PrimerChoice>({ kind: 'custom', sequence: '' });
  const [productIndex, setProductIndex] = useState(0);
  const [savePrimers, setSavePrimers] = useState(false);

  useEffect(() => {
    if (!open || !doc) return;
    const d = defaultPrimers(doc.record, selectedText(doc));
    setForward(d.forward);
    setReverse(d.reverse);
    setProductIndex(0);
    setSavePrimers(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const preview = useMemo(() => (open && record ? runPcr(record, forward, reverse) : null), [open, record, forward, reverse]);
  const result = preview?.result ?? null;
  const count = result?.products.length ?? 0;
  const index = Math.min(productIndex, Math.max(0, count - 1));
  const product = result?.products[index] ?? null;
  const amplicon = result?.amplicons[index] ?? null;
  const siteOf = (id: string | undefined) => (amplicon && id ? ([amplicon.forwardSite, amplicon.reverseSite].find((s) => s.primerId === id) ?? null) : null);

  const ladder = getLadder(LADDER_ID) ?? LADDERS[0];
  const lanes = useMemo(() => productGelLanes(product ? [product] : [], ladder, 'PCR'), [product, ladder]);

  const typed = forward.kind === 'custom' || reverse.kind === 'custom';
  const close = () => useApp.getState().closeSheet();

  const create = () => {
    if (!record || !preview || !doc) return;
    const rec = pcrProductRecord(record, preview, index);
    if (!rec) return;
    const app = useApp.getState();
    if (savePrimers && typed) {
      const toAdd = [forward.kind === 'custom' ? preview.forward : null, reverse.kind === 'custom' ? preview.reverse : null].filter(
        (p): p is NonNullable<typeof p> => !!p && !record.primers.some((q) => q.sequence === p.sequence),
      );
      if (toAdd.length) app.change((r) => toAdd.reduce((acc, p) => addPrimer(acc, { ...p, id: newId('p') }), r), 'Add Primers');
    }
    close();
    app.openRecords([rec]);
    app.flash(`Created ${rec.name} (${formatBp(rec.seq.length)})`);
  };

  const emptyMessage = preview?.inputError ?? 'Choose a forward and a reverse primer.';

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => {
        if (!o) close();
      }}
      title="PCR"
      description={record ? `Amplify part of ${record.name} (${formatBp(record.seq.length)}, ${record.topology}) with two primers.` : undefined}
      width={920}
      primaryAction={{ label: 'Create Product', onAction: create, disabled: !product }}
      footerStart={
        typed ? (
          <Checkbox label={`Add typed primers to ${record?.name ?? 'the template'}`} checked={savePrimers} onCheckedChange={(v) => setSavePrimers(v === true)} />
        ) : null
      }
    >
      {record ? (
        <div className={styles.layout}>
          <div className={styles.inputs}>
            <PrimerInput label="Forward primer" record={record} choice={forward} onChange={setForward} site={siteOf(preview?.forward?.id)} />
            <PrimerInput label="Reverse primer" record={record} choice={reverse} onChange={setReverse} site={siteOf(preview?.reverse?.id)} />
            <p className={styles.hint}>
              Primers are written 5′→3′; a 5′ tail that does not anneal (a restriction site, an overlap) is added to the product. Select a region before
              opening PCR to start with primers that amplify it.
            </p>
          </div>
          <div className={styles.preview}>
            <ProductPreview
              product={product}
              emptyMessage={result?.error ? undefined : emptyMessage}
              headerAccessory={
                count > 1 ? (
                  <Select
                    aria-label="Product"
                    size="sm"
                    value={String(index)}
                    onValueChange={(v) => setProductIndex(Number(v))}
                    options={result!.products.map((p, i) => ({ value: String(i), label: `Product ${i + 1} · ${formatBp(p.seq.length)}`, textValue: `Product ${i + 1}` }))}
                  />
                ) : null
              }
              aside={
                <>
                  <GelThumbnail lanes={lanes} width={120} height={236} aria-label={product ? `Gel: ${formatBp(product.seq.length)} product next to ${ladder.name}` : `Gel: ${ladder.name}`} />
                  <p className={styles.asideCaption}>1% agarose</p>
                </>
              }
            />
            <Issues error={result?.error} warnings={result?.warnings} />
          </div>
        </div>
      ) : null}
    </Sheet>
  );
}
