/**
 * Keyboard shortcuts (Cmd on macOS, Ctrl elsewhere). One table: the toolbar shows the same
 * bindings in its tooltips.
 */
import type { ToolbarShortcuts, ViewMode } from '../shell';
import { useSettings } from '../state/settings';
import { useApp } from '../state/store';
import { requestClose } from './commands';
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

/** Open the toolbar's enzyme menu (Radix menus open from the keyboard on Enter). */
function openEnzymeMenu() {
  const button = document.querySelector<HTMLButtonElement>('button[aria-label="Enzymes"]');
  if (!button || button.disabled) return;
  button.focus();
  button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
}

export interface ShortcutContext {
  focusSearch: () => void;
}

/** Handle a keydown; returns true when it was a shortcut. */
export function handleShortcut(e: KeyboardEvent, ctx: ShortcutContext): boolean {
  const mac = isMac();
  const mod = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  if (!mod) return false;
  const app = useApp.getState();
  const hasDoc = app.activeId !== null;
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
      return run(ctx.focusSearch);
    case 'd':
      if (!hasDoc) return false;
      return run(() => app.openSheet('digest'));
    case 'e':
      if (!hasDoc) return false;
      return run(openEnzymeMenu);
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
