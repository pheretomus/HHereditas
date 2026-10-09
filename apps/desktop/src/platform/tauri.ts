/** Desktop implementation: Tauri dialog and fs plugins, window and webview APIs. */
import { SEQUENCE_FILE_EXTENSIONS } from '@hhereditas/core';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { open, save } from '@tauri-apps/plugin-dialog';
import { readFile, writeFile, writeTextFile } from '@tauri-apps/plugin-fs';
import { fileNameOf } from '../state/documents';
import { SAVE_FORMATS, formatFromName, type OpenedFile, type PlatformApi } from './types';

const OPEN_FILTERS = [
  {
    name: 'Sequence files',
    extensions: [...Object.values(SEQUENCE_FILE_EXTENSIONS).flat()],
  },
  { name: 'All files', extensions: ['*'] },
];

async function readPath(path: string): Promise<OpenedFile> {
  return { name: fileNameOf(path), path, data: await readFile(path) };
}

/** Subscribe to an async Tauri listener; the returned function also works before it resolved. */
function subscribe(start: () => Promise<() => void>): () => void {
  let stop: (() => void) | null = null;
  let cancelled = false;
  start()
    .then((unlisten) => {
      if (cancelled) unlisten();
      else stop = unlisten;
    })
    .catch(() => undefined);
  return () => {
    cancelled = true;
    stop?.();
  };
}

export const tauriPlatform: PlatformApi = {
  kind: 'tauri',

  pickFiles: async () => {
    const picked = await open({ multiple: true, directory: false, filters: OPEN_FILTERS });
    if (!picked) return [];
    const paths = Array.isArray(picked) ? picked : [picked];
    return Promise.all(paths.map(readPath));
  },

  readPath,

  chooseSaveTarget: async (defaultName, format) => {
    const preferred = SAVE_FORMATS.find((f) => f.format === format) ?? SAVE_FORMATS[0];
    const filters = [preferred, ...SAVE_FORMATS.filter((f) => f !== preferred)].map((f) => ({ name: f.name, extensions: [f.extension] }));
    const path = await save({ defaultPath: defaultName, filters });
    if (!path) return null;
    const name = fileNameOf(path);
    return { path, name, format: formatFromName(name) ?? format };
  },

  writeFile: async (target, data) => {
    if (!target.path) throw new Error('No file path');
    if (typeof data === 'string') await writeTextFile(target.path, data);
    else await writeFile(target.path, data);
  },

  setTitle: (title) => {
    document.title = title;
    getCurrentWindow()
      .setTitle(title)
      .catch(() => undefined);
  },

  onOpenPaths: (cb) =>
    subscribe(async () => {
      const unlisten = await listen<string[]>('open-files', (e) => cb(e.payload));
      // Files that arrived before the listener existed (command-line arguments, first launch).
      const pending = await invoke<string[]>('take_pending_open_files');
      if (pending.length) cb(pending);
      return unlisten;
    }),

  onDragDrop: (cb) =>
    subscribe(() =>
      getCurrentWebview().onDragDropEvent((e) => {
        const p = e.payload;
        if (p.type === 'enter' || p.type === 'over') cb({ type: 'over' });
        else if (p.type === 'leave') cb({ type: 'leave' });
        else cb({ type: 'drop', paths: p.paths });
      }),
    ),

  onCloseRequested: (handler) =>
    subscribe(() =>
      getCurrentWindow().onCloseRequested((event) => {
        if (!handler()) event.preventDefault();
      }),
    ),

  closeWindow: () => {
    getCurrentWindow()
      .destroy()
      .catch(() => undefined);
  },
};
