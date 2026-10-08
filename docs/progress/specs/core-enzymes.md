MODULE KEY: enzymes
OWNERSHIP: packages/core/src/enzymes/** (data.ts, enzyme.ts, search.ts, digest.ts, sets.ts, index.ts, *.test.ts), tools/oracle/enzymes_*.py, packages/core/test/oracle/enzymes/**.

DATA: generate src/enzymes/data.ts with tools/oracle/enzymes_generate.py from Biopython's REBASE-derived tables (Bio.Restriction and Bio.Restriction.Restriction_Dictionary: rest_dict, suppliers, typedict). Include every enzyme with defined cut positions that is commercially available (≥ 1 supplier); decide whether to also include non-commercial ones (flagged commercial: false) and document the choice. Header comment: data source (REBASE via Biopython 1.88; cite Roberts RJ et al., REBASE, Nucleic Acids Res.) and the regeneration command. Also export the supplier table (code → company name).
Model (enzyme.ts):
  interface RestrictionEnzyme {
    name: string;            // e.g. 'EcoRI'
    site: string;            // recognition sequence 5'->3' on the top strand, uppercase IUPAC
    cuts: ReadonlyArray<{ top: number; bottom: number }>;
      // one entry per cleavage event (two for enzymes such as BaeI/CspCI that cut on both sides).
      // Offsets are GAP positions relative to the first base of the site, in TOP-strand coordinates, for a site read on the top strand:
      // EcoRI G^AATTC → [{top: 1, bottom: 5}]; PstI CTGCA^G → [{top: 5, bottom: 1}]; SmaI → [{top: 3, bottom: 3}];
      // BsaI GGTCTC(1/5) → [{top: 7, bottom: 11}]. Values may be negative or larger than the site length.
    suppliers: string;       // REBASE supplier letters
    commercial: boolean;
  }
Derived helpers: overhang(enzyme) → { kind: EndKind; length: number; sequence?: string when non-degenerate } for the first cut pair (top < bottom → '5prime', top > bottom → '3prime', equal → 'blunt'); isPalindromic(site) (site === reverseComplement(site)); cutsOutsideSite(enzyme) (Type IIS-like); isoschizomers(enzyme, list) (same site) and neoschizomers (same site, different cuts); getEnzyme(name) (case-insensitive exact name); ENZYMES (all), COMMON_ENZYMES: a curated, ordered list of the ~40 enzymes most used in cloning labs (EcoRI, BamHI, HindIII, XhoI, XbaI, NotI, NdeI, NcoI, KpnI, SacI, SalI, PstI, SphI, SmaI, EcoRV, BglII, NheI, SpeI, AgeI, MluI, ApaI, ClaI, AscI, PacI, SbfI, BsaI, BsmBI, BbsI, SapI, NsiI, AvrII, MfeI, XmaI, HpaI, ScaI, StuI, PmeI, SwaI, FseI, DpnI, ...): each must exist in the data (test). sets.ts: helpers the UI will use to pick enzymes to display: uniqueCutters(sites), cuttersWithCount(sites, n), filterEnzymes(list, { minSiteLength?, commercialOnly?, suppliers?, overhang?: EndKind[], palindromicOnly? }).

SEARCH (search.ts):
  findSites(seq: string, topology: Topology, enzymes: readonly RestrictionEnzyme[]): EnzymeSite[]   // EnzymeSite from types.ts, sorted by range.start then enzyme name
  findSitesForEnzyme(seq, topology, enzyme): EnzymeSite[]
  countCuts(sites): Map<string, number>   // distinct cleavage events per enzyme
- Both strands: palindromic sites reported once (strand 1); a non-palindromic site found as reverseComplement(site) on the top strand gets strand -1 with mirrored cut offsets (footprint starting at p, site length n: top cut = p + n - cut.bottom, bottom cut = p + n - cut.top).
- Degenerate IUPAC recognition sequences (e.g. BglI GCCNNNNNGGC, AvaI CYCGRG). The TARGET may contain N or other ambiguity codes: such positions never count as matches (a site matches only where every target base is unambiguous and accepted).
- Circular molecules: sites spanning the origin are found (range.end > L) and cut positions are normalized into [0, L). Linear: cut events whose top or bottom cut falls outside [0, L] are dropped from site.cuts (the site is still listed). Use Biopython's behaviour as the reference for cuts exactly at 0 or L and document it.
- Overlapping occurrences must all be found; lower-case input tolerated.
- Performance: all enzymes on a 10 kb plasmid < 100 ms; one enzyme on the 4.6 Mb E. coli genome < 300 ms; all COMMON_ENZYMES on the genome < 5 s (measure; tests with generous limits).

DIGEST (digest.ts):
  interface DigestFragment { seq: string; topology: Topology; ends: FragmentEnds; parentRange: Range; length: number; leftCut?: { enzyme: string; top: number; bottom: number }; rightCut?: { enzyme: string; top: number; bottom: number } }
     // seq covers the fragment's full duplex extent including single-stranded overhangs (FragmentEnds convention in types.ts); parentRange = that extent in parent top-strand coordinates (may wrap on circular parents).
  digest(seq: string, topology: Topology, enzymes: readonly RestrictionEnzyme[], options?: { ends?: FragmentEnds }): DigestFragment[]
     // fragments in parent order. Circular with n ≥ 1 cleavage events → n linear fragments (the one spanning the origin has a wrapping parentRange); circular with no cuts → the intact circular molecule; linear with n cuts → n + 1 fragments, the outermost keep the input ends (options.ends, default blunt).
  Cleavage events whose cut zones overlap or interleave (two nearby Type IIS sites, a top cut beyond the next site's bottom cut): produce physically sensible results or drop the impossible event by a documented rule; never negative-length fragments.
  digestSizes(...) → number[] fragment lengths in bp (largest first) for gel lanes.

ORACLE & TESTS:
- tools/oracle/enzymes_oracle.py: (1) for EVERY enzyme in data.ts the top-strand cut positions from Biopython enzyme.search() on several seeded random sequences (with planted sites near both ends and spanning the origin), linear and circular, plus pUC19 and pBR322 from the fixtures; (2) pydna Dseq.cut() double-stranded fragments (watson/crick/ovhg) for a few hundred (enzymes, sequence) cases including 2-enzyme digests, Type IIS (BsaI, BsmBI, SapI, BbsI), 3' overhangs (PstI, KpnI, SacI, ApaI), blunt (SmaI, EcoRV), degenerate sites, double cutters (BaeI), circular and linear. Vitest compares top cuts for every enzyme, and fragment sequences plus end kinds/lengths for the pydna cases. Biopython reports the 1-based position of the first base after the top-strand cut: convert carefully. Document any disagreement.
- Unit tests: hand-checked examples (EcoRI on pUC19: verify the single site against the fixture's annotation/sequence), BsaI orientation on both strands, PstI 3' overhang ends, SmaI blunt, overlapping sites, origin-spanning site, N in the target.
