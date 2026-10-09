/**
 * PCR simulation: products of a primer pair on a linear or circular template.
 *
 * Binding sites come from `primers/binding` (3'-anchored annealing, optional mismatches). A
 * forward-direction site (strand 1) and a reverse-direction site (strand -1) facing each other make
 * one product. Coordinates follow `types.ts`.
 */
import type { Feature, Primer, PrimerBindingSite, SeqRecord } from '../types';
import { reverseComplement } from '../seq/alphabet';
import { makeFeature, makeRecord } from '../seq/features';
import { newId } from '../seq/id';
import { mod, sliceRange } from '../seq/range';
import { findBindingSites } from '../primers/binding';
import type { BindingOptions } from '../primers/binding';
import { concatRecords, extractRange } from '../ops/transform';
import type { CloningOutcome } from './result';
import { errorMessage, failure, outcome } from './result';

/** Options of {@link pcr}: primer binding options plus the product name. */
export type PcrOptions = BindingOptions & {
  /** Name of the product. Default `<template name> PCR`; with several products ` (n bp)` is appended. */
  name?: string;
  /** Maximum number of products returned (largest numbers of products are reported, not built). Default 50. */
  maxProducts?: number;
};

/** Where one product came from. */
export interface PcrAmplicon {
  /** Binding site of the primer whose sequence starts the product's top strand. */
  forwardSite: PrimerBindingSite;
  /** Binding site of the primer whose reverse complement ends the product's top strand. */
  reverseSite: PrimerBindingSite;
  /**
   * Template region copied between the two primers' 5' annealed ends, in template top-strand
   * coordinates (circular templates: start in [0, L), end may exceed L).
   */
  templateRange: { start: number; end: number };
  /** Product length in bp (tails included). */
  length: number;
}

/** Result of {@link pcr}: the common outcome plus one {@link PcrAmplicon} per product (same order). */
export interface PcrResult extends CloningOutcome {
  amplicons: PcrAmplicon[];
}

const DEFAULT_MAX_PRODUCTS = 50;

/**
 * Simulate a PCR with `forward` and `reverse` primers on `template`.
 *
 * Product rule: for a forward-direction site [fs, fe) (primer anneals to the bottom strand and
 * extends rightwards) and a reverse-direction site [rs, re) downstream of it, the product's top
 * strand is
 *   full forward primer (5' tail included) + template[fe, rs) + reverseComplement(full reverse primer)
 * so its length is tailF + (re - fs) + tailR. When the two annealed regions overlap (fe > rs) the
 * reverse primer's copy of the overlap is dropped. Inside the annealed regions the product carries
 * the PRIMER's bases (mismatches are "corrected" to the primer, as in a real PCR).
 *
 * Pairing: the site pairs must face each other. Linear templates: the reverse site must start at or
 * after the forward site's start and end at or after its 3' end (fs <= rs and fe <= re). Circular
 * templates: the reverse site is reached by walking rightwards from the forward site, possibly across
 * the origin (the product then spans the origin); every pair of sites gives exactly one product, at
 * most one full turn of template plus the primers.
 * Both primers are searched in both orientations: the designated pair (forward primer on strand 1,
 * reverse primer on strand -1) is the normal case; products from swapped primers or from one primer
 * acting at both ends are also made in a real reaction, so they are returned too, with a warning.
 *
 * Products are sorted by length (smallest first) and are linear and blunt. Features: template
 * features inside the copied region are clipped to it (partial flags for clipped ones) and shifted
 * by the forward tail; one `primer_bind` feature per primer covers the full primer (tail included),
 * strand 1 at the left end, strand -1 at the right end. Product primers = the two primers.
 *
 * Several products: all are returned (up to `maxProducts`) with a warning. No product: `error`
 * explains why (a primer does not bind; both bind but never face each other; invalid primer).
 */
export function pcr(template: SeqRecord, forward: Primer, reverse: Primer, options: PcrOptions = {}): PcrResult {
  const warnings: string[] = [];
  const empty = { amplicons: [] as PcrAmplicon[] };
  if (template.molecule === 'protein') return failure('PCR needs a DNA template, not a protein', warnings, empty);
  const L = template.seq.length;
  if (L === 0) return failure('The template is empty', warnings, empty);
  const { name, maxProducts = DEFAULT_MAX_PRODUCTS, ...bindingOptions } = options;
  const samePrimer = forward === reverse || (forward.id === reverse.id && forward.sequence === reverse.sequence);
  let fSites: PrimerBindingSite[];
  let rSites: PrimerBindingSite[];
  try {
    fSites = findBindingSites(template.seq, template.topology, forward, bindingOptions);
    rSites = samePrimer ? fSites : findBindingSites(template.seq, template.topology, reverse, bindingOptions);
  } catch (e) {
    return failure(`Cannot search primer binding sites: ${errorMessage(e)}`, warnings, empty);
  }
  if (fSites.length === 0 && rSites.length === 0) {
    return failure(`Neither primer binds the template ('${forward.name}', '${reverse.name}')`, warnings, empty);
  }
  if (fSites.length === 0) return failure(`Forward primer '${forward.name}' does not bind the template`, warnings, empty);
  if (rSites.length === 0) return failure(`Reverse primer '${reverse.name}' does not bind the template`, warnings, empty);

  type Tagged = { site: PrimerBindingSite; primer: Primer; designated: boolean };
  const fwdDir: Tagged[] = [];
  const revDir: Tagged[] = [];
  for (const s of fSites) (s.strand === 1 ? fwdDir : revDir).push({ site: s, primer: forward, designated: s.strand === 1 });
  if (!samePrimer) for (const s of rSites) (s.strand === -1 ? revDir : fwdDir).push({ site: s, primer: reverse, designated: s.strand === -1 });

  const circular = template.topology === 'circular';
  type Pair = { f: Tagged; r: Tagged; start: number; end: number; length: number };
  const pairs: Pair[] = [];
  for (const f of fwdDir) {
    for (const r of revDir) {
      const fs = f.site.range.start;
      const fe = f.site.range.end;
      let rs = r.site.range.start;
      let re = r.site.range.end;
      if (circular) {
        const shift = mod(rs - fs, L);
        re = fs + shift + (re - rs);
        rs = fs + shift;
        if (re < fe) {
          rs += L;
          re += L;
        }
      } else if (!(fs <= rs && fe <= re)) {
        continue;
      }
      const length = f.site.tailLength + (re - fs) + r.site.tailLength;
      pairs.push({ f, r, start: fs, end: re, length });
    }
  }
  if (pairs.length === 0) {
    return failure(
      `The primers bind but no forward site faces a reverse site${circular ? '' : ' downstream of it'} ` +
        `('${forward.name}': ${siteList(fSites)}; '${reverse.name}': ${siteList(rSites)})`,
      warnings,
      empty,
    );
  }
  pairs.sort((a, b) => a.length - b.length || a.start - b.start);
  const nonDesignated = pairs.filter((p) => !(p.f.designated && p.r.designated && p.f.primer !== p.r.primer));
  if (nonDesignated.length > 0) {
    if (nonDesignated.length === pairs.length) {
      warnings.push(
        `The primers appear swapped or act alone: no product comes from '${forward.name}' extending rightwards and '${reverse.name}' leftwards; ` +
          'the products made by the actual binding orientation are shown',
      );
    } else {
      warnings.push(`${nonDesignated.length} of the ${pairs.length} products come from swapped primer orientations or from a single primer at both ends`);
    }
  }
  if (pairs.length > 1) {
    warnings.push(`${pairs.length} possible products: ${pairs.slice(0, 10).map((p) => `${p.length} bp`).join(', ')}${pairs.length > 10 ? ', …' : ''}`);
  }
  if (pairs.length > maxProducts) warnings.push(`Only the ${maxProducts} smallest products are built`);
  const mism = [...fSites, ...rSites].filter((s) => s.mismatches > 0);
  if (mism.length > 0) warnings.push(`${mism.length} binding site(s) have mismatches; the product carries the primer's bases there`);

  const products: SeqRecord[] = [];
  const amplicons: PcrAmplicon[] = [];
  const baseName = name ?? `${template.name} PCR`;
  for (const p of pairs.slice(0, maxProducts)) {
    try {
      const prod = buildProduct(template, p.f.site, p.f.primer, p.r.site, p.r.primer, p.start, p.end, pairs.length > 1 ? `${baseName} (${p.length} bp)` : baseName, warnings);
      products.push(prod);
      amplicons.push({ forwardSite: p.f.site, reverseSite: p.r.site, templateRange: { start: p.start, end: p.end }, length: p.length });
    } catch (e) {
      warnings.push(`A ${p.length} bp product could not be built: ${errorMessage(e)}`);
    }
  }
  if (products.length === 0) return failure('No product could be built', warnings, empty);
  return outcome(products, warnings, { amplicons });
}

function siteList(sites: readonly PrimerBindingSite[]): string {
  const shown = sites.slice(0, 5).map((s) => `${s.strand === 1 ? '→' : '←'} ${s.range.start + 1}..${s.range.end}`);
  return shown.join(', ') + (sites.length > 5 ? ', …' : '');
}

/** Product record for one site pair; `start`/`end` = template extent of the annealed+copied region (unrolled). */
function buildProduct(
  template: SeqRecord,
  fSite: PrimerBindingSite,
  fPrimer: Primer,
  rSite: PrimerBindingSite,
  rPrimer: Primer,
  start: number,
  end: number,
  name: string,
  warnings: string[],
): SeqRecord {
  const fSeq = fPrimer.sequence.toUpperCase().replace(/U/g, 'T');
  const rcRev = reverseComplement(rPrimer.sequence.toUpperCase().replace(/U/g, 'T'));
  const fe = start + fSite.annealedLength;
  const rs = end - rSite.annealedLength;
  // sliceRange needs a start inside the molecule: on a circle fe may lie past the origin (fe >= L).
  const shift = template.topology === 'circular' ? Math.floor(fe / template.seq.length) * template.seq.length : 0;
  const middle = fe <= rs ? sliceRange(template.seq, { start: fe - shift, end: rs - shift }) + rcRev : rcRev.slice(fe - rs);
  const seq = fSeq + middle;
  const L = template.seq.length;
  const fTail = fSite.tailLength;
  const rTail = rSite.tailLength;

  // Template features inside the copied region, shifted by the forward tail.
  let features: Feature[] = [];
  const span = end - start;
  if (span <= L || template.topology === 'linear') {
    const region = template.topology === 'circular' ? { start: mod(start, L), end: mod(start, L) + span } : { start, end };
    const ext = extractRange({ ...template, primers: [] }, region);
    const pieces = [makeRecord({ seq: 'N'.repeat(fTail) }), ext, makeRecord({ seq: 'N'.repeat(rTail) })].filter((r) => r.seq.length > 0);
    features = concatRecords(pieces).features;
  } else {
    warnings.push(`Template features are not transferred to the ${seq.length} bp product, which covers more than one turn of the circular template`);
  }
  features.push(
    makeFeature({
      type: 'primer_bind',
      name: fPrimer.name,
      strand: 1,
      segments: [{ start: 0, end: fSeq.length }],
      qualifiers: [{ key: 'label', value: fPrimer.name }, { key: 'note', value: `sequence: ${fPrimer.sequence}` }],
    }),
    makeFeature({
      type: 'primer_bind',
      name: rPrimer.name,
      strand: -1,
      segments: [{ start: seq.length - rcRev.length, end: seq.length }],
      qualifiers: [{ key: 'label', value: rPrimer.name }, { key: 'note', value: `sequence: ${rPrimer.sequence}` }],
    }),
  );
  const primers = [{ ...fPrimer }];
  if (rPrimer.id !== fPrimer.id || rPrimer.sequence !== fPrimer.sequence) primers.push({ ...rPrimer });
  return {
    id: newId('doc'),
    name,
    description: `PCR product of ${fPrimer.name} and ${rPrimer.name} on ${template.name} (${seq.length} bp)`,
    seq,
    topology: 'linear',
    molecule: 'DNA',
    features,
    primers,
    meta: {},
  };
}
