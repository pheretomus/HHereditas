import type { ReactNode } from 'react';
import type { MoleculeType, Topology } from '@hhereditas/core';
import { cx } from '@hhereditas/ui';
import { formatDocumentSubtitle } from './format';
import { formatSelectionStatus, type SelectionSummary } from './selectionSummary';
import styles from './StatusBar.module.css';

export interface StatusBarProps {
  /** Selection summary (useSelectionSummary); null shows no selection text. */
  selection?: SelectionSummary | null;
  /** Document length, shown at the trailing end with the topology. */
  length?: number;
  topology?: Topology;
  molecule?: MoleculeType;
  /** Short transient message ("Copied 861 bp") shown instead of the selection text. */
  message?: ReactNode;
  /** Extra trailing items (e.g. a zoom level), placed before the document length. */
  trailing?: ReactNode;
  className?: string;
}

/**
 * Slim (26 px) bar under the canvas: "Selection 396..1,256 · 861 bp · GC 52.3 %" at the
 * leading end, the document length and topology at the trailing end. Updates are announced
 * politely to screen readers.
 */
export function StatusBar({ selection, length, topology, molecule, message, trailing, className }: StatusBarProps) {
  const text = message ?? (selection ? formatSelectionStatus(selection, molecule) : null);
  return (
    <footer className={cx(styles.bar, className)} aria-label="Status">
      <div className={styles.leading} role="status" aria-live="polite">
        {text}
      </div>
      <div className={styles.trailing}>
        {trailing}
        {length !== undefined && topology ? (
          <span className={styles.document}>{formatDocumentSubtitle(length, topology, molecule)}</span>
        ) : null}
      </div>
    </footer>
  );
}
