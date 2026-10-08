import { describe, expect, it } from 'vitest';
import { readOracle } from '../../test/oracle/enzymes/load';
import { reverseComplement } from '../seq/alphabet';
import { ENZYME_ROWS, METHYL_DIRECTED_ENZYMES, SUPPLIERS } from './data';
import {
  COMMERCIAL_ENZYMES,
  COMMON_ENZYMES,
  COMMON_ENZYME_NAMES,
  ENZYMES,
  cutNotation,
  cutsOutsideSite,
  effectiveSiteLength,
  equischizomers,
  getEnzyme,
  isPalindromic,
  isoschizomers,
  makeEnzyme,
  neoschizomers,
  overhang,
  validateEnzyme,
} from './enzyme';
import type { RestrictionEnzyme } from './enzyme';

interface PropsEntry {
  name: string;
  site: string;
  charac: [number, number, number | null, number | null];
  size: number;
  ovhg: number;
  ovhgseq: string;
  palindromic: boolean;
  overhang: string;
  defined: boolean;
  ambiguous: boolean;
  suppliers: string;
  commercial: boolean;
  isoschizomers: string[];
  neoschizomers: string[];
  equischizomers: string[];
  deviation: string | null;
}

const props = readOracle<{ enzymes: PropsEntry[] }>('enzyme_props.json').enzymes;

function E(name: string): RestrictionEnzyme {
  const e = getEnzyme(name);
  if (e === undefined) throw new Error(`missing enzyme ${name}`);
  return e;
}

const names = (list: readonly RestrictionEnzyme[]) => list.map((e) => e.name).sort();

describe('catalogue data', () => {
  it('contains every enzyme with defined cleavage, commercial and not', () => {
    expect(ENZYMES).toHaveLength(754);
    expect(ENZYMES).toHaveLength(ENZYME_ROWS.length);
    expect(COMMERCIAL_ENZYMES).toHaveLength(623);
    expect(ENZYMES.filter((e) => !e.commercial)).toHaveLength(131);
  });

  it('has unique names (case-insensitively) and valid definitions', () => {
    expect(new Set(ENZYMES.map((e) => e.name.toLowerCase())).size).toBe(ENZYMES.length);
    for (const e of ENZYMES) {
      expect(validateEnzyme(e), e.name).toEqual([]);
      expect(e.site, e.name).toMatch(/^[ACGTRYSWKMBDHVN]+$/);
      expect(e.cuts.length === 1 || e.cuts.length === 2, e.name).toBe(true);
      expect(e.commercial, e.name).toBe(e.suppliers !== '');
      for (const code of e.suppliers) expect(SUPPLIERS[code], `${e.name} supplier ${code}`).toBeDefined();
    }
  });

  it('is sorted case-insensitively by name', () => {
    const keys = ENZYMES.map((e) => e.name.toLowerCase());
    expect([...keys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))).toEqual(keys);
  });

  it('exposes the supplier table', () => {
    expect(SUPPLIERS.N).toBe('New England Biolabs');
    expect(SUPPLIERS.B).toBe('Thermo Fisher Scientific');
    expect(Object.keys(SUPPLIERS)).toHaveLength(15);
  });

  it('freezes catalogue objects', () => {
    const e = E('EcoRI');
    expect(Object.isFrozen(e)).toBe(true);
    expect(Object.isFrozen(e.cuts)).toBe(true);
    expect(Object.isFrozen(e.cuts[0])).toBe(true);
    expect(Object.isFrozen(ENZYMES)).toBe(true);
  });

  it('flags methyl-directed enzymes from REBASE', () => {
    expect(E('DpnI').methylDirected).toBe(true);
    expect(E('MspJI').methylDirected).toBe(true);
    expect(E('GlaI').methylDirected).toBe(true);
    expect(E('MboI').methylDirected).toBeUndefined();
    expect(E('EcoRI').methylDirected).toBeUndefined();
    expect(ENZYMES.filter((e) => e.methylDirected)).toHaveLength(METHYL_DIRECTED_ENZYMES.length);
    for (const name of METHYL_DIRECTED_ENZYMES) expect(getEnzyme(name)?.methylDirected, name).toBe(true);
  });

  it('resolves every COMMON_ENZYMES name, in order, all commercial', () => {
    expect(COMMON_ENZYMES.map((e) => e.name)).toEqual(COMMON_ENZYME_NAMES);
    expect(COMMON_ENZYMES.length).toBeGreaterThanOrEqual(40);
    for (const name of ['EcoRI', 'BamHI', 'HindIII', 'XhoI', 'XbaI', 'NotI', 'NdeI', 'NcoI', 'KpnI', 'SacI',
      'SalI', 'PstI', 'SphI', 'SmaI', 'EcoRV', 'BglII', 'NheI', 'SpeI', 'AgeI', 'MluI', 'ApaI', 'ClaI', 'AscI',
      'PacI', 'SbfI', 'BsaI', 'BsmBI', 'BbsI', 'SapI', 'NsiI', 'AvrII', 'MfeI', 'XmaI', 'HpaI', 'ScaI', 'StuI',
      'PmeI', 'SwaI', 'FseI', 'DpnI']) {
      expect(COMMON_ENZYME_NAMES, name).toContain(name);
    }
    for (const e of COMMON_ENZYMES) expect(e.commercial, e.name).toBe(true);
    expect(new Set(COMMON_ENZYME_NAMES).size).toBe(COMMON_ENZYME_NAMES.length);
  });

  it('stores the documented cut offsets', () => {
    expect(E('EcoRI').cuts).toEqual([{ top: 1, bottom: 5 }]);
    expect(E('PstI').cuts).toEqual([{ top: 5, bottom: 1 }]);
    expect(E('SmaI').cuts).toEqual([{ top: 3, bottom: 3 }]);
    expect(E('BsaI').cuts).toEqual([{ top: 7, bottom: 11 }]);
    expect(E('BaeI').cuts).toEqual([
      { top: -10, bottom: -15 },
      { top: 23, bottom: 18 },
    ]);
    expect(E('CspCI').cuts).toEqual([
      { top: -11, bottom: -13 },
      { top: 24, bottom: 22 },
    ]);
    expect(E('TspRI').cuts).toEqual([{ top: 7, bottom: -2 }]); // NNCASTGNN^ : 9-nt 3' overhang (NEB)
    expect(E('CviKI-1').site).toBe('RGCY');
  });
});

describe('agreement with Biopython enzyme properties (enzyme_props.json)', () => {
  const byName = new Map(props.map((p) => [p.name, p]));

  it('covers exactly the catalogue', () => {
    expect(props.map((p) => p.name)).toEqual(ENZYMES.map((e) => e.name));
  });

  it('has the same site, cut offsets, suppliers and palindromicity', () => {
    for (const e of ENZYMES) {
      const p = byName.get(e.name) as PropsEntry;
      expect(e.site, e.name).toBe(p.site);
      const [fst5, fst3, scd5, scd3] = p.charac;
      const cuts = [{ top: fst5, bottom: p.size + fst3 }];
      if (scd5 !== null && scd3 !== null) cuts.push({ top: scd5, bottom: p.size + scd3 });
      expect(e.cuts, e.name).toEqual(cuts);
      expect(e.suppliers, e.name).toBe(p.suppliers);
      expect(e.commercial, e.name).toBe(p.commercial);
      expect(isPalindromic(e.site), e.name).toBe(p.palindromic);
    }
  });

  it('derives the same overhang kind, length and sequence', () => {
    const kindOf: Record<string, string> = { "5' overhang": '5prime', "3' overhang": '3prime', blunt: 'blunt' };
    let ovhgFieldDeviations = 0;
    for (const e of ENZYMES) {
      const p = byName.get(e.name) as PropsEntry;
      const o = overhang(e);
      expect(o.kind, e.name).toBe(kindOf[p.overhang]);
      if (p.deviation === 'ovhg-field') {
        // Biopython's ovhg field (10) contradicts its own fst5/fst3 (9-nt NNCASTGNN overhang).
        expect(o.length, e.name).toBe(9);
        expect(p.ovhgseq, e.name).toHaveLength(9);
        ovhgFieldDeviations++;
      } else {
        expect(o.length, e.name).toBe(Math.abs(p.ovhg));
      }
      // Biopython "Defined" = the overhang sequence does not depend on the target.
      expect(o.sequence !== undefined, e.name).toBe(p.defined);
      if (o.sequence !== undefined) expect(o.sequence, e.name).toBe(p.ovhgseq);
    }
    expect(ovhgFieldDeviations).toBe(2);
  });

  it('finds the same isoschizomers, neoschizomers and equischizomers', () => {
    for (const e of ENZYMES) {
      const p = byName.get(e.name) as PropsEntry;
      expect(names(isoschizomers(e)), e.name).toEqual([...p.isoschizomers].sort());
      expect(names(neoschizomers(e)), e.name).toEqual([...p.neoschizomers].sort());
      expect(names(equischizomers(e)), e.name).toEqual([...p.equischizomers].sort());
    }
  });
});

describe('overhang', () => {
  it('classifies 5prime, 3prime and blunt ends with their top-strand sequence', () => {
    expect(overhang(E('EcoRI'))).toEqual({ kind: '5prime', length: 4, sequence: 'AATT' });
    expect(overhang(E('PstI'))).toEqual({ kind: '3prime', length: 4, sequence: 'TGCA' });
    expect(overhang(E('KpnI'))).toEqual({ kind: '3prime', length: 4, sequence: 'GTAC' });
    expect(overhang(E('SmaI'))).toEqual({ kind: 'blunt', length: 0, sequence: '' });
    expect(overhang(E('NotI'))).toEqual({ kind: '5prime', length: 4, sequence: 'GGCC' });
    expect(overhang(E('ApoI'))).toEqual({ kind: '5prime', length: 4, sequence: 'AATT' }); // R^AATTY
  });

  it('omits the sequence when it depends on the target', () => {
    expect(overhang(E('BsaI'))).toEqual({ kind: '5prime', length: 4 });
    expect(overhang(E('SapI'))).toEqual({ kind: '5prime', length: 3 });
    expect(overhang(E('AvaI'))).toEqual({ kind: '5prime', length: 4 }); // C^YCGRG -> YCGR
    expect(overhang(E('BglI'))).toEqual({ kind: '3prime', length: 3 }); // GCCNNNN^NGGC
    expect(overhang(E('BaeI'))).toEqual({ kind: '3prime', length: 5 });
    expect(overhang(E('MlyI'))).toEqual({ kind: 'blunt', length: 0, sequence: '' });
  });

  it('rejects an enzyme without cleavage', () => {
    expect(() => overhang({ name: 'X', site: 'GATC', cuts: [], suppliers: '', commercial: false })).toThrow(/no cleavage/);
  });
});

describe('site helpers', () => {
  it('detects palindromic sites, IUPAC aware and case-insensitive', () => {
    expect(isPalindromic('GAATTC')).toBe(true);
    expect(isPalindromic('GCCNNNNNGGC')).toBe(true);
    expect(isPalindromic('CYCGRG')).toBe(true);
    expect(isPalindromic('gaattc')).toBe(true);
    expect(isPalindromic('GGTCTC')).toBe(false);
    expect(isPalindromic('A')).toBe(false);
    expect(isPalindromic('')).toBe(true);
    for (const e of ENZYMES) expect(isPalindromic(e.site)).toBe(e.site === reverseComplement(e.site));
  });

  it('detects cuts outside the recognition site', () => {
    expect(cutsOutsideSite(E('EcoRI'))).toBe(false);
    expect(cutsOutsideSite(E('MboI'))).toBe(false); // ^GATC: on the boundary
    expect(cutsOutsideSite(E('NlaIII'))).toBe(false); // CATG^
    expect(cutsOutsideSite(E('BglI'))).toBe(false);
    expect(cutsOutsideSite(E('BsaI'))).toBe(true);
    expect(cutsOutsideSite(E('BaeI'))).toBe(true);
    expect(cutsOutsideSite(E('MlyI'))).toBe(true);
    expect(cutsOutsideSite(E('TspRI'))).toBe(true);
  });

  it('computes effective site lengths', () => {
    expect(effectiveSiteLength('GAATTC')).toBe(6);
    expect(effectiveSiteLength('GCCNNNNNGGC')).toBe(6);
    expect(effectiveSiteLength('CYCGRG')).toBe(5);
    expect(effectiveSiteLength('N')).toBe(0);
    expect(effectiveSiteLength('B')).toBeCloseTo(Math.log2(4 / 3) / 2, 12);
    expect(effectiveSiteLength('GAXTC')).toBeNaN();
  });

  it('writes REBASE-style cut notation', () => {
    const cases: Record<string, string> = {
      EcoRI: 'G^AATTC',
      PstI: 'CTGCA^G',
      SmaI: 'CCC^GGG',
      MboI: '^GATC',
      NlaIII: 'CATG^',
      BglI: 'GCCNNNN^NGGC',
      BsaI: 'GGTCTC(1/5)',
      SapI: 'GCTCTTC(1/4)',
      MlyI: 'GAGTC(5/5)',
      BaeI: '(10/15)ACNNNNGTAYC(12/7)',
      CspCI: '(11/13)CAANNNNNGTGG(12/10)',
      TspRI: 'CASTG(2/-7)',
      MmeI: 'TCCRAC(20/18)',
    };
    for (const [name, notation] of Object.entries(cases)) expect(cutNotation(E(name)), name).toBe(notation);
  });

  it('looks enzymes up case-insensitively', () => {
    expect(getEnzyme('ecori')).toBe(E('EcoRI'));
    expect(getEnzyme(' HINDIII ')?.name).toBe('HindIII');
    expect(getEnzyme('CviKI_1')?.name).toBe('CviKI-1');
    expect(getEnzyme('NoSuchI')).toBeUndefined();
    expect(getEnzyme('')).toBeUndefined();
  });
});

describe('isoschizomers', () => {
  it('distinguishes neoschizomers from equischizomers', () => {
    expect(names(isoschizomers(E('SmaI')))).toContain('XmaI');
    expect(names(neoschizomers(E('SmaI')))).toContain('XmaI');
    expect(names(equischizomers(E('SmaI')))).not.toContain('XmaI');
    expect(names(equischizomers(E('SacI')))).toContain('SstI');
    expect(names(neoschizomers(E('SacI')))).toContain('Ecl136II'); // GAG^CTC (blunt)
    expect(names(equischizomers(E('BsmBI')))).toContain('Esp3I');
    expect(names(isoschizomers(E('BsmBI')))).not.toContain('BsmBI');
  });

  it('accepts sites written as the reverse complement', () => {
    const bsaI = E('BsaI');
    // the same specificity written on the other strand: GAGACC with mirrored cuts (n - 11, n - 7)
    const flipped = makeEnzyme({ name: 'BsaI-rc', site: 'GAGACC', cuts: [{ top: -5, bottom: -1 }] });
    const shifted = makeEnzyme({ name: 'BsaI-neo', site: 'GAGACC', cuts: [{ top: -4, bottom: 0 }] });
    expect(names(equischizomers(bsaI, [bsaI, flipped, shifted]))).toEqual(['BsaI-rc']);
    expect(names(neoschizomers(bsaI, [bsaI, flipped, shifted]))).toEqual(['BsaI-neo']);
    expect(names(isoschizomers(flipped, [bsaI, flipped, shifted]))).toEqual(['BsaI', 'BsaI-neo']);
  });
});

describe('validateEnzyme / makeEnzyme', () => {
  it('builds normalized user-defined enzymes', () => {
    const e = makeEnzyme({ name: ' MyI ', site: 'gaattc', cuts: [{ top: 1, bottom: 5 }] });
    expect(e).toEqual({ name: 'MyI', site: 'GAATTC', cuts: [{ top: 1, bottom: 5 }], suppliers: '', commercial: false });
    const sold = makeEnzyme({ name: 'X', site: 'GATC', cuts: [{ top: 0, bottom: 4 }], suppliers: 'N', methylDirected: true });
    expect(sold.commercial).toBe(true);
    expect(sold.methylDirected).toBe(true);
  });

  it('reports every problem', () => {
    expect(validateEnzyme({ name: '', site: 'GAUTC', cuts: [], suppliers: '', commercial: false })).toEqual([
      'name is empty',
      "recognition site contains 'U', which is not an IUPAC nucleotide code",
      'no cleavage positions',
    ]);
    expect(validateEnzyme({ name: 'X', site: '', cuts: [{ top: 0.5, bottom: 1e6 }], suppliers: '', commercial: false })).toEqual([
      'recognition site is empty',
      'invalid cut offset 0.5',
      'invalid cut offset 1000000',
    ]);
    expect(() => makeEnzyme({ name: 'Bad', site: 'GA-TC', cuts: [{ top: 1, bottom: 3 }] })).toThrow(/Invalid enzyme 'Bad'.*'-'/);
  });

  it('does not mutate its input', () => {
    const cuts = [{ top: 1, bottom: 5 }];
    const e = makeEnzyme({ name: 'Y', site: 'gaattc', cuts });
    expect(e.cuts).not.toBe(cuts);
    expect(cuts).toEqual([{ top: 1, bottom: 5 }]);
  });
});
