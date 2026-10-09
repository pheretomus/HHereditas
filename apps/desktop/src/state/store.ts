/**
 * Application store (zustand): the open documents, the active one, and transient UI state
 * (open sheets, status message). Document changes go through the pure functions of
 * documents.ts so they are undoable and testable without React.
 */
import type { Range, SeqRecord } from '@hhereditas/core';
import { featureExtent, makeRecord } from '@hhereditas/core';
import { selectRange, type SequenceEdit, type SequenceSelection } from '@hhereditas/viewer';
import { create } from 'zustand';
import type { SidebarItemRef, ViewMode } from '../shell';
import {
  applySequenceEdit,
  commitChange,
  createDocument,
  nextRequestId,
  redoDocument,
  undoDocument,
  type DocumentSource,
  type DocumentState,
  type FileFormat,
} from './documents';

/** Modal sheets of the document window. */
export type SheetId = 'digest' | 'add-primer' | 'add-feature' | 'new-sequence' | 'choose-enzymes' | 'save-as';

export interface SheetOptions {
  /** Add Primer: forward (1) or reverse (-1). */
  direction?: 1 | -1;
  /** Digest: enzymes chosen when the sheet opens. */
  enzymes?: string[];
  /** Save As (browser). */
  docId?: string;
  defaultName?: string;
  format?: FileFormat;
}

/** "Save changes?" alert: for closing one document, or the window (every dirty document in turn). */
export interface ClosePrompt {
  docId: string;
  /** Close the window once every document is dealt with. */
  quit: boolean;
}

export interface StatusMessage {
  text: string;
  tone: 'info' | 'error';
  id: number;
}

export interface AppState {
  documents: DocumentState[];
  activeId: string | null;
  sheet: SheetId | null;
  /** Options of the open sheet (e.g. the primer direction). */
  sheetOptions: SheetOptions;
  closePrompt: ClosePrompt | null;
  status: StatusMessage | null;

  openRecords: (records: readonly SeqRecord[], source?: DocumentSource) => string[];
  newSequence: (init: { name: string; seq: string; topology: SeqRecord['topology'] }) => string;
  activate: (id: string) => void;
  close: (id: string) => void;
  setSelection: (selection: SequenceSelection | null) => void;
  setView: (view: ViewMode) => void;
  /** Select an annotation (sidebar row or map click): selects its range and reveals it. */
  selectItem: (item: SidebarItemRef | null, range?: Range | null, options?: { zoom?: boolean }) => void;
  /** Scroll the sequence view to a base. */
  reveal: (position: number) => void;
  applyEdit: (edit: SequenceEdit) => void;
  /** Any undoable record change (features, primers...). */
  change: (update: (record: SeqRecord) => SeqRecord, label: string, selection?: SequenceSelection | null) => void;
  undo: () => void;
  redo: () => void;
  markSaved: (id: string, saved: { record: SeqRecord; filePath: string | null; fileName: string; format: FileFormat }) => void;
  dismissWarnings: (id: string) => void;
  openSheet: (sheet: SheetId, options?: SheetOptions) => void;
  setClosePrompt: (prompt: ClosePrompt | null) => void;
  closeSheet: () => void;
  flash: (text: string, tone?: StatusMessage['tone']) => void;
}

let statusCounter = 0;

/** Does a new selection still correspond to the selected sidebar item? (Otherwise the item is deselected.) */
function itemMatches(doc: DocumentState, selection: SequenceSelection | null): boolean {
  const item = doc.selectedItem;
  if (!item || !selection || selection.range.end <= selection.range.start) return false;
  if (item.kind !== 'feature') return true;
  const f = doc.record.features.find((x) => x.id === item.id);
  if (!f) return false;
  const n = doc.record.seq.length;
  const e = selectRange(featureExtent(f, n, doc.record.topology), n, doc.record.topology).range;
  return e.start === selection.range.start && e.end === selection.range.end;
}

function updateDoc(state: AppState, id: string | null, fn: (doc: DocumentState) => DocumentState): Partial<AppState> {
  if (!id) return {};
  let changed = false;
  const documents = state.documents.map((d) => {
    if (d.id !== id) return d;
    const next = fn(d);
    if (next !== d) changed = true;
    return next;
  });
  return changed ? { documents } : {};
}

export const useApp = create<AppState>()((set, get) => ({
  documents: [],
  activeId: null,
  sheet: null,
  sheetOptions: {},
  closePrompt: null,
  status: null,

  openRecords: (records, source = {}) => {
    if (records.length === 0) return [];
    // A file that is already open is brought to the front instead of being opened twice.
    if (source.filePath) {
      const existing = get().documents.find((d) => d.filePath === source.filePath);
      if (existing) {
        set({ activeId: existing.id });
        return [existing.id];
      }
    }
    const multi = records.length > 1;
    const docs = records.map((r) =>
      createDocument(r, {
        ...source,
        // Only a single-record file can be saved back in place.
        filePath: multi ? null : (source.filePath ?? null),
        warnings: source.warnings,
      }),
    );
    set((s) => ({ documents: [...s.documents, ...docs], activeId: docs[0].id }));
    return docs.map((d) => d.id);
  },

  newSequence: ({ name, seq, topology }) => {
    const record = makeRecord({ seq, name: name || 'Untitled', topology });
    const doc = createDocument(record);
    set((s) => ({ documents: [...s.documents, { ...doc, view: seq.length === 0 ? 'sequence' : doc.view }], activeId: doc.id }));
    return doc.id;
  },

  activate: (id) => set((s) => (s.documents.some((d) => d.id === id) ? { activeId: id } : {})),

  close: (id) =>
    set((s) => {
      const i = s.documents.findIndex((d) => d.id === id);
      if (i < 0) return {};
      const documents = s.documents.filter((d) => d.id !== id);
      const activeId = s.activeId === id ? (documents[Math.min(i, documents.length - 1)]?.id ?? null) : s.activeId;
      return { documents, activeId, sheet: activeId ? s.sheet : null };
    }),

  setSelection: (selection) =>
    set((s) =>
      updateDoc(s, s.activeId, (d) => {
        const a = d.selection;
        if (a === selection) return d;
        if (a && selection && a.caret === selection.caret && a.range.start === selection.range.start && a.range.end === selection.range.end) return d;
        return { ...d, selection, selectedItem: itemMatches(d, selection) ? d.selectedItem : null };
      }),
    ),

  setView: (view) => set((s) => updateDoc(s, s.activeId, (d) => (d.view === view ? d : { ...d, view }))),

  selectItem: (item, range, options) =>
    set((s) =>
      updateDoc(s, s.activeId, (d) => {
        const r = d.record;
        const n = r.seq.length;
        let target = range ?? null;
        if (!target && item?.kind === 'feature') {
          const f = r.features.find((x) => x.id === item.id);
          if (f) target = featureExtent(f, n, r.topology);
        }
        if (!target || n === 0) return { ...d, selectedItem: item };
        return {
          ...d,
          selectedItem: item,
          selection: selectRange(target, n, r.topology),
          scrollRequest: { position: target.start % n, requestId: nextRequestId(), ...(options?.zoom ? { zoomRange: target } : {}) },
        };
      }),
    ),

  reveal: (position) => set((s) => updateDoc(s, s.activeId, (d) => ({ ...d, scrollRequest: { position, requestId: nextRequestId() } }))),

  applyEdit: (edit) => {
    try {
      set((s) => updateDoc(s, s.activeId, (d) => applySequenceEdit(d, edit)));
    } catch (e) {
      get().flash(`Could not edit: ${e instanceof Error ? e.message : String(e)}`, 'error');
    }
  },

  change: (update, label, selection) => {
    try {
      set((s) => updateDoc(s, s.activeId, (d) => commitChange(d, update(d.record), label, selection === undefined ? d.selection : selection)));
    } catch (e) {
      get().flash(`${label} failed: ${e instanceof Error ? e.message : String(e)}`, 'error');
    }
  },

  undo: () => set((s) => updateDoc(s, s.activeId, undoDocument)),
  redo: () => set((s) => updateDoc(s, s.activeId, redoDocument)),

  markSaved: (id, saved) =>
    set((s) =>
      updateDoc(s, id, (d) => ({
        ...d,
        savedRecord: saved.record,
        filePath: saved.filePath,
        fileName: saved.fileName,
        format: saved.format,
      })),
    ),

  dismissWarnings: (id) => set((s) => updateDoc(s, id, (d) => ({ ...d, warnings: [] }))),

  openSheet: (sheet, options = {}) => set({ sheet, sheetOptions: options }),
  closeSheet: () => set({ sheet: null, sheetOptions: {} }),
  setClosePrompt: (closePrompt) => set({ closePrompt }),

  flash: (text, tone = 'info') => {
    statusCounter += 1;
    const id = statusCounter;
    set({ status: { text, tone, id } });
    setTimeout(() => {
      if (get().status?.id === id) set({ status: null });
    }, 4000);
  },
}));

/** The active document, or null. */
export function useActiveDocument(): DocumentState | null {
  return useApp((s) => s.documents.find((d) => d.id === s.activeId) ?? null);
}

export function getActiveDocument(): DocumentState | null {
  const s = useApp.getState();
  return s.documents.find((d) => d.id === s.activeId) ?? null;
}
