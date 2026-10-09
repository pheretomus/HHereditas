/** Browser implementation (dev mode, tests): <input type=file>, Blob downloads, beforeunload. */
import { SEQUENCE_FILE_EXTENSIONS } from '@hhereditas/core';
import type { OpenedFile, PlatformApi, SaveTarget } from './types';

const ACCEPT = Object.values(SEQUENCE_FILE_EXTENSIONS)
  .flat()
  .map((e) => `.${e}`)
  .join(',');

export async function readBrowserFile(file: File): Promise<OpenedFile> {
  return { name: file.name, path: null, data: new Uint8Array(await file.arrayBuffer()) };
}

function pickFiles(): Promise<OpenedFile[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = `${ACCEPT},.txt,text/plain`;
    input.style.display = 'none';
    input.addEventListener('change', async () => {
      const files = Array.from(input.files ?? []);
      input.remove();
      resolve(await Promise.all(files.map(readBrowserFile)));
    });
    input.addEventListener('cancel', () => {
      input.remove();
      resolve([]);
    });
    document.body.appendChild(input);
    input.click();
  });
}

function download(target: SaveTarget, data: Uint8Array | string) {
  const blob =
    typeof data === 'string'
      ? new Blob([data], { type: 'text/plain;charset=utf-8' })
      : new Blob([data.slice().buffer as ArrayBuffer], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = target.name;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export const browserPlatform: PlatformApi = {
  kind: 'browser',
  pickFiles,
  readPath: () => Promise.reject(new Error('Opening files by path needs the desktop app')),
  chooseSaveTarget: () => Promise.resolve(undefined),
  writeFile: async (target, data) => download(target, data),
  setTitle: (title) => {
    document.title = title;
  },
  onOpenPaths: () => () => undefined,
  onDragDrop: () => () => undefined,
  onCloseRequested: (handler) => {
    const listener = (e: BeforeUnloadEvent) => {
      if (!handler()) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', listener);
    return () => window.removeEventListener('beforeunload', listener);
  },
  closeWindow: () => window.close(),
};
