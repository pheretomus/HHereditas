/**
 * Application commands shared by the toolbar, context menus, the native menu and keyboard
 * shortcuts (one implementation per command).
 */
import type { SeqRecord } from '@hhereditas/core';
import { extractRange, normalizeRange, sliceRange } from '@hhereditas/core';
import { hasSelectedBases } from '@hhereditas/viewer';
import { isDirty, type DocumentState } from '../state/documents';
import { getActiveDocument, useApp } from '../state/store';
import { openWithDialog, saveDocument } from './files';

/** Text of the selected bases (top strand), or null without a selection. */
export function selectedText(doc: DocumentState | null): string | null {
  const sel = doc?.selection;
  if (!doc || !hasSelectedBases(sel)) return null;
  const r = normalizeRange(sel.range, doc.record.seq.length, doc.record.topology);
  return sliceRange(doc.record.seq, r);
}

export async function copySelection(): Promise<void> {
  const text = selectedText(getActiveDocument());
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    useApp.getState().flash(`Copied ${text.length.toLocaleString('en-US')} bp`);
  } catch {
    useApp.getState().flash('Could not copy to the clipboard', 'error');
  }
}

/** Open a record as a new, unsaved document. */
export function openAsNewDocument(record: SeqRecord): void {
  useApp.getState().openRecords([record]);
}

export function openSelectionAsDocument(): void {
  const doc = getActiveDocument();
  if (!doc || !hasSelectedBases(doc.selection)) return;
  try {
    const r = normalizeRange(doc.selection.range, doc.record.seq.length, doc.record.topology);
    openAsNewDocument(extractRange(doc.record, r));
  } catch (e) {
    useApp.getState().flash(`Could not extract the selection: ${e instanceof Error ? e.message : String(e)}`, 'error');
  }
}

export function deleteFeatureCommand(id: string): void {
  const app = useApp.getState();
  app.change((r) => ({ ...r, features: r.features.filter((f) => f.id !== id) }), 'Delete Feature');
}

export function deletePrimerCommand(id: string): void {
  const app = useApp.getState();
  app.change((r) => ({ ...r, primers: r.primers.filter((p) => p.id !== id) }), 'Delete Primer');
}

// ---------------------------------------------------------------------------------------
// Closing documents and the window
// ---------------------------------------------------------------------------------------

/** Close a document, asking to save it first when it has unsaved changes. */
export function requestClose(id: string | null = useApp.getState().activeId): void {
  const app = useApp.getState();
  const doc = app.documents.find((d) => d.id === id);
  if (!doc) return;
  if (isDirty(doc)) app.setClosePrompt({ docId: doc.id, quit: false });
  else app.close(doc.id);
}

/**
 * The window wants to close. Returns true when it may close now; otherwise the user is asked
 * about each unsaved document in turn and the window closes after the last one.
 */
export function requestQuit(): boolean {
  const app = useApp.getState();
  const dirty = app.documents.find(isDirty);
  if (!dirty) return true;
  app.activate(dirty.id);
  app.setClosePrompt({ docId: dirty.id, quit: true });
  return false;
}

/** Answer of the "Save changes?" alert. */
export async function resolveClosePrompt(answer: 'save' | 'discard' | 'cancel', closeWindow: () => void): Promise<void> {
  const app = useApp.getState();
  const prompt = app.closePrompt;
  if (!prompt) return;
  if (answer === 'cancel') {
    app.setClosePrompt(null);
    return;
  }
  app.setClosePrompt(null);
  if (answer === 'save') {
    const saved = await saveDocument(prompt.docId);
    if (!saved) return; // cancelled or failed: keep the document (and the window) open
  }
  if (prompt.quit) {
    // Forget the document's changes (the window is closing), then continue with the next one.
    useApp.getState().close(prompt.docId);
    if (requestQuit()) closeWindow();
  } else {
    useApp.getState().close(prompt.docId);
  }
}

export { openWithDialog, saveDocument };
