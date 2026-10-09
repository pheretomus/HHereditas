/** TEMPORARY review stories (linear design reviewer, port 5213); delete after the review. */
import type { SeqRecord } from '@hhereditas/core';
import type { ReactNode } from 'react';
import { LinearMap } from '../../../../packages/viewer/src/linear';
import { SAMPLES } from '../../../../packages/viewer/src/fixtures';
import type { EnzymeSite } from '@hhereditas/core';

function uniqueOnly(sites: readonly EnzymeSite[]): EnzymeSite[] {
  const n = new Map<string, number>();
  for (const x of sites) n.set(x.enzyme, (n.get(x.enzyme) ?? 0) + x.cuts.length);
  return sites.filter((x) => n.get(x.enzyme) === 1);
}

const AA = 'ACDEFGHIKLMNPQRSTVWY';
function protein(n: number): string {
  let s = '';
  let x = 7;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) % 2147483648;
    s += AA[x % 20];
  }
  return s;
}

const longProtein: SeqRecord = {
  id: 'long-protein',
  name: 'Polyprotein',
  description: '',
  seq: `M${protein(34349)}`,
  topology: 'linear',
  molecule: 'protein',
  features: [
    { id: 'd1', type: 'misc_feature', name: 'Kinase domain', strand: 0, segments: [{ start: 1000, end: 12000 }], qualifiers: [] },
    { id: 'd2', type: 'misc_feature', name: 'Coiled coil', strand: 0, segments: [{ start: 15000, end: 28000 }], qualifiers: [] },
  ],
  primers: [],
  meta: {},
};

const fragSeq = 'AATTCATGGTGAGCAAGGGCGAGGAGCTGTTCACCGGGGTGGTGCCCATCCTGGTCGAGCTGGACGGCGACGTAAACGGC';
const sticky5: SeqRecord = {
  id: 'frag',
  name: 'EcoRI–XhoI fragment',
  description: '',
  seq: fragSeq,
  topology: 'linear',
  molecule: 'DNA',
  features: [{ id: 'k', type: 'CDS', name: 'EGFP (5′)', strand: 1, segments: [{ start: 5, end: 80 }], qualifiers: [] }],
  primers: [],
  ends: { left: { kind: '5prime', length: 4 }, right: { kind: '5prime', length: 4 } },
  meta: {},
};
const sticky3: SeqRecord = {
  ...sticky5,
  id: 'frag3',
  name: 'PstI fragment',
  ends: { left: { kind: '3prime', length: 4 }, right: { kind: '3prime', length: 4 } },
};

const fill = { height: '100%' };
const stories: Record<string, () => ReactNode> = {
  'pFA6a-unique-only': () => (
    <div style={fill}>
      <LinearMap record={SAMPLES.pFA6a.record} enzymeSites={uniqueOnly(SAMPLES.pFA6a.enzymeSites)} />
    </div>
  ),
  'pBAD30-unique-only': () => (
    <div style={fill}>
      <LinearMap record={SAMPLES.pBAD30.record} enzymeSites={uniqueOnly(SAMPLES.pBAD30.enzymeSites)} />
    </div>
  ),
  'long-protein': () => (
    <div style={fill}>
      <LinearMap record={longProtein} />
    </div>
  ),
  'sticky5-right': () => (
    <div style={fill}>
      <LinearMap record={sticky5} viewport={{ start: 40, end: 80 }} />
    </div>
  ),
  'sticky3-left': () => (
    <div style={fill}>
      <LinearMap record={sticky3} viewport={{ start: 0, end: 40 }} />
    </div>
  ),
  'sticky3-right': () => (
    <div style={fill}>
      <LinearMap record={sticky3} viewport={{ start: 40, end: 80 }} />
    </div>
  ),
};

export default stories;
