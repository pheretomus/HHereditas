/**
 * NCBI genetic codes ("translation tables"): the values of the INSDC `/transl_table` qualifier.
 *
 * GENERATED FILE: do not edit by hand. Regenerate with
 *   tools/oracle/.venv/bin/python -I tools/oracle/seqtools_codons.py
 *
 * Source: Biopython 1.88 Bio.Data.CodonTable, itself generated from the NCBI genetic code
 * file gc.prt (data version 4.5), https://ftp.ncbi.nih.gov/entrez/misc/data/gc.prt , see also
 * https://www.ncbi.nlm.nih.gov/Taxonomy/Utils/wprintgc.cgi . codon-tables.test.ts checks this data
 * against a copy of NCBI gc.prt version 4.6 (test/oracle/seqtools/ncbi_gc.prt).
 *
 * Each table is stored in NCBI's layout: `ncbieaa` lists the amino acid of the 64 codons in the
 * order TTT, TTC, TTA, TTG, TCT, ... GGG (bases T, C, A, G; the first base varies slowest), with
 * '*' for codons that are never translated. Codons are DNA (T, never U).
 */

/** One NCBI genetic code. All codons are uppercase DNA triplets (T, never U). */
export interface GeneticCode {
  /** NCBI table id, i.e. the value of a `/transl_table` qualifier (1 = standard, 11 = bacterial). */
  readonly id: number;
  /** NCBI name of the code, e.g. 'Bacterial, Archaeal and Plant Plastid'. */
  readonly name: string;
  /**
   * Every name Biopython registers for the code (alternative names such as 'SGC0' included), plus
   * the current NCBI name where NCBI renamed the code later (gc.prt 4.6: table 24 is now
   * 'Rhabdopleuridae Mitochondrial').
   */
  readonly names: readonly string[];
  /**
   * Amino acid (one-letter code) of every codon that is translated, keyed by codon (61 to 64
   * entries). Codons that only terminate translation are absent. A codon present here AND in
   * `stopCodons` (tables 27, 28 and 31) is a context-dependent stop: it codes for the amino acid
   * inside a gene and terminates translation at the end of a gene.
   */
  readonly forwardTable: Readonly<Record<string, string>>;
  /** Codons that can initiate translation (alternative start codons included), in NCBI order. */
  readonly startCodons: readonly string[];
  /** Codons that terminate translation, in NCBI order. */
  readonly stopCodons: readonly string[];
  /** Amino acids of the 64 codons in NCBI order (see {@link NCBI_CODON_ORDER}); '*' = never translated. */
  readonly ncbieaa: string;
}

/** The 64 codons in NCBI order: bases T, C, A, G, first codon position varying slowest (TTT, TTC, ... GGG). */
export const NCBI_CODON_ORDER: readonly string[] = Object.freeze(
  (() => {
    const bases = 'TCAG';
    const out: string[] = [];
    for (const a of bases) for (const b of bases) for (const c of bases) out.push(a + b + c);
    return out;
  })(),
);

interface RawGeneticCode {
  id: number;
  name: string;
  names: string[];
  ncbieaa: string;
  startCodons: string[];
  stopCodons: string[];
}

const RAW_CODES: readonly RawGeneticCode[] = [
  {
    id: 1,
    name: 'Standard',
    names: ['Standard', 'SGC0'],
    ncbieaa: 'FFLLSSSSYY**CC*WLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG',
    startCodons: ['TTG', 'CTG', 'ATG'],
    stopCodons: ['TAA', 'TAG', 'TGA'],
  },
  {
    id: 2,
    name: 'Vertebrate Mitochondrial',
    names: ['Vertebrate Mitochondrial', 'SGC1'],
    ncbieaa: 'FFLLSSSSYY**CCWWLLLLPPPPHHQQRRRRIIMMTTTTNNKKSS**VVVVAAAADDEEGGGG',
    startCodons: ['ATT', 'ATC', 'ATA', 'ATG', 'GTG'],
    stopCodons: ['TAA', 'TAG', 'AGA', 'AGG'],
  },
  {
    id: 3,
    name: 'Yeast Mitochondrial',
    names: ['Yeast Mitochondrial', 'SGC2'],
    ncbieaa: 'FFLLSSSSYY**CCWWTTTTPPPPHHQQRRRRIIMMTTTTNNKKSSRRVVVVAAAADDEEGGGG',
    startCodons: ['ATA', 'ATG', 'GTG'],
    stopCodons: ['TAA', 'TAG'],
  },
  {
    id: 4,
    name: 'Mold Mitochondrial; Protozoan Mitochondrial; Coelenterate Mitochondrial; Mycoplasma; Spiroplasma',
    names: [
      'Mold Mitochondrial; Protozoan Mitochondrial; Coelenterate Mitochondrial; Mycoplasma; Spiroplasma',
      'Mold Mitochondrial',
      'Protozoan Mitochondrial',
      'Coelenterate Mitochondrial',
      'Mycoplasma',
      'Spiroplasma',
      'SGC3',
    ],
    ncbieaa: 'FFLLSSSSYY**CCWWLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG',
    startCodons: ['TTA', 'TTG', 'CTG', 'ATT', 'ATC', 'ATA', 'ATG', 'GTG'],
    stopCodons: ['TAA', 'TAG'],
  },
  {
    id: 5,
    name: 'Invertebrate Mitochondrial',
    names: ['Invertebrate Mitochondrial', 'SGC4'],
    ncbieaa: 'FFLLSSSSYY**CCWWLLLLPPPPHHQQRRRRIIMMTTTTNNKKSSSSVVVVAAAADDEEGGGG',
    startCodons: ['TTG', 'ATT', 'ATC', 'ATA', 'ATG', 'GTG'],
    stopCodons: ['TAA', 'TAG'],
  },
  {
    id: 6,
    name: 'Ciliate Nuclear; Dasycladacean Nuclear; Hexamita Nuclear',
    names: [
      'Ciliate Nuclear; Dasycladacean Nuclear; Hexamita Nuclear',
      'Ciliate Nuclear',
      'Dasycladacean Nuclear',
      'Hexamita Nuclear',
      'SGC5',
    ],
    ncbieaa: 'FFLLSSSSYYQQCC*WLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG',
    startCodons: ['ATG'],
    stopCodons: ['TGA'],
  },
  {
    id: 9,
    name: 'Echinoderm Mitochondrial; Flatworm Mitochondrial',
    names: [
      'Echinoderm Mitochondrial; Flatworm Mitochondrial',
      'Echinoderm Mitochondrial',
      'Flatworm Mitochondrial',
      'SGC8',
    ],
    ncbieaa: 'FFLLSSSSYY**CCWWLLLLPPPPHHQQRRRRIIIMTTTTNNNKSSSSVVVVAAAADDEEGGGG',
    startCodons: ['ATG', 'GTG'],
    stopCodons: ['TAA', 'TAG'],
  },
  {
    id: 10,
    name: 'Euplotid Nuclear',
    names: ['Euplotid Nuclear', 'SGC9'],
    ncbieaa: 'FFLLSSSSYY**CCCWLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG',
    startCodons: ['ATG'],
    stopCodons: ['TAA', 'TAG'],
  },
  {
    id: 11,
    name: 'Bacterial, Archaeal and Plant Plastid',
    names: ['Bacterial, Archaeal and Plant Plastid', 'Bacterial', 'Archaeal', 'Plant Plastid'],
    ncbieaa: 'FFLLSSSSYY**CC*WLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG',
    startCodons: ['TTG', 'CTG', 'ATT', 'ATC', 'ATA', 'ATG', 'GTG'],
    stopCodons: ['TAA', 'TAG', 'TGA'],
  },
  {
    id: 12,
    name: 'Alternative Yeast Nuclear',
    names: ['Alternative Yeast Nuclear'],
    ncbieaa: 'FFLLSSSSYY**CC*WLLLSPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG',
    startCodons: ['CTG', 'ATG'],
    stopCodons: ['TAA', 'TAG', 'TGA'],
  },
  {
    id: 13,
    name: 'Ascidian Mitochondrial',
    names: ['Ascidian Mitochondrial'],
    ncbieaa: 'FFLLSSSSYY**CCWWLLLLPPPPHHQQRRRRIIMMTTTTNNKKSSGGVVVVAAAADDEEGGGG',
    startCodons: ['TTG', 'ATA', 'ATG', 'GTG'],
    stopCodons: ['TAA', 'TAG'],
  },
  {
    id: 14,
    name: 'Alternative Flatworm Mitochondrial',
    names: ['Alternative Flatworm Mitochondrial'],
    ncbieaa: 'FFLLSSSSYYY*CCWWLLLLPPPPHHQQRRRRIIIMTTTTNNNKSSSSVVVVAAAADDEEGGGG',
    startCodons: ['ATG'],
    stopCodons: ['TAG'],
  },
  {
    id: 15,
    name: 'Blepharisma Macronuclear',
    names: ['Blepharisma Macronuclear'],
    ncbieaa: 'FFLLSSSSYY*QCC*WLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG',
    startCodons: ['ATG'],
    stopCodons: ['TAA', 'TGA'],
  },
  {
    id: 16,
    name: 'Chlorophycean Mitochondrial',
    names: ['Chlorophycean Mitochondrial'],
    ncbieaa: 'FFLLSSSSYY*LCC*WLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG',
    startCodons: ['ATG'],
    stopCodons: ['TAA', 'TGA'],
  },
  {
    id: 21,
    name: 'Trematode Mitochondrial',
    names: ['Trematode Mitochondrial'],
    ncbieaa: 'FFLLSSSSYY**CCWWLLLLPPPPHHQQRRRRIIMMTTTTNNNKSSSSVVVVAAAADDEEGGGG',
    startCodons: ['ATG', 'GTG'],
    stopCodons: ['TAA', 'TAG'],
  },
  {
    id: 22,
    name: 'Scenedesmus obliquus Mitochondrial',
    names: ['Scenedesmus obliquus Mitochondrial'],
    ncbieaa: 'FFLLSS*SYY*LCC*WLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG',
    startCodons: ['ATG'],
    stopCodons: ['TCA', 'TAA', 'TGA'],
  },
  {
    id: 23,
    name: 'Thraustochytrium Mitochondrial',
    names: ['Thraustochytrium Mitochondrial'],
    ncbieaa: 'FF*LSSSSYY**CC*WLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG',
    startCodons: ['ATT', 'ATG', 'GTG'],
    stopCodons: ['TTA', 'TAA', 'TAG', 'TGA'],
  },
  {
    id: 24,
    name: 'Pterobranchia Mitochondrial',
    names: ['Pterobranchia Mitochondrial', 'Rhabdopleuridae Mitochondrial'],
    ncbieaa: 'FFLLSSSSYY**CCWWLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSSKVVVVAAAADDEEGGGG',
    startCodons: ['TTG', 'CTG', 'ATG', 'GTG'],
    stopCodons: ['TAA', 'TAG'],
  },
  {
    id: 25,
    name: 'Candidate Division SR1 and Gracilibacteria',
    names: ['Candidate Division SR1 and Gracilibacteria', 'Candidate Division SR1', 'Gracilibacteria'],
    ncbieaa: 'FFLLSSSSYY**CCGWLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG',
    startCodons: ['TTG', 'ATG', 'GTG'],
    stopCodons: ['TAA', 'TAG'],
  },
  {
    id: 26,
    name: 'Pachysolen tannophilus Nuclear',
    names: ['Pachysolen tannophilus Nuclear'],
    ncbieaa: 'FFLLSSSSYY**CC*WLLLAPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG',
    startCodons: ['CTG', 'ATG'],
    stopCodons: ['TAA', 'TAG', 'TGA'],
  },
  {
    id: 27,
    name: 'Karyorelict Nuclear',
    names: ['Karyorelict Nuclear'],
    ncbieaa: 'FFLLSSSSYYQQCCWWLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG',
    startCodons: ['ATG'],
    stopCodons: ['TGA'],
  },
  {
    id: 28,
    name: 'Condylostoma Nuclear',
    names: ['Condylostoma Nuclear'],
    ncbieaa: 'FFLLSSSSYYQQCCWWLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG',
    startCodons: ['ATG'],
    stopCodons: ['TAA', 'TAG', 'TGA'],
  },
  {
    id: 29,
    name: 'Mesodinium Nuclear',
    names: ['Mesodinium Nuclear'],
    ncbieaa: 'FFLLSSSSYYYYCC*WLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG',
    startCodons: ['ATG'],
    stopCodons: ['TGA'],
  },
  {
    id: 30,
    name: 'Peritrich Nuclear',
    names: ['Peritrich Nuclear'],
    ncbieaa: 'FFLLSSSSYYEECC*WLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG',
    startCodons: ['ATG'],
    stopCodons: ['TGA'],
  },
  {
    id: 31,
    name: 'Blastocrithidia Nuclear',
    names: ['Blastocrithidia Nuclear'],
    ncbieaa: 'FFLLSSSSYYEECCWWLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG',
    startCodons: ['ATG'],
    stopCodons: ['TAA', 'TAG'],
  },
  {
    id: 32,
    name: 'Balanophoraceae Plastid',
    names: ['Balanophoraceae Plastid'],
    ncbieaa: 'FFLLSSSSYY*WCC*WLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG',
    startCodons: ['TTG', 'CTG', 'ATT', 'ATC', 'ATA', 'ATG', 'GTG'],
    stopCodons: ['TAA', 'TGA'],
  },
  {
    id: 33,
    name: 'Cephalodiscidae Mitochondrial',
    names: ['Cephalodiscidae Mitochondrial'],
    ncbieaa: 'FFLLSSSSYYY*CCWWLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSSKVVVVAAAADDEEGGGG',
    startCodons: ['TTG', 'CTG', 'ATG', 'GTG'],
    stopCodons: ['TAG'],
  },
];

function buildGeneticCode(raw: RawGeneticCode): GeneticCode {
  const forwardTable: Record<string, string> = {};
  for (let i = 0; i < 64; i++) {
    const aa = raw.ncbieaa[i];
    if (aa !== '*') forwardTable[NCBI_CODON_ORDER[i]] = aa;
  }
  return Object.freeze({
    id: raw.id,
    name: raw.name,
    names: Object.freeze([...raw.names]),
    forwardTable: Object.freeze(forwardTable),
    startCodons: Object.freeze([...raw.startCodons]),
    stopCodons: Object.freeze([...raw.stopCodons]),
    ncbieaa: raw.ncbieaa,
  });
}

/** Every NCBI genetic code known to Biopython, sorted by id (1-6, 9-16, 21-33). Frozen. */
export const GENETIC_CODES: readonly GeneticCode[] = Object.freeze(RAW_CODES.map(buildGeneticCode));

const CODES_BY_ID: ReadonlyMap<number, GeneticCode> = new Map(GENETIC_CODES.map((c) => [c.id, c]));

/**
 * The NCBI genetic code with the given table id (default 1, the standard code).
 * @throws RangeError when no such table exists (NCBI ids 7, 8 and 17-20 are unassigned).
 */
export function getGeneticCode(id = 1): GeneticCode {
  const code = CODES_BY_ID.get(id);
  if (code === undefined) {
    const known = GENETIC_CODES.map((c) => c.id).join(', ');
    throw new RangeError(`Unknown NCBI genetic code (translation table) ${id}; known tables: ${known}`);
  }
  return code;
}
