/**
 * What the app needs from its host: the Tauri desktop shell or a plain browser (dev mode,
 * Playwright). Tauri-only abilities degrade gracefully in the browser.
 */
import type { FileFormat } from '../state/documents';

export interface OpenedFile {
  name: string;
  /** Absolute path (desktop app); null for browser File objects. */
  path: string | null;
  data: Uint8Array;
}

export interface SaveTarget {
  /** Absolute path (desktop app); null in the browser (the file is downloaded). */
  path: string | null;
  name: string;
  format: FileFormat;
}

export type DragDropEventKind = { type: 'over' } | { type: 'leave' } | { type: 'drop'; paths: string[] };

export interface PlatformApi {
  kind: 'tauri' | 'browser';
  /** Native "Open" dialog; empty when cancelled. */
  pickFiles: () => Promise<OpenedFile[]>;
  /** Read a file by path (desktop app only). */
  readPath: (path: string) => Promise<OpenedFile>;
  /**
   * Native "Save As" dialog (desktop app). The browser has no save dialog and returns
   * undefined: the app then asks for a name and format itself.
   */
  chooseSaveTarget: (defaultName: string, format: FileFormat) => Promise<SaveTarget | null | undefined>;
  writeFile: (target: SaveTarget, data: Uint8Array | string) => Promise<void>;
  setTitle: (title: string) => void;
  /** Files the operating system asks the app to open (double-click, "Open With", second launch). */
  onOpenPaths: (cb: (paths: string[]) => void) => () => void;
  /** Files dragged onto the window (desktop app; the browser uses DOM drag events). */
  onDragDrop: (cb: (event: DragDropEventKind) => void) => () => void;
  /**
   * The window is about to close. Return true to allow it; false keeps it open (the app then
   * closes it itself with closeWindow() once the user decided).
   */
  onCloseRequested: (handler: () => boolean) => () => void;
  closeWindow: () => void;
}

/** File-dialog filters, GenBank first (the default format). */
export const SAVE_FORMATS: readonly { format: FileFormat; name: string; extension: string }[] = [
  { format: 'genbank', name: 'GenBank', extension: 'gb' },
  { format: 'fasta', name: 'FASTA', extension: 'fasta' },
  { format: 'snapgene', name: 'SnapGene (experimental)', extension: 'dna' },
];

export function extensionOf(format: FileFormat): string {
  return SAVE_FORMATS.find((f) => f.format === format)?.extension ?? 'gb';
}

/** Format implied by a file name's extension. */
export function formatFromName(name: string): FileFormat | null {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (['gb', 'gbk', 'genbank', 'gbff', 'ape'].includes(ext)) return 'genbank';
  if (['fa', 'fasta', 'fas', 'fna', 'ffn'].includes(ext)) return 'fasta';
  if (ext === 'dna') return 'snapgene';
  return null;
}
