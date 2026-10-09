import { Fragment, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { CircleMinus, Plus } from 'lucide-react';
import type { Qualifier } from '@hhereditas/core';
import { Button, IconButton, PropertyList, TextField, type PropertyItem } from '@hhereditas/ui';
import { qualifierLabel } from './featureTypes';
import styles from './QualifierEditor.module.css';

export interface QualifierEditorProps {
  /** All qualifiers of the feature, in file order. */
  qualifiers: readonly Qualifier[];
  /**
   * Qualifiers hidden in the read-only list because another field already shows them (e.g. a
   * /label equal to the feature name). The editor shows every qualifier.
   */
  isRedundant?: (qualifier: Qualifier) => boolean;
  /** Commits a complete new list. Omit for a read-only list. */
  onChange?: (qualifiers: Qualifier[]) => void;
  /** Width of the label column (matches the surrounding PropertyLists). */
  labelWidth: number;
  /** Changes when another feature is shown: leaves edit mode. */
  resetKey?: string;
}

interface Row {
  id: number;
  key: string;
  value: string;
  /**
   * An empty field means "no value" (a flag such as /pseudo) rather than an empty string:
   * true for valueless qualifiers and for rows added in the editor.
   */
  wasNull: boolean;
}

const toRows = (qualifiers: readonly Qualifier[], firstId: number): Row[] =>
  qualifiers.map((q, i) => ({ id: firstId + i, key: q.key, value: q.value ?? '', wasNull: q.value === null }));

/** The qualifier list a set of edit rows stands for: keyless rows are dropped, keys trimmed. */
export function qualifiersFromRows(rows: readonly Pick<Row, 'key' | 'value' | 'wasNull'>[]): Qualifier[] {
  const out: Qualifier[] = [];
  for (const r of rows) {
    const key = r.key.trim();
    if (!key) continue;
    out.push({ key, value: r.value === '' && r.wasNull ? null : r.value });
  }
  return out;
}

/**
 * Width (px) of the key column while editing: fits the longest key in the 11 px monospaced
 * key fields (≈ 6.7 px per character plus the field padding), within 60–112 px.
 */
export function keyColumnWidth(keys: readonly string[]): number {
  const longest = keys.reduce((n, k) => Math.max(n, k.length), 4);
  return Math.round(Math.min(112, Math.max(60, 18 + longest * 6.7)));
}

export function sameQualifiers(a: readonly Qualifier[], b: readonly Qualifier[]): boolean {
  return a.length === b.length && a.every((q, i) => q.key === b[i].key && q.value === b[i].value);
}

/**
 * The Qualifiers section of the inspector's Feature card: a read-only label/value list with
 * an Edit button that turns it into key/value fields (remove with −, Add Qualifier at the
 * end). Every field commits on Return or when focus leaves it; Esc reverts the uncommitted
 * text. Long values (translations) stay clamped in the read-only list.
 */
export function QualifierEditor({ qualifiers, isRedundant, onChange, labelWidth, resetKey }: QualifierEditorProps) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [focusId, setFocusId] = useState<number | null>(null);
  const nextId = useRef(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const keyFields = useRef(new Map<number, HTMLInputElement>());
  const editing = rows !== null;

  // Move the keyboard to a row's key field once it is rendered (after Add or Remove).
  useEffect(() => {
    if (focusId === null) return;
    keyFields.current.get(focusId)?.focus();
    setFocusId(null);
  }, [focusId, rows]);

  // Another feature: back to the read-only list.
  useEffect(() => {
    setRows(null);
  }, [resetKey]);

  // Outside changes (undo, another view) while editing and not typing: show them.
  useEffect(() => {
    setRows((current) => {
      if (current === null) return current;
      if (rootRef.current?.contains(document.activeElement)) return current;
      if (sameQualifiers(qualifiersFromRows(current), qualifiers)) return current;
      const fresh = toRows(qualifiers, nextId.current);
      nextId.current += fresh.length;
      return fresh;
    });
  }, [qualifiers]);

  const startEditing = () => {
    const fresh = toRows(qualifiers, nextId.current);
    nextId.current += fresh.length;
    setRows(fresh);
  };

  const commit = (next: Row[] | null = rows) => {
    if (!next || !onChange) return;
    const list = qualifiersFromRows(next);
    if (!sameQualifiers(list, qualifiers)) onChange(list);
  };

  const update = (id: number, patch: Partial<Pick<Row, 'key' | 'value'>>) =>
    setRows((current) => current && current.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  const remove = (id: number) => {
    if (!rows) return;
    const index = rows.findIndex((r) => r.id === id);
    const next = rows.filter((r) => r.id !== id);
    setRows(next);
    commit(next);
    // Keep the keyboard in the list: the row that moved up, else the Add button.
    const after = next[index] ?? null;
    if (after) setFocusId(after.id);
    else addRef.current?.focus();
  };

  const add = () => {
    const id = nextId.current++;
    setRows((current) => [...(current ?? []), { id, key: '', value: '', wasNull: true }]);
    setFocusId(id);
  };

  const onFieldKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      // Revert to what is committed (every field commits when it loses focus).
      e.preventDefault();
      e.stopPropagation();
      const fresh = toRows(qualifiers, nextId.current);
      nextId.current += fresh.length;
      setRows(fresh);
    }
  };

  const visible: PropertyItem[] = qualifiers
    .filter((q) => !isRedundant?.(q))
    .map((q, i) => ({
      key: `${q.key}-${i}`,
      label: qualifierLabel(q.key),
      // Valueless qualifiers are flags (/pseudo): "Yes". An explicit empty value reads "—".
      value: q.value === null ? 'Yes' : q.value === '' ? <span className={styles.none}>—</span> : q.value,
      copyable: !!q.value,
      title: q.key,
      mono: q.key === 'translation',
      maxLines: q.key === 'translation' ? 4 : 6,
    }));

  if (!onChange && visible.length === 0) return null;

  return (
    <div ref={rootRef} className={styles.root}>
      <div className={styles.header}>
        <span className={styles.subheading}>Qualifiers</span>
        {onChange ? (
          <Button
            size="sm"
            variant="plain"
            className={styles.toggle}
            aria-pressed={editing}
            onClick={() => {
              if (editing) {
                commit();
                setRows(null);
              } else startEditing();
            }}
          >
            {editing ? 'Done' : 'Edit'}
          </Button>
        ) : null}
      </div>
      {!editing ? (
        visible.length > 0 ? (
          <PropertyList labelWidth={labelWidth} items={visible} />
        ) : (
          <p className={styles.empty}>No qualifiers</p>
        )
      ) : (
        <div className={styles.editor} role="group" aria-label="Edit qualifiers">
          <div
            className={styles.grid}
            style={{ gridTemplateColumns: `${keyColumnWidth(rows.map((r) => r.key))}px minmax(0, 1fr) 20px` }}
          >
            {rows.map((row) => (
              <Fragment key={row.id}>
                <TextField
                  ref={(el) => {
                    if (el) keyFields.current.set(row.id, el);
                    else keyFields.current.delete(row.id);
                  }}
                  size="sm"
                  mono
                  className={styles.keyField}
                  aria-label={`Key of ${row.key || 'new qualifier'}`}
                  placeholder="key"
                  spellCheck={false}
                  autoComplete="off"
                  value={row.key}
                  onValueChange={(key) => update(row.id, { key: key.replace(/\s+/g, '_') })}
                  onBlur={() => commit()}
                  onKeyDown={onFieldKeyDown}
                />
                <TextField
                  size="sm"
                  aria-label={`Value of ${row.key || 'new qualifier'}`}
                  value={row.value}
                  onValueChange={(value) => update(row.id, { value })}
                  onBlur={() => commit()}
                  onKeyDown={onFieldKeyDown}
                />
                <IconButton
                  size="sm"
                  icon={<CircleMinus />}
                  aria-label={`Remove ${row.key || 'qualifier'}`}
                  tooltip="Remove Qualifier"
                  className={styles.remove}
                  onClick={() => remove(row.id)}
                />
              </Fragment>
            ))}
          </div>
          <Button ref={addRef} size="sm" variant="plain" icon={<Plus />} className={styles.add} onClick={add}>
            Add Qualifier
          </Button>
        </div>
      )}
    </div>
  );
}
