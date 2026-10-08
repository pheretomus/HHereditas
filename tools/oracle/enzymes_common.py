"""Shared helpers for the enzymes oracle scripts (enzymes_oracle.py, enzymes_live.py).

Reference implementations:
* Biopython 1.88 Bio.Restriction  -- recognition-site search and cut positions.
* pydna 5.5.16 Dseq.cut            -- double-stranded fragments (watson / crick / overhangs).

Position conventions: Biopython's search() returns, for every cleavage event, the 1-based
position of the first base AFTER the top-strand cut. HHereditas uses 0-based GAP positions, so
gap = biopython_value - 1 (circular results lie in [1, L] and map to gaps [0, L)).

`expected_top_cuts` re-runs Biopython's own search machinery (its compiled site regexes,
_modify/_rev_modify and _drop) with four documented corrections; for every enzyme NOT listed in
`deviation_kind` the result is asserted to be identical to plain `enzyme.search()`:
  both-orientations   non-palindromic degenerate sites whose site and reverse complement can
                      match the same target position (MspJI CNNR/YNNG, ...): Biopython's regex
                      alternation reports only the top-strand match there.
  palindromic-asym    palindromic sites with asymmetric cleavage (SgeI, HauII): both readings of
                      the site are recognised, Biopython applies only the forward cut.
  ovhg-field          TspRI/TscAI: Biopython's `ovhg` (10) contradicts fst5/fst3 (9-nt 3'
                      overhang NNCASTGNN, also NEB's specification); _drop's bottom-strand
                      filter uses the wrong value.
  unsorted-drop       palindromic two-cut enzymes: Biopython's circular _drop assumes sorted
                      results, but they are not sorted for these enzymes.
"""

from __future__ import annotations

import re
from functools import lru_cache

from Bio.Restriction import Restriction
from Bio.Restriction.Restriction import FormattedSeq
from Bio.Restriction.Restriction_Dictionary import rest_dict
from Bio.Seq import Seq

from enzymes_generate import IUPAC, biopython_name, enzyme_cuts, reverse_complement, select_enzymes


def biopython_enzyme(name: str):
    """Biopython enzyme class for a HHereditas (REBASE-spelled) enzyme name."""
    return getattr(Restriction, biopython_name(name))


def site_info(name: str) -> tuple[str, list[tuple[int, int]]]:
    entry = rest_dict[biopython_name(name)]
    return entry["site"], enzyme_cuts(entry)


def is_palindromic_site(site: str) -> bool:
    return site == reverse_complement(site)


@lru_cache(maxsize=None)
def deviation_kind(name: str) -> str | None:
    """Which documented Biopython defect (if any) affects this enzyme. See module docstring."""
    site, cuts = site_info(name)
    entry = rest_dict[biopython_name(name)]
    if any(t - b != entry["ovhg"] for t, b in cuts):
        return "ovhg-field"
    if is_palindromic_site(site):
        n = len(site)
        if sorted((n - b, n - t) for t, b in cuts) != sorted(cuts):
            return "palindromic-asym"
        if len(cuts) > 1:
            return "unsorted-drop"
        return None
    rc = reverse_complement(site)
    if all(set(IUPAC[a]) & set(IUPAC[b]) for a, b in zip(site, rc)):
        return "both-orientations"
    return None


def biopython_top_cuts(name: str, seq: str, linear: bool) -> list[int]:
    """Plain Biopython search() result, converted to sorted 0-based gap positions."""
    enzyme = biopython_enzyme(name)
    return sorted(r - 1 for r in enzyme.search(Seq(seq), linear=linear))


def expected_top_cuts(name: str, seq: str, linear: bool) -> list[int]:
    """Biopython's search with the corrections listed in the module docstring (sorted gaps)."""
    enzyme = biopython_enzyme(name)
    site, cuts = site_info(name)
    dna = FormattedSeq(Seq(seq), linear)
    data = dna.data if linear else dna.data + dna.data[1 : enzyme.size]
    alternatives = enzyme.compsite.pattern.split("|")
    forward = [m.start() for m in re.finditer(alternatives[0], data)]
    reverse = [m.start() for m in re.finditer(alternatives[1], data)] if len(alternatives) > 1 else []
    results = [x for s in forward for x in enzyme._modify(s)]
    if is_palindromic_site(site) and deviation_kind(name) == "palindromic-asym":
        results += [x for s in forward for x in enzyme._rev_modify(s)]
    results += [x for s in reverse for x in enzyme._rev_modify(s)]
    results.sort()
    saved_ovhg = enzyme.ovhg
    try:
        enzyme.ovhg = cuts[0][0] - cuts[0][1]
        enzyme.dna = dna
        enzyme.results = results
        if results:
            enzyme._drop()
        out = sorted(r - 1 for r in enzyme.results)
    finally:
        enzyme.ovhg = saved_ovhg
    if deviation_kind(name) is None:
        plain = biopython_top_cuts(name, seq, linear)
        assert out == plain, (name, seq, linear, out, plain)
    return out


def instantiate(site: str, rng) -> str:
    """A random concrete sequence matching an IUPAC site."""
    return "".join(rng.choice(IUPAC[c]) for c in site)


def random_dna(n: int, rng) -> str:
    return "".join(rng.choice("ACGT") for _ in range(n))


def plant(seq: str, pos: int, text: str) -> str:
    """Overwrite seq[pos:pos+len(text)] (pos may wrap around the end of a circular sequence)."""
    out = list(seq)
    for i, ch in enumerate(text):
        out[(pos + i) % len(out)] = ch
    return "".join(out)


def all_enzyme_names() -> list[str]:
    """HHereditas names (REBASE spelling) of every enzyme in data.ts, in data.ts order."""
    from enzymes_generate import display_name

    return [display_name(n) for n in select_enzymes()]


# ---------------------------------------------------------------------------
# pydna digests
# ---------------------------------------------------------------------------


def _end(kind_and_seq) -> dict:
    kind, sticky = kind_and_seq
    if kind == "blunt":
        return {"kind": "blunt", "length": 0}
    if kind == "5'":
        return {"kind": "5prime", "length": len(sticky)}
    if kind == "3'":
        return {"kind": "3prime", "length": len(sticky)}
    raise ValueError(f"unexpected pydna end {kind_and_seq!r}")


def make_dseq(seq: str, topology: str, ends: dict | None = None):
    from pydna.dseq import Dseq

    if topology == "circular":
        return Dseq(seq, circular=True)
    if not ends:
        return Dseq(seq)
    # pydna: crick_ovhg > 0 = left 3' overhang, < 0 = left 5'; watson_ovhg > 0 = right 3', < 0 = right 5'
    left, right = ends["left"], ends["right"]
    crick_ovhg = {"blunt": 0, "3prime": left["length"], "5prime": -left["length"]}[left["kind"]]
    watson_ovhg = {"blunt": 0, "3prime": right["length"], "5prime": -right["length"]}[right["kind"]]
    return Dseq.from_full_sequence_and_overhangs(seq, crick_ovhg, watson_ovhg)


def cut_events(dseq, enzymes) -> list[tuple[int, int]]:
    """pydna cut sites as (top, bottom) gap positions in full-sequence coordinates, pydna order."""
    L = len(dseq)
    out = []
    for (watson, ovhg), _enzyme in dseq.get_cutsites(*enzymes):
        crick = watson - ovhg
        out.append((watson, crick % L if dseq.circular else crick))
    return out


def has_conflict(dseq, enzymes, end_margin: int = 0) -> bool:
    """True if two cleavage events leave no base pair between their cut zones (or coincide), or
    a cut zone comes within `end_margin` bases (at least touching) of a linear molecule's
    single-stranded end.

    HHereditas resolves such conflicts by a documented rule that pydna does not implement
    (pydna raises ValueError for overlapping zones and returns unpaired or empty fragments
    for touching or identical ones), so these cases are not used for differential testing.
    """
    L = len(dseq)
    zones = []
    for (watson, ovhg), _enzyme in dseq.get_cutsites(*enzymes):
        lo, hi = min(watson, watson - ovhg), max(watson, watson - ovhg)
        if dseq.circular:
            shift = (lo % L) - lo
            lo, hi = lo + shift, hi + shift
        zones.append((lo, hi))
    zones.sort()
    if not dseq.circular:
        ds_start = max(dseq.left_end_position())
        ds_end = min(dseq.right_end_position())
        if any(lo <= ds_start + end_margin or hi >= ds_end - end_margin for lo, hi in zones):
            return True
    for (lo1, hi1), (lo2, _hi2) in zip(zones, zones[1:]):
        if lo2 <= hi1:
            return True
    if dseq.circular and len(zones) > 1 and zones[0][0] + L <= max(h for _, h in zones):
        return True
    if dseq.circular and len(zones) == 1 and zones[0][1] - zones[0][0] >= L:
        return True
    return False


def pydna_site_check_reliable(seq: str, enzyme_names: list[str], margin: int) -> bool:
    """False when pydna's recognition-site check may be wrong for this molecule.

    pydna 5.5.16 Dseq.cutsite_is_valid locates the recognition site of a cut at
    `cut_watson - enzyme.fst5`, which is only right for sites read on the top strand. For a
    site found on the bottom strand (non-palindromic enzymes) it checks a window up to
    ~2 x (site + cut distance) away, and for enzymes that cut twice (scd5) it accepts a cut
    when either window is double-stranded. Near single-stranded ends this can accept a cut whose
    site is not double-stranded or reject a valid one, so such molecules are not used to test
    sticky-end validity: returns False if any two-cut enzyme is used, or if a bottom-strand site
    of a non-palindromic enzyme starts or ends within `margin` bases of either end.
    """
    for name in enzyme_names:
        site, cuts = site_info(name)
        if len(cuts) > 1:
            return False
        if is_palindromic_site(site):
            continue
        rc = reverse_complement(site)
        pattern = re.compile("(?=(" + "".join(f"[{IUPAC[c]}]" for c in rc) + "))")
        for m in pattern.finditer(seq.upper()):
            q = m.start()
            if q < margin or q + len(site) > len(seq) - margin:
                return False
    return True


def count_shadowed(dseq, enzymes) -> int:
    """Breaks that pydna accepts for one enzyme although another enzyme's site making the same
    break was rejected (e.g. BsaI straddling a sticky end while the BsmAI site inside it cuts)."""
    cutsites = dseq.get_cutsites(*enzymes)  # pydna's validity check applied
    accepted = {(w, o, str(e)) for (w, o), e in cutsites}
    valid = {(w, o) for w, o, _name in accepted}
    raw = {(c - 1, e.ovhg, str(e)) for e in enzymes for c in e.search(dseq, linear=not dseq.circular)}
    return len({(w, o) for w, o, _name in raw - accepted if (w, o) in valid})


def pydna_fragments(seq: str, topology: str, enzyme_names: list[str], ends: dict | None = None) -> list[dict]:
    """pydna Dseq.cut() products as {seq, ends, watson, crick, ovhg} (upper-cased; crick 5'->3')."""
    dseq = make_dseq(seq, topology, ends)
    enzymes = [biopython_enzyme(n) for n in enzyme_names]
    frags = []
    for f in dseq.cut(*enzymes):
        frags.append(
            {
                "seq": str(f).upper(),
                "ends": {"left": _end(f.five_prime_end()), "right": _end(f.three_prime_end())},
                "watson": f.watson.upper(),
                "crick": f.crick.upper(),
                "ovhg": f.ovhg,
            }
        )
    return frags
