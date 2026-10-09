# core-verify-enzymes: progress log

STATUS: FINISHED (2026-10-08, ~22:27).
- One defect found (D1) and fixed, with regression tests.
- Enzymes suite 140/140 green. `tsc` reports 0 errors in the whole core package.
- API summary written to docs/progress/api/core-enzymes.md.

## Goal
Final verification of module `enzymes`, with fresh eyes. The module covers `packages/core/src/enzymes/**`, `tools/oracle/enzymes_*.py` and `packages/core/test/oracle/enzymes/**`.
1. Run the tests and the typecheck.
2. Read the source end to end against the spec.
3. Probe the riskiest behaviours.
4. Fix every proven defect, with a regression test.
5. Write the API summary.

## Done
**1. Baseline.**
- `npx vitest run src/enzymes`: 135/135 green.
- tsc: 0 errors in enzymes files. At that time there were 11 errors in other agents' files; at the end the whole project has 0.

**2. Source read end to end** (enzyme.ts, data.ts header, ends.ts, search.ts, digest.ts, sets.ts, index.ts) against the spec.
- No spec deviation found.
- The conflict rule, the free-start circular walk and the whole-circle walk were reasoned through.

**3. Probes.** All were temporary files in test/review-tmp/enzymes-verify-*.test.ts and the scratchpad; all are deleted.

- **P1 — live oracle, 12 fresh seeds** (HH_ENZYMES_LIVE_SEED = 101 … 3333)
  - Search vs Biopython, digests vs pydna, and sticky ends with sites at the ends.
  - All green: about 6,000 search cases and about 5,600 digests.
- **P2 — plain Biopython `search()` on 6 real sequences never used by the oracle**
  - Sequences: a 60 kb slice of E. coli, NC_005816, Addgene 11664 and 39296, pBAD30, and SnapGene pFA-KanMX4.
  - All 737 enzymes without a documented Biopython deviation, each sequence linear and circular.
  - Result: 8,844 comparisons and 549,863 cleavage events, all identical.
- **P3 — independent strand-level model**
  - Events enumerated by brute force.
  - Products rebuilt by union-find over per-base top and bottom strand nodes, with nicks at the cuts and the base pairs inside cut zones melted.
  - Exact bookkeeping checks:
    - every event is applied, or skipped with the right reason;
    - no event that could cut without a conflict is dropped;
    - `blockedBy` names an applied break that really conflicts.
  - `findSites` with the same ends matches the events that can cut.
  - The digest is symmetric under reverse complement (RC), rotation and enzyme order.
  - About 150,000 random digests (tiny to 600 bp; clustered Type IIS, two-cut and degenerate sites; sticky ends; N; lower case). About 60,000 conflict skips and 55,000 end skips were exercised.
  - Found D1 (see below) and nothing else.
  - Molecules that are their own RC around a conflict give the mirror choice, which is the same physical fragments. This is documented behaviour, not a defect.
- **P4 — published marker digests, primary datasheets read**
  - Datasheets:
    - pBR322/MspI: Nippon Gene Marker 10, 26 fragments.
    - pUC19/MspI and HpaII: Thermo SM0221 Marker 23 (MAN0012992 Rev. C.00), 13 fragments.
  - Both are reproduced exactly as cut-to-cut (top-strand) lengths.
- **P5 — `cutNotation` and performance**
  - `cutNotation` round-trips for all 754 enzymes, and `overhang()` lengths are consistent.
  - Performance targets are met: 754 enzymes on a 10 kb circle in 35 ms; EcoRI on the 4.6 Mb genome in 20 ms; 48 common enzymes on the genome in 0.43 s.

**4. D1 — defect, minor, FIXED**
- **Symptom:** on a very small circle, two cut pairs of one site can cut at the same gaps modulo L. Examples are two-cut enzymes (TstI, BsaXI, BcgI, …) and SgeI's mirrored reading. `digestDetailed` then listed that one event twice in `skipped`, while `findSites` lists it once.
- **Example:** TstI + BsaXI on the 32-bp circle CACAATACCTCCGACTCCCGGCAAGGAGTTCT.
- **Cause:** `collectCleavages` did not dedupe a site's events modulo L, as `search.ts circularSiteCuts` does.
- **Fix (src/enzymes/digest.ts):**
  - New internal helper `hasCircularEvent()`.
  - `collectCleavages` skips an event of the same site that cuts at the same gaps modulo L.
  - The file comment (EVENTS) and the TSDoc are updated.
- **Scope:** fragments were never affected, only the `skipped` bookkeeping. Circles larger than about 40 bp are unaffected.

**5. New permanent tests** at the end of src/enzymes/digest.test.ts, in the 'verification: ...' blocks (5 tests):
- TstI 32-bp circle regression.
- Small-circle exact bookkeeping property (400 cases).
- Published marker digests (2 tests). They pin cut-to-cut = published, and `digestSizes` = published + 2 for MspI.
- Independent strand-level model (1,500 random digests, about 0.25 s).
- The 3 D1-related tests were confirmed to FAIL with the fix disabled and to pass with it.

**6. API summary:** docs/progress/api/core-enzymes.md. It covers:
- every one of the 44 exports, with full signatures and result shapes;
- conventions and one-line semantics;
- recipes, measured performance and verification evidence;
- known limitations.

**7. Cleanup**
- Deleted my test/review-tmp/enzymes-verify-*.test.ts files. Other agents' files there were left untouched.
- Removed the gitignored tools/oracle/__pycache__/enzymes_*.pyc. Live-oracle runs recreate them.
- No git operations, no installs, no shared-file edits.

## Final state
- `npx vitest run src/enzymes`: 140/140 (digest 53, enzyme 25, live-oracle 3, oracle 10, search 37, sets 12), about 4.6 s.
- src/ops/ops.regression.test.ts: 36/36. Another agent grew it; it is the only other importer of enzymes.
- `npx tsc --noEmit -p .`: 0 errors overall.
- Files changed by this session:
  - packages/core/src/enzymes/digest.ts (D1 fix and comments)
  - packages/core/src/enzymes/digest.test.ts (new import `isPalindromic`, new 'verification:' blocks)
  - docs/progress/api/core-enzymes.md (new)
  - this log

## Open decision for the spec owner (not changed)
**Size convention.**
- `DigestFragment.length`, `digestSizes` and `DigestSize.size` are full duplex extents, including overhangs. Examples:
  - EcoRI-linearized pUC19 = 2690.
  - pBR322/MspI fragments are each 2 more than the published marker sizes.
- Datasheets, NEBcutter and labs use cut-to-cut sizes, which sum to the plasmid length: EcoRI-linearized pUC19 = 2686.
- This is spec-consistent: the spec says `seq` covers the full extent, and `length` is not defined further. So it was not changed.
- The API doc gives the one-line cut-to-cut formula and recommends it for user-facing labels.
- If the spec owner switches `digestSizes` to cut-to-cut, update the test 'verification: published marker digests'.

## Notes for the integrator (also in the API doc)
- Pass `record.ends` to `findSites` and `digest` for linear records.
- Use `digestSizesWithTopology` for gel lanes, with 'circular' mapped to 'supercoiled'.
- Methyl-directed enzymes (DpnI) are simulated as if their sites were methylated.
- No Dam/Dcm blocking is modelled.
- `src/index.ts` needs `export * from './enzymes'`. No name collisions with seq, io, primers, ops, gel or cloning.
