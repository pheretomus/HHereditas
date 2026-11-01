/**
 * File access on Android through the Tauri dialog and fs plugins. The picker returns a
 * content:// URI, which the fs plugin can read directly.
 */
import { open } from '@tauri-apps/plugin-dialog';
import { readFile } from '@tauri-apps/plugin-fs';

export interface OpenedFile {
  name: string;
  data: Uint8Array;
}

function fileNameOf(path: string): string {
  const tail = decodeURIComponent(path.split(/[\\/]/).pop() ?? path);
  // content:// URIs often end in "document/primary:Download/pUC19.gb".
  return tail.split(':').pop() ?? tail;
}

export async function pickFile(): Promise<OpenedFile | null> {
  // No extension filters: the Android picker turns them into MIME types through
  // MimeTypeMap, which knows nothing about .gb/.dna/.fasta, so every sequence file
  // would be greyed out. Without filters the picker offers "*/*" and the parser
  // sniffs the format itself.
  const picked = await open({ multiple: false, directory: false });
  if (!picked) return null;
  const path = Array.isArray(picked) ? picked[0] : picked;
  if (!path) return null;
  return { name: fileNameOf(path), data: await readFile(path) };
}
