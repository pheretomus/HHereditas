/**
 * Keyboard shortcuts (Cmd on macOS, Ctrl elsewhere). One table: the toolbar shows the same
 * bindings in its tooltips. Includes full SnapGene shortcut parity.
 */
import { reverseComplement, reverseComplementRecord, translate } from '@hhereditas/core';
import { hasSelectedBases } from '@hhereditas/viewer';
import type { ToolbarShortcuts, ViewMode } from '../shell';
import type { DocumentState } from '../state/documents';
import { useSettings } from '../state/settings';
import { getActiveDocument, useApp } from '../state/store';
import { detectCommonFeaturesCommand, requestClose, selectedText } from './commands';
import { openWithDialog, saveDocument } from './files';

export const SHORTCUTS: ToolbarShortcuts = {
  toggleSidebar: 'Alt+Mod+S',
  toggleInspector: 'Alt+Mod+I',
  viewMap: 'Mod+1',
  viewSequence: 'Mod+2',
  viewSplit: 'Mod+3',
  enzymes: 'Mod+E',
  digest: 'Mod+D',
  search: 'Mod+F',
};

export function isMac(): boolean {
  return document.documentElement.classList.contains('hh-platform-mac');
}

/** A text field other than the sequence view's own input has focus. */
function inTextField(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.closest !== 'function') return false;
  if (el.closest('[data-hh-sequence]')) return false;
  return el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT';
}

function modalOpen(): boolean {
  return !!document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]');
}

function openEnzymeMenu(): boolean {
  const btn = document.querySelector<HTMLButtonElement>('button[aria-label="Enzymes"]');
  if (!btn || btn.disabled) return false;
  btn.focus();
  btn.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
  return true;
}

async function copyReverseComplementSelection(doc: DocumentState | null): Promise<void> {
  const app = useApp.getState();
  const text = selectedText(doc);
  if (!text) {
    app.flash('Select bases first to copy reverse complement');
    return;
  }
  const rc = reverseComplement(text);
  try {
    await navigator.clipboard.writeText(rc);
    app.flash(`Copied reverse complement (${rc.length.toLocaleString('en-US')} bp)`);
  } catch {
    app.flash('Could not copy reverse complement to the clipboard', 'error');
  }
}

async function copyTranslationSelection(doc: DocumentState | null): Promise<void> {
  const app = useApp.getState();
  const text = selectedText(doc);
  if (!text || text.length < 3) {
    app.flash('Select at least 3 bases to copy amino acid translation');
    return;
  }
  try {
    const aa = translate(text);
    await navigator.clipboard.writeText(aa);
    app.flash(`Copied amino acid translation (${aa.length.toLocaleString('en-US')} aa)`);
  } catch {
    app.flash('Could not copy translation to the clipboard', 'error');
  }
}

export interface ShortcutContext {
  focusSearch: () => void;
}

/** Handle a keydown; returns true when it was a shortcut. */
export function handleShortcut(e: KeyboardEvent, ctx: ShortcutContext): boolean {
  const mac = isMac();
  const mod = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  const app = useApp.getState();
  const hasDoc = app.activeId !== null;
  const doc = hasDoc ? getActiveDocument() : null;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const code = e.code;
  const textField = inTextField(e.target);
  const modal = modalOpen();

  const run = (fn: () => void) => {
    e.preventDefault();
    e.stopPropagation();
    fn();
    return true;
  };

  // Browser-safe fallback: Alt+T opens Add Feature when Ctrl+T is intercepted by browser new-tab.
  if (!mod && e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
    if ((code === 'KeyT' || key === 't') && hasDoc && !textField && !modal) {
      return run(() => app.openSheet('add-feature'));
    }
    return false;
  }

  if (!mod) return false;

  // Alt+Mod combinations (pane toggles); compare physical keys: Alt changes e.key on macOS.
  if (e.altKey) {
    if (code === 'KeyS' && hasDoc) return run(() => useSettings.getState().update({ sidebarVisible: !useSettings.getState().sidebarVisible }));
    if (code === 'KeyI' && hasDoc) return run(() => useSettings.getState().update({ inspectorVisible: !useSettings.getState().inspectorVisible }));
    return false;
  }

  if (key === 'z' || (!mac && key === 'y')) {
    if (textField || modal || !hasDoc) return false; // native text undo in fields
    const redo = key === 'y' || e.shiftKey;
    return run(() => (redo ? app.redo() : app.undo()));
  }
  if (modal) return false;

  switch (key) {
    case 'n':
      return run(() => app.openSheet('new-sequence'));
    case 'o':
      return run(() => void openWithDialog());
    case 's':
      if (!hasDoc) return false;
      return run(() => void saveDocument(undefined, e.shiftKey));
    case 'w':
      if (!hasDoc) return false;
      return run(() => requestClose());
    case 'f':
      if (!hasDoc) return false;
      if (e.shiftKey) return run(() => detectCommonFeaturesCommand());
      return run(ctx.focusSearch);
    case 'd':
      if (!hasDoc) return false;
      return run(() => app.openSheet('digest'));
    case 'e':
      if (!hasDoc) return false;
      return run(() => {
        if (!openEnzymeMenu()) app.openSheet('choose-enzymes');
      });
    case 't': {
      if (!hasDoc || textField) return false;
      if (e.shiftKey) {
        const featureId =
          doc?.selectedItem?.kind === 'feature'
            ? doc.selectedItem.id
            : doc?.selectedFeatureIds?.[0] ?? doc?.record.features[0]?.id;
        if (featureId) return run(() => app.openSheet('edit-feature', { featureId }));
        return run(() => app.flash('Select a feature to edit or duplicate'));
      }
      return run(() => app.openSheet('add-feature'));
    }
    case 'i': {
      if (!hasDoc || textField) return false;
      const featureId =
        doc?.selectedItem?.kind === 'feature' ? doc.selectedItem.id : doc?.selectedFeatureIds?.[0];
      if (featureId) {
        return run(() => app.openSheet('edit-feature', { featureId }));
      }
      return run(() =>
        useSettings.getState().update({ inspectorVisible: !useSettings.getState().inspectorVisible }),
      );
    }
    case 'r':
    case 'p': {
      if (!hasDoc || textField) return false;
      if (key === 'p' && !e.shiftKey) return false;
      return run(() => {
        if (doc && hasSelectedBases(doc.selection)) {
          app.openSheet('add-primer', { direction: e.shiftKey ? -1 : 1 });
        } else {
          app.flash('Select bases first to add a primer');
        }
      });
    }
    case 'g':
    case 'j':
      if (!hasDoc) return false;
      return run(() => app.openSheet('goto-position'));
    case 'u':
      if (!hasDoc || textField) return false;
      return run(() => {
        app.change((r) => reverseComplementRecord(r), 'Reverse Complement');
        app.flash('Flipped sequence (reverse complement)');
      });
    case 'c':
      if (!e.shiftKey || !hasDoc || textField) return false;
      return run(() => void copyReverseComplementSelection(doc));
    case 'k':
      if (!e.shiftKey || !hasDoc || textField) return false;
      return run(() => void copyTranslationSelection(doc));
    case '1':
    case '2':
    case '3': {
      if (!hasDoc || textField) return false;
      const view: ViewMode = key === '1' ? 'map' : key === '2' ? 'sequence' : 'split';
      return run(() => app.setView(view));
    }
    default:
      return false;
  }
}
