#!/usr/bin/env python
"""Differential-test oracle for packages/core/src/enzymes (search + digest).

Usage (from the repository root; deterministic, safe to re-run):

    tools/oracle/.venv/bin/python tools/oracle/enzymes_oracle.py

Writes JSON into packages/core/test/oracle/enzymes/:

  enzyme_props.json     Biopython's view of every enzyme in data.ts (charac, ovhg, ovhgseq,
                        palindromic, overhang type, defined/ambiguous, suppliers, isoschizomers).
  search_planted.json   For EVERY enzyme: seeded random sequences with planted sites (both
                        orientations, at both ends, near the ends, spanning the origin), top-strand
                        cut positions for the linear and the circular molecule.
  search_<id>.json      For EVERY enzyme: top-strand cuts on a shared sequence (pUC19 M77789,
                        pBR322 J01749 from the fixtures; seeded random sequences), linear + circular.
  pydna_digests_*.json  pydna Dseq.cut() fragments for several hundred (enzymes, sequence) cases:
                        single and double digests, Type IIS, 3' overhangs, blunt, degenerate sites,
                        two-cut enzymes, linear (blunt and sticky input ends) and circular
                        (_single: one enzyme on a planted sequence; _multi: double digests,
                        sticky input ends kept 50 bp from the sites, pUC19/pBR322; _near_end:
                        sticky input ends with sites planted at and across the single-stranded
                        ends, including nested Type IIS pairs making the same break).

Cut positions are 0-based gap positions (Biopython value - 1); see enzymes_common.py for the
documented corrections of known Biopython defects ("expected" vs "biopython" fields).
"""

from __future__ import annotations

import json
import random
from pathlib import Path

import Bio
import pydna
from Bio import SeqIO
from Bio.Restriction.Restriction_Dictionary import rest_dict

from enzymes_common import (
    all_enzyme_names,
    biopython_enzyme,
    biopython_top_cuts,
    count_shadowed,
    deviation_kind,
    expected_top_cuts,
    has_conflict,
    instantiate,
    make_dseq,
    plant,
    pydna_fragments,
    pydna_site_check_reliable,
    random_dna,
    site_info,
)
from enzymes_generate import biopython_name, reverse_complement

SEED = 20261008
REPO_ROOT = Path(__file__).resolve().parents[2]
OUT_DIR = REPO_ROOT / "packages" / "core" / "test" / "oracle" / "enzymes"
FIXTURES = REPO_ROOT / "packages" / "core" / "test" / "fixtures" / "genbank"

META = {
    "generator": "tools/oracle/enzymes_oracle.py",
    "seed": SEED,
    "biopython": Bio.__version__,
    "pydna": pydna.__version__,
    "positions": "0-based gap positions (Biopython search() value - 1)",
}


def write_json(name: str, payload: dict) -> None:
    path = OUT_DIR / name
    text = json.dumps(payload, separators=(",", ":"), sort_keys=False)
    path.write_text(text + "\n", encoding="utf-8")
    size = path.stat().st_size
    assert size < 2_000_000, f"{name} is {size} bytes"
    print(f"wrote {path.relative_to(REPO_ROOT)} ({size} bytes)")


def reach(name: str) -> int:
    """How far (in bases) cuts can lie from the site, plus the site length."""
    site, cuts = site_info(name)
    return len(site) + max(max(abs(t), abs(b)) for t, b in cuts)


# ---------------------------------------------------------------------------
# enzyme properties
# ---------------------------------------------------------------------------


def enzyme_props(names: list[str]) -> dict:
    in_data = {biopython_name(n): n for n in names}
    out = []
    for n in names:
        e = biopython_enzyme(n)
        entry = rest_dict[biopython_name(n)]

        def ours(batch):
            return sorted(in_data[str(x)] for x in batch if str(x) in in_data)

        out.append(
            {
                "name": n,
                "site": entry["site"],
                "charac": list(e.charac[:4]),
                "size": e.size,
                "ovhg": e.ovhg,
                "ovhgseq": e.ovhgseq,
                "palindromic": e.is_palindromic(),
                "overhang": e.overhang(),
                "defined": e.is_defined(),
                "ambiguous": e.is_ambiguous(),
                "suppliers": "".join(sorted(entry["suppl"])),
                "commercial": e.is_comm(),
                "isoschizomers": ours(e.isoschizomers()),
                "neoschizomers": ours(e.neoschizomers()),
                "equischizomers": ours(e.equischizomers()),
                "deviation": deviation_kind(n),
            }
        )
    return {"meta": META, "enzymes": out}


# ---------------------------------------------------------------------------
# search: planted sites
# ---------------------------------------------------------------------------


def planted_sequences(name: str, rng: random.Random) -> list[tuple[str, str]]:
    """(label, sequence) pairs with planted sites of `name`."""
    site, _cuts = site_info(name)
    n = len(site)
    r = reach(name)
    fwd = lambda: instantiate(site, rng)  # noqa: E731
    rev = lambda: reverse_complement(instantiate(site, rng))  # noqa: E731
    out = []

    L = 2 * r + 3 * n + rng.randint(20, 60)
    s = random_dna(L, rng)
    s = plant(s, 0, fwd())
    s = plant(s, L - n, rev())
    s = plant(s, L // 2 - n // 2, fwd())
    out.append(("fwd-start/rev-end/mid", s))

    L = 2 * r + 3 * n + rng.randint(20, 60)
    s = random_dna(L, rng)
    s = plant(s, 0, rev())
    s = plant(s, L - n, fwd())
    s = plant(s, L // 2, rev())
    out.append(("rev-start/fwd-end/mid", s))

    L = 2 * r + 3 * n + rng.randint(20, 60)
    s = random_dna(L, rng)
    if n > 1:
        s = plant(s, L - rng.randint(1, n - 1), fwd())  # spans the origin when circular
    s = plant(s, L // 2, rev())
    out.append(("fwd-origin/rev-mid", s))

    L = 2 * r + 3 * n + rng.randint(20, 60)
    s = random_dna(L, rng)
    if n > 1:
        s = plant(s, L - rng.randint(1, n - 1), rev())
    s = plant(s, L // 3, fwd())
    out.append(("rev-origin/fwd-mid", s))

    L = 2 * r + 3 * n + rng.randint(20, 60)
    s = random_dna(L, rng)
    s = plant(s, rng.randint(1, r), fwd())
    s = plant(s, L - n - rng.randint(1, r), rev())
    s = plant(s, rng.randint(r + n, L - r - 2 * n), rev())
    out.append(("near-ends", s))

    # Exact linear boundaries: the leftmost cut of a forward site at gap `edge` and the rightmost
    # cut of a reverse site at gap L - edge (edge 1: kept; edge 0: on the end, dropped).
    lo = min(min(t, b) for t, b in _cuts)
    for label, edge in (("edge-in", 1), ("edge-out", 0)):
        L = 2 * r + 3 * n + rng.randint(20, 60)
        s = random_dna(L, rng)
        start = edge - lo  # forward reading: start + lo == edge
        if 0 <= start <= L - n:
            s = plant(s, start, fwd())
        q = L - edge - n + lo  # reverse reading: rightmost raw cut is q + n - lo == L - edge
        if 0 <= q <= L - n:
            s = plant(s, q, rev())
        out.append((label, s))
    return out


def search_planted(names: list[str]) -> dict:
    cases = []
    stats = {"cases": 0, "biopythonDiffers": 0}
    for name in names:
        rng = random.Random(f"{SEED}:planted:{name}")
        for label, seq in planted_sequences(name, rng):
            case = {"enzyme": name, "label": label, "seq": seq}
            for topology, linear in (("linear", True), ("circular", False)):
                expected = expected_top_cuts(name, seq, linear)
                plain = biopython_top_cuts(name, seq, linear)
                case[topology] = expected
                if plain != expected:
                    case[f"biopython_{topology}"] = plain
                    stats["biopythonDiffers"] += 1
            cases.append(case)
            stats["cases"] += 1
    return {"meta": {**META, **stats}, "cases": cases}


# ---------------------------------------------------------------------------
# search: shared sequences (every enzyme on the same molecule)
# ---------------------------------------------------------------------------


def genbank_sequence(path: Path) -> str:
    return str(SeqIO.read(path, "genbank").seq).upper()


def search_shared(names: list[str], seq_id: str, seq: str, description: str) -> dict:
    results = {}
    differs = 0
    for name in names:
        entry = {}
        for topology, linear in (("linear", True), ("circular", False)):
            expected = expected_top_cuts(name, seq, linear)
            entry[topology] = expected
            plain = biopython_top_cuts(name, seq, linear)
            if plain != expected:
                entry[f"biopython_{topology}"] = plain
                differs += 1
        results[name] = entry
    return {
        "meta": {**META, "id": seq_id, "description": description, "length": len(seq), "biopythonDiffers": differs},
        "seq": seq,
        "results": results,
    }


# ---------------------------------------------------------------------------
# pydna digests
# ---------------------------------------------------------------------------

DIGEST_GROUPS = {
    "5prime": ["EcoRI", "BamHI", "HindIII", "XhoI", "XbaI", "NotI", "NdeI", "NcoI", "SalI", "BglII",
               "NheI", "SpeI", "AgeI", "MluI", "AscI", "AvrII", "MfeI", "XmaI", "ClaI", "BsrGI"],
    "3prime": ["PstI", "KpnI", "SacI", "ApaI", "SphI", "NsiI", "SbfI", "PacI", "FseI", "AatII", "SacII", "PvuI"],
    "blunt": ["SmaI", "EcoRV", "HpaI", "ScaI", "StuI", "PmeI", "SwaI", "PvuII", "NruI", "DpnI", "MlyI", "HincII"],
    "typeIIS": ["BsaI", "BsmBI", "SapI", "BbsI", "Esp3I", "BtgZI", "BsmFI", "FokI", "MmeI", "AcuI", "BpmI",
                "HgaI", "PaqCI", "BspQI", "BsmAI", "EarI"],
    "degenerate": ["BglI", "AvaI", "SfiI", "BstXI", "AlwNI", "DraIII", "XcmI", "BslI", "EcoO109I", "StyI",
                   "BanII", "Bsp1286I", "ApoI", "BsiHKAI", "AccI"],
    "twocut": ["BaeI", "CspCI", "BcgI", "AloI", "BsaXI"],
}


def planted_digest_sequence(enzymes: list[str], topology: str, rng: random.Random, sticky: bool) -> str:
    max_reach = max(reach(e) for e in enzymes)
    L = rng.randint(max(160, 6 * max_reach), 900)
    s = random_dna(L, rng)
    margin = 50 if sticky else 0
    for _ in range(rng.randint(1, 4)):
        e = rng.choice(enzymes)
        site, _cuts = site_info(e)
        text = instantiate(site, rng)
        if rng.random() < 0.5:
            text = reverse_complement(text)
        r = rng.random()
        if sticky:
            pos = rng.randint(margin + max_reach, L - margin - max_reach - len(site))
        elif topology == "circular" and r < 0.25:
            pos = L - rng.randint(1, max(1, len(site) - 1))  # spans the origin
        elif topology == "linear" and r < 0.35:
            pos = rng.choice([rng.randint(0, max_reach), L - len(site) - rng.randint(0, max_reach)])
        else:
            pos = rng.randint(0, L - len(site))
        s = plant(s, pos, text)
    return s


def digest_cases() -> dict:
    rng = random.Random(f"{SEED}:digest")
    all_names = [n for group in DIGEST_GROUPS.values() for n in group]
    for n in all_names:
        assert biopython_name(n) in rest_dict and deviation_kind(n) is None, n
    puc19 = genbank_sequence(FIXTURES / "pUC19_M77789.gb")
    pbr322 = genbank_sequence(FIXTURES / "pBR322_J01749.gb")

    plasmids = {"pUC19": puc19, "pBR322": pbr322}
    specs: list[tuple[str, list[str], str, str, dict | None]] = []  # (group, enzymes, topology, seq, ends)
    for group, names in DIGEST_GROUPS.items():
        for name in names:
            for topology in ("linear", "circular"):
                for _ in range(2):
                    specs.append((group, [name], topology, planted_digest_sequence([name], topology, rng, False), None))
    for _ in range(140):
        pair = rng.sample(all_names, 2)
        topology = rng.choice(["linear", "circular"])
        specs.append(("double", pair, topology, planted_digest_sequence(pair, topology, rng, False), None))
    for _ in range(30):
        names = rng.sample(all_names, rng.randint(1, 2))
        ends = {
            side: (lambda kind: {"kind": kind, "length": 0 if kind == "blunt" else rng.randint(1, 6)})(
                rng.choice(["blunt", "5prime", "3prime"])
            )
            for side in ("left", "right")
        }
        specs.append(("sticky-input", names, "linear", planted_digest_sequence(names, "linear", rng, True), ends))
    plasmid_digests = [["EcoRI"], ["EcoRI", "HindIII"], ["PstI"], ["BsaI"], ["BglI"], ["SmaI"], ["PvuII"],
                       ["AvaI"], ["BamHI", "SalI"], ["DraIII"], ["SapI"], ["AlwNI"], ["ApaLI"], ["BsmBI"],
                       ["HincII"], ["EcoRV", "NruI"], ["AatII", "SspI"], ["BaeI"]]
    for enzymes in plasmid_digests:
        for seq_id, seq in plasmids.items():
            for topology in ("circular", "linear"):
                specs.append((f"plasmid:{seq_id}", enzymes, topology, seq, None))

    cases = []
    skipped = 0
    for group, enzymes, topology, seq, ends in specs:
        dseq = make_dseq(seq, topology, ends)
        bp = [biopython_enzyme(e) for e in enzymes]
        if has_conflict(dseq, bp, end_margin=0):
            skipped += 1
            continue
        frags = pydna_fragments(seq, topology, enzymes, ends)
        case = {"group": group, "enzymes": enzymes, "topology": topology}
        if group.startswith("plasmid:"):
            case["seqRef"] = group.split(":", 1)[1]
        else:
            case["seq"] = seq
        if ends:
            case["ends"] = ends
        case["fragments"] = frags
        cases.append(case)
    meta = {**META, "cases": len(cases), "skippedConflicts": skipped}
    return {"meta": meta, "sequences": plasmids, "cases": cases}


# Single-cut enzymes whose sites may be planted at the single-stranded ends (pydna's site check is
# reliable for top-strand sites, see enzymes_common.pydna_site_check_reliable).
NEAR_END_POOL = [n for g in ("5prime", "3prime", "blunt", "typeIIS", "degenerate") for n in DIGEST_GROUPS[g]]
# Outer site containing the inner site one base from its 5' end; both make the same break, so
# when the outer site straddles a single-stranded end only the inner one can cut.
NESTED_PAIRS = [("BsaI", "BsmAI"), ("BsmBI", "BsmAI"), ("Esp3I", "BsmAI"), ("SapI", "EarI"), ("BspQI", "EarI")]


def near_end_cases() -> dict:
    """pydna digests of linear molecules with sticky ends and sites planted AT the ends: sites
    straddling or touching a single-stranded end and nested Type IIS pairs whose outer site
    straddles an end while the inner one makes the same break. Cases where pydna's site check is
    unreliable (bottom-strand sites near the ends, two-cut enzymes) and cases with conflicting or
    end-touching cut zones are left out."""
    rng = random.Random(f"{SEED}:near-end")
    for n in NEAR_END_POOL + [n for pair in NESTED_PAIRS for n in pair]:
        assert biopython_name(n) in rest_dict and deviation_kind(n) is None, n
    cases = []
    unreliable = conflicts = shadowed = 0

    def end(sticky_only: bool) -> dict:
        kind = rng.choice(["5prime", "3prime"] if sticky_only else ["blunt", "5prime", "3prime"])
        return {"kind": kind, "length": 0 if kind == "blunt" else rng.randint(1, 8)}

    while len(cases) < 300:
        nested = rng.random() < 0.5
        if nested:
            outer, inner = rng.choice(NESTED_PAIRS)
            names = [outer, inner] + ([rng.choice(NEAR_END_POOL)] if rng.random() < 0.3 else [])
        else:
            names = rng.sample(NEAR_END_POOL, rng.randint(1, 2))
        names = list(dict.fromkeys(names))
        max_reach = max(reach(n) for n in names)
        L = rng.randint(max(60, 4 * max_reach + 20), 220)
        ends = {"left": end(nested), "right": end(False)}
        s = random_dna(L, rng)
        if nested:
            # outer site on the top strand with its first base in the left single-stranded end
            s = plant(s, ends["left"]["length"] - 1, instantiate(site_info(outer)[0], rng))
        for _ in range(rng.randint(1, 3)):
            site = site_info(rng.choice(names))[0]
            k = len(site)
            r = rng.random()
            if r < 0.35:
                pos = ends["left"]["length"] - rng.randint(0, k)  # straddles or touches the left end
            elif r < 0.7:
                pos = L - ends["right"]["length"] - k + rng.randint(0, k)  # the right end
            else:
                pos = rng.randint(0, L - k)
            s = plant(s, max(0, min(L - k, pos)), instantiate(site, rng))  # top-strand reading only
        if not pydna_site_check_reliable(s, names, 2 * max_reach + 10):
            unreliable += 1
            continue
        dseq = make_dseq(s, "linear", ends)
        enzymes = [biopython_enzyme(n) for n in names]
        if has_conflict(dseq, enzymes, end_margin=0):
            conflicts += 1
            continue
        shadow = count_shadowed(dseq, enzymes)
        shadowed += shadow
        cases.append(
            {
                "group": "near-end:nested" if nested else "near-end",
                "enzymes": names,
                "topology": "linear",
                "seq": s,
                "ends": ends,
                "shadowed": shadow,
                "fragments": pydna_fragments(s, "linear", names, ends),
            }
        )
    meta = {**META, "cases": len(cases), "skippedUnreliable": unreliable, "skippedConflicts": conflicts, "shadowedBreaks": shadowed}
    return {"meta": meta, "sequences": {}, "cases": cases}


def write_digest_files(payload: dict) -> None:
    """Split the digest cases over two files to keep each under 2 MB."""
    single = [c for c in payload["cases"] if len(c["enzymes"]) == 1 and "ends" not in c and "seqRef" not in c]
    other = [c for c in payload["cases"] if c not in single]
    for name, cases in (("pydna_digests_single.json", single), ("pydna_digests_multi.json", other)):
        meta = {**payload["meta"], "cases": len(cases)}
        write_json(name, {"meta": meta, "sequences": payload["sequences"], "cases": cases})


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    names = all_enzyme_names()
    write_json("enzyme_props.json", enzyme_props(names))
    write_json("search_planted.json", search_planted(names))
    shared = [
        ("puc19", genbank_sequence(FIXTURES / "pUC19_M77789.gb"), "pUC19 (GenBank M77789), fixture"),
        ("pbr322", genbank_sequence(FIXTURES / "pBR322_J01749.gb"), "pBR322 (GenBank J01749), fixture"),
        ("random3k", random_dna(3000, random.Random(f"{SEED}:random3k")), "seeded random 3000 bp"),
    ]
    for seq_id, seq, description in shared:
        write_json(f"search_{seq_id}.json", search_shared(names, seq_id, seq, description))
    write_digest_files(digest_cases())
    write_json("pydna_digests_near_end.json", near_end_cases())


if __name__ == "__main__":
    main()
