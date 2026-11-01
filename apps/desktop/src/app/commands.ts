/**
 * Application commands shared by the toolbar, context menus, the native menu and keyboard
 * shortcuts (one implementation per command).
 */
import type { Primer, SeqRecord } from '@hhereditas/core';
import { annotateCommonFeatures, extractRange, normalizeDna, normalizeRange, sliceRange } from '@hhereditas/core';
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

/** The selected primer of the active document, or null. */
export function selectedPrimer(doc: DocumentState | null): Primer | null {
  const item = doc?.selectedItem;
  if (!doc || item?.kind !== 'primer') return null;
  return doc.record.primers.find((p) => p.id === item.id) ?? null;
}

/**
 * The primer last copied with {@link copyPrimerCommand}: its name travels with its sequence, so
 * {@link pastePrimerCommand} can restore both while the clipboard (plain text) only holds the sequence.
 */
let copiedPrimer: Primer | null = null;

/** Copy the selected primer's sequence (5'→3') to the clipboard; returns false without a selected primer. */
export function copyPrimerCommand(): boolean {
  const primer = selectedPrimer(getActiveDocument());
  if (!primer) return false;
  const app = useApp.getState();
  copiedPrimer = primer;
  navigator.clipboard.writeText(primer.sequence).then(
    () => app.flash(`Copied primer "${primer.name}" (${primer.sequence.length} nt)`),
    () => app.flash('Could not copy to the clipboard', 'error'),
  );
  return true;
}

/**
 * Read a primer from pasted text: a bare sequence, FASTA (">name" then the sequence), or a line
 * "name<tab or spaces>sequence" (as pasted from a table or an order form). Null when no sequence.
 */
export function parsePastedPrimer(text: string): { name?: string; sequence: string } | null {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return null;
  const isDna = (s: string) => normalizeDna(s).invalid.length === 0 && normalizeDna(s).seq.length > 0;
  if (lines[0].startsWith('>')) {
    const body = lines.slice(1).join('');
    if (!isDna(body)) return null;
    return { name: lines[0].slice(1).trim() || undefined, sequence: normalizeDna(body).seq };
  }
  if (lines.length === 1) {
    // "name<tab>sequence": the last word is the sequence unless every word is plain bases (a spaced-out sequence)
    const parts = lines[0].split(/[\t,;]+|\s+/).filter(Boolean);
    const plain = (s: string) => /^[ACGTUacgtu]+$/.test(s);
    if (parts.length >= 2 && isDna(parts[parts.length - 1]) && !parts.every(plain)) {
      return { name: parts.slice(0, -1).join(' '), sequence: normalizeDna(parts[parts.length - 1]).seq };
    }
  }
  const body = lines.join('');
  return isDna(body) ? { sequence: normalizeDna(body).seq } : null;
}

/**
 * Paste a primer: opens Add Primer with the clipboard's sequence, and with the name of the primer
 * last copied with {@link copyPrimerCommand} when the clipboard still holds its sequence.
 */
export async function pastePrimerCommand(): Promise<void> {
  const app = useApp.getState();
  if (!getActiveDocument()) return;
  let text = '';
  try {
    text = await navigator.clipboard.readText();
  } catch {
    text = copiedPrimer?.sequence ?? '';
  }
  const parsed = parsePastedPrimer(text);
  if (!parsed) {
    app.flash('Clipboard does not contain a primer sequence', 'error');
    return;
  }
  const same = copiedPrimer && normalizeDna(copiedPrimer.sequence).seq === parsed.sequence ? copiedPrimer : null;
  app.openSheet('add-primer', {
    primer: same
      ? { name: same.name, sequence: same.sequence, description: same.description, phosphorylated: same.phosphorylated }
      : { name: parsed.name, sequence: parsed.sequence },
  });
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

export function setPrimersHiddenCommand(ids: readonly string[], hidden: boolean): void {
  const app = useApp.getState();
  const target = new Set(ids);
  app.change(
    (r) => ({ ...r, primers: r.primers.map((p) => (target.has(p.id) ? (hidden ? { ...p, hidden } : { ...p, hidden: undefined }) : p)) }),
    hidden ? 'Hide Primers' : 'Show Primers',
  );
}

export function detectCommonFeaturesCommand(): void {
  const doc = getActiveDocument();
  if (!doc) return;
  const app = useApp.getState();
  const { record: updated, added } = annotateCommonFeatures(doc.record);
  if (added.length === 0) {
    app.flash('No new common features, epitope tags, or protease sites detected');
    return;
  }
  app.change(() => updated, 'Detect Common Features');
  app.flash(`Detected ${added.length} common feature${added.length === 1 ? '' : 's'} (${added.slice(0, 4).map((f) => f.name).join(', ')}${added.length > 4 ? ', …' : ''})`);
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
