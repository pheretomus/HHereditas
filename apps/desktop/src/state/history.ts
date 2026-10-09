/**
 * Per-document undo/redo. Every entry is a complete snapshot (records are immutable and share
 * structure, so a snapshot costs little) plus the selection to restore and a label for menus.
 */
import type { SeqRecord } from '@hhereditas/core';
import type { SequenceSelection } from '@hhereditas/viewer';

export interface Snapshot {
  record: SeqRecord;
  selection: SequenceSelection | null;
}

export interface HistoryEntry extends Snapshot {
  /** What the change did, e.g. "Typing" or "Delete Feature" (shown as "Undo Typing"). */
  label: string;
}

export interface History {
  undo: readonly HistoryEntry[];
  redo: readonly HistoryEntry[];
}

/** Oldest entries are dropped beyond this many steps. */
export const HISTORY_LIMIT = 200;

export const EMPTY_HISTORY: History = { undo: [], redo: [] };

/** Record a change: `before` is the state the change started from. Clears the redo stack. */
export function pushHistory(history: History, before: Snapshot, label: string): History {
  const undo = [...history.undo, { ...before, label }];
  if (undo.length > HISTORY_LIMIT) undo.splice(0, undo.length - HISTORY_LIMIT);
  return { undo, redo: [] };
}

/** Step back: returns the snapshot to show and the new history, or null when there is nothing to undo. */
export function undoHistory(history: History, current: Snapshot): { snapshot: HistoryEntry; history: History } | null {
  const entry = history.undo[history.undo.length - 1];
  if (!entry) return null;
  return {
    snapshot: entry,
    history: { undo: history.undo.slice(0, -1), redo: [...history.redo, { ...current, label: entry.label }] },
  };
}

/** Step forward again after an undo. */
export function redoHistory(history: History, current: Snapshot): { snapshot: HistoryEntry; history: History } | null {
  const entry = history.redo[history.redo.length - 1];
  if (!entry) return null;
  return {
    snapshot: entry,
    history: { undo: [...history.undo, { ...current, label: entry.label }], redo: history.redo.slice(0, -1) },
  };
}
