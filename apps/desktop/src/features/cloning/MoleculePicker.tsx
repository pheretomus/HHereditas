/**
 * Choose a molecule for a cloning wizard: an open document (whole, or its current selection)
 * or a file opened on the spot (it opens as a document too, behind the sheet).
 */
import { Select, type SelectEntry } from '@hhereditas/ui';
import { openFiles } from '../../app/files';
import { platform } from '../../platform';
import type { DocumentState } from '../../state/documents';
import { useApp } from '../../state/store';
import { errorText, formatBp, formatRange, selectionRange, type MoleculeSource } from './model/common';
import styles from './CloningSheet.module.css';

const OPEN_FILE = '__open-file__';

export function sourceKey(source: MoleculeSource | null): string {
  if (!source) return '';
  return source.range ? `${source.docId}|${source.range.start}-${source.range.end}` : source.docId;
}

/** Choices for a document: the whole molecule and, when it has selected bases, the selection. */
export function sourceOptions(documents: readonly DocumentState[], options: { exclude?: string; selections?: boolean } = {}) {
  const out: { source: MoleculeSource; label: string; detail: string }[] = [];
  for (const d of documents) {
    if (d.id === options.exclude || d.record.molecule === 'protein') continue;
    const L = d.record.seq.length;
    out.push({ source: { docId: d.id, range: null }, label: d.record.name, detail: `${formatBp(L)} · ${d.record.topology}` });
    const r = options.selections === false ? null : selectionRange(d);
    if (r && r.end - r.start < L) {
      out.push({ source: { docId: d.id, range: r }, label: `${d.record.name} — selection`, detail: `${formatRange(r, L)} · ${formatBp(r.end - r.start)}` });
    }
  }
  return out;
}

/**
 * Open files with the platform dialog without leaving the wizard: the documents open behind the
 * sheet and the previously active one stays active. Returns the new documents' ids.
 */
export async function openFilesForWizard(): Promise<string[]> {
  const app = useApp.getState();
  const before = new Set(app.documents.map((d) => d.id));
  const active = app.activeId;
  try {
    openFiles(await platform.pickFiles());
  } catch (e) {
    app.flash(`Could not open: ${errorText(e)}`, 'error');
  }
  const after = useApp.getState();
  if (active && after.activeId !== active) after.activate(active);
  return after.documents.filter((d) => !before.has(d.id)).map((d) => d.id);
}

export interface MoleculePickerProps {
  'aria-label': string;
  documents: readonly DocumentState[];
  value: MoleculeSource | null;
  onChange: (source: MoleculeSource | null) => void;
  /** Document not offered (e.g. the vector). */
  exclude?: string;
  /** Offer documents' selections (default true). */
  selections?: boolean;
  placeholder?: string;
}

export function MoleculePicker({ documents, value, onChange, exclude, selections, placeholder = 'Choose…', ...rest }: MoleculePickerProps) {
  const opts = sourceOptions(documents, { exclude, selections });
  // A range picked earlier stays listed after the document's selection moved on.
  const pickedDoc = value?.range ? documents.find((d) => d.id === value.docId) : undefined;
  if (value?.range && pickedDoc && !opts.some((o) => sourceKey(o.source) === sourceKey(value))) {
    const L = pickedDoc.record.seq.length;
    const at = opts.findIndex((o) => o.source.docId === value.docId) + 1;
    opts.splice(at, 0, { source: value, label: `${pickedDoc.record.name} — ${formatRange(value.range, L)}`, detail: formatBp(value.range.end - value.range.start) });
  }
  const entries: SelectEntry[] = opts.map((o) => ({
    value: sourceKey(o.source),
    textValue: o.label,
    label: (
      <span className={styles.option}>
        <span className={styles.optionLabel}>{o.label}</span>
        <span className={styles.optionDetail}>{o.detail}</span>
      </span>
    ),
  }));
  if (entries.length) entries.push({ type: 'separator' });
  entries.push({ value: OPEN_FILE, label: 'Open File…', textValue: 'Open File' });

  const current = value ? sourceKey(value) : '';
  const known = opts.some((o) => sourceKey(o.source) === current);
  return (
    <Select
      aria-label={rest['aria-label']}
      size="sm"
      width="100%"
      placeholder={placeholder}
      value={known ? current : ''}
      options={entries}
      onValueChange={async (key) => {
        if (key === OPEN_FILE) {
          const ids = await openFilesForWizard();
          if (ids[0]) onChange({ docId: ids[0], range: null });
          return;
        }
        const o = opts.find((x) => sourceKey(x.source) === key);
        onChange(o ? o.source : null);
      }}
    />
  );
}
