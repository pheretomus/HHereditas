/**
 * The document model: an open sequence record plus everything the window remembers about it
 * (file, selection, view, undo history). Pure functions; the zustand store (store.ts) holds the list.
 */
import type { Range, SeqRecord, SourceFormat } from '@hhereditas/core';
import { deleteRange, insertBases, replaceRange } from '@hhereditas/core';
import { caretAt, selectionAfterEdit, type SequenceEdit, type SequenceSelection } from '@hhereditas/viewer';
import type { SidebarItemRef, ViewMode } from '../shell';
import { EMPTY_HISTORY, pushHistory, redoHistory, undoHistory, type History } from './history';

/** Formats the app writes. */
export type FileFormat = 'genbank' | 'fasta' | 'snapgene';

export interface ScrollRequest {
  /** Base to bring into view. */
  position: number;
  /** Changes on every request so the same position can be revealed twice. */
  requestId: number;
  /** Also zoom the linear map to this range. */
  zoomRange?: Range;
}

export interface DocumentState {
  id: string;
  record: SeqRecord;
  /** The record as last opened or saved: the document is dirty while `record !== savedRecord`. */
  savedRecord: SeqRecord;
  /** Where the document lives on disk (desktop app), null for new / sample / browser documents. */
  filePath: string | null;
  /** File name for display and as the default name when saving. */
  fileName: string | null;
  /** Format of the file at `filePath` (what Save writes back). */
  format: FileFormat | null;
  selection: SequenceSelection | null;
  selectedItem: SidebarItemRef | null;
  view: ViewMode;
  history: History;
  /** Non-fatal problems reported while reading the file. */
  warnings: string[];
  scrollRequest: ScrollRequest | null;
  /** Ongoing typing run: consecutive keystrokes at the caret become one undo step. */
  typing: { gap: number; at: number } | null;
}

/** Keystrokes further apart than this (ms) start a new undo step. */
export const TYPING_COALESCE_MS = 2000;

let requestCounter = 0;
export function nextRequestId(): number {
  requestCounter += 1;
  return requestCounter;
}

export function isDirty(doc: DocumentState): boolean {
  return doc.record !== doc.savedRecord;
}

export function writableFormat(format: SourceFormat | undefined | null): FileFormat | null {
  return format === 'genbank' || format === 'fasta' || format === 'snapgene' ? format : null;
}

export interface DocumentSource {
  filePath?: string | null;
  fileName?: string | null;
  format?: FileFormat | null;
  warnings?: string[];
}

export function createDocument(record: SeqRecord, source: DocumentSource = {}): DocumentState {
  return {
    id: record.id,
    record,
    savedRecord: record,
    filePath: source.filePath ?? null,
    fileName: source.fileName ?? null,
    format: source.format ?? null,
    selection: caretAt(0),
    selectedItem: null,
    view: record.topology === 'circular' ? 'map' : 'split',
    history: EMPTY_HISTORY,
    warnings: source.warnings ?? [],
    scrollRequest: null,
    typing: null,
  };
}

/** Replace the record, recording the change for undo. */
export function commitChange(
  doc: DocumentState,
  record: SeqRecord,
  label: string,
  selection: SequenceSelection | null = doc.selection,
): DocumentState {
  if (record === doc.record) return doc;
  return {
    ...doc,
    record,
    selection,
    history: pushHistory(doc.history, { record: doc.record, selection: doc.selection }, label),
    typing: null,
  };
}

/** Apply a sequence-view edit intent with the core editing operations (features are remapped). */
export function applySequenceEdit(doc: DocumentState, edit: SequenceEdit): DocumentState {
  const rec = doc.record;
  let next: SeqRecord;
  let label: string;
  switch (edit.kind) {
    case 'insert':
      next = insertBases(rec, edit.gap, edit.bases);
      label = 'Typing';
      break;
    case 'delete':
      next = deleteRange(rec, edit.range);
      label = 'Delete';
      break;
    case 'replace':
      next = replaceRange(rec, edit.range, edit.bases);
      label = 'Replace';
      break;
  }
  const { selection } = selectionAfterEdit(edit, {
    length: rec.seq.length,
    topology: rec.topology,
    basesPerRow: 100,
    editable: true,
    molecule: rec.molecule,
  });
  const now = Date.now();
  const continues =
    edit.kind === 'insert' &&
    doc.typing !== null &&
    doc.typing.gap === edit.gap &&
    now - doc.typing.at < TYPING_COALESCE_MS &&
    doc.history.undo[doc.history.undo.length - 1]?.label === 'Typing';
  const changed = continues ? { ...doc, record: next, selection } : commitChange(doc, next, label, selection);
  if (edit.kind === 'insert') changed.typing = { gap: selection.caret, at: now };
  // A feature or primer may be gone; keep the sidebar selection only while its item exists.
  return { ...changed, selectedItem: itemExists(next, doc.selectedItem) ? doc.selectedItem : null };
}

export function undoDocument(doc: DocumentState): DocumentState {
  const step = undoHistory(doc.history, { record: doc.record, selection: doc.selection });
  if (!step) return doc;
  const { record, selection } = step.snapshot;
  return { ...doc, record, selection, history: step.history, typing: null, selectedItem: itemExists(record, doc.selectedItem) ? doc.selectedItem : null };
}

export function redoDocument(doc: DocumentState): DocumentState {
  const step = redoHistory(doc.history, { record: doc.record, selection: doc.selection });
  if (!step) return doc;
  const { record, selection } = step.snapshot;
  return { ...doc, record, selection, history: step.history, typing: null, selectedItem: itemExists(record, doc.selectedItem) ? doc.selectedItem : null };
}

function itemExists(record: SeqRecord, item: SidebarItemRef | null): boolean {
  if (!item) return false;
  if (item.kind === 'feature') return record.features.some((f) => f.id === item.id);
  if (item.kind === 'primer') return record.primers.some((p) => p.id === item.id);
  return true;
}

/** Label of the next undo / redo step ("Undo Typing"), or null when there is none. */
export function undoLabel(doc: DocumentState | null): string | null {
  const e = doc?.history.undo[doc.history.undo.length - 1];
  return e ? e.label : null;
}
export function redoLabel(doc: DocumentState | null): string | null {
  const e = doc?.history.redo[doc.history.redo.length - 1];
  return e ? e.label : null;
}

/** Base name without the extension. */
export function stripExtension(name: string): string {
  return name.replace(/\.[^./\\]+$/, '') || name;
}

/** File name from a path (either separator). */
export function fileNameOf(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** Folder of a path, with the home directory shortened to "~" when recognisable. */
export function folderOf(path: string): string {
  const parts = path.split(/[\\/]/);
  parts.pop();
  const dir = parts.join(path.includes('\\') && !path.includes('/') ? '\\' : '/');
  return dir.replace(/^\/(?:home|Users)\/[^/]+/, '~');
}

