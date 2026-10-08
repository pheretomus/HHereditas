import { describe, expect, it } from 'vitest';
import { FIXTURES_DIR, genbankSequence } from '../../test/oracle/enzymes/load';
import { COMMERCIAL_ENZYMES, COMMON_ENZYMES, ENZYMES, effectiveSiteLength, getEnzyme, isPalindromic, overhang } from './enzyme';
import type { RestrictionEnzyme } from './enzyme';
import { findSites } from './search';
import { cuttersWithCount, filterEnzymes, nonCutters, uniqueCutters } from './sets';

function E(name: string): RestrictionEnzyme {
  const e = getEnzyme(name);
  if (e === undefined) throw new Error(`missing enzyme ${name}`);
  return e;
}

const PUC19 = genbankSequence(`${FIXTURES_DIR}/genbank/pUC19_M77789.gb`);

describe('cutter sets on pUC19 (counts cross-checked with Biopython RestrictionBatch.search)', () => {
  const sites = findSites(PUC19, 'circular', COMMON_ENZYMES);

  it('lists unique cutters', () => {
    expect(uniqueCutters(sites)).toEqual(
      ['BamHI', 'BsaI', 'EcoRI', 'HindIII', 'KpnI', 'NdeI', 'PstI', 'SacI', 'SalI', 'SapI', 'SbfI', 'ScaI', 'SmaI', 'SphI', 'XbaI', 'XmaI'],
    );
  });

  it('lists enzymes by number of cuts', () => {
    expect(cuttersWithCount(sites, 2)).toEqual(['BsmBI', 'Esp3I', 'PvuI', 'PvuII']);
    expect(cuttersWithCount(sites, 15)).toEqual(['DpnI']);
    expect(cuttersWithCount(sites, 3)).toEqual([]);
  });

  it('lists non-cutters when the searched enzymes are given', () => {
    expect(nonCutters(sites, COMMON_ENZYMES)).toEqual(
      ['AflII', 'AgeI', 'ApaI', 'AscI', 'AvrII', 'BbsI', 'BglII', 'BlpI', 'BsrGI', 'ClaI', 'EcoRV', 'FseI', 'HpaI', 'MfeI', 'MluI',
        'NcoI', 'NheI', 'NotI', 'NruI', 'NsiI', 'PacI', 'PmeI', 'SacII', 'SpeI', 'StuI', 'SwaI', 'XhoI'],
    );
    // without the enzyme list, enzymes that have no site at all are unknown
    expect(cuttersWithCount(sites, 0)).toEqual([]);
    expect(cuttersWithCount(sites, 0, COMMON_ENZYMES)).toEqual(nonCutters(sites, COMMON_ENZYMES));
  });
});

describe('cutter sets: cleavage events, not sites', () => {
  it('counts both breaks of a two-cut enzyme and uncleavable sites as zero', () => {
    const seq = 'T'.repeat(20) + 'ACAAAAGTATC' + 'T'.repeat(20) + 'GATCAAAAAAAAAAGAATTCAAAAAAAAGATC';
    const sites = findSites(seq, 'linear', [E('BaeI'), E('EcoRI'), E('MboI')]);
    // MboI has two sites, but the last one (^GATC at L - 4: bottom cut at gap L) cannot be cleaved
    expect(uniqueCutters(sites)).toEqual(['EcoRI', 'MboI']);
    expect(cuttersWithCount(sites, 2)).toEqual(['BaeI']);
    const tail = findSites('AAAAAAAAAAGATC', 'linear', [E('MboI')]);
    expect(tail).toHaveLength(1);
    expect(cuttersWithCount(tail, 0)).toEqual(['MboI']);
    expect(uniqueCutters([])).toEqual([]);
  });
});

describe('filterEnzymes', () => {
  it('returns a copy of the list without criteria', () => {
    const out = filterEnzymes(COMMON_ENZYMES, {});
    expect(out).toEqual([...COMMON_ENZYMES]);
    expect(out).not.toBe(COMMON_ENZYMES);
  });

  it('filters by recognition length (literal and effective)', () => {
    const long = filterEnzymes(ENZYMES, { minSiteLength: 8 });
    expect(long.length).toBeGreaterThan(0);
    expect(long.every((e) => e.site.length >= 8)).toBe(true);
    expect(long.map((e) => e.name)).toContain('NotI');
    expect(long.map((e) => e.name)).toContain('BglI'); // GCCNNNNNGGC is 11 bases long
    const sixPlus = filterEnzymes(ENZYMES, { minEffectiveLength: 6 }).map((e) => e.name);
    expect(sixPlus).toContain('BglI'); // 6 specified bases
    expect(sixPlus).toContain('EcoRI');
    expect(sixPlus).not.toContain('AvaI'); // CYCGRG: 5
    expect(sixPlus).not.toContain('HhaI');
    expect(filterEnzymes(ENZYMES, { minEffectiveLength: 6 }).every((e) => effectiveSiteLength(e.site) >= 6 - 1e-9)).toBe(true);
  });

  it('filters by availability and supplier', () => {
    expect(filterEnzymes(ENZYMES, { commercialOnly: true })).toEqual([...COMMERCIAL_ENZYMES]);
    const neb = filterEnzymes(ENZYMES, { suppliers: 'N' });
    expect(neb.every((e) => e.suppliers.includes('N'))).toBe(true);
    expect(neb.map((e) => e.name)).toContain('BsaI');
    expect(neb.map((e) => e.name)).not.toContain('Eco31I'); // Thermo's BsaI isoschizomer
    const nebOrThermo = filterEnzymes(ENZYMES, { suppliers: ['N', 'B'] }).map((e) => e.name);
    expect(nebOrThermo).toContain('Eco31I');
    expect(nebOrThermo).toContain('BsaI');
    expect(filterEnzymes(ENZYMES, { suppliers: 'NB' }).map((e) => e.name)).toEqual(nebOrThermo);
    expect(filterEnzymes(ENZYMES, { suppliers: [] })).toEqual([]);
  });

  it('filters by end kind, palindromicity and methylation requirement', () => {
    const blunt = filterEnzymes(COMMON_ENZYMES, { overhang: ['blunt'] }).map((e) => e.name);
    expect(blunt).toEqual(['SmaI', 'EcoRV', 'HpaI', 'ScaI', 'StuI', 'PmeI', 'SwaI', 'DpnI', 'PvuII', 'NruI']);
    const sticky = filterEnzymes(COMMON_ENZYMES, { overhang: ['5prime', '3prime'] });
    expect(sticky.every((e) => overhang(e).kind !== 'blunt')).toBe(true);
    expect(sticky.length + blunt.length).toBe(COMMON_ENZYMES.length);
    const pal = filterEnzymes(COMMON_ENZYMES, { palindromicOnly: true });
    expect(pal.every((e) => isPalindromic(e.site))).toBe(true);
    expect(pal.map((e) => e.name)).not.toContain('BsaI');
    expect(filterEnzymes(COMMON_ENZYMES, { excludeMethylDirected: true }).map((e) => e.name)).not.toContain('DpnI');
    expect(filterEnzymes(COMMON_ENZYMES, { excludeMethylDirected: true })).toHaveLength(COMMON_ENZYMES.length - 1);
  });

  it('combines criteria and keeps list order', () => {
    const out = filterEnzymes(ENZYMES, { commercialOnly: true, minEffectiveLength: 6, overhang: ['5prime'], palindromicOnly: true, suppliers: 'N' });
    expect(out.length).toBeGreaterThan(20);
    for (const e of out) {
      expect(e.commercial && e.suppliers.includes('N') && isPalindromic(e.site) && overhang(e).kind === '5prime').toBe(true);
    }
    const idx = out.map((e) => ENZYMES.indexOf(e));
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
  });
});

describe('regression: cutter lists given an enzyme list only name enzymes of that list', () => {
  // MboI ^GATC at the very end of a linear molecule: the site is found but cannot be cleaved (cuts: [])
  const sites = findSites('AAAAAAAAAAGATC', 'linear', [E('MboI'), E('EcoRI')]);

  it('nonCutters ignores uncleavable sites of enzymes that were not asked about', () => {
    expect(sites.map((s) => [s.enzyme, s.cuts])).toEqual([['MboI', []]]);
    expect(nonCutters(sites, [E('EcoRI')])).toEqual(['EcoRI']);
    expect(nonCutters(sites, [E('MboI'), E('EcoRI')])).toEqual(['EcoRI', 'MboI']);
    expect(nonCutters(sites, [])).toEqual([]);
  });

  it('cuttersWithCount restricts its answer to the given enzymes', () => {
    expect(cuttersWithCount(sites, 0, [E('EcoRI')])).toEqual(['EcoRI']);
    expect(cuttersWithCount(sites, 0, [E('EcoRI'), E('EcoRI')])).toEqual(['EcoRI']);
    const puc = findSites(PUC19, 'circular', COMMON_ENZYMES);
    expect(cuttersWithCount(puc, 1, [E('EcoRI'), E('NotI'), E('PvuII')])).toEqual(['EcoRI']);
    expect(cuttersWithCount(puc, 2, [E('EcoRI'), E('NotI'), E('PvuII')])).toEqual(['PvuII']);
    // without a list every enzyme present in `sites` is considered
    expect(cuttersWithCount(sites, 0)).toEqual(['MboI']);
  });
});
