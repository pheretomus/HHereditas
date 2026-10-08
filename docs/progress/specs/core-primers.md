MODULE KEY: primers
OWNERSHIP: packages/core/src/primers/** (tm.ts, thermo-tables.ts, binding.ts, design.ts, analysis.ts, index.ts, *.test.ts), tools/oracle/primers_*.py, packages/core/test/oracle/primers/**.

TM (tm.ts):
  interface TmConditions { monovalentMilliMolar: number; divalentMilliMolar: number; dntpMilliMolar: number; oligoNanoMolar: number; saltCorrection: 'schildkraut' | 'santalucia' | 'owczarzy'; }   // refine names if needed, keep them explicit about units
  DEFAULT_TM_CONDITIONS: primer3's defaults (read primer3-py's calc_tm signature/docs in the venv: mv_conc, dv_conc, dntp_conc, dna_conc, tm_method='santalucia', salt_corrections_method) so our default output equals primer3's.
  tm(seq: string, conditions?: Partial<TmConditions>): number   // °C. Nearest-neighbour SantaLucia 1998 unified parameters (terminal AT penalties, symmetry correction for self-complementary oligos), the selected salt correction including Mg2+/dNTP handling as primer3 does (divalent→monovalent equivalence / Owczarzy 2008). Long oligos: follow primer3 (it switches formula above a maximum NN length; check) so results match.
  thermo(seq, conditions?): { dH: number /* kcal/mol */; dS: number /* cal/(K·mol) */; dG37: number /* kcal/mol */ }
  gcContent(seq): number   // 0..1; S counts as GC, W as AT; document ambiguity handling
  Degenerate primers (IUPAC): provide tmRange(seq) (min/max over expansions, sampled when there are too many) and make tm() return a documented value (e.g. mean), never NaN.
  Must agree with primer3-py calc_tm within 0.05 °C for unambiguous oligos of 8–60 nt across a grid of conditions (monovalent 10–200 mM, Mg 0–5 mM, dNTP 0–1 mM, oligo 25–500 nM) for every salt-correction method implemented (oracle JSON with ≥ 2000 cases from seeded random oligos with varied GC).

BINDING (binding.ts):
  interface BindingOptions { minAnneal?: number /* 3'-terminal primer bases that must anneal, default 15 */; anchor3?: number /* last bases that must match perfectly, default 5? decide */; maxMismatches?: number /* default 0 */; computeTm?: boolean; conditions?: Partial<TmConditions> }
  findBindingSites(template: string, topology: Topology, primer: Primer, options?: BindingOptions): PrimerBindingSite[]   // PrimerBindingSite from types.ts
  findAllBindingSites(template, topology, primers: readonly Primer[], options?): PrimerBindingSite[]
  Semantics: a primer binds where its 3'-terminal bases match the template (forward: the primer's 3' part equals the top strand there → strand 1, the site range covers the annealed bases; reverse: the reverse complement of the primer's 3' part equals the top strand → strand -1). The annealed region extends towards the primer's 5' end as far as it keeps matching (allowing up to maxMismatches isolated mismatches only if matching resumes afterwards; trailing 5' mismatching bases are tail). Report annealedLength, mismatches, tailLength and the Tm of the annealed part when computeTm. Circular templates: sites across the origin (range.end > L). Primers with IUPAC codes match accordingly (iupacMatches). Sorted by range.start; no duplicates.
  Performance: 50 primers × 10 kb plasmid < 50 ms; 1 primer on the 4.6 Mb genome < 1 s (seed with an exact search of the 3' anchor, e.g. indexOf).

DESIGN (design.ts):
  designPrimer(template: string, topology: Topology, opts: { position: number; direction: 1 | -1; targetTm?: number /* default 60 */; minLength?: number /* 18 */; maxLength?: number /* 30 */; conditions?: Partial<TmConditions> }): { sequence: string; range: Range; tm: number; gc: number; length: number }
     // direction 1: the primer's 5' end sits at gap 'position' and it covers bases to the right (primer = top strand); direction -1: the primer's 5' end sits at gap 'position' and it covers bases to the left (primer = reverse complement). Choose the length whose Tm is closest to targetTm, preferring a 3' G/C clamp when that costs ≤ 1 °C. Circular aware.
  designPrimerPair(template, topology, target: Range, opts?) → { forward, reverse, productLength }   // amplifies exactly 'target'.
  analysis.ts: hairpin / self-dimer / hetero-dimer checks. Implement primer3-style thermodynamic alignment ONLY if you can validate it against primer3-py calc_hairpin / calc_homodimer / calc_heterodimer (dg and tm) within reasonable tolerance; otherwise provide a simpler, clearly documented complementarity score (longest 3' complementary run, maximum complementary stretch) and say so. Prefer validated thermodynamics if feasible.

ORACLE & TESTS: tools/oracle/primers_oracle.py generates the Tm cases (primer3-py calc_tm across the condition grid; Biopython MeltingTemp only as a secondary sanity check) and binding cases (a brute-force Python reference for anchored matching on random templates with planted primer sites incl. mismatches, origin-spanning sites and reverse primers). Unit tests for designPrimer (Tm within ±2.5 °C of target when possible, sequence matches the template, circular) and edge cases (primer longer than the template, empty primer, all-N primer).
