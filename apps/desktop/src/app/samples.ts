/** Sample plasmids bundled with the app (src/samples/*.gb, see the README there). */
import { parseAny } from '@hhereditas/core';
import type { SampleSequence } from '../shell';

const SOURCES = import.meta.glob<string>('../samples/*.gb', { query: '?raw', import: 'default', eager: true });

const DESCRIPTIONS: Record<string, string> = {
  pUC19: 'High-copy cloning vector',
  pBR322: 'Classic E. coli cloning vector',
  pBAD30: 'Arabinose-inducible expression vector',
};

export interface BundledSample extends SampleSequence {
  fileName: string;
  text: string;
}

export const SAMPLES: readonly BundledSample[] = Object.entries(SOURCES)
  .map(([path, text]) => {
    const fileName = path.split('/').pop() ?? path;
    const id = fileName.replace(/\.gb$/, '');
    const record = parseAny(text, fileName).records[0];
    return {
      id,
      fileName,
      text,
      name: id,
      description: DESCRIPTIONS[id] ?? record?.description,
      length: record?.seq.length ?? 0,
      topology: record?.topology ?? 'circular',
    };
  })
  .sort((a, b) => a.name.localeCompare(b.name));
