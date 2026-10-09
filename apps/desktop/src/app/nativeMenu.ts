/**
 * The macOS menu bar (Tauri menu API). Windows and Linux have no native menu bar: the same
 * commands are reachable from the toolbar, context menus and keyboard shortcuts.
 *
 * Note: on macOS the menu's key equivalents are handled before the web view sees the keys, so
 * every shortcut that has a menu item runs through here (the keydown handler is the fallback
 * for the browser and the other platforms).
 */
import { isTauri, platform } from '../platform';
import { useSettings } from '../state/settings';
import { useApp } from '../state/store';
import { requestClose, requestQuit } from './commands';
import { openWithDialog, saveDocument } from './files';
import { isMac } from './shortcuts';

function editingText(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el || el.closest('[data-hh-sequence]')) return false;
  return el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA';
}

export function installNativeMenu(focusSearch: () => void): () => void {
  if (!isTauri() || !isMac()) return () => undefined;
  let cancelled = false;
  void (async () => {
    const { Menu, MenuItem, PredefinedMenuItem, Submenu } = await import('@tauri-apps/api/menu');
    const app = () => useApp.getState();
    const withDoc = (fn: () => void) => () => {
      if (app().activeId) fn();
    };
    const item = (text: string, accelerator: string | undefined, action: () => void, enabled = true) =>
      MenuItem.new({ text, ...(accelerator ? { accelerator } : {}), enabled, action: () => action() });
    const sep = () => PredefinedMenuItem.new({ item: 'Separator' });

    const appMenu = await Submenu.new({
      text: 'HHereditas',
      items: [
        await PredefinedMenuItem.new({ item: { About: null }, text: 'About HHereditas' }),
        await sep(),
        await PredefinedMenuItem.new({ item: 'Services' }),
        await sep(),
        await PredefinedMenuItem.new({ item: 'Hide' }),
        await PredefinedMenuItem.new({ item: 'HideOthers' }),
        await PredefinedMenuItem.new({ item: 'ShowAll' }),
        await sep(),
        await item('Quit HHereditas', 'CmdOrCtrl+Q', () => {
          if (requestQuit()) platform.closeWindow();
        }),
      ],
    });
    const fileMenu = await Submenu.new({
      text: 'File',
      items: [
        await item('New Sequence…', 'CmdOrCtrl+N', () => app().openSheet('new-sequence')),
        await item('Open…', 'CmdOrCtrl+O', () => void openWithDialog()),
        await sep(),
        await item('Close', 'CmdOrCtrl+W', withDoc(() => requestClose())),
        await item('Save', 'CmdOrCtrl+S', withDoc(() => void saveDocument())),
        await item('Save As…', 'CmdOrCtrl+Shift+S', withDoc(() => void saveDocument(undefined, true))),
      ],
    });
    const editMenu = await Submenu.new({
      text: 'Edit',
      items: [
        await item('Undo', 'CmdOrCtrl+Z', () => (editingText() ? document.execCommand('undo') : app().undo())),
        await item('Redo', 'CmdOrCtrl+Shift+Z', () => (editingText() ? document.execCommand('redo') : app().redo())),
        await sep(),
        await PredefinedMenuItem.new({ item: 'Cut' }),
        await PredefinedMenuItem.new({ item: 'Copy' }),
        await PredefinedMenuItem.new({ item: 'Paste' }),
        await PredefinedMenuItem.new({ item: 'SelectAll' }),
        await sep(),
        await item('Find…', 'CmdOrCtrl+F', withDoc(focusSearch)),
      ],
    });
    const settings = () => useSettings.getState();
    const viewMenu = await Submenu.new({
      text: 'View',
      items: [
        await item('Map', 'CmdOrCtrl+1', withDoc(() => app().setView('map'))),
        await item('Sequence', 'CmdOrCtrl+2', withDoc(() => app().setView('sequence'))),
        await item('Map and Sequence', 'CmdOrCtrl+3', withDoc(() => app().setView('split'))),
        await sep(),
        await item('Toggle Sidebar', 'Alt+CmdOrCtrl+S', () => settings().update({ sidebarVisible: !settings().sidebarVisible })),
        await item('Toggle Inspector', 'Alt+CmdOrCtrl+I', () => settings().update({ inspectorVisible: !settings().inspectorVisible })),
        await sep(),
        await PredefinedMenuItem.new({ item: 'Fullscreen' }),
      ],
    });
    const toolsMenu = await Submenu.new({
      text: 'Tools',
      items: [
        await item('Digest & Gel…', 'CmdOrCtrl+D', withDoc(() => app().openSheet('digest'))),
        await item('Choose Enzymes…', undefined, withDoc(() => app().openSheet('choose-enzymes'))),
        await item('Show Open Reading Frames', undefined, () => settings().update({ showOrfs: !settings().showOrfs })),
        await sep(),
        await item('Cloning (coming soon)', undefined, () => undefined, false),
      ],
    });
    const windowMenu = await Submenu.new({
      text: 'Window',
      items: [await PredefinedMenuItem.new({ item: 'Minimize' }), await PredefinedMenuItem.new({ item: 'Maximize' }), await sep(), await PredefinedMenuItem.new({ item: 'BringAllToFront' })],
    });
    if (cancelled) return;
    const menu = await Menu.new({ items: [appMenu, fileMenu, editMenu, viewMenu, toolsMenu, windowMenu] });
    await menu.setAsAppMenu();
  })().catch(() => undefined);
  return () => {
    cancelled = true;
  };
}
