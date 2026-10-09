/**
 * Opening and saving documents: parsing with the core readers, writing GenBank / FASTA /
 * SnapGene, the Save / Save As flow and the recent-files list.
 */
import type { Feature, SeqRecord } from '@hhereditas/core';
import { featureLabel, parseAny, writeFasta, writeGenbank, writeSnapGeneWithWarnings } from '@hhereditas/core';
import { platform, extensionOf, type OpenedFile, type SaveTarget } from '../platform';
import { primerSites } from '../state/analysis';
import { fileNameOf, stripExtension, writableFormat, type FileFormat } from '../state/documents';
import { useSettings } from '../state/settings';
import { getActiveDocument, useApp } from '../state/store';

/** Parse files and open every record they contain. Returns the number of documents opened. */
export function openFiles(files: readonly OpenedFile[], options: { name?: string } = {}): number {
  const app = useApp.getState();
  let opened = 0;
  for (const file of files) {
    const result = parseAny(file.data, file.name);
    if (result.records.length === 0) {
      app.flash(`Could not open ${file.name}: ${result.warnings[0]?.message ?? 'no sequence found'}`, 'error');
      continue;
    }
    // Vector NTI / ApE write spaces in labels as backslashes ("araC\promoter"); show them as spaces.
    for (const r of result.records) {
      if (r.features.some((f) => f.name.includes('\\'))) {
        r.features = r.features.map((f) => (f.name.includes('\\') ? { ...f, name: f.name.replace(/\\/g, ' ') } : f));
      }
    }
    // e.g. bundled samples: "pUC19" rather than the GenBank LOCUS name "SYNPUC19V".
    if (options.name && result.records.length === 1) result.records[0] = { ...result.records[0], name: options.name };
    const format = writableFormat(result.records[0].meta.sourceFormat);
    const warnings = result.warnings.map((w) => (w.line ? `Line ${w.line}: ${w.message}` : w.message));
    app.openRecords(result.records, { filePath: file.path, fileName: file.name, format, warnings });
    opened += result.records.length;
    if (file.path) {
      const r = result.records[0];
      useSettings.getState().addRecent({ path: file.path, name: file.name, length: r.seq.length, topology: r.topology });
    }
  }
  return opened;
}

export async function openPaths(paths: readonly string[]): Promise<void> {
  const files: OpenedFile[] = [];
  for (const path of paths) {
    try {
      files.push(await platform.readPath(path));
    } catch (e) {
      useApp.getState().flash(`Could not read ${fileNameOf(path)}: ${e instanceof Error ? e.message : String(e)}`, 'error');
    }
  }
  openFiles(files);
}

export async function openWithDialog(): Promise<void> {
  try {
    openFiles(await platform.pickFiles());
  } catch (e) {
    useApp.getState().flash(`Could not open: ${e instanceof Error ? e.message : String(e)}`, 'error');
  }
}

/**
 * GenBank cannot store primers: they are written as primer_bind features at their binding
 * sites (as SnapGene and Benchling export them), so they are not lost.
 */
export function withPrimerFeatures(record: SeqRecord): SeqRecord {
  if (record.primers.length === 0) return record;
  const { sites } = primerSites(record);
  const features: Feature[] = [];
  for (const site of sites) {
    const primer = record.primers.find((p) => p.id === site.primerId);
    if (!primer) continue;
    const qualifiers = [
      { key: 'label', value: primer.name },
      { key: 'note', value: `sequence: ${primer.sequence}` },
    ];
    features.push({
      id: `${primer.id}-${site.range.start}-${site.strand}`,
      type: 'primer_bind',
      name: featureLabel('primer_bind', qualifiers),
      strand: site.strand,
      segments: [{ ...site.range }],
      qualifiers,
    });
  }
  return features.length ? { ...record, features: [...record.features, ...features] } : record;
}

export interface Serialized {
  data: Uint8Array | string;
  warnings: string[];
}

export function serialize(record: SeqRecord, format: FileFormat): Serialized {
  switch (format) {
    case 'genbank':
      return { data: writeGenbank(withPrimerFeatures(record)), warnings: [] };
    case 'fasta':
      return { data: writeFasta(record), warnings: [] };
    case 'snapgene': {
      const { data, warnings } = writeSnapGeneWithWarnings(record);
      return { data, warnings: warnings.map((w) => w.message) };
    }
  }
}

/** Default file name for a document in a format. */
export function defaultFileName(name: string, format: FileFormat): string {
  const base = stripExtension(name).replace(/[\\/:*?"<>|]+/g, '_').trim() || 'Untitled';
  return `${base}.${extensionOf(format)}`;
}

// The browser has no save dialog: the app shows its own Save As sheet and resolves this.
let pendingSaveAs: ((target: SaveTarget | null) => void) | null = null;

/** Called by the Save As sheet (browser). */
export function resolveSaveAs(target: SaveTarget | null) {
  const resolve = pendingSaveAs;
  pendingSaveAs = null;
  useApp.getState().closeSheet();
  resolve?.(target);
}

async function chooseTarget(docId: string, defaultName: string, format: FileFormat): Promise<SaveTarget | null> {
  const native = await platform.chooseSaveTarget(defaultName, format);
  if (native !== undefined) return native;
  pendingSaveAs?.(null);
  return new Promise((resolve) => {
    pendingSaveAs = resolve;
    useApp.getState().openSheet('save-as', { docId, defaultName, format });
  });
}

/**
 * Save a document. Save writes back to its file when that is a GenBank or FASTA file; new
 * documents, browser documents and SnapGene sources go through Save As (SnapGene writing is
 * experimental, so it is never chosen silently). Resolves true when the document was written.
 */
export async function saveDocument(docId: string | null = getActiveDocument()?.id ?? null, saveAs = false): Promise<boolean> {
  const app = useApp.getState();
  const doc = app.documents.find((d) => d.id === docId);
  if (!doc) return false;
  let target: SaveTarget | null;
  const inPlace = !saveAs && doc.filePath && doc.fileName && (doc.format === 'genbank' || doc.format === 'fasta');
  if (inPlace) {
    target = { path: doc.filePath, name: doc.fileName!, format: doc.format! };
  } else {
    const format: FileFormat = doc.format === 'fasta' ? 'fasta' : 'genbank';
    target = await chooseTarget(doc.id, defaultFileName(doc.fileName ?? doc.record.name, format), format);
  }
  if (!target) return false;
  const record = useApp.getState().documents.find((d) => d.id === doc.id)?.record ?? doc.record;
  try {
    const { data, warnings } = serialize(record, target.format);
    await platform.writeFile(target, data);
    useApp.getState().markSaved(doc.id, { record, filePath: target.path, fileName: target.name, format: target.format });
    if (target.path) {
      useSettings.getState().addRecent({ path: target.path, name: target.name, length: record.seq.length, topology: record.topology });
    }
    const verb = target.path ? 'Saved' : 'Downloaded';
    useApp
      .getState()
      .flash(warnings.length ? `${verb} ${target.name} (${warnings.length} item${warnings.length > 1 ? 's' : ''} not representable in this format)` : `${verb} ${target.name}`);
    return true;
  } catch (e) {
    useApp.getState().flash(`Could not save ${target.name}: ${e instanceof Error ? e.message : String(e)}`, 'error');
    return false;
  }
}
