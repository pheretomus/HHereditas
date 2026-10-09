/** Choose the enzymes to display ("Chosen enzymes"): searchable list of commercial enzymes. */
import { COMMERCIAL_ENZYMES, countCuts, cutNotation, findSites } from '@hhereditas/core';
import { Badge, Checkbox, SearchField, Sheet } from '@hhereditas/ui';
import { useEffect, useMemo, useState } from 'react';
import type { DocumentState } from '../../state/documents';
import { LARGE_RECORD } from '../../state/analysis';
import { useSettings } from '../../state/settings';
import { useApp } from '../../state/store';
import styles from './DigestSheet.module.css';

const LIST_LIMIT = 200;

export function ChooseEnzymesSheet({ open, doc }: { open: boolean; doc: DocumentState | null }) {
  const [chosen, setChosen] = useState<string[]>([]);
  const [filter, setFilter] = useState('');
  useEffect(() => {
    if (!open) return;
    setChosen(useSettings.getState().customEnzymes);
    setFilter('');
  }, [open]);

  const record = doc?.record ?? null;
  const counts = useMemo(() => {
    if (!open || !record || record.seq.length > LARGE_RECORD || record.molecule === 'protein') return null;
    const pool = COMMERCIAL_ENZYMES.filter((e) => e.site.replace(/N/g, '').length >= 4);
    return countCuts(findSites(record.seq, record.topology, pool));
  }, [open, record]);

  const q = filter.trim().toLowerCase();
  const list = useMemo(() => {
    const all = COMMERCIAL_ENZYMES.filter((e) => !q || e.name.toLowerCase().includes(q) || e.site.toLowerCase().includes(q));
    return all.slice(0, LIST_LIMIT);
  }, [q]);

  const toggle = (name: string, on: boolean) => setChosen((cur) => (on ? [...cur.filter((n) => n !== name), name] : cur.filter((n) => n !== name)));

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => {
        if (!o) useApp.getState().closeSheet();
      }}
      title="Choose Enzymes"
      description="The chosen enzymes are shown on every map."
      primaryAction={{
        label: 'Show',
        disabled: chosen.length === 0,
        onAction: () => {
          useSettings.getState().update({ customEnzymes: chosen, enzymeDisplay: 'custom' });
          useApp.getState().closeSheet();
        },
      }}
      width={460}
    >
      <div className={styles.enzymes} style={{ height: 420 }}>
        <SearchField placeholder="Name or site" aria-label="Filter enzymes" value={filter} onValueChange={setFilter} />
        <div className={styles.chosen}>
          {chosen.length === 0 ? <span className={styles.hint}>Nothing chosen yet.</span> : null}
          {chosen.map((name) => (
            <button key={name} type="button" className={styles.chip} onClick={() => toggle(name, false)} aria-label={`Remove ${name}`}>
              {name}
            </button>
          ))}
        </div>
        <div className={styles.list}>
          {list.map((e) => {
            const c = counts?.get(e.name) ?? 0;
            return (
              <div key={e.name} className={styles.option}>
                <Checkbox label={e.name} description={cutNotation(e)} checked={chosen.includes(e.name)} onCheckedChange={(v) => toggle(e.name, v === true)} />
                {counts ? (
                  <Badge size="sm" tone={c === 1 ? 'accent' : 'neutral'}>
                    {c === 0 ? 'no cut' : c === 1 ? '1 cut' : `${c} cuts`}
                  </Badge>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </Sheet>
  );
}
