/**
 * SnapGene `<Primers>` XML (packet 0x05) <-> {@link Primer}.
 *
 *   <Primers nextValidID="1">
 *     <HybridizationParams minContinuousMatchLen="10" allowMismatch="1" minMeltingTemperature="40" .../>
 *     <Primer recentID="0" name="M13 Forward" sequence="TGTAAAACGACGGCCAGT" description="..."
 *             dateAdded="2023-01-22T18:09:42Z">
 *       <BindingSite location="..." boundStrand="0" .../>
 *     </Primer>
 *   </Primers>
 *
 * Binding sites stored in the file are ignored: HHereditas computes them from the sequence
 * (see types.ts `Primer`). Source: fixtures; Biopython SnapGeneIO; sgffp format spec.
 */
import { IUPAC_DNA, normalizeDna } from '../seq/alphabet';
import { newId } from '../seq/id';
import type { Primer } from '../types';
import type { ParseWarning } from './types';
import { childElements, richTextToPlain, storeOneLine, xmlElement, type XmlElement } from './snapgene-markup';
import { clip, listCharacters } from './snapgene-messages';

/**
 * Normalize a primer sequence with `normalizeDna` (uppercase IUPAC, 'U' -> 'T') and list every
 * non-whitespace character it removed (including the digits and separators that
 * `normalizeDna` drops silently), so that callers can report them.
 */
function cleanPrimerSequence(raw: string): { seq: string; removed: string[] } {
  const { seq } = normalizeDna(raw);
  const removed = new Set<string>();
  for (const ch of raw) {
    if (/\s/.test(ch)) continue;
    const upper = ch.toUpperCase();
    if (IUPAC_DNA[upper === 'U' ? 'T' : upper] === undefined) removed.add(ch);
  }
  return { seq, removed: [...removed] };
}

/**
 * Hybridization parameters written with the primers: the values found in every fixture
 * written by recent SnapGene versions (e.g. sample-f.dna, sample-hybridization-params.dna).
 * They only steer how SnapGene itself searches for binding sites.
 */
const HYBRIDIZATION_PARAMS: ReadonlyArray<readonly [string, string]> = [
  ['minContinuousMatchLen', '10'],
  ['allowMismatch', '1'],
  ['minMeltingTemperature', '40'],
  ['showAdditionalFivePrimeMatches', '1'],
  ['minimumFivePrimeAnnealing', '15'],
];

/**
 * Read the primers of a `<Primers>` element. Sequences are normalized to uppercase IUPAC
 * ('U' -> 'T'); characters that are not nucleotide codes are dropped with a warning, and a
 * primer without any valid base is skipped. An empty description (SnapGene writes an empty
 * HTML document) is omitted.
 */
export function parsePrimers(root: XmlElement, warnings: ParseWarning[]): Primer[] {
  const primers: Primer[] = [];
  childElements(root, 'Primer').forEach((element, index) => {
    const name = richTextToPlain(element.attributes.get('name') ?? '', 'line') || `Primer ${index + 1}`;
    const { seq, removed } = cleanPrimerSequence(element.attributes.get('sequence') ?? '');
    if (removed.length > 0) {
      warnings.push({ message: `Primer "${clip(name)}": removed characters that are not nucleotide codes (${listCharacters(removed)}).` });
    }
    if (seq === '') {
      warnings.push({ message: `Primer "${clip(name)}" has no sequence; skipped.` });
      return;
    }
    const description = richTextToPlain(element.attributes.get('description') ?? '', 'line');
    primers.push({ id: newId('p'), name, sequence: seq, ...(description !== '' ? { description } : {}) });
  });
  return primers;
}

/** ISO 8601 UTC timestamp without milliseconds, as in SnapGene's `dateAdded` ("2023-01-22T18:09:42Z"). */
function isoSeconds(date: Date): string {
  return `${date.toISOString().slice(0, 19)}Z`;
}

/**
 * Build the `<Primers>` packet text. Primer sequences are written in uppercase IUPAC
 * (invalid characters are dropped with a warning; primers left empty are not written).
 * No `<BindingSite>` elements are written, because HHereditas does not store binding sites
 * (they are computed); how SnapGene displays primers without them has not been verified.
 * Names and descriptions whose line breaks or spacing will not read back are listed in `changedText`.
 */
export function buildPrimersXml(primers: readonly Primer[], now: Date, warnings: ParseWarning[], changedText: string[] = []): string {
  const dateAdded = isoSeconds(now);
  const written: string[] = [];
  primers.forEach((primer, index) => {
    const name = primer.name.trim() || `Primer ${index + 1}`;
    const { seq, removed } = cleanPrimerSequence(primer.sequence);
    if (removed.length > 0) {
      warnings.push({ message: `Primer "${clip(name)}": characters that are not nucleotide codes were not written (${listCharacters(removed)}).` });
    }
    if (seq === '') {
      warnings.push({ message: `Primer "${clip(name)}" has no sequence; not written.` });
      return;
    }
    const who = `Primer "${clip(name)}"`;
    const description = primer.description !== undefined && primer.description.trim() !== '' ? storeOneLine(primer.description.trim(), `${who} description`, changedText) : undefined;
    written.push(
      xmlElement('Primer', [
        ['recentID', String(written.length)],
        ['name', storeOneLine(name, `${who} name`, changedText)],
        ['sequence', seq],
        ['description', description],
        ['dateAdded', dateAdded],
      ]),
    );
  });
  const content = xmlElement('HybridizationParams', HYBRIDIZATION_PARAMS) + written.join('');
  return `<?xml version="1.0"?>${xmlElement('Primers', [['nextValidID', String(written.length)]], content)}\n`;
}
