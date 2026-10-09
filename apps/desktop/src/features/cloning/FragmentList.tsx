/**
 * Ordered list of molecules for an assembly (Gibson fragments, Golden Gate parts): each row can
 * be reversed (optional), moved and removed; a picker below adds open documents, their
 * selections or files.
 */
import { IconButton } from '@hhereditas/ui';
import { ArrowDown, ArrowLeftRight, ArrowUp, X } from 'lucide-react';
import type { DocumentState } from '../../state/documents';
import { formatBp, sourceLabel } from './model/common';
import { newEntry, type FragmentEntry } from './model/gibson';
import { MoleculePicker } from './MoleculePicker';
import styles from './CloningSheet.module.css';

export interface FragmentListProps {
  'aria-label': string;
  documents: readonly DocumentState[];
  entries: readonly FragmentEntry[];
  onChange: (entries: FragmentEntry[]) => void;
  /** Offer reverse-complementing a row (Gibson uses fragments exactly as given). */
  allowReverse?: boolean;
  emptyText: string;
  addLabel: string;
}

export function FragmentList({ documents, entries, onChange, allowReverse = false, emptyText, addLabel, ...rest }: FragmentListProps) {
  const move = (i: number, d: -1 | 1) => {
    const next = [...entries];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    onChange(next);
  };
  return (
    <>
      <div className={styles.list} role="list" aria-label={rest['aria-label']}>
        {entries.length === 0 ? <div className={styles.listEmpty}>{emptyText}</div> : null}
        {entries.map((e, i) => {
          const doc = documents.find((d) => d.id === e.docId);
          const name = doc ? sourceLabel(doc, e.range) : 'Closed document';
          const size = doc ? (e.range ? e.range.end - e.range.start : doc.record.seq.length) : 0;
          return (
            <div key={e.key} className={styles.listItem} role="listitem" aria-label={name}>
              <span className={styles.listIndex}>{i + 1}</span>
              <span className={styles.listName} title={name}>
                {name}
                {e.reversed ? ' (rc)' : ''}
              </span>
              <span className={styles.listMeta}>{doc ? formatBp(size) : ''}</span>
              {allowReverse ? (
                <IconButton
                  size="sm"
                  icon={<ArrowLeftRight />}
                  aria-label={`Reverse complement ${name}`}
                  tooltip="Reverse complement"
                  pressed={e.reversed}
                  onClick={() => onChange(entries.map((x) => (x.key === e.key ? { ...x, reversed: !x.reversed } : x)))}
                />
              ) : null}
              <IconButton size="sm" icon={<ArrowUp />} aria-label={`Move ${name} up`} tooltip="Move up" disabled={i === 0} onClick={() => move(i, -1)} />
              <IconButton size="sm" icon={<ArrowDown />} aria-label={`Move ${name} down`} tooltip="Move down" disabled={i === entries.length - 1} onClick={() => move(i, 1)} />
              <IconButton size="sm" icon={<X />} aria-label={`Remove ${name}`} tooltip="Remove" onClick={() => onChange(entries.filter((x) => x.key !== e.key))} />
            </div>
          );
        })}
      </div>
      <MoleculePicker
        aria-label={addLabel}
        documents={documents}
        value={null}
        placeholder={`${addLabel}…`}
        onChange={(source) => {
          if (source) onChange([...entries, newEntry(source)]);
        }}
      />
    </>
  );
}
