/**
 * Standard plasmid feature database, epitope/affinity tags, protease cleavage sites,
 * and automatic feature detection engine reconstructed from SnapGene via REA
 * (`morluto/rea` + Ghidra 12.1.4 + Capstone x86-64 disassembly):
 *
 * - `SnapGene.exe` `0x142213810..0x142213a11` & `0x1410ec820..0x1410f0026`:
 *   `standardCommonFeatures.ftrs` container parser and `maxRunOn` ORF extension rule.
 * - `SnapGene.exe` `0x141e9d770..0x141e9e781`:
 *   `epitopeAndAffinityTags.xml` (category 0, 14 tags) and `proteaseCleavageSites.xml`
 *   (category 1, 6 protease cleavage sites with `↓` cleavage offset).
 */
import type { Feature, Qualifier, Range, SeqRecord, Strand } from "../types";
import { reverseComplement } from "./alphabet";
import { newId } from "./id";
import { normalizeRange } from "./range";

export type FeatureTemplateCategory = "common_feature" | "epitope_tag" | "protease_cleavage";

export interface CommonFeatureTemplate {
  name: string;
  type: string;
  strand: Strand;
  sequence: string;
  color: string;
  maxRunOn?: number;
  qualifiers: readonly Qualifier[];
  category: FeatureTemplateCategory;
}

export interface EpitopeTagDefinition {
  name: string;
  sequence: string;
  translation: string;
}

export interface ProteaseCleavageSiteDefinition {
  name: string;
  sequence: string;
  translation: string;
  rawTranslation: string;
  cleavageOffsetAa: number | null;
}

export interface PolymeraseDefinition {
  name: string;
  summary: string;
  example: string;
  overhangType: "blunt" | "3";
  overhangBases?: string;
}

export const STANDARD_POLYMERASES: readonly PolymeraseDefinition[] = [
  {
    name: "Creates Blunt Ends",
    summary: "polymerase that creates blunt ends",
    example: "(e.g., Pfu)",
    overhangType: "blunt",
  },
  {
    name: "Creates 3' A or G Overhangs",
    summary: "polymerase that creates 3' A or G overhangs",
    example: "(e.g., Taq)",
    overhangType: "3",
    overhangBases: "R",
  },
];

export const STANDARD_EPITOPE_TAGS: readonly EpitopeTagDefinition[] = [
  {
    "name": "6xHis",
    "sequence": "CATCATCACCATCACCAC",
    "translation": "HHHHHH"
  },
  {
    "name": "8xHis",
    "sequence": "CATCATCATCACCATCACCACCAC",
    "translation": "HHHHHHHH"
  },
  {
    "name": "10xHis",
    "sequence": "CATCATCATCATCACCATCACCACCACCAC",
    "translation": "HHHHHHHHHH"
  },
  {
    "name": "AviTag™",
    "sequence": "GGCCTGAACGACATCTTCGAGGCTCAGAAAATCGAATGGCACGAA",
    "translation": "GLNDIFEAQKIEWHE"
  },
  {
    "name": "c-myc",
    "sequence": "GAGCAGAAACTCATCTCTGAAGAGGATCTG",
    "translation": "EQKLISEEDL"
  },
  {
    "name": "FLAG®",
    "sequence": "GATTACAAGGATGACGACGATAAG",
    "translation": "DYKDDDDK"
  },
  {
    "name": "Glu-Glu",
    "sequence": "GAGTACATGCCAATGGAG",
    "translation": "EYMPME"
  },
  {
    "name": "Hemagglutinin (HA)",
    "sequence": "TACCCATACGATGTTCCAGATTACGCT",
    "translation": "YPYDVPDYA"
  },
  {
    "name": "HSV",
    "sequence": "CAGCCAGAACTCGCCCCGGAAGACCCCGAGGAT",
    "translation": "QPELAPEDPED"
  },
  {
    "name": "S-Tag",
    "sequence": "AAAGAAACCGCTGCTGCTAAATTCGAACGCCAGCACATGGACAGC",
    "translation": "KETAAAKFERQHMDS"
  },
  {
    "name": "Strep-Tag II",
    "sequence": "TGGAGCCACCCGCAGTTCGAAAAG",
    "translation": "WSHPQFEK"
  },
  {
    "name": "T7",
    "sequence": "ATGGCTAGCATGACTGGTGGACAGCAAATGGGT",
    "translation": "MASMTGGQQMG"
  },
  {
    "name": "VSV-G",
    "sequence": "TATACAGACATAGAGATGAACCGACTTGGAAAG",
    "translation": "YTDIEMNRLGK"
  },
  {
    "name": "V5",
    "sequence": "GGTAAGCCTATCCCTAACCCTCTCCTCGGTCTCGATTCTACG",
    "translation": "GKPIPNPLLGLDST"
  }
];

export const STANDARD_PROTEASE_SITES: readonly ProteaseCleavageSiteDefinition[] = [
  {
    "name": "Enterokinase",
    "sequence": "GACGACGACGACAAG",
    "translation": "DDDDK",
    "rawTranslation": "DDDDK↓",
    "cleavageOffsetAa": 5
  },
  {
    "name": "Factor Xa",
    "sequence": "ATCGAAGGTCGT",
    "translation": "IEGR",
    "rawTranslation": "IEGR↓",
    "cleavageOffsetAa": 4
  },
  {
    "name": "Genenase™ I",
    "sequence": "CCAGGGGCCGCACACTAT",
    "translation": "PGAAHY",
    "rawTranslation": "PGAAHY↓",
    "cleavageOffsetAa": 6
  },
  {
    "name": "PreScission Protease (HRV 3C)",
    "sequence": "CTGGAAGTTCTGTTCCAGGGGCCC",
    "translation": "LEVLFQGP",
    "rawTranslation": "LEVLFQ↓GP",
    "cleavageOffsetAa": 6
  },
  {
    "name": "TEV Protease",
    "sequence": "GAGGATCTGTACTTTCAGAGC",
    "translation": "EDLYFQS",
    "rawTranslation": "EDLYFQ↓S",
    "cleavageOffsetAa": 6
  },
  {
    "name": "Thrombin",
    "sequence": "CTGGTGCCGCGCGGCAGC",
    "translation": "LVPRGS",
    "rawTranslation": "LVPR↓GS",
    "cleavageOffsetAa": 4
  }
];

export const STANDARD_COMMON_FEATURES: readonly CommonFeatureTemplate[] = [
  {
    "name": "AmpR promoter",
    "type": "promoter",
    "strand": 1,
    "sequence": "CATTCAAATATGTATCCGCTCATGAGACAATAACCCTGATAAATGCTTCAATAATATTGAAAAAGGAAGAGT",
    "color": "#ffffff",
    "qualifiers": [
      {
        "key": "gene",
        "value": "bla"
      }
    ],
    "category": "common_feature"
  },
  {
    "name": "lacZα",
    "type": "CDS",
    "strand": 1,
    "sequence": "ATGACCATGATTACGGATTCACTGGCCGTCGTTTTACAACGTCGTGACTGGGAAAACCCTGGCGTTACCCAACTTAATCGCCTTGCAGCACATCCCCCTTTCGCCAGCTGGCGTAATAGCGAAGAGGCCCGCACCGATCGCCCTTCCCAACAGTTGCGCAGCCTGAATGGCGAA",
    "color": "#993366",
    "maxRunOn": 43038,
    "qualifiers": [
      {
        "key": "codon_start",
        "value": "1"
      },
      {
        "key": "gene",
        "value": "lacZ fragment"
      },
      {
        "key": "product",
        "value": "LacZα fragment of β-galactosidase"
      },
      {
        "key": "transl_table",
        "value": "1"
      },
      {
        "key": "translation",
        "value": "MTMITDSLAVVLQRRDWENPGVTQLNRLAAHPPFASWRNSEEARTDRPSQQLRSLNGE"
      }
    ],
    "category": "common_feature"
  },
  {
    "name": "CAP binding site",
    "type": "protein_bind",
    "strand": 0,
    "sequence": "TAATGTGAGTTAGCTCACTCAT",
    "color": "#31849b",
    "qualifiers": [
      {
        "key": "bound_moiety",
        "value": "E. coli catabolite activator protein"
      },
      {
        "key": "note",
        "value": "CAP binding activates transcription in the presence of cAMP."
      }
    ],
    "category": "common_feature"
  },
  {
    "name": "AmpR promoter",
    "type": "promoter",
    "strand": 1,
    "sequence": "TATGTATCCGCTCATGAGACAATAACCCTGATAAATGCTTCAATAATATTGAAAAAGGAAGAGT",
    "color": "#ffffff",
    "qualifiers": [
      {
        "key": "gene",
        "value": "bla"
      }
    ],
    "category": "common_feature"
  },
  {
    "name": "AmpR promoter",
    "type": "promoter",
    "strand": 1,
    "sequence": "CGCGGAACCCCTATTTGTTTATTTTTCTAAATACATTCAAATATGTATCCGCTCATGAGACAATAACCCTGATAAATGCTTCAATAATATTGAAAAAGGAAGA",
    "color": "#ffffff",
    "qualifiers": [
      {
        "key": "gene",
        "value": "bla"
      }
    ],
    "category": "common_feature"
  },
  {
    "name": "AmpR promoter",
    "type": "promoter",
    "strand": 1,
    "sequence": "CGCGGAACCCCTATTTGTTTATTTTTCTAAATACATTCAAATATGTATCCGCTCATGAGACAATAACCCTGATAAATGCTTCAATAATATTGAAAAAGGAAGAGT",
    "color": "#ffffff",
    "qualifiers": [
      {
        "key": "gene",
        "value": "bla"
      }
    ],
    "category": "common_feature"
  },
  {
    "name": "M13 rev",
    "type": "primer_bind",
    "strand": 1,
    "sequence": "CAGGAAACAGCTATGAC",
    "color": "#a020f0",
    "qualifiers": [
      {
        "key": "note",
        "value": "common sequencing primer, one of multiple similar variants"
      }
    ],
    "category": "common_feature"
  },
  {
    "name": "M13 fwd",
    "type": "primer_bind",
    "strand": 1,
    "sequence": "GTAAAACGACGGCCAGT",
    "color": "#a020f0",
    "qualifiers": [
      {
        "key": "note",
        "value": "common sequencing primer, one of multiple similar variants"
      }
    ],
    "category": "common_feature"
  },
  {
    "name": "lac promoter",
    "type": "promoter",
    "strand": 1,
    "sequence": "TTTACACTTTATGCTTCCGGCTCGTATGTTG",
    "color": "#ffffff",
    "qualifiers": [
      {
        "key": "note",
        "value": "promoter for the E. coli lac operon"
      }
    ],
    "category": "common_feature"
  },
  {
    "name": "lac operator",
    "type": "protein_bind",
    "strand": 0,
    "sequence": "TTGTGAGCGGATAACAA",
    "color": "#31849b",
    "qualifiers": [
      {
        "key": "bound_moiety",
        "value": "lac repressor encoded by lacI"
      },
      {
        "key": "note",
        "value": "The lac repressor binds to the lac operator to inhibit transcription in E. coli. This inhibition can be relieved by adding lactose or isopropyl-β-D-thiogalactopyranoside (IPTG)."
      }
    ],
    "category": "common_feature"
  },
  {
    "name": "MCS",
    "type": "misc_feature",
    "strand": 0,
    "sequence": "GAATTCGAGCTCGGTACCCGGGGATCCTCTAGAGTCGACCTGCAGGCATGCAAGCTT",
    "color": "#99ccff",
    "qualifiers": [
      {
        "key": "gene",
        "value": ""
      },
      {
        "key": "note",
        "value": "pUC18/19 multiple cloning site"
      }
    ],
    "category": "common_feature"
  },
  {
    "name": "ori",
    "type": "rep_origin",
    "strand": 1,
    "sequence": "TTGAGATCCTTTTTTTCTGCGCGTAATCTGCTGCTTGCAAACAAAAAAACCACCGCTACCAGCGGTGGTTTGTTTGCCGGATCAAGAGCTACCAACTCTTTTTCCGAAGGTAACTGGCTTCAGCAGAGCGCAGATACCAAATACTGTCCTTCTAGTGTAGCCGTAGTTAGGCCACCACTTCAAGAACTCTGTAGCACCGCCTACATACCTCGCTCTGCTAATCCTGTTACCAGTGGCTGCTGCCAGTGGCGATAAGTCGTGTCTTACCGGGTTGGACTCAAGACGATAGTTACCGGATAAGGCGCAGCGGTCGGGCTGAACGGGGGGTTCGTGCACACAGCCCAGCTTGGAGCGAACGACCTACACCGAACTGAGATACCTACAGCGTGAGCTATGAGAAAGCGCCACGCTTCCCGAAGGGAGAAAGGCGGACAGGTATCCGGTAAGCGGCAGGGTCGGAACAGGAGAGCGCACGAGGGAGCTTCCAGGGGGAAACGCCTGGTATCTTTATAGTCCTGTCGGGTTTCGCCACCTCTGACTTGAGCGTCGATTTTTGTGATGCTCGTCAGGGGGGCGGAGCCTATGGAAA",
    "color": "#ffff00",
    "qualifiers": [
      {
        "key": "direction",
        "value": "RIGHT"
      },
      {
        "key": "note",
        "value": "high-copy-number ColE1/pMB1/pBR322/pUC origin of replication"
      }
    ],
    "category": "common_feature"
  },
  {
    "name": "AmpR",
    "type": "CDS",
    "strand": 1,
    "sequence": "ATGAGTATTCAACATTTCCGTGTCGCCCTTATTCCCTTTTTTGCGGCATTTTGCCTTCCTGTTTTTGCTCACCCAGAAACGCTGGTGAAAGTAAAAGATGCTGAAGATCAGTTGGGTGCACGAGTGGGTTACATCGAACTGGATCTCAACAGCGGTAAGATCCTTGAGAGTTTTCGCCCCGAAGAACGTTTTCCAATGATGAGCACTTTTAAAGTTCTGCTATGTGGCGCGGTATTATCCCGTGTTGACGCCGGGCAAGAGCAACTCGGTCGCCGCATACACTATTCTCAGAATGACTTGGTTGAGTACTCACCAGTCACAGAAAAGCATCTTACGGATGGCATGACAGTAAGAGAATTATGCAGTGCTGCCATAACCATGAGTGATAACACTGCGGCCAACTTACTTCTGACAACGATCGGAGGACCGAAGGAGCTAACCGCTTTTTTGCACAACATGGGGGATCATGTAACTCGCCTTGATCGTTGGGAACCGGAGCTGAATGAAGCCATACCAAACGACGAGCGTGACACCACGATGCCTGCAGCAATGGCAACAACGTTGCGCAAACTATTAACTGGCGAACTACTTACTCTAGCTTCCCGGCAACAATTAATAGACTGGATGGAGGCGGATAAAGTTGCAGGACCACTTCTGCGCTCGGCCCTTCCGGCTGGCTGGTTTATTGCTGATAAATCTGGAGCCGGTGAGCGTGGGTCTCGCGGTATCATTGCAGCACTGGGGCCAGATGGTAAGCCCTCCCGTATCGTAGTTATCTACACGACGGGGAGTCAGGCAACTATGGATGAACGAAATAGACAGATCGCTGAGATAGGTGCCTCACTGATTAAGCATTGGTAA",
    "color": "#ccffcc",
    "qualifiers": [
      {
        "key": "codon_start",
        "value": "1"
      },
      {
        "key": "gene",
        "value": "bla"
      },
      {
        "key": "note",
        "value": "confers resistance to ampicillin, carbenicillin, and related antibiotics"
      },
      {
        "key": "product",
        "value": "β-lactamase"
      },
      {
        "key": "transl_table",
        "value": "1"
      },
      {
        "key": "translation",
        "value": "MSIQHFRVALIPFFAAFCLPVFA,HPETLVKVKDAEDQLGARVGYIELDLNSGKILESFRPEERFPMMSTFKVLLCGAVLSRVDAGQEQLGRRIHYSQNDLVEYSPVTEKHLTDGMTVRELCSAAITMSDNTAANLLLTTIGGPKELTAFLHNMGDHVTRLDRWEPELNEAIPNDERDTTMPAAMATTLRKLLTGELLTLASRQQLIDWMEADKVAGPLLRSALPAGWFIADKSGAGERGSRGIIAALGPDGKPSRIVVIYTTGSQATMDERNRQIAEIGASLIKHW*"
      }
    ],
    "category": "common_feature"
  },
  {
    "name": "AmpR promoter",
    "type": "promoter",
    "strand": 1,
    "sequence": "TTTGTTTATTTTTCTAAATACATTCAAATATGTATCCGCTCATGAGACAATAACCCTGATAAATGCTTCAATAATATTGAAAAAGGAAGAGT",
    "color": "#ffffff",
    "qualifiers": [
      {
        "key": "gene",
        "value": "bla"
      }
    ],
    "category": "common_feature"
  },
  {
    "name": "ISS",
    "type": "CDS",
    "strand": 1,
    "sequence": "AACGTTTTCCAATGATGAGCACTTTTAAAGTTCTGCTATGTGGCGCGGTATTATCCCGTATTGACGCCGGGCAAGAGCAACTCGGTCGCCGCATACACTATTCTCAGAATGACTTGGTTGAGTACTCACCAGTCACAGAAAAGCATCTTACGGATGGCATGACAGTAAGAGAATTATGCAGTGCTGCCATAACCATGAGTGATAACACTGCGGCCAACTTACTTCTGACAACGATCGGAGGACCGAAGGAGCTAACCGCTTTTTTGCACAACATGGGGGATCATGTAACTCGCCTTGATCGTTGGGAACCGGAGCTGAATGAAGCCATACCAAACGACGAGCGTGACACCACGATGCCTGTAGCAATGGCAACAACGTT",
    "color": "#a6acb3",
    "qualifiers": [
      {
        "key": "codon_start",
        "value": "1"
      },
      {
        "key": "note",
        "value": "immunostimulatory sequence from the AmpR gene; contains unmethylated CpG dinucleotides in the context of 5'-AACGTT-3' (Sato et al., 1996)"
      },
      {
        "key": "transl_table",
        "value": "1"
      }
    ],
    "category": "common_feature"
  },
  {
    "name": "bom",
    "type": "misc_feature",
    "strand": 0,
    "sequence": "CGCAGCCATGACCCAGTCACGTAGCGATAGCGGAGTGTATACTGGCTTAACTATGCGGCATCAGAGCAGATTGTACTGAGAGTGCACCATATGCGGTGTGAAATACCGCACAGATGCGTAAGGAGAAAATACCGCATCAGG",
    "color": "#a6acb3",
    "qualifiers": [
      {
        "key": "note",
        "value": "basis of mobility region from pBR322"
      }
    ],
    "category": "common_feature"
  },
  {
    "name": "rop",
    "type": "CDS",
    "strand": 1,
    "sequence": "GTGACCAAACAGGAAAAAACCGCCCTTAACATGGCCCGCTTTATCAGAAGCCAGACATTAACGCTTCTGGAGAAACTCAACGAGCTGGACGCGGATGAACAGGCAGACATCTGTGAATCGCTTCACGACCACGCTGATGAGCTTTACCGCAGCTGCCTCGCGCGTTTCGGTGATGACGGTGAAAACCTCTGA",
    "color": "#993366",
    "qualifiers": [
      {
        "key": "codon_start",
        "value": "1"
      },
      {
        "key": "gene",
        "value": "rop"
      },
      {
        "key": "product",
        "value": "Rop protein, which maintains plasmids at low copy number"
      },
      {
        "key": "transl_table",
        "value": "1"
      },
      {
        "key": "translation",
        "value": "VTKQEKTALNMARFIRSQTLTLLEKLNELDADEQADICESLHDHADELYRSCLARFGDDGENL*"
      }
    ],
    "category": "common_feature"
  },
  {
    "name": "TcR",
    "type": "CDS",
    "strand": 1,
    "sequence": "ATGAAATCTAACAATGCGCTCATCGTCATCCTCGGCACCGTCACCCTGGATGCTGTAGGCATAGGCTTGGTTATGCCGGTACTGCCGGGCCTCTTGCGGGATATCGTCCATTCCGACAGCATCGCCAGTCACTATGGCGTGCTGCTAGCGCTATATGCGTTGATGCAATTTCTATGCGCACCCGTTCTCGGAGCACTGTCCGACCGCTTTGGCCGCCGCCCAGTCCTGCTCGCTTCGCTACTTGGAGCCACTATCGACTACGCGATCATGGCGACCACACCCGTCCTGTGGATCCTCTACGCCGGACGCATCGTGGCCGGCATCACCGGCGCCACAGGTGCGGTTGCTGGCGCCTATATCGCCGACATCACCGATGGGGAAGATCGGGCTCGCCACTTCGGGCTCATGAGCGCTTGTTTCGGCGTGGGTATGGTGGCAGGCCCCGTGGCCGGGGGACTGTTGGGCGCCATCTCCTTGCATGCACCATTCCTTGCGGCGGCGGTGCTCAACGGCCTCAACCTACTACTGGGCTGCTTCCTAATGCAGGAGTCGCATAAGGGAGAGCGTCGACCGATGCCCTTGAGAGCCTTCAACCCAGTCAGCTCCTTCCGGTGGGCGCGGGGCATGACTATCGTCGCCGCACTTATGACTGTCTTCTTTATCATGCAACTCGTAGGACAGGTGCCGGCAGCGCTCTGGGTCATTTTCGGCGAGGACCGCTTTCGCTGGAGCGCGACGATGATCGGCCTGTCGCTTGCGGTATTCGGAATCTTGCACGCCCTCGCTCAAGCCTTCGTCACTGGTCCCGCCACCAAACGTTTCGGCGAGAAGCAGGCCATTATCGCCGGCATGGCGGCCGACGCGCTGGGCTACGTCTTGCTGGCGTTCGCGACGCGAGGCTGGATGGCCTTCCCCATTATGATTCTTCTCGCTTCCGGCGGCATCGGGATGCCCGCGTTGCAGGCCATGCTGTCCAGGCAGGTAGATGACGACCATCAGGGACAGCTTCAAGGATCGCTCGCGGCTCTTACCAGCCTAACTTCGATCATTGGACCGCTGATCGTCACGGCGATTTATGCCGCCTCGGCGAGCACATGGAACGGGTTGGCATGGATTGTAGGCGCCGCCCTATACCTTGTCTGCCTCCCCGCGTTGCGTCGCGGTGCATGGAGCCGGGCCACCTCGACCTGA",
    "color": "#ccffcc",
    "qualifiers": [
      {
        "key": "codon_start",
        "value": "1"
      },
      {
        "key": "gene",
        "value": "tet"
      },
      {
        "key": "note",
        "value": "confers resistance to tetracycline"
      },
      {
        "key": "product",
        "value": "tetracycline efflux protein"
      },
      {
        "key": "transl_table",
        "value": "1"
      },
      {
        "key": "translation",
        "value": "MKSNNALIVILGTVTLDAVGIGLVMPVLPGLLRDIVHSDSIASHYGVLLALYALMQFLCAPVLGALSDRFGRRPVLLASLLGATIDYAIMATTPVLWILYAGRIVAGITGATGAVAGAYIADITDGEDRARHFGLMSACFGVGMVAGPVAGGLLGAISLHAPFLAAAVLNGLNLLLGCFLMQESHKGERRPMPLRAFNPVSSFRWARGMTIVAALMTVFFIMQLVGQVPAALWVIFGEDRFRWSATMIGLSLAVFGILHALAQAFVTGPATKRFGEKQAIIAGMAADALGYVLLAFATRGWMAFPIMILLASGGIGMPALQAMLSRQVDDDHQGQLQGSLAALTSLTSIIGPLIVTAIYAASASTWNGLAWIVGAALYLVCLPALRRGAWSRATST*"
      }
    ],
    "category": "common_feature"
  },
  {
    "name": "tet promoter",
    "type": "promoter",
    "strand": 1,
    "sequence": "TTGACAGCTTATCATCGATAAGCTTTAAT",
    "color": "#ffffff",
    "qualifiers": [
      {
        "key": "note",
        "value": "E. coli promoter for tetracycline efflux protein gene"
      }
    ],
    "category": "common_feature"
  },
  {
    "name": "araBAD promoter",
    "type": "promoter",
    "strand": 1,
    "sequence": "AAGAAACCAATTGTCCATATTGCATCAGACATTGCCGTCACTGCGTCTTTTACTGGCTCTTCTCGCTAACCAAACCGGTAACCCCGCTTATTAAAAGCATTCTGTAACAAAGCGGGACCAAAGCCATGACAAAAACGCGTAACAAAAGTGTCTATAATCACGGCAGAAAAGTCCACATTGATTATTTGCACGGCGTCACACTTTGCTATGCCATAGCATTTTTATCCATAAGATTAGCGGATCCTACCTGACGCTTTTTATCGCAACTCTCTACTGTTTCTCCAT",
    "color": "#ffffff",
    "qualifiers": [
      {
        "key": "gene",
        "value": "araBAD"
      },
      {
        "key": "note",
        "value": "promoter of the L-arabinose operon of E. coli; the araC regulatory gene is transcribed in the opposite direction (Guzman et al., 1995)"
      }
    ],
    "category": "common_feature"
  },
  {
    "name": "araBAD promoter",
    "type": "promoter",
    "strand": 1,
    "sequence": "AAAGCCATGACAAAAACGCGTAACAAAAGTGTCTATAATCACGGCAGAAAAGTCCACATTGATTATTTGCACGGCGTCACACTTTGCTATGCCATAGCATTTTTATCCATAAGATTAGCGGATCCTACCTGACGCTTTTTATCGCAACTCTCTACTGTTTCTCCAT",
    "color": "#ffffff",
    "qualifiers": [
      {
        "key": "gene",
        "value": "araBAD"
      },
      {
        "key": "note",
        "value": "promoter of the L-arabinose operon of E. coli; the araC regulatory gene is transcribed in the opposite direction (Guzman et al., 1995)"
      }
    ],
    "category": "common_feature"
  },
  {
    "name": "rrnB T1 terminator",
    "type": "terminator",
    "strand": 1,
    "sequence": "CAAATAAAACGAAAGGCTCAGTCGAAAGACTGGGCCTTTCGTTTTATCTGTTGTTTGTCGGTGAACGCTCTC",
    "color": "#ffffff",
    "qualifiers": [
      {
        "key": "note",
        "value": "transcription terminator T1 from the E. coli rrnB gene"
      }
    ],
    "category": "common_feature"
  },
  {
    "name": "M13 ori",
    "type": "rep_origin",
    "strand": 1,
    "sequence": "ACGCGCCCTGTAGCGGCGCATTAAGCGCGGCGGGTGTGGTGGTTACGCGCAGCGTGACCGCTACACTTGCCAGCGCCCTAGCGCCCGCTCCTTTCGCTTTCTTCCCTTCCTTTCTCGCCACGTTCGCCGGCTTTCCCCGTCAAGCTCTAAATCGGGGGCTCCCTTTAGGGTTCCGATTTAGTGCTTTACGGCACCTCGACCCCAAAAAACTTGATTTGGGTGATGGTTCACGTAGTGGGCCATCGCCCTGATAGACGGTTTTTCGCCCTTTGACGTTGGAGTCCACGTTCTTTAATAGTGGACTCTTGTTCCAAACTGGAACAACACTCAACCCTATCTCGGGCTATTCTTTTGATTTATAAGGGATTTTGCCGATTTCGG",
    "color": "#ffff00",
    "qualifiers": [
      {
        "key": "direction",
        "value": "RIGHT"
      },
      {
        "key": "note",
        "value": "M13 bacteriophage origin of replication; arrow indicates direction of (+) strand synthesis"
      }
    ],
    "category": "common_feature"
  },
  {
    "name": "rrnB T1 terminator",
    "type": "terminator",
    "strand": 1,
    "sequence": "CAAATAAAACGAAAGGCTCAGTCGAAAGACTGGGCCTTTCGTTTTAT",
    "color": "#ffffff",
    "qualifiers": [
      {
        "key": "note",
        "value": "transcription terminator T1 from the E. coli rrnB gene"
      }
    ],
    "category": "common_feature"
  },
  {
    "name": "rrnB T1 terminator",
    "type": "terminator",
    "strand": 1,
    "sequence": "CAAATAAAACGAAAGGCTCAGTCGAAAGACTGGGCCTTTCGTTTTATCTGTTGTTTGTCGGTGAACGCTCTCCTGAGTAGGACAAAT",
    "color": "#ffffff",
    "qualifiers": [
      {
        "key": "gene",
        "value": "Escherichia coli rrnB"
      },
      {
        "key": "note",
        "value": "transcription terminator T1 from the E. coli rrnB gene"
      }
    ],
    "category": "common_feature"
  },
  {
    "name": "p15A ori",
    "type": "rep_origin",
    "strand": 1,
    "sequence": "TTGAGATCGTTTTGGTCTGCGCGTAATCTCTTGCTCTGAAAACGAAAAAACCGCCTTGCAGGGCGGTTTTTCGAAGGTTCTCTGAGCTACCAACTCTTTGAACCGAGGTAACTGGCTTGGAGGAGCGCAGTCACCAAAACTTGTCCTTTCAGTTTAGCCTTAACCGGCGCATGACTTCAAGACTAACTCCTCTAAATCAATTACCAGTGGCTGCTGCCAGTGGTGCTTTTGCATGTCTTTCCGGGTTGGACTCAAGACGATAGTTACCGGATAAGGCGCAGCGGTCGGACTGAACGGGGGGTTCGTGCATACAGTCCAGCTTGGAGCGAACTGCCTACCCGGAACTGAGTGTCAGGCGTGGAATGAGACAAACGCGGCCATAACAGCGGAATGACACCGGTAAACCGAAAGGCAGGAACAGGAGAGCGCACGAGGGAGCCGCCAGGGGGAAACGCCTGGTATCTTTATAGTCCTGTCGGGTTTCGCCACCACTGATTTGAGCGTCAGATTTCGTGATGCTTGTCAGGGGGGCGGAGCCTATGGAAA",
    "color": "#ffff00",
    "qualifiers": [
      {
        "key": "direction",
        "value": "RIGHT"
      },
      {
        "key": "note",
        "value": "Plasmids containing the medium-copy-number p15A origin of replication&nbsp;can be propagated in E. coli&nbsp;cells&nbsp;that contain a second plasmid with the ColE1 origin."
      }
    ],
    "category": "common_feature"
  },
  {
    "name": "araC",
    "type": "CDS",
    "strand": 1,
    "sequence": "ATGGCTGAAGCGCAAAATGATCCCCTGCTGCCGGGATACTCGTTTAATGCCCATCTGGTGGCGGGTTTAACGCCGATTGAGGCCAACGGTTATCTCGATTTTTTTATCGACCGACCGCTGGGAATGAAAGGTTATATTCTCAATCTCACCATTCGCGGTCAGGGGGTGGTGAAAAATCAGGGACGAGAATTTGTTTGCCGACCGGGTGATATTTTGCTGTTCCCGCCAGGAGAGATTCATCACTACGGTCGTCATCCGGAGGCTCGCGAATGGTATCACCAGTGGGTTTACTTTCGTCCGCGCGCCTACTGGCATGAATGGCTTAACTGGCCGTCAATATTTGCCAATACGGGGTTCTTTCGCCCGGATGAAGCGCACCAGCCGCATTTCAGCGACCTGTTTGGGCAAATCATTAACGCCGGGCAAGGGGAAGGGCGCTATTCGGAGCTGCTGGCGATAAATCTGCTTGAGCAATTGTTACTGCGGCGCATGGAAGCGATTAACGAGTCGCTCCATCCACCGATGGATAATCGGGTACGCGAGGCTTGTCAGTACATCAGCGATCACCTGGCAGACAGCAATTTTGATATCGCCAGCGTCGCACAGCATGTTTGCTTGTCGCCGTCGCGTCTGTCACATCTTTTCCGCCAGCAGTTAGGGATTAGCGTCTTAAGCTGGCGCGAGGACCAACGTATCAGCCAGGCGAAGCTGCTTTTGAGCACCACCCGGATGCCTATCGCCACCGTCGGTCGCAATGTTGGTTTTGACGATCAACTCTATTTCTCGCGGGTATTTAAAAAATGCACCGGGGCCAGCCCGAGCGAGTTCCGTGCCGGTTGTGAAGAAAAAGTGAATGATGTAGCCGTCAAGTTGTCATAA",
    "color": "#993366",
    "qualifiers": [
      {
        "key": "codon_start",
        "value": "1"
      },
      {
        "key": "gene",
        "value": "araC"
      },
      {
        "key": "product",
        "value": "L-arabinose regulatory protein"
      },
      {
        "key": "transl_table",
        "value": "1"
      },
      {
        "key": "translation",
        "value": "MAEAQNDPLLPGYSFNAHLVAGLTPIEANGYLDFFIDRPLGMKGYILNLTIRGQGVVKNQGREFVCRPGDILLFPPGEIHHYGRHPEAREWYHQWVYFRPRAYWHEWLNWPSIFANTGFFRPDEAHQPHFSDLFGQIINAGQGEGRYSELLAINLLEQLLLRRMEAINESLHPPMDNRVREACQYISDHLADSNFDIASVAQHVCLSPSRLSHLFRQQLGISVLSWREDQRISQAKLLLSTTRMPIATVGRNVGFDDQLYFSRVFKKCTGASPSEFRAGCEEKVNDVAVKLS*"
      }
    ],
    "category": "common_feature"
  },
  {
    "name": "rrnB T2 terminator",
    "type": "terminator",
    "strand": 1,
    "sequence": "AGAAGGCCATCCTGACGGATGGCCTTTT",
    "color": "#ffffff",
    "qualifiers": [
      {
        "key": "note",
        "value": "transcription terminator T2 from the E. coli rrnB gene"
      }
    ],
    "category": "common_feature"
  },
  {
    "name": "rrnB T1 terminator",
    "type": "terminator",
    "strand": 1,
    "sequence": "AAAACGAAAGGCTCAGTCGAAAGACTGGGCCTTTCGTTTTATCTGTTGTTTGTCGGTGAACGCTCTCCTGAGTAGGACAAAT",
    "color": "#ffffff",
    "qualifiers": [
      {
        "key": "gene",
        "value": "Escherichia coli rrnB"
      },
      {
        "key": "note",
        "value": "transcription terminator T1 from the E. coli rrnB gene"
      }
    ],
    "category": "common_feature"
  },
  {
    "name": "HygR",
    "type": "CDS",
    "strand": 1,
    "sequence": "ATGCCTGAACTCACCGCGACGTCTGTCGAGAAGTTTCTGATCGAAAAGTTCGACAGCGTCTCCGACCTGATGCAGCTCTCGGAGGGCGAAGAATCTCGTGCTTTCAGCTTCGATGTAGGAGGGCGTGGATATGTCCTGCGGGTAAATAGCTGCGCCGATGGTTTCTACAAAGATCGTTATGTTTATCGGCACTTTGCATCGGCCGCGCTCCCGATTCCGGAAGTGCTTGACATTGGGGAATTCAGCGAGAGCCTGACCTATTGCATCTCCCGCCGTGCACAGGGTGTCACGTTGCAAGACCTGCCTGAAACCGAACTGCCCGCTGTTCTGCAGCCGGTCGCGGAGGCCATGGATGCGATCGCTGCGGCCGATCTTAGCCAGACGAGCGGGTTCGGCCCATTCGGACCGCAAGGAATCGGTCAATACACTACATGGCGTGATTTCATATGCGCGATTGCTGATCCCCATGTGTATCACTGGCAAACTGTGATGGACGACACCGTCAGTGCGTCCGTCGCGCAGGCTCTCGATGAGCTGATGCTTTGGGCCGAGGACTGCCCCGAAGTCCGGCACCTCGTGCACGCGGATTTCGGCTCCAACAATGTCCTGACGGACAATGGCCGCATAACAGCGGTCATTGACTGGAGCGAGGCGATGTTCGGGGATTCCCAATACGAGGTCGCCAACATCTTCTTCTGGAGGCCGTGGTTGGCTTGTATGGAGCAGCAGACGCGCTACTTCGAGCGGAGGCATCCGGAGCTTGCAGGATCGCCGCGGCTCCGGGCGTATATGCTCCGCATTGGTCTTGACCAACTCTATCAGAGCTTGGTTGACGGCAATTTCGATGATGCAGCTTGGGCGCAGGGTCGATGCGACGCAATCGTCCGATCCGGAGCCGGGACTGTCGGGCGTACACAAATCGCCCGCAGAAGCGCGGCCGTCTGGACCGATGGCTGTGTAGAAGTACTCGCCGATAGTGGAAACCGACGCCCCAGCACTCGTCCGAGGGCAAAGGAATAG",
    "color": "#ccffcc",
    "qualifiers": [
      {
        "key": "codon_start",
        "value": "1"
      },
      {
        "key": "note",
        "value": "confers resistance to hygromycin"
      },
      {
        "key": "product",
        "value": "aminoglycoside phosphotransferase from E. coli"
      },
      {
        "key": "transl_table",
        "value": "1"
      },
      {
        "key": "translation",
        "value": "MPELTATSVEKFLIEKFDSVSDLMQLSEGEESRAFSFDVGGRGYVLRVNSCADGFYKDRYVYRHFASAALPIPEVLDIGEFSESLTYCISRRAQGVTLQDLPETELPAVLQPVAEAMDAIAAADLSQTSGFGPFGPQGIGQYTTWRDFICAIADPHVYHWQTVMDDTVSASVAQALDELMLWAEDCPEVRHLVHADFGSNNVLTDNGRITAVIDWSEAMFGDSQYEVANIFFWRPWLACMEQQTRYFERRHPELAGSPRLRAYMLRIGLDQLYQSLVDGNFDDAAWAQGRCDAIVRSGAGTVGRTQIARRSAAVWTDGCVEVLADSGNRRPSTRPRAKE*"
      }
    ],
    "category": "common_feature"
  },
  {
    "name": "SV40 promoter",
    "type": "promoter",
    "strand": 1,
    "sequence": "GCAGGCAGAAGTATGCAAAGCATGCATCTCAATTAGTCAGCAACCATAGTCCCGCCCCTAACTCCGCCCATCCCGCCCCTAACTCCGCCCAGTTCCGCCCATTCTCCGCCCCATGGCTGACTAATTTTTTTTATTTATGCAGAGGCCGAGGCCGCCTCGGCCTCTGAGCTATTCCAGAAGTAGTGAGGAGGCTTTTTTGGAGGCCTAGGCT",
    "color": "#ffffff",
    "qualifiers": [
      {
        "key": "note",
        "value": "SV40 early promoter"
      }
    ],
    "category": "common_feature"
  },
  {
    "name": "CMV enhancer",
    "type": "enhancer",
    "strand": 0,
    "sequence": "CGTTACATAACTTACGGTAAATGGCCCGCCTGGCTGACCGCCCAACGACCCCCGCCCATTGACGTCAATAGTAACGCCAATAGGGACTTTCCATTGACGTCAATGGGTGGAGTATTTACGGTAAACTGCCCACTTGGCAGTACATCAAGTGTATCATATGCCAAGTACGCCCCCTATTGACGTCAATGACGGTAAATGGCCCGCCTGGCATTGTGCCCAGTACATGACCTTATGGGACTTTCCTACTTGGCAGTACATCTACGTATTAGTCATCGCTATTACCATG",
    "color": "#ffffff",
    "qualifiers": [
      {
        "key": "note",
        "value": "human cytomegalovirus immediate early enhancer; contains an 18-bp deletion relative to the standard CMV enhancer"
      }
    ],
    "category": "common_feature"
  },
  {
    "name": "TetR",
    "type": "CDS",
    "strand": 1,
    "sequence": "ATGTCCAGACTGGACAAGAGCAAAGTCATCAACTCTGCCTTGGAGCTCCTGAATGAAGTTGGCATTGAGGGCTTGACCACCAGGAAGCTGGCCCAGAAGCTGGGTGTGGAGCAGCCTACCCTGTACTGGCATGTGAAGAACAAGAGGGCTCTGCTTGATGCCCTGGCCATTGAGATGTTGGACAGGCACCACACCCACTTCTGCCCTCTGGAAGGGGAGTCCTGGCAGGACTTCCTGAGGAACAATGCCAAGAGCTTCAGATGTGCCTTGCTCTCCCACCGGGACGGTGCCAAAGTTCACTTGGGCACCAGGCCTACAGAGAAGCAGTATGAGACCCTGGAGAACCAGCTGGCATTCCTGTGCCAACAAGGCTTCTCCCTGGAAAATGCCTTGTATGCCCTCTCTGCTGTGGGCCACTTCACCTTGGGCTGTGTGCTGGAGGACCAGGAGCACCAAGTTGCCAAGGAGGAGAGGGAGACCCCCACCACTGACTCCATGCCACCACTGCTGCGGCAAGCTATTGAGTTGTTTGACCACCAAGGGGCTGAGCCTGCATTCCTGTTTGGCCTGGAACTGATCATCTGTGGCCTGGAAAAGCAGCTGAAATGTGAGTCTGGCTCT",
    "color": "#993366",
    "maxRunOn": 248437,
    "qualifiers": [
      {
        "key": "codon_start",
        "value": "1"
      },
      {
        "key": "gene",
        "value": "synthetic gene"
      },
      {
        "key": "note",
        "value": "TetR binds to the tetracycline operator tetO to inhibit transcription. This inhibition can be relieved by adding tetracycline or doxycycline."
      },
      {
        "key": "product",
        "value": "tetracycline repressor TetR"
      },
      {
        "key": "transl_table",
        "value": "1"
      },
      {
        "key": "translation",
        "value": "MSRLDKSKVINSALELLNEVGIEGLTTRKLAQKLGVEQPTLYWHVKNKRALLDALAIEMLDRHHTHFCPLEGESWQDFLRNNAKSFRCALLSHRDGAKVHLGTRPTEKQYETLENQLAFLCQQGFSLENALYALSAVGHFTLGCVLEDQEHQVAKEERETPTTDSMPPLLRQAIELFDHQGAEPAFLFGLELIICGLEKQLKCESGS"
      }
    ],
    "category": "common_feature"
  },
  {
    "name": "NeoR/KanR",
    "type": "CDS",
    "strand": 1,
    "sequence": "ATGCTTGAACAAGATGGATTGCACGCAGGTTCTCCGGCCGCTTGGGTGGAGAGGCTATTCGGCTATGACTGGGCACAACAGACAATCGGCTGCTCTGATGCCGCCGTGTTCCGGCTGTCAGCGCAGGGGCGCCCGGTTCTTTTTGTCAAGACCGACCTGTCCGGTGCCCTGAATGAACTGCAGGACGAGGCAGCGCGGCTATCGTGGCTGGCCACGACGGGCGTTCCTTGCGCAGCTGTGCTCGACGTTGTCACTGAAGCGGGAAGGGACTGGCTGCTATTGGGCGAAGTGCCGGGGCAGGATCTCCTGTCATCTCACCTTGCTCCTGCCGAGAAAGTATCCATCATGGCTGATGCAATGCGGCGGCTGCATACGCTTGATCCGGCTACCTGCCCATTCGACCACCAAGCGAAACATCGCATCGAGCGAGCACGCACTCGGATGGAAGCCGGTCTTGTCGATCAGGATGATCTGGACGAAGAGCATCAGGGGCTCGCGCCAGCCGAACTGTTCGCCAGGCTCAAGGCGCGTATGCCGGATGGTGAGGATCTCGTCGTGACTCATGGCGATGCCTGCTTGCCGAATATCATGGTGGAAAATGGCCGCTTTTCTGGATTCATCGACTGTGGCCGGCTGGGTGTGGCGGACCGCTATCAGGACATAGCGTTGGCTACCCGTGATATTGCTGAAGAGCTTGGCGGCGAATGGGCTGACCGCTTCCTCGTGCTTTACGGTATCGCCGCTCCCGATTCGCAGCGCATCGCCTTCTATCGCCTTCTTGACGAGTTCTTCTGA",
    "color": "#ccffcc",
    "qualifiers": [
      {
        "key": "codon_start",
        "value": "1"
      },
      {
        "key": "gene",
        "value": "aph(3')-II (or nptII)"
      },
      {
        "key": "note",
        "value": "confers resistance to neomycin, kanamycin, and G418 (Geneticin®)"
      },
      {
        "key": "product",
        "value": "aminoglycoside phosphotransferase from Tn5"
      },
      {
        "key": "transl_table",
        "value": "1"
      },
      {
        "key": "translation",
        "value": "MLEQDGLHAGSPAAWVERLFGYDWAQQTIGCSDAAVFRLSAQGRPVLFVKTDLSGALNELQDEAARLSWLATTGVPCAAVLDVVTEAGRDWLLLGEVPGQDLLSSHLAPAEKVSIMADAMRRLHTLDPATCPFDHQAKHRIERARTRMEAGLVDQDDLDEEHQGLAPAELFARLKARMPDGEDLVVTHGDACLPNIMVENGRFSGFIDCGRLGVADRYQDIALATRDIAEELGGEWADRFLVLYGIAAPDSQRIAFYRLLDEFF*"
      }
    ],
    "category": "common_feature"
  },
  {
    "name": "WPRE",
    "type": "misc_feature",
    "strand": 0,
    "sequence": "AATCAACCTCTGGATTACAAAATTTGTGAAAGATTGACTGATATTCTTAACTATGTTGCTCCTTTTACGCTGTGTGGATATGCTGCTTTAATGCCTCTGTATCATGCTATTGCTTCCCGTACGGCTTTCGTTTTCTCCTCCTTGTATAAATCCTGGTTGCTGTCTCTTTATGAGGAGTTGTGGCCCGTTGTCCGTCAACGTGGCGTGGTGTGCTCTGTGTTTGCTGACGCAACCCCCACTGGCTGGGGCATTGCCACCACCTGTCAACTCCTTTCTGGGACTTTCGCTTTCCCCCTCCCGATCGCCACGGCAGAACTCATCGCCGCCTGCCTTGCCCGCTGCTGGACAGGGGCTAGGTTGCTGGGCACTGATAATTCCGTGGTGTTGTCGGGGAAGCTGACGTC",
    "color": "#ffffff",
    "qualifiers": [
      {
        "key": "label",
        "value": "WPRE"
      },
      {
        "key": "note",
        "value": "woodchuck hepatitis virus&nbsp;posttranscriptional regulatory element"
      }
    ],
    "category": "common_feature"
  },
  {
    "name": "CMV promoter",
    "type": "promoter",
    "strand": 1,
    "sequence": "TGATGCGGTTTTGGCAGTACACCAATGGGCGTGGATAGCGGTTTGACTCACGGGGATTTCCAAGTCTCCACCCCATTGACGTCAATGGGAGTTTGTTTTGGCACCAAAATCAACGGGACTTTCCAAAATGTCGTAATAACCCCGCCCCGTTGACGCAAATGGGCGGTAGGCGTGTACGGTGGGAGGTCTATATAAGCAGA",
    "color": "#ffffff",
    "qualifiers": [
      {
        "key": "note",
        "value": "human cytomegalovirus (CMV) immediate early promoter"
      }
    ],
    "category": "common_feature"
  },
  {
    "name": "f1 ori",
    "type": "rep_origin",
    "strand": 1,
    "sequence": "ACGCGCCCTGTAGCGGCGCATTAAGCGCGGCGGGTGTGGTGGTTACGCGCAGCGTGACCGCTACACTTGCCAGCGCCCTAGCGCCCGCTCCTTTCGCTTTCTTCCCTTCCTTTCTCGCCACGTTCGCCGGCTTTCCCCGTCAAGCTCTAAATCGGGGGCTCCCTTTAGGGTTCCGATTTAGTGCTTTACGGCACCTCGACCCCAAAAAACTTGATTAGGGTGATGGTTCACGTAGTGGGCCATCGCCCTGATAGACGGTTTTTCGCCCTTTGACGTTGGAGTCCACGTTCTTTAATAGTGGACTCTTGTTCCAAACTGGAACAACACTCAACCCTATCTCGGTCTATTCTTTTGATTTATAAGGGATTTTGCCGATTTCGGCCTATTGGTTAAAAAATGAGCTGATTTAACAAAAATTTAACGCGAATT",
    "color": "#ffff00",
    "qualifiers": [
      {
        "key": "direction",
        "value": "RIGHT"
      },
      {
        "key": "note",
        "value": "f1 bacteriophage origin of replication; arrow indicates direction of (+) strand synthesis"
      }
    ],
    "category": "common_feature"
  },
  {
    "name": "KanR",
    "type": "CDS",
    "strand": 1,
    "sequence": "ATGAGCCATATTCAACGGGAAACGTCTTGCTCCCGTCCGCGCTTAAACTCCAACATGGACGCTGATTTATATGGGTATAAATGGGCTCGCGATAATGTCGGGCAATCAGGTGCGACAATCTATCGCTTGTATGGGAAGCCCGATGCGCCAGAGTTGTTTCTGAAACATGGCAAAGGTAGCGTTGCCAATGATGTTACAGATGAGATGGTCCGTCTCAACTGGCTGACGGAGTTTATGCCTCTCCCGACCATCAAGCATTTTATCCGTACTCCTGATGATGCGTGGTTACTCACCACCGCGATTCCTGGGAAAACAGCCTTCCAGGTATTAGAAGAATATCCTGATTCAGGTGAAAATATTGTTGATGCGCTGGCCGTGTTCCTGCGCCGGTTACATTCGATTCCTGTTTGTAATTGTCCTTTTAACAGCGATCGTGTATTTCGTCTTGCTCAGGCGCAATCACGCATGAATAACGGTTTGGTTGATGCGAGTGATTTTGATGACGAGCGTAATGGCTGGCCTGTTGAACAAGTCTGGAAAGAAATGCACAAGCTCTTGCCATTCTCACCGGATTCAGTCGTCACTCATGGTGATTTCTCACTTGATAACCTTATTTTTGACGAGGGGAAATTAATAGGTTGTATTGATGTTGGACGGGTCGGAATCGCAGACCGTTACCAGGACCTTGCCATTCTTTGGAACTGCCTCGGTGAGTTTTCTCCTTCATTACAGAAACGGCTTTTTCAAAAATATGGTATTGATAATCCTGATATGAATAAATTGCAGTTTCATTTGATGCTCGATGAGTTTTTCTAA",
    "color": "#ccffcc",
    "qualifiers": [
      {
        "key": "codon_start",
        "value": "1"
      },
      {
        "key": "note",
        "value": "confers resistance to kanamycin in bacteria or G418 (Geneticin®) in eukaryotes"
      },
      {
        "key": "product",
        "value": "aminoglycoside phosphotransferase"
      },
      {
        "key": "transl_table",
        "value": "1"
      },
      {
        "key": "translation",
        "value": "MSHIQRETSCSRPRLNSNMDADLYGYKWARDNVGQSGATIYRLYGKPDAPELFLKHGKGSVANDVTDEMVRLNWLTEFMPLPTIKHFIRTPDDAWLLTTAIPGKTAFQVLEEYPDSGENIVDALAVFLRRLHSIPVCNCPFNSDRVFRLAQAQSRMNNGLVDASDFDDERNGWPVEQVWKEMHKLLPFSPDSVVTHGDFSLDNLIFDEGKLIGCIDVGRVGIADRYQDLAILWNCLGEFSPSLQKRLFQKYGIDNPDMNKLQFHLMLDEFF*"
      }
    ],
    "category": "common_feature"
  },
  {
    "name": "CmR",
    "type": "CDS",
    "strand": 1,
    "sequence": "ATGGAGAAAAAAATCACTGGATATACCACCGTTGATATATCCCAATGGCATCGTAAAGAACATTTTGAGGCATTTCAGTCAGTTGCTCAATGTACCTATAACCAGACCGTTCAGCTGGATATTACGGCCTTTTTAAAGACCGTAAAGAAAAATAAGCACAAGTTTTATCCGGCCTTTATTCACATTCTTGCCCGCCTGATGAATGCTCATCCGGAATTCCGTATGGCAATGAAAGACGGTGAGCTGGTGATATGGGATAGTGTTCACCCTTGTTACACCGTTTTCCATGAGCAAACTGAAACGTTTTCATCGCTCTGGAGTGAATACCACGACGATTTCCGGCAGTTTCTACACATATATTCGCAAGATGTGGCGTGTTACGGTGAAAACCTGGCCTATTTCCCTAAAGGGTTTATTGAGAATATGTTTTTCGTCTCAGCCAATCCCTGGGTGAGTTTCACCAGTTTTGATTTAAACGTGGCCAATATGGACAACTTCTTCGCCCCCGTTTTCACCATGGGCAAATATTATACGCAAGGCGACAAGGTGCTGATGCCGCTGGCGATTCAGGTTCATCATGCCGTTTGTGATGGCTTCCATGTCGGCAGAATGCTTAATGAATTACAACAGTACTGCGATGAGTGGCAGGCGGGGCGTAATCTAGAGGATCCGGCTTACTAA",
    "color": "#ccffcc",
    "qualifiers": [
      {
        "key": "codon_start",
        "value": "1"
      },
      {
        "key": "note",
        "value": "confers resistance to chloramphenicol"
      },
      {
        "key": "product",
        "value": "chloramphenicol acetyltransferase"
      },
      {
        "key": "transl_table",
        "value": "1"
      },
      {
        "key": "translation",
        "value": "MEKKITGYTTVDISQWHRKEHFEAFQSVAQCTYNQTVQLDITAFLKTVKKNKHKFYPAFIHILARLMNAHPEFRMAMKDGELVIWDSVHPCYTVFHEQTETFSSLWSEYHDDFRQFLHIYSQDVACYGENLAYFPKGFIENMFFVSANPWVSFTSFDLNVANMDNFFAPVFTMGKYYTQGDKVLMPLAIQVHHAVCDGFHVGRMLNELQQYCDEWQAGRNLEDPAY*"
      }
    ],
    "category": "common_feature"
  },
  {
    "name": "IRES",
    "type": "misc_feature",
    "strand": 0,
    "sequence": "TCCCTCCCCCCCCCCTAACGTTACTGGCCGAAGCCGCTTGGAATAAGGCCGGTGTGCGTTTGTCTATATGTTATTTTCCACCATATTGCCGTCTTTTGGCAATGTGAGGGCCCGGAAACCTGGCCCTGTCTTCTTGACGAGCATTCCTAGGGGTCTTTCCCCTCTCGCCAAAGGAATGCAAGGTCTGTTGAATGTCGTGAAGGAAGCAGTTCCTCTGGAAGCTTCTTGAAGACAAACAACGTCTGTAGCGACCCTTTGCAGGCAGCGGAACCCCCCACCTGGCGACAGGTGCCTCTGCGGCCAAAAGCCACGTGTATAAGATACACCTGCAAAGGCGGCACAACCCCAGTGCCACGTTGTGAGTTGGATAGTTGTGGAAAGAGTCAAATGGCTCTCCTCAAGCGTATTCAACAAGGGGCTGAAGGATGCCCAGAAGGTACCCCATTGTATGGGATCTGATCTGGGGCCTCGGTGCACATGCTTTACATGTGTTTAGTCGAGGTTAAAAAACGTCTAGGCCCCCCGAACCACGGGGACGTGGTTTTCCTTTGAAAAACACGATGATAA",
    "color": "#a6acb3",
    "qualifiers": [
      {
        "key": "note",
        "value": "internal ribosome entry site (IRES) of the encephalomyocarditis virus (EMCV)"
      }
    ],
    "category": "common_feature"
  },
  {
    "name": "NeoR/KanR",
    "type": "CDS",
    "strand": 1,
    "sequence": "ATGATCGAACAAGACGGCCTCCATGCTGGCAGTCCCGCAGCTTGGGTCGAACGCTTGTTCGGGTACGACTGGGCCCAGCAGACCATCGGATGTAGCGATGCGGCCGTGTTCCGTCTAAGCGCTCAAGGCCGGCCCGTGCTGTTCGTGAAGACCGACCTGAGCGGCGCCCTGAACGAGCTTCAAGACGAGGCTGCCCGCCTGAGCTGGCTGGCCACCACCGGCGTACCCTGCGCCGCTGTGTTGGATGTTGTGACCGAAGCCGGCCGGGACTGGCTGCTGCTGGGCGAGGTCCCTGGCCAGGATCTGCTGAGCAGCCACCTTGCCCCCGCTGAGAAGGTTTCTATCATGGCCGATGCAATGCGGCGCCTGCACACCCTGGACCCCGCTACCTGCCCCTTCGACCACCAGGCTAAGCATCGGATCGAGCGTGCTCGGACCCGCATGGAGGCCGGCCTGGTGGACCAGGACGACCTGGACGAGGAGCATCAGGGCCTGGCCCCCGCTGAACTGTTCGCCCGACTGAAAGCCCGCATGCCGGACGGTGAGGACCTGGTTGTCACACACGGAGATGCCTGCCTCCCTAACATCATGGTCGAGAATGGCCGCTTCTCCGGCTTCATCGACTGCGGTCGCCTAGGAGTTGCCGACCGCTACCAGGACATCGCCCTGGCCACCCGCGACATCGCTGAGGAGCTTGGCGGCGAGTGGGCCGACCGCTTCTTAGTCTTGTACGGCATCGCAGCTCCCGACAGCCAGCGCATCGCCTTCTACCGCTTGCTCGACGAGTTCTTTTAA",
    "color": "#ccffcc",
    "qualifiers": [
      {
        "key": "codon_start",
        "value": "1"
      },
      {
        "key": "note",
        "value": "confers resistance to neomycin, kanamycin, and G418 (Geneticin®)"
      },
      {
        "key": "product",
        "value": "aminoglycoside phosphotransferase"
      },
      {
        "key": "transl_table",
        "value": "1"
      },
      {
        "key": "translation",
        "value": "MIEQDGLHAGSPAAWVERLFGYDWAQQTIGCSDAAVFRLSAQGRPVLFVKTDLSGALNELQDEAARLSWLATTGVPCAAVLDVVTEAGRDWLLLGEVPGQDLLSSHLAPAEKVSIMADAMRRLHTLDPATCPFDHQAKHRIERARTRMEAGLVDQDDLDEEHQGLAPAELFARLKARMPDGEDLVVTHGDACLPNIMVENGRFSGFIDCGRLGVADRYQDIALATRDIAEELGGEWADRFLVLYGIAAPDSQRIAFYRLLDEFF*"
      }
    ],
    "category": "common_feature"
  },
  {
    "name": "attB2",
    "type": "protein_bind",
    "strand": 1,
    "sequence": "ACCACTTTGTACAAGAAAGCTGGGT",
    "color": "#31849b",
    "qualifiers": [
      {
        "key": "bound_moiety",
        "value": "BP Clonase™"
      },
      {
        "key": "gene",
        "value": "mutant version of&nbsp;attB"
      },
      {
        "key": "note",
        "value": "recombination site for the Gateway® BP reaction"
      }
    ],
    "category": "common_feature"
  },
  {
    "name": "attB2",
    "type": "protein_bind",
    "strand": 1,
    "sequence": "CCACTTTGTACAAGAAAGCTG",
    "color": "#31849b",
    "qualifiers": [
      {
        "key": "bound_moiety",
        "value": "BP Clonase™"
      },
      {
        "key": "gene",
        "value": "mutant version of&nbsp;attB"
      },
      {
        "key": "note",
        "value": "core recombination site for the Gateway® BP reaction"
      }
    ],
    "category": "common_feature"
  },
  {
    "name": "attB1",
    "type": "protein_bind",
    "strand": 1,
    "sequence": "ACAAGTTTGTACAAAAAAGCAGGCT",
    "color": "#31849b",
    "qualifiers": [
      {
        "key": "bound_moiety",
        "value": "BP Clonase™"
      },
      {
        "key": "gene",
        "value": "mutant version of&nbsp;attB"
      },
      {
        "key": "note",
        "value": "recombination site for the Gateway® BP reaction"
      }
    ],
    "category": "common_feature"
  },
  {
    "name": "attB1",
    "type": "protein_bind",
    "strand": 1,
    "sequence": "CAAGTTTGTACAAAAAAGCAG",
    "color": "#31849b",
    "qualifiers": [
      {
        "key": "bound_moiety",
        "value": "BP Clonase™"
      },
      {
        "key": "gene",
        "value": "mutant version of&nbsp;attB"
      },
      {
        "key": "note",
        "value": "core recombination site for the Gateway® BP reaction"
      }
    ],
    "category": "common_feature"
  },
  {
    "name": "FRT",
    "type": "protein_bind",
    "strand": 1,
    "sequence": "GAAGTTCCTATTCCGAAGTTCCTATTCTCTAGAAAGTATAGGAACTTC",
    "color": "#31849b",
    "qualifiers": [
      {
        "key": "bound_moiety",
        "value": "FLP recombinase from the Saccharomyces cerevisiae 2μ plasmid"
      },
      {
        "key": "note",
        "value": "FLP-mediated recombination occurs in the 8-bp core sequence TCTAGAAA (Turan and Bode, 2011)."
      }
    ],
    "category": "common_feature"
  },
  {
    "name": "TetR",
    "type": "CDS",
    "strand": 1,
    "sequence": "ATGACAAAGTTGCAGCCGAATACAGTGATCCGTGCCGCCCTGGACCTGTTGAACGAGGTCGGCGTAGACGGTCTGACGACACGCAAACTGGCGGAACGGTTGGGGGTTCAGCAGCCGGCGCTTTACTGGCACTTCAGGAACAAGCGGGCGCTGCTCGACGCACTGGCCGAAGCCATGCTGGCGGAGAATCATACGCATTCGGTGCCGAGAGCCGACGACGACTGGCGCTCATTTCTGATCGGGAATGCCCGCAGCTTCAGGCAGGCGCTGCTCGCCTACCGCGATGGCGCGCGCATCCATGCCGGCACGCGACCGGGCGCACCGCAGATGGAAACGGCCGACGCGCAGCTTCGCTTCCTCTGCGAGGCGGGTTTTTCGGCCGGGGACGCCGTCAATGCGCTGATGACAATCAGCTACTTCACTGTTGGGGCCGTGCTTGAGGAGCAGGCCGGCGACAGCGATGCCGGCGAGCGCGGCGGCACCGTTGAACAGGCTCCGCTCTCGCCGCTGTTGCGGGCCGCGATAGACGCCTTCGACGAAGCCGGTCCGGACGCAGCGTTCGAGCAGGGACTCGCGGTGATTGTCGATGGATTGGCGAAAAGGAGGCTCGTTGTCAGGAACGTTGAAGGACCGAGAAAGGGTGACGATTGA",
    "color": "#993366",
    "qualifiers": [
      {
        "key": "codon_start",
        "value": "1"
      },
      {
        "key": "gene",
        "value": "tetR"
      },
      {
        "key": "product",
        "value": "tetracycline resistance regulatory protein"
      },
      {
        "key": "protein_id",
        "value": ""
      },
      {
        "key": "transl_table",
        "value": "1"
      },
      {
        "key": "translation",
        "value": "MTKLQPNTVIRAALDLLNEVGVDGLTTRKLAERLGVQQPALYWHFRNKRALLDALAEAMLAENHTHSVPRADDDWRSFLIGNARSFRQALLAYRDGARIHAGTRPGAPQMETADAQLRFLCEAGFSAGDAVNALMTISYFTVGAVLEEQAGDSDAGERGGTVEQAPLSPLLRAAIDAFDEAGPDAAFEQGLAVIVDGLAKRRLVVRNVEGPRKGDD*"
      }
    ],
    "category": "common_feature"
  },
  {
    "name": "KanR",
    "type": "CDS",
    "strand": 1,
    "sequence": "ATGGCTAAAATGAGAATATCACCGGAATTGAAAAAACTGATCGAAAAATACCGCTGCGTAAAAGATACGGAAGGAATGTCTCCTGCTAAGGTATATAAGCTGGTGGGAGAAAATGAAAACCTATATTTAAAAATGACGGACAGCCGGTATAAAGGGACCACCTATGATGTGGAACGGGAAAAGGACATGATGCTATGGCTGGAAGGAAAGCTGCCTGTTCCAAAGGTCCTGCACTTTGAACGGCATGATGGCTGGAGCAATCTGCTCATGAGTGAGGCCGATGGCGTCCTTTGCTCGGAAGAGTATGAAGATGAACAAAGCCCTGAAAAGATTATCGAGCTGTATGCGGAGTGCATCAGGCTCTTTCACTCCATCGACATATCGGATTGTCCCTATACGAATAGCTTAGACAGCCGCTTAGCCGAATTGGATTACTTACTGAATAACGATCTGGCCGATGTGGATTGCGAAAACTGGGAAGAAGACACTCCATTTAAAGATCCGCGCGAGCTGTATGATTTTTTAAAGACGGAAAAGCCCGAAGAGGAACTTGTCTTTTCCCACGGCGACCTGGGAGACAGCAACATCTTTGTGAAAGATGGCAAAGTAAGTGGCTTTATTGATCTTGGGAGAAGCGGCAGGGCGGACAAGTGGTATGACATTGCCTTCTGCGTCCGGTCGATCAGGGAGGATATCGGGGAAGAACAGTATGTCGAGCTATTTTTTGACTTACTGGGGATCAAGCCTGATTGGGAGAAAATAAAATATTATATTTTACTGGATGAATTGTTTTAG",
    "color": "#ccffcc",
    "qualifiers": [
      {
        "key": "codon_start",
        "value": "1"
      },
      {
        "key": "gene",
        "value": "aphA-3"
      },
      {
        "key": "note",
        "value": "confers resistance to kanamycin"
      },
      {
        "key": "product",
        "value": "aminoglycoside phosphotransferase"
      },
      {
        "key": "protein_id",
        "value": ""
      },
      {
        "key": "transl_table",
        "value": "1"
      },
      {
        "key": "translation",
        "value": "MAKMRISPELKKLIEKYRCVKDTEGMSPAKVYKLVGENENLYLKMTDSRYKGTTYDVEREKDMMLWLEGKLPVPKVLHFERHDGWSNLLMSEADGVLCSEEYEDEQSPEKIIELYAECIRLFHSIDISDCPYTNSLDSRLAELDYLLNNDLADVDCENWEEDTPFKDPRELYDFLKTEKPEEELVFSHGDLGDSNIFVKDGKVSGFIDLGRSGRADKWYDIAFCVRSIREDIGEEQYVELFFDLLGIKPDWEKIKYYILLDELF*"
      }
    ],
    "category": "common_feature"
  },
  {
    "name": "PuroR",
    "type": "CDS",
    "strand": 1,
    "sequence": "ATGACCGAGTACAAGCCCACGGTGCGCCTCGCCACCCGCGACGACGTCCCCAGGGCCGTACGCACCCTCGCCGCCGCGTTCGCCGACTACCCCGCCACGCGCCACACCGTCGATCCGGACCGCCACATCGAGCGGGTCACCGAGCTGCAAGAACTCTTCCTCACGCGCGTCGGGCTCGACATCGGCAAGGTGTGGGTCGCGGACGACGGCGCCGCGGTGGCGGTCTGGACCACGCCGGAGAGCGTCGAAGCGGGGGCGGTGTTCGCCGAGATCGGCCCGCGCATGGCCGAGTTGAGCGGTTCCCGGCTGGCCGCGCAGCAACAGATGGAAGGCCTCCTGGCGCCGCACCGGCCCAAGGAGCCCGCGTGGTTCCTGGCCACCGTCGGCGTCTCGCCCGACCACCAGGGCAAGGGTCTGGGCAGCGCCGTCGTGCTCCCCGGAGTGGAGGCGGCCGAGCGCGCCGGGGTGCCCGCCTTCCTGGAGACCTCCGCGCCCCGCAACCTCCCCTTCTACGAGCGGCTCGGCTTCACCGTCACCGCCGACGTCGAGTGCCCGAAGGACCGCGCGACCTGGTGCATGACCCGCAAGCCCGGTGCCTGA",
    "color": "#ccffcc",
    "qualifiers": [
      {
        "key": "codon_start",
        "value": "1"
      },
      {
        "key": "gene",
        "value": "pac from Streptomyces"
      },
      {
        "key": "note",
        "value": "confers resistance to puromycin"
      },
      {
        "key": "product",
        "value": "puromycin N-acetyltransferase"
      },
      {
        "key": "transl_table",
        "value": "1"
      },
      {
        "key": "translation",
        "value": "MTEYKPTVRLATRDDVPRAVRTLAAAFADYPATRHTVDPDRHIERVTELQELFLTRVGLDIGKVWVADDGAAVAVWTTPESVEAGAVFAEIGPRMAELSGSRLAAQQQMEGLLAPHRPKEPAWFLATVGVSPDHQGKGLGSAVVLPGVEAAERAGVPAFLETSAPRNLPFYERLGFTVTADVECPKDRATWCMTRKPGA*"
      }
    ],
    "category": "common_feature"
  },
  {
    "name": "HygR",
    "type": "CDS",
    "strand": 1,
    "sequence": "ATGAAAAAGCCTGAACTCACCGCGACGTCTGTCGAGAAGTTTCTGATCGAAAAGTTCGACAGCGTCTCCGACCTGATGCAGCTCTCGGAGGGCGAAGAATCTCGTGCTTTCAGCTTCGATGTAGGAGGGCGTGGATATGTCCTGCGGGTAAATAGCTGCGCCGATGGTTTCTACAAAGATCGTTATGTTTATCGGCACTTTGCATCGGCCGCGCTCCCGATTCCGGAAGTGCTTGACATTGGGGAATTCAGCGAGAGCCTGACCTATTGCATCTCCCGCCGTGCACAGGGTGTCACGTTGCAAGACCTGCCTGAAACCGAACTGCCCGCTGTTCTGCAGCCGGTCGCGGAGGCCATGGATGCGATCGCTGCGGCCGATCTTAGCCAGACGAGCGGGTTCGGCCCATTCGGACCGCAAGGAATCGGTCAATACACTACATGGCGTGATTTCATATGCGCGATTGCTGATCCCCATGTGTATCACTGGCAAACTGTGATGGACGACACCGTCAGTGCGTCCGTCGCGCAGGCTCTCGATGAGCTGATGCTTTGGGCCGAGGACTGCCCCGAAGTCCGGCACCTCGTGCACGCGGATTTCGGCTCCAACAATGTCCTGACGGACAATGGCCGCATAACAGCGGTCATTGACTGGAGCGAGGCGATGTTCGGGGATTCCCAATACGAGGTCGCCAACATCTTCTTCTGGAGGCCGTGGTTGGCTTGTATGGAGCAGCAGACGCGCTACTTCGAGCGGAGGCATCCGGAGCTTGCAGGATCGCCGCGGCTCCGGGCGTATATGCTCCGCATTGGTCTTGACCAACTCTATCAGAGCTTGGTTGACGGCAATTTCGATGATGCAGCTTGGGCGCAGGGTCGATGCGACGCAATCGTCCGATCCGGAGCCGGGACTGTCGGGCGTACACAAATCGCCCGCAGAAGCGCGGCCGTCTGGACCGATGGCTGTGTAGAAGTACTCGCCGATAGTGGAAACCGACGCCCCAGCACTCGTCCGGATCGGGAGATGGGGGAGGCTAACTGA",
    "color": "#ccffcc",
    "qualifiers": [
      {
        "key": "codon_start",
        "value": "1"
      },
      {
        "key": "note",
        "value": "confers resistance to hygromycin"
      },
      {
        "key": "product",
        "value": "hygromycin B phosphotransferase"
      },
      {
        "key": "transl_table",
        "value": "1"
      },
      {
        "key": "translation",
        "value": "MKKPELTATSVEKFLIEKFDSVSDLMQLSEGEESRAFSFDVGGRGYVLRVNSCADGFYKDRYVYRHFASAALPIPEVLDIGEFSESLTYCISRRAQGVTLQDLPETELPAVLQPVAEAMDAIAAADLSQTSGFGPFGPQGIGQYTTWRDFICAIADPHVYHWQTVMDDTVSASVAQALDELMLWAEDCPEVRHLVHADFGSNNVLTDNGRITAVIDWSEAMFGDSQYEVANIFFWRPWLACMEQQTRYFERRHPELAGSPRLRAYMLRIGLDQLYQSLVDGNFDDAAWAQGRCDAIVRSGAGTVGRTQIARRSAAVWTDGCVEVLADSGNRRPSTRPDREMGEAN*"
      }
    ],
    "category": "common_feature"
  },
  {
    "name": "bGH poly(A) signal",
    "type": "polyA_signal",
    "strand": 0,
    "sequence": "CTGTGCCTTCTAGTTGCCAGCCATCTGTTGTTTGCCCCTCCCCCGTGCCTTCCTTGACCCTGGAAGGTGCCACTCCCACTGTCCTTTCCTAATAAAATGAGGAAATTGCATCGCATTGTCTGAGTAGGTGTCATTCTATTCTGGGGGGTGGGGTGGGGCAGGACAGCAAGGGGGAGGATTGGGAAGACAATAGCAGGCATGCTGGGGA",
    "color": "#a6acb3",
    "qualifiers": [
      {
        "key": "note",
        "value": "bovine growth hormone polyadenylation signal"
      }
    ],
    "category": "common_feature"
  },
  {
    "name": "SV40 promoter",
    "type": "promoter",
    "strand": 1,
    "sequence": "GGTGTGGAAAGTCCCCAGGCTCCCCAGCAGGCAGAAGTATGCAAAGCATGCATCTCAATTAGTCAGCAACCAGGTGTGGAAAGTCCCCAGGCTCCCCAGCAGGCAGAAGTATGCAAAGCATGCATCTCAATTAGTCAGCAACCATAGTCCCGCCCCTAACTCCGCCCATCCCGCCCCTAACTCCGCCCAGTTCCGCCCATTCTCCGCCCCATGGCTGACTAATTTTTTTTATTTATGCAGAGGCCGAGGCCGCCTCGGCCTCTGAGCTATTCCAGAAGTAGTGAGGAGGCTTTTTTGG",
    "color": "#ffffff",
    "qualifiers": [
      {
        "key": "note",
        "value": "SV40 enhancer and early promoter"
      }
    ],
    "category": "common_feature"
  },
  {
    "name": "CMV enhancer",
    "type": "enhancer",
    "strand": 0,
    "sequence": "CGTTACATAACTTACGGTAAATGGCCCGCCTGGCTGACCGCCCAACGACCCCCGCCCATTGACGTCAATAATGACGTATGTTCCCATAGTAACGCCAATAGGGACTTTCCATTGACGTCAATGGGTGGAGTATTTACGGTAAACTGCCCACTTGGCAGTACATCAAGTGTATCATATGCCAAGTACGCCCCCTATTGACGTCAATGACGGTAAATGGCCCGCCTGGCATTATGCCCAGTACATGACCTTATGGGACTTTCCTACTTGGCAGTACATCTACGTATTAGTCATCGCTATTACCATG",
    "color": "#ffffff",
    "qualifiers": [
      {
        "key": "note",
        "value": "human cytomegalovirus immediate early enhancer"
      }
    ],
    "category": "common_feature"
  },
  {
    "name": "EF-1α promoter",
    "type": "promoter",
    "strand": 1,
    "sequence": "GGCTCCGGTGCCCGTCAGTGGGCAGAGCGCACATCGCCCACAGTCCCCGAGAAGTTGGGGGGAGGGGTCGGCAATTGAACCGGTGCCTAGAGAAGGTGGCGCGGGGTAAACTGGGAAAGTGATGTCGTGTACTGGCTCCGCCTTTTTCCCGAGGGTGGGGGAGAACCGTATATAAGTGCAGTAGTCGCCGTGAACGTTCTTTTTCGCAACGGGTTTGCCGCCAGAACACAGGTAAGTGCCGTGTGTGGTTCCCGCGGGCCTGGCCTCTTTACGGGTTATGGCCCTTGCGTGCCTTGAATTACTTCCACCTGGCTCCAGTACGTGATTCTTGATCCCGAGCTGGAGCCAGGGGCGGGCCTTGCGCTTTAGGAGCCCCTTCGCCTCGTGCTTGAGTTGAGGCCTGGCCTGGGCGCTGGGGCCGCCGCGTGCGAATCTGGTGGCACCTTCGCGCCTGTCTCGCTGCTTTCGATAAGTCTCTAGCCATTTAAAATTTTTGATGACCTGCTGCGACGCTTTTTTTCTGGCAAGATAGTCTTGTAAATGCGGGCCAGGATCTGCACACTGGTATTTCGGTTTTTGGGCCCGCGGCCGGCGACGGGGCCCGTGCGTCCCAGCGCACATGTTCGGCGAGGCGGGGCCTGCGAGCGCGGCCACCGAGAATCGGACGGGGGTAGTCTCAAGCTGGCCGGCCTGCTCTGGTGCCTGGCCTCGCGCCGCCGTGTATCGCCCCGCCCTGGGCGGCAAGGCTGGCCCGGTCGGCACCAGTTGCGTGAGCGGAAAGATGGCCGCTTCCCGGCCCTGCTCCAGGGGGCTCAAAATGGAGGACGCGGCGCTCGGGAGAGCGGGCGGGTGAGTCACCCACACAAAGGAAAAGGGCCTTTCCGTCCTCAGCCGTCGCTTCATGTGACTCCACGGAGTACCGGGCGCCGTCCAGGCACCTCGATTAGTTCTGGAGCTTTTGGAGTACGTCGTCTTTAGGTTGGGGGGAGGGGTTTTATGCGATGGAGTTTCCCCACACTGAGTGGGTGGAGACTGAAGTTAGGCCAGCTTGGCACTTGATGTAATTCTCCTTGGAATTTGGCCTTTTTGAGTTTGGATCTTGGTTCATTCTCAAGCCTCAGACAGTGGTTCAAAGTTTTTTTCTTCCATTTCAGGTGTCGTGA",
    "color": "#ffffff",
    "qualifiers": [
      {
        "key": "note",
        "value": "strong constitutive promoter for human elongation factor EF-1α"
      }
    ],
    "category": "common_feature"
  },
  {
    "name": "EF-1α promoter",
    "type": "promoter",
    "strand": 1,
    "sequence": "GCTCCGGTGCCCGTCAGTGGGCAGAGCGCACATCGCCCACAGTCCCCGAGAAGTTGGGGGGAGGGGTCGGCAATTGAACCGGTGCCTAGAGAAGGTGGCGCGGGGTAAACTGGGAAAGTGATGTCGTGTACTGGCTCCGCCTTTTTCCCGAGGGTGGGGGAGAACCGTATATAAGTGCAGTAGTCGCCGTGAACGTTCTTTTTCGCAACGGGTTTGCCGCCAGAACACAGGTAAGTGCCGTGTGTGGTTCCCGCGGGCCTGGCCTCTTTACGGGTTATGGCCCTTGCGTGCCTTGAATTACTTCCACGCCCCTGGCTGCAGTACGTGATTCTTGATCCCGAGCTTCGGGTTGGAAGTGGGTGGGAGAGTTCGAGGCCTTGCGCTTAAGGAGCCCCTTCGCCTCGTGCTTGAGTTGAGGCCTGGCCTGGGCGCTGGGGCCGCCGCGTGCGAATCTGGTGGCACCTTCGCGCCTGTCTCGCTGCTTTCGATAAGTCTCTAGCCATTTAAAATTTTTGATGACCTGCTGCGACGCTTTTTTTCTGGCAAGATAGTCTTGTAAATGCGGGCCAAGATCGATCTGCACACTGGTATTTCGGTTTTTGGGGCCGCGGGCGGCGACGGGGCCCGTGCGTCCCAGCGCACATGTTCGGCGAGGCGGGGCCTGCGAGCGCGGCCACCGAGAATCGGACGGGGGTAGTCTCAAGCTGGCCGGCCTGCTCTGGTGCCTGGCCTCGCGCCGCCGTGTATCGCCCCGCCCTGGGCGGCAAGGCTGGCCCGGTCGGCACCAGTTGCGTGAGCGGAAAGATGGCCGCTTCCCGGCCCTGCTGCAGGGAGCTCAAAATGGAGGACGCGGCGCTCGGGAGAGCGGGCGGGTGAGTCACCCACACAAAGGAAAAGGGCCTTTCCGTCCTCAGCCGTCGCTTCATGTGACTCCACGGAGTACCGGGCGCCGTCCAGGCACCTCGATTAGTTCTCGATCGAGCTTTTGGAGTACGTCGTCTTTAGGTTGGGGGGAGGGGTTTTATGCGATGGAGTTTCCCCACACTGAGTGGGTGGAGACTGAAGTTAGGCCAGCTTGGCACTTGATGTAATTCTCCTTGGAATTTGCCCTTTTTGAGTTTGGATCTTGGTTCATTCTCAAGCCTCAGACAGTGGTTCAAAGTTTTTTTCTTCCATTTCAGGTGTCGTGA",
    "color": "#ffffff",
    "qualifiers": [
      {
        "key": "note",
        "value": "strong constitutive promoter for human elongation factor EF-1α"
      }
    ],
    "category": "common_feature"
  },
  {
    "name": "EF-1α promoter",
    "type": "promoter",
    "strand": 1,
    "sequence": "GCTCCGGTGCCCGTCAGTGGGCAGAGCGCACATCGCCCACAGTCCCCGAGAAGTTGGGGGGAGGGGTCGGCAATTGAACCGGTGCCTAGAGAAGGTGGCGCGGGGTAAACTGGGAAAGTGATGTCGTGTACTGGCTCCGCCTTTTTCCCGAGGGTGGGGGAGAACCGTATATAAGTGCAGTAGTCGCCGTGAACGTTCTTTTTCGCAACGGGTTTGCCGCCAGAACACAGGTAAGTGCCGTGTGTGGTTCCCGCGGGCCTGGCCTCTTTACGGGTTATGGCCCTTGCGTGCCTTGAATTACTTCCACGCCCCTGGCTGCAGTACGTGATTCTTGATCCCGAGCTTCGGGTTGGAAGTGGGTGGGAGAGTTCGAGGCCTTGCGCTTAAGGAGCCCCTTCGCCTCGTGCTTGAGTTGAGGCCTGGCCTGGGCGCTGGGGCCGCCGCGTGCGAATCTGGTGGCACCTTCGCGCCTGTCTCGCTGCTTTCGATAAGTCTCTAGCCATTTAAAATTTTTGATGACCTGCTGCGACGCTTTTTTTCTGGCAAGATAGTCTTGTAAATGCGGGCCAAGATCTGCACACTGGTATTTCGGTTTTTGGGGCCGCGGGCGGCGACGGGGCCCGTGCGTCCCAGCGCACATGTTCGGCGAGGCGGGGCCTGCGAGCGCGGCCACCGAGAATCGGACGGGGGTAGTCTCAAGCTGGCCGGCCTGCTCTGGTGCCTGGCCTCGCGCCGCCGTGTATCGCCCCGCCCTGGGCGGCAAGGCTGGCCCGGTCGGCACCAGTTGCGTGAGCGGAAAGATGGCCGCTTCCCGGCCCTGCTGCAGGGAGCTCAAAATGGAGGACGCGGCGCTCGGGAGAGCGGGCGGGTGAGTCACCCACACAAAGGAAAAGGGCCTTTCCGTCCTCAGCCGTCGCTTCATGTGACTCCACGGAGTACCGGGCGCCGTCCAGGCACCTCGATTAGTTCTCGAGCTTTTGGAGTACGTCGTCTTTAGGTTGGGGGGAGGGGTTTTATGCGATGGAGTTTCCCCACACTGAGTGGGTGGAGACTGAAGTTAGGCCAGCTTGGCACTTGATGTAATTCTCCTTGGAATTTGCCCTTTTTGAGTTTGGATCTTGGTTCATTCTCAAGCCTCAGACAGTGGTTCAAAGTTTTTTTCTTCCATTTCAGGTGTCGTGA",
    "color": "#ffffff",
    "qualifiers": [
      {
        "key": "note",
        "value": "strong constitutive promoter for human elongation factor EF-1α"
      }
    ],
    "category": "common_feature"
  },
  {
    "name": "KanR",
    "type": "CDS",
    "strand": 1,
    "sequence": "ATGAGCCATATTCAACGGGAAACGTCGAGGCCGCGATTAAATTCCAACATGGATGCTGATTTATATGGGTATAAATGGGCTCGCGATAATGTCGGGCAATCAGGTGCGACAATCTATCGCTTGTATGGGAAGCCCGATGCGCCAGAGTTGTTTCTGAAACATGGCAAAGGTAGCGTTGCCAATGATGTTACAGATGAGATGGTCAGACTAAACTGGCTGACGGAATTTATGCCTCTTCCGACCATCAAGCATTTTATCCGTACTCCTGATGATGCATGGTTACTCACCACTGCGATCCCCGGAAAAACAGCATTCCAGGTATTAGAAGAATATCCTGATTCAGGTGAAAATATTGTTGATGCGCTGGCAGTGTTCCTGCGCCGGTTGCATTCGATTCCTGTTTGTAATTGTCCTTTTAACAGCGATCGCGTATTTCGTCTCGCTCAGGCGCAATCACGAATGAATAACGGTTTGGTTGATGCGAGTGATTTTGATGACGAGCGTAATGGCTGGCCTGTTGAACAAGTCTGGAAAGAAATGCATAAACTTTTGCCATTCTCACCGGATTCAGTCGTCACTCATGGTGATTTCTCACTTGATAACCTTATTTTTGACGAGGGGAAATTAATAGGTTGTATTGATGTTGGACGAGTCGGAATCGCAGACCGATACCAGGATCTTGCCATCCTATGGAACTGCCTCGGTGAGTTTTCTCCTTCATTACAGAAACGGCTTTTTCAAAAATATGGTATTGATAATCCTGATATGAATAAATTGCAGTTTCATTTGATGCTCGATGAGTTTTTCTAA",
    "color": "#ccffcc",
    "qualifiers": [
      {
        "key": "codon_start",
        "value": "1"
      },
      {
        "key": "gene",
        "value": "aph(3')-Ia"
      },
      {
        "key": "note",
        "value": "confers resistance to kanamycin in bacteria or G418 (Geneticin®) in eukaryotes"
      },
      {
        "key": "product",
        "value": "aminoglycoside phosphotransferase"
      },
      {
        "key": "transl_table",
        "value": "1"
      },
      {
        "key": "translation",
        "value": "MSHIQRETSRPRLNSNMDADLYGYKWARDNVGQSGATIYRLYGKPDAPELFLKHGKGSVANDVTDEMVRLNWLTEFMPLPTIKHFIRTPDDAWLLTTAIPGKTAFQVLEEYPDSGENIVDALAVFLRRLHSIPVCNCPFNSDRVFRLAQAQSRMNNGLVDASDFDDERNGWPVEQVWKEMHKLLPFSPDSVVTHGDFSLDNLIFDEGKLIGCIDVGRVGIADRYQDLAILWNCLGEFSPSLQKRLFQKYGIDNPDMNKLQFHLMLDEFF*"
      }
    ],
    "category": "common_feature"
  },
  {
    "name": "TetR",
    "type": "CDS",
    "strand": 1,
    "sequence": "ATGTCTAGATTAGATAAAAGTAAAGTGATTAACAGCGCATTAGAGCTGCTTAATGAGGTCGGAATCGAAGGTTTAACAACCCGTAAACTCGCCCAGAAGCTAGGTGTAGAGCAGCCTACATTGTATTGGCATGTAAAAAATAAGCGGGCTTTGCTCGACGCCTTAGCCATTGAGATGTTAGATAGGCACCATACTCACTTTTGCCCTTTAGAAGGGGAAAGCTGGCAAGATTTTTTACGTAATAACGCTAAAAGTTTTAGATGTGCTTTACTAAGTCATCGCGATGGAGCAAAAGTACATTTAGGTACACGGCCTACAGAAAAACAGTATGAAACTCTCGAAAATCAATTAGCCTTTTTATGCCAACAAGGTTTTTCACTAGAGAATGCATTATATGCACTCAGCGCTGTGGGGCATTTTACTTTAGGTTGCGTATTGGAAGATCAAGAGCATCAAGTCGCTAAAGAAGAAAGGGAAACACCTACTACTGATAGTATGCCGCCATTATTACGACAAGCTATCGAATTATTTGATCACCAAGGTGCAGAGCCAGCCTTCTTATTCGGCCTTGAATTGATCATATGCGGATTAGAAAAACAACTTAAATGTGAAAGTGGGTCTTAA",
    "color": "#993366",
    "qualifiers": [
      {
        "key": "codon_start",
        "value": "1"
      },
      {
        "key": "gene",
        "value": "tetR&nbsp;from transposon Tn10"
      },
      {
        "key": "note",
        "value": "TetR binds to the tetracycline operator tetO to inhibit transcription. This inhibition can be relieved by adding tetracycline or doxycycline."
      },
      {
        "key": "product",
        "value": "tetracycline repressor TetR"
      },
      {
        "key": "protein_id",
        "value": ""
      },
      {
        "key": "transl_table",
        "value": "1"
      },
      {
        "key": "translation",
        "value": "MSRLDKSKVINSALELLNEVGIEGLTTRKLAQKLGVEQPTLYWHVKNKRALLDALAIEMLDRHHTHFCPLEGESWQDFLRNNAKSFRCALLSHRDGAKVHLGTRPTEKQYETLENQLAFLCQQGFSLENALYALSAVGHFTLGCVLEDQEHQVAKEERETPTTDSMPPLLRQAIELFDHQGAEPAFLFGLELIICGLEKQLKCESGS*"
      }
    ],
    "category": "common_feature"
  },
  {
    "name": "bGH poly(A) signal",
    "type": "polyA_signal",
    "strand": 0,
    "sequence": "CTGTGCCTTCTAGTTGCCAGCCATCTGTTGTTTGCCCCTCCCCCGTGCCTTCCTTGACCCTGGAAGGTGCCACTCCCACTGTCCTTTCCTAATAAAATGAGGAAATTGCATCGCATTGTCTGAGTAGGTGTCATTCTATTCTGGGGGGTGGGGTGGGGCAGGACAGCAAGGGGGAGGATTGGGAAGACAATAGCAGGCATGCTGGGGATGCGGTGGGCTCTATGG",
    "color": "#a6acb3",
    "qualifiers": [
      {
        "key": "note",
        "value": "bovine growth hormone polyadenylation signal"
      }
    ],
    "category": "common_feature"
  },
  {
    "name": "KanR",
    "type": "CDS",
    "strand": 1,
    "sequence": "ATGGGTAAGGAAAAGACTCACGTTTCGAGGCCGCGATTAAATTCCAACATGGATGCTGATTTATATGGGTATAAATGGGCTCGCGATAATGTCGGGCAATCAGGTGCGACAATCTATCGATTGTATGGGAAGCCCGATGCGCCAGAGTTGTTTCTGAAACATGGCAAAGGTAGCGTTGCCAATGATGTTACAGATGAGATGGTCAGACTAAACTGGCTGACGGAATTTATGCCTCTTCCGACCATCAAGCATTTTATCCGTACTCCTGATGATGCATGGTTACTCACCACTGCGATCCCCGGCAAAACAGCATTCCAGGTATTAGAAGAATATCCTGATTCAGGTGAAAATATTGTTGATGCGCTGGCAGTGTTCCTGCGCCGGTTGCATTCGATTCCTGTTTGTAATTGTCCTTTTAACAGCGATCGCGTATTTCGTCTCGCTCAGGCGCAATCACGAATGAATAACGGTTTGGTTGATGCGAGTGATTTTGATGACGAGCGTAATGGCTGGCCTGTTGAACAAGTCTGGAAAGAAATGCATAAGCTTTTGCCATTCTCACCGGATTCAGTCGTCACTCATGGTGATTTCTCACTTGATAACCTTATTTTTGACGAGGGGAAATTAATAGGTTGTATTGATGTTGGACGAGTCGGAATCGCAGACCGATACCAGGATCTTGCCATCCTATGGAACTGCCTCGGTGAGTTTTCTCCTTCATTACAGAAACGGCTTTTTCAAAAATATGGTATTGATAATCCTGATATGAATAAATTGCAGTTTCATTTGATGCTCGATGAGTTTTTCTAA",
    "color": "#ccffcc",
    "qualifiers": [
      {
        "key": "codon_start",
        "value": "1"
      },
      {
        "key": "gene",
        "value": "aph(3')-Ia"
      },
      {
        "key": "note",
        "value": "confers resistance to kanamycin"
      },
      {
        "key": "product",
        "value": "aminoglycoside phosphotransferase"
      },
      {
        "key": "transl_table",
        "value": "1"
      },
      {
        "key": "translation",
        "value": "MGKEKTHVSRPRLNSNMDADLYGYKWARDNVGQSGATIYRLYGKPDAPELFLKHGKGSVANDVTDEMVRLNWLTEFMPLPTIKHFIRTPDDAWLLTTAIPGKTAFQVLEEYPDSGENIVDALAVFLRRLHSIPVCNCPFNSDRVFRLAQAQSRMNNGLVDASDFDDERNGWPVEQVWKEMHKLLPFSPDSVVTHGDFSLDNLIFDEGKLIGCIDVGRVGIADRYQDLAILWNCLGEFSPSLQKRLFQKYGIDNPDMNKLQFHLMLDEFF*"
      }
    ],
    "category": "common_feature"
  },
  {
    "name": "f1 ori",
    "type": "rep_origin",
    "strand": 1,
    "sequence": "ACGCGCCCTGTAGCGGCGCATTAAGCGCGGCGGGTGTGGTGGTTACGCGCAGCGTGACCGCTACACTTGCCAGCGCCCTAGCGCCCGCTCCTTTCGCTTTCTTCCCTTCCTTTCTCGCCACGTTCGCCGGCTTTCCCCGTCAAGCTCTAAATCGGGGGCTCCCTTTAGGGTTCCGATTTAGTGCTTTACGGCACCTCGACCCCAAAAAACTTGATTAGGGTGATGGTTCACGTAGTGGGCCATCGCCCTGATAGACGGTTTTTCGCCCTTTGACGTTGGAGTCCACGTTCTTTAATAGTGGACTCTTGTTCCAAACTGGAACAACACTCAACCCTATCTCGGTCTATTCTTTTGATTTA",
    "color": "#ffff00",
    "qualifiers": [
      {
        "key": "direction",
        "value": "RIGHT"
      },
      {
        "key": "note",
        "value": "f1 bacteriophage origin of replication; arrow indicates direction of (+) strand synthesis"
      }
    ],
    "category": "common_feature"
  },
  {
    "name": "SV40 promoter",
    "type": "promoter",
    "strand": 1,
    "sequence": "GGTGTGGAAAGTCCCCAGGCTCCCCAGCAGGCAGAAGTATGCAAAGCATGCATCTCAATTAGTCAGCAACCAGGTGTGGAAAGTCCCCAGGCTCCCCAGCAGGCAGAAGTATGCAAAGCATGCATCTCAATTAGTCAGCAACCATAGTCCCGCCCCTAACTCCGCCCATCCCGCCCCTAACTCCGCCCAGTTCCGCCCATTCTCCGCCCCATGGCTGACTAATTTTTTTTATTTATGCAGAGGCCGAGGCCGCCTCGGCCTCTGAGCTATTCCAGAAGTAGTGAGGAGGCTTTTTTGGAGGCCTAGGCTTTTGCAAA",
    "color": "#ffffff",
    "qualifiers": [
      {
        "key": "note",
        "value": "SV40 enhancer and early promoter"
      }
    ],
    "category": "common_feature"
  },
  {
    "name": "CmR",
    "type": "CDS",
    "strand": 1,
    "sequence": "ATGGAGAAAAAAATCACTGGATATACCACCGTTGATATATCCCAATGGCATCGTAAAGAACATTTTGAGGCATTTCAGTCAGTTGCTCAATGTACCTATAACCAGACCGTTCAGCTGGATATTACGGCCTTTTTAAAGACCGTAAAGAAAAATAAGCACAAGTTTTATCCGGCCTTTATTCACATTCTTGCCCGCCTGATGAATGCTCATCCGGAATTCCGTATGGCAATGAAAGACGGTGAGCTGGTGATATGGGATAGTGTTCACCCTTGTTACACCGTTTTCCATGAGCAAACTGAAACGTTTTCATCGCTCTGGAGTGAATACCACGACGATTTCCGGCAGTTTCTACACATATATTCGCAAGATGTGGCGTGTTACGGTGAAAACCTGGCCTATTTCCCTAAAGGGTTTATTGAGAATATGTTTTTCGTCTCAGCCAATCCCTGGGTGAGTTTCACCAGTTTTGATTTAAACGTGGCCAATATGGACAACTTCTTCGCCCCCGTTTTCACCATGGGCAAATATTATACGCAAGGCGACAAGGTGCTGATGCCGCTGGCGATTCAGGTTCATCATGCCGTTTGTGATGGCTTCCATGTCGGCAGAATGCTTAATGAATTACAACAGTACTGCGATGAGTGGCAGGGCGGGGCGTAA",
    "color": "#ccffcc",
    "qualifiers": [
      {
        "key": "codon_start",
        "value": "1"
      },
      {
        "key": "gene",
        "value": "cat"
      },
      {
        "key": "note",
        "value": "confers resistance to chloramphenicol"
      },
      {
        "key": "product",
        "value": "chloramphenicol acetyltransferase"
      },
      {
        "key": "transl_table",
        "value": "1"
      },
      {
        "key": "translation",
        "value": "MEKKITGYTTVDISQWHRKEHFEAFQSVAQCTYNQTVQLDITAFLKTVKKNKHKFYPAFIHILARLMNAHPEFRMAMKDGELVIWDSVHPCYTVFHEQTETFSSLWSEYHDDFRQFLHIYSQDVACYGENLAYFPKGFIENMFFVSANPWVSFTSFDLNVANMDNFFAPVFTMGKYYTQGDKVLMPLAIQVHHAVCDGFHVGRMLNELQQYCDEWQGGA*"
      }
    ],
    "category": "common_feature"
  },
  {
    "name": "lacI promoter",
    "type": "promoter",
    "strand": 1,
    "sequence": "GACACCATCGAATGGCGCAAAACCTTTCGCGGTATGGCATGATAGCGCCCGGAAGAGAGTCAATTCAGGGTGGTGAAT",
    "color": "#ffffff",
    "qualifiers": [
      {
        "key": "gene",
        "value": "lacI"
      },
      {
        "key": "note",
        "value": ""
      }
    ],
    "category": "common_feature"
  },
  {
    "name": "T3 promoter",
    "type": "promoter",
    "strand": 1,
    "sequence": "AATTAACCCTCACTAAAGG",
    "color": "#ffffff",
    "qualifiers": [
      {
        "key": "note",
        "value": "promoter for bacteriophage T3 RNA polymerase"
      }
    ],
    "category": "common_feature"
  }
];

export interface DetectCommonFeaturesOptions {
  /** Custom feature templates (defaults to STANDARD_COMMON_FEATURES). */
  templates?: readonly CommonFeatureTemplate[];
  /** Include the 14 standard epitope and affinity tags (default: true). */
  includeEpitopeTags?: boolean;
  /** Include the 6 standard protease cleavage sites (default: true). */
  includeProteaseSites?: boolean;
  /** Skip features whose name and span already exist on the record (default: true). */
  skipExisting?: boolean;
}

function extendRunOnCds(seq: string, start: number, end: number, strand: Strand): Range {
  const L = seq.length;
  if (strand === 1) {
    let newStart = start;
    for (let p = start; p >= 0; p -= 3) {
      const cod = seq.slice(p, p + 3);
      if (p < start && (cod === "TAA" || cod === "TAG" || cod === "TGA")) break;
      if (cod === "ATG") newStart = p;
    }
    let newEnd = end;
    for (let p = end; p + 3 <= L; p += 3) {
      const cod = seq.slice(p, p + 3);
      if (cod === "TAA" || cod === "TAG" || cod === "TGA") {
        newEnd = p + 3;
        break;
      }
    }
    return { start: newStart, end: newEnd };
  }
  if (strand === -1) {
    let newEnd = end;
    for (let p = end; p + 3 <= L; p += 3) {
      const cod = seq.slice(p, p + 3);
      if (cod === "TTA" || cod === "CTA" || cod === "TCA") break;
      if (cod === "CAT") newEnd = p + 3;
    }
    let newStart = start;
    for (let p = start - 3; p >= 0; p -= 3) {
      const cod = seq.slice(p, p + 3);
      if (cod === "TTA" || cod === "CTA" || cod === "TCA") {
        newStart = p;
        break;
      }
    }
    return { start: newStart, end: newEnd };
  }
  return { start, end };
}

function findNearMatch(haystack: string, needle: string): number[] {
  const n = needle.length;
  if (n < 200) return [];
  const seedLen = 60;
  const results: number[] = [];
  for (const seedOffset of [0, n - seedLen]) {
    const seed = needle.slice(seedOffset, seedOffset + seedLen);
    let pos = 0;
    while ((pos = haystack.indexOf(seed, pos)) !== -1) {
      const candStart = pos - seedOffset;
      if (candStart >= 0 && candStart + n <= haystack.length) {
        let mismatches = 0;
        for (let i = 0; i < n; i++) {
          if (haystack[candStart + i] !== needle[i]) {
            mismatches++;
            if (mismatches > 2) break;
          }
        }
        if (mismatches <= 2 && !results.includes(candStart)) {
          results.push(candStart);
        }
      }
      pos += 1;
    }
  }
  return results;
}

/**
 * Parse a binary SnapGene `.ftrs` feature library file (such as `standardCommonFeatures.ftrs`)
 * into {@link CommonFeatureTemplate} entries.
 */
export function parseSnapGeneFtrs(data: Uint8Array): CommonFeatureTemplate[] {
  let offset = 0;
  let seq = "";
  let featuresXml = "";
  const decoder = new TextDecoder("utf-8");
  const latin1 = new TextDecoder("latin1");
  while (offset + 5 <= data.length) {
    const type = data[offset];
    const len =
      ((data[offset + 1] << 24) >>> 0) +
      ((data[offset + 2] << 16) | (data[offset + 3] << 8) | data[offset + 4]);
    const start = offset + 5;
    const end = start + len;
    if (end > data.length) break;
    const payload = data.subarray(start, end);
    if (type === 0x00 && payload.length >= 1) {
      seq = latin1.decode(payload.subarray(1)).toUpperCase();
    } else if (type === 0x0a) {
      featuresXml = decoder.decode(payload);
    }
    offset = end;
  }
  if (!seq || !featuresXml) return [];

  const templates: CommonFeatureTemplate[] = [];
  const featureRe = /<Feature\b([^>]*)>([\s\S]*?)<\/Feature>/g;
  let match: RegExpExecArray | null;
  while ((match = featureRe.exec(featuresXml)) !== null) {
    const attrs = match[1];
    const body = match[2];
    const getAttr = (k: string): string | undefined => {
      const m = new RegExp(`\\b${k}="([^"]*)"`).exec(attrs);
      return m ? m[1] : undefined;
    };
    const name = (getAttr("name") ?? "feature")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, "&");
    const type = getAttr("type") ?? "misc_feature";
    const dir = getAttr("directionality");
    const strand: Strand = dir === "1" ? 1 : dir === "2" ? -1 : 0;
    const maxRunOn = Number.parseInt(getAttr("maxRunOn") ?? "0", 10) || 0;

    let minStart = Infinity;
    let maxEnd = 0;
    let color = "#993366";
    const segRe = /<Segment\b([^>]*)\/>/g;
    let segMatch: RegExpExecArray | null;
    while ((segMatch = segRe.exec(body)) !== null) {
      const segAttrs = segMatch[1];
      const rangeM = /\brange="(\d+)-(\d+)"/.exec(segAttrs);
      const colorM = /\bcolor="([^"]*)"/.exec(segAttrs);
      if (colorM && color === "#993366") color = colorM[1];
      if (rangeM) {
        minStart = Math.min(minStart, Number.parseInt(rangeM[1], 10) - 1);
        maxEnd = Math.max(maxEnd, Number.parseInt(rangeM[2], 10));
      }
    }
    if (!Number.isFinite(minStart) || maxEnd <= minStart) continue;
    let featSeq = seq.slice(minStart, maxEnd);
    if (strand === -1) featSeq = reverseComplement(featSeq);
    if (featSeq.length < 12) continue;

    const qualifiers: Qualifier[] = [];
    const qRe = /<Q\s+name="([^"]*)">([\s\S]*?)<\/Q>/g;
    let qMatch: RegExpExecArray | null;
    while ((qMatch = qRe.exec(body)) !== null) {
      const qName = qMatch[1];
      const vMatch = /<V\s+(?:text|int)="([^"]*)"/.exec(qMatch[2]);
      if (vMatch) {
        qualifiers.push({
          key: qName,
          value: vMatch[1]
            .replace(/<[^>]+>/g, "")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&quot;/g, '"')
            .replace(/&apos;/g, "'")
            .replace(/&amp;/g, "&")
            .trim(),
        });
      }
    }
    templates.push({
      name,
      type,
      strand,
      sequence: featSeq,
      color,
      ...(maxRunOn > 0 ? { maxRunOn } : {}),
      qualifiers,
      category: "common_feature",
    });
  }
  return templates;
}

/**
 * Scan a {@link SeqRecord} for standard plasmid features, epitope/affinity tags, and
 * protease cleavage sites on both strands (handling circular wrap-around and `maxRunOn`
 * spliced ORFs such as `lacZα`).
 */
export function detectCommonFeatures(
  record: SeqRecord,
  options: DetectCommonFeaturesOptions = {}
): Feature[] {
  const upperSeq = record.seq.toUpperCase();
  const L = upperSeq.length;
  if (L === 0 || record.molecule === "protein") return [];

  const templates: CommonFeatureTemplate[] = [...(options.templates ?? STANDARD_COMMON_FEATURES)];
  if (options.includeEpitopeTags !== false) {
    for (const tag of STANDARD_EPITOPE_TAGS) {
      templates.push({
        name: tag.name,
        type: "CDS",
        strand: 1,
        sequence: tag.sequence,
        color: "#cc99ff",
        qualifiers: [
          { key: "label", value: tag.name },
          { key: "product", value: `${tag.name} epitope/affinity tag` },
          { key: "translation", value: tag.translation },
        ],
        category: "epitope_tag",
      });
    }
  }
  if (options.includeProteaseSites !== false) {
    for (const site of STANDARD_PROTEASE_SITES) {
      templates.push({
        name: site.name,
        type: "CDS",
        strand: 1,
        sequence: site.sequence,
        color: "#ff9966",
        qualifiers: [
          { key: "label", value: site.name },
          { key: "note", value: `protease cleavage site (${site.rawTranslation})` },
          { key: "translation", value: site.translation },
        ],
        category: "protease_cleavage",
      });
    }
  }

  const searchSpace =
    record.topology === "circular"
      ? upperSeq + upperSeq.slice(0, Math.min(L - 1, 5000))
      : upperSeq;
  const rcSearchSpace = reverseComplement(searchSpace);
  const totalLen = searchSpace.length;

  const existingKeys = new Set<string>();
  if (options.skipExisting !== false) {
    for (const f of record.features) {
      if (f.segments.length > 0) {
        const s0 = f.segments[0];
        existingKeys.add(`${f.name.toLowerCase()}:${s0.start}:${s0.end}`);
      }
    }
  }

  const seen = new Set<string>();
  const detected: Feature[] = [];

  const recordHit = (tmpl: CommonFeatureTemplate, rawStart: number, rawEnd: number, hitStrand: Strand) => {
    const ext =
      (tmpl.maxRunOn ?? 0) > 0
        ? extendRunOnCds(upperSeq, rawStart, rawEnd, hitStrand)
        : { start: rawStart, end: rawEnd };
    const norm = normalizeRange(ext, L, record.topology);
    const finalStrand: Strand = tmpl.strand === 0 ? 0 : hitStrand;
    const dedupKey = `${tmpl.name.toLowerCase()}:${norm.start}:${norm.end}`;
    if (seen.has(dedupKey) || existingKeys.has(dedupKey)) return;
    seen.add(dedupKey);

    const hasLabel = tmpl.qualifiers.some((q) => q.key === "label");
    const qualifiers: Qualifier[] = hasLabel
      ? [...tmpl.qualifiers]
      : [{ key: "label", value: tmpl.name }, ...tmpl.qualifiers];

    detected.push({
      id: newId("feat"),
      name: tmpl.name,
      type: tmpl.type,
      strand: finalStrand,
      segments: [norm],
      qualifiers,
      color: tmpl.color,
    });
  };

  for (const tmpl of templates) {
    const q = tmpl.sequence;
    const qLen = q.length;
    if (qLen === 0 || qLen > L) continue;

    let foundExact = false;

    let pos = 0;
    while ((pos = searchSpace.indexOf(q, pos)) !== -1) {
      if (pos < L) {
        foundExact = true;
        recordHit(tmpl, pos, pos + qLen, 1);
      }
      pos += 1;
    }

    pos = 0;
    while ((pos = rcSearchSpace.indexOf(q, pos)) !== -1) {
      const origEnd = totalLen - pos;
      const origStart = origEnd - qLen;
      if (origStart >= 0 && origStart < L) {
        foundExact = true;
        recordHit(tmpl, origStart, origEnd, -1);
      }
      pos += 1;
    }

    if (!foundExact && qLen >= 200) {
      for (const fPos of findNearMatch(searchSpace, q)) {
        if (fPos < L) recordHit(tmpl, fPos, fPos + qLen, 1);
      }
      for (const rPos of findNearMatch(rcSearchSpace, q)) {
        const origEnd = totalLen - rPos;
        const origStart = origEnd - qLen;
        if (origStart >= 0 && origStart < L) recordHit(tmpl, origStart, origEnd, -1);
      }
    }

    if (!foundExact && (tmpl.maxRunOn ?? 0) > 0 && qLen >= 120) {
      const core = q.slice(18);
      const coreLen = core.length;
      let cPos = 0;
      while ((cPos = searchSpace.indexOf(core, cPos)) !== -1) {
        if (cPos < L) recordHit(tmpl, cPos, cPos + coreLen, 1);
        cPos += 1;
      }
      cPos = 0;
      while ((cPos = rcSearchSpace.indexOf(core, cPos)) !== -1) {
        const origEnd = totalLen - cPos;
        const origStart = origEnd - coreLen;
        if (origStart >= 0 && origStart < L) {
          recordHit(tmpl, origStart, origEnd, -1);
        }
        cPos += 1;
      }
    }
  }

  detected.sort(
    (a, b) =>
      a.segments[0].start - b.segments[0].start ||
      b.segments[0].end - b.segments[0].start - (a.segments[0].end - a.segments[0].start)
  );
  return detected;
}

/**
 * Detect common plasmid features, epitope tags, and protease cleavage sites on `record`
 * and return an updated {@link SeqRecord} with the newly discovered features appended.
 */
export function annotateCommonFeatures(
  record: SeqRecord,
  options: DetectCommonFeaturesOptions = {}
): { record: SeqRecord; added: Feature[] } {
  const added = detectCommonFeatures(record, options);
  if (added.length === 0) return { record, added: [] };
  return {
    record: {
      ...record,
      features: [...record.features, ...added],
    },
    added,
  };
}
