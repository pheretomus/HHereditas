/**
 * The application: welcome screen or document window, the sheets and alerts, global shortcuts,
 * the window title, files from the OS (open-files events, drag and drop) and the unsaved
 * changes guard when the window closes.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { CloningSheets } from '../features/cloning';
import { ChooseEnzymesSheet } from '../features/enzymes/ChooseEnzymesSheet';
import { DigestSheet } from '../features/enzymes/DigestSheet';
import { AddFeatureSheet } from '../features/features/AddFeatureSheet';
import { AddPrimerSheet } from '../features/primers/AddPrimerSheet';
import { ClosePromptDialog } from '../features/dialogs/ClosePromptDialog';
import { NewSequenceSheet } from '../features/dialogs/NewSequenceSheet';
import { SaveAsSheet } from '../features/dialogs/SaveAsSheet';
import { platform, readBrowserFile } from '../platform';
import { WelcomeScreen, type RecentFile } from '../shell';
import { folderOf, isDirty } from '../state/documents';
import { useSettings, type RecentEntry } from '../state/settings';
import { useActiveDocument, useApp } from '../state/store';
import { requestQuit } from './commands';
import { DocumentWindow } from './DocumentWindow';
import { openFiles, openPaths, openWithDialog } from './files';
import { SAMPLES } from './samples';
import { handleShortcut } from './shortcuts';
import { installNativeMenu } from './nativeMenu';
import styles from './App.module.css';

const APP_NAME = 'HHereditas';
const VERSION = '0.1.0';

function formatRecentDate(ms: number): string {
  if (!ms) return '';
  const d = new Date(ms);
  const now = new Date();
  const days = Math.floor((new Date(now.toDateString()).getTime() - new Date(d.toDateString()).getTime()) / 86_400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
}

function recentFiles(entries: readonly RecentEntry[]): RecentFile[] {
  return entries.map((r) => ({
    id: r.path,
    name: r.name,
    location: folderOf(r.path),
    modified: formatRecentDate(r.openedAt),
    ...(r.length !== undefined ? { length: r.length } : {}),
    ...(r.topology ? { topology: r.topology } : {}),
  }));
}

export function App() {
  const hasDocuments = useApp((s) => s.documents.length > 0);
  const sheet = useApp((s) => s.sheet);
  const sheetOptions = useApp((s) => s.sheetOptions);
  const doc = useActiveDocument();
  const recent = useSettings((s) => s.recentFiles);
  const searchRef = useRef<HTMLInputElement>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [dropActive, setDropActive] = useState(false);

  const focusSearch = useCallback(() => {
    const input = searchRef.current;
    if (input) {
      input.focus();
      input.select();
    } else {
      // Narrow toolbar: the search field lives in a popover behind a button.
      document.querySelector<HTMLButtonElement>('button[aria-label="Search sequence"]')?.click();
    }
  }, []);

  // Global shortcuts (capture phase, so views that handle keys themselves do not swallow them).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      handleShortcut(e, { focusSearch });
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [focusSearch]);

  // Window title: "<name> — Edited" like a macOS document window.
  const title = doc ? `${doc.record.name}${isDirty(doc) ? ' — Edited' : ''}` : APP_NAME;
  useEffect(() => platform.setTitle(title), [title]);

  // Files from the operating system, drag and drop onto the window, closing with unsaved changes.
  useEffect(() => {
    const stops = [
      platform.onOpenPaths((paths) => void openPaths(paths)),
      platform.onDragDrop((e) => {
        if (e.type === 'over') setDropActive(true);
        else {
          setDropActive(false);
          if (e.type === 'drop' && e.paths.length) void openPaths(e.paths);
        }
      }),
      platform.onCloseRequested(requestQuit),
      installNativeMenu(focusSearch),
    ];
    return () => stops.forEach((stop) => stop());
  }, [focusSearch]);

  // Browser drag and drop over the document window (the welcome screen handles its own).
  useEffect(() => {
    if (platform.kind !== 'browser' || !hasDocuments) return;
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
    const over = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const drop = async (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      const files = Array.from(e.dataTransfer?.files ?? []);
      openFiles(await Promise.all(files.map(readBrowserFile)));
    };
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragover', over);
      window.removeEventListener('drop', drop);
    };
  }, [hasDocuments]);

  const app = useApp.getState();

  return (
    <div className={styles.app}>
      {hasDocuments ? (
        <DocumentWindow searchRef={searchRef} searchQuery={searchQuery} onSearchQueryChange={setSearchQuery} />
      ) : (
        <WelcomeScreen
          appName={APP_NAME}
          version={VERSION}
          onOpen={() => void openWithDialog()}
          onNewSequence={() => app.openSheet('new-sequence')}
          recentFiles={platform.kind === 'tauri' ? recentFiles(recent) : []}
          onOpenRecent={(file) => void openPaths([file.id])}
          onClearRecent={recent.length ? () => useSettings.getState().clearRecent() : undefined}
          samples={SAMPLES}
          onOpenSample={(sample) => {
            const s = SAMPLES.find((x) => x.id === sample.id);
            if (s) openFiles([{ name: s.fileName, path: null, data: new TextEncoder().encode(s.text) }], { name: s.name });
          }}
          {...(platform.kind === 'tauri' ? { dropActive } : {})}
          onDropFiles={async (files) => openFiles(await Promise.all(files.map(readBrowserFile)))}
        />
      )}
      <DigestSheet open={sheet === 'digest'} doc={doc} initialEnzymes={sheetOptions.enzymes} />
      <AddPrimerSheet open={sheet === 'add-primer'} doc={doc} direction={sheetOptions.direction ?? 1} />
      <AddFeatureSheet open={sheet === 'add-feature'} doc={doc} />
      <NewSequenceSheet open={sheet === 'new-sequence'} />
      <ChooseEnzymesSheet open={sheet === 'choose-enzymes'} doc={doc} />
      <SaveAsSheet open={sheet === 'save-as'} defaultName={sheetOptions.defaultName} format={sheetOptions.format} />
      <CloningSheets sheet={sheet} doc={doc} />
      <ClosePromptDialog />
    </div>
  );
}
