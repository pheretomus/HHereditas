# core-fix-ops progress log

## Goal
Finish the review fixes for module `ops` (packages/core/src/ops/**). For each of the 17 findings in
docs/progress/findings/ops.review-findings.json (F0-F16): make sure a permanent regression test
exists, then fix the root cause or reject the finding with a precise reason. Finish with the whole
ops suite green and a clean typecheck for the ops files.

## STATUS: DONE (final)
- `npx vitest run src/ops`: 12 files, 192 tests, all passing (about 11 s).
- `npx tsc --noEmit -p packages/core`: 0 errors in src/ops (0 in the whole package at the last run).
- My temporary files test/review-tmp/fixops-*.test.ts are deleted. The other files in that folder
  belong to other agents and were left alone.
- No git operations, no installs, no shared files touched.

## Baseline at the start of this session
- There was no progress log and no ops.fix-report.json.
- An earlier fix pass had already done the following:
  - created qualifiers.ts (/codon_start and position-bearing qualifiers);
  - added the contiguous-run rule to remap.ts;
  - added RNA alphabet handling;
  - made checkRange accept {L,L} and made checkGap turn -0 into +0;
  - added ops.regression.test.ts (tests for F0-F8).
- Suite: 149 tests, 7 failing, all in ops.property.test.ts. The property-test models predated the
  contiguous-run rule and the /codon_start rewriting.
- Typecheck: one TS6133 error in ops.regression.test.ts.

## Per-finding outcome
- **F0, F5** (RNA reverse complement): already fixed by the earlier pass; tests pass. I added a
  property test showing that reverse-complementing RNA written with U is an involution.
- **F1** (an RNA record inserted into DNA left U in the sequence): already fixed. A property test now
  inserts RNA payloads.
- **F2** (origin-crossing join form): already fixed by the contiguous-run rule. The property model
  now covers that rule.
- **F3** (/codon_start when extractRange clips a CDS): already fixed. The extraction property test
  now checks /codon_start.
- **F4** (/transl_except not remapped): already fixed. Speed and round trips were handled under F13
  and F14.
- **F6** ({L,L} on circular records): already fixed.
- **F7** (extractRange with a range of L + overhang): rejected, as the earlier pass had decided.
  - Per types.ts, a normalized range satisfies end - start <= L.
  - Which copy of the repeated overhang bases should carry the features crossing the cut is a
    cloning decision.
  - The test pins the RangeError and the recipe: take the whole circle opened at the cut, then call
    insertBases with the overhang.
- **F8** (gap -0): already fixed.
- **F9, F12** (red suite): fixed.
  - The property models were rewritten: a token model that understands contiguous runs, and a
    per-base qualifier model.
  - The reviewers' failing cases are pinned as regression tests.
  - The TS6133 error is fixed.
- **F10** (stale /translation): fixed. /translation is dropped when a feature's bases change and kept
  when the feature only moves.
- **F11** (run rule versus the docs and the preview): fixed by settling on the run rule and
  documenting it everywhere.
  - remapFeatures is the preview that exactly matches the edit.
  - remapRange is documented as the rule for a single range.
- **F13** (round trips of position-bearing qualifiers): fixed. Written parts are kept, parts split at
  the origin are merged back, the one-base `n..n` form is kept, and a <base_range> that crosses the
  origin is written as join(...).
- **F14** (base-by-base expansion): fixed with arithmetic per run. The 36 KB hostile case dropped from
  10.8 s to about 9 ms.
- **F15** (-0 leaks): fixed in remapGap, in the circular branch of checkRange, and for strand -0 in
  the CRUD helpers.
- **F16** (bias 'right' at the left boundary of a replaced region): fixed.

## Test changes (justification: "never weaken correct tests")
- **checkEditAgainstModel** used to require qualifiers unchanged. That was wrong under the
  /codon_start, /transl_except and /translation rules. It now requires the exact qualifiers predicted
  by the model, which is stronger.
- **Per-segment model replaced by a run-aware model.** The old `modelSegmentTokens` encoded the
  per-segment rule. Finding F2 showed that rule gives different results for two equivalent ways of
  writing the same bases. The new model works base by base and is independent of remap.ts.
- **remapRange compared with the record edit.** The per-segment equality now applies only to features
  without adjacent segments. For every segment, remapRange must equal a one-segment feature, and
  remapFeatures must equal the edit for every feature.
- **Rotation round trip (f)** is exact, except in the documented edge case below. There the test
  checks the model's prediction and that everything else is identical. Before this, the generator
  produced no position-bearing qualifiers at all.
- **Generator additions:** joins, position-bearing qualifiers (including per-base written parts,
  rare `<`/`>` markers, one-base TERM, /tag_peptide and /translation), and RNA records. The
  `molecule` option of the generator was broken (always DNA) and is fixed.

## Verification beyond the suite
- **Mutation testing:** 23 deliberate bugs were injected into the source one at a time and reverted
  from backups. All are now caught.
- **Soak runs:** 2 seed sets × 19 property groups × 20,000 cases, about 760,000 random cases, all
  passing.
- **Protein checks:** translateFeature gives the same protein before and after for features whose
  bases are kept (edits, rotation, reverse complement of stranded features, extraction).
- **Edge case found by the protein checks:** a feature covering the whole circle whose two ends meet
  at the insertion gap.
  - The insertion is outside the feature, but its /transl_except was dropped.
  - Fix: a location is cut only when the inserted bases join the feature.

## Decisions and known limitations
- **Adjacent segments are one stretch.** This deviates from the spec's literal per-segment insertion
  rule and generalizes its intent ("insertion inside a feature extends it"). It is documented in the
  TSDoc of insertBases and replaceRange and in remap.ts.
- **/translation is dropped, not regenerated.** It is derived data; INSDC calls it "automatically
  generated". A replacement by identical bases also drops it.
- **Ambiguity in rotation round trips.** Take a value that writes two consecutive bases as separate
  parts, e.g. join(1,2,3), and rotate so that the origin falls exactly between them. Rotating back
  writes the two parts as one run, because the text cannot tell that boundary from a split made at
  the origin. The bases are the same. This is documented in qualifiers.ts.
- **Interior markers can block a merge.** Two parts meeting at the old origin that carry `<` or `>`
  markers between them are never merged.

## Next steps
- None for this module. Suggestion for the integrator: decide whether cloning code should build
  single-cut fragments with the extractRange + insertBases recipe from F7.
