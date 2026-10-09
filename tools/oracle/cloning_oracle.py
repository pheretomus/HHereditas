#!/usr/bin/env python
"""Differential-test oracle for packages/core/src/cloning (pydna 5.5.16).

Usage (from the repository root; deterministic, safe to re-run):

    tools/oracle/.venv/bin/python tools/oracle/cloning_oracle.py

Writes JSON into packages/core/test/oracle/cloning/:

  pcr.json          pydna.amplify.Anneal(limit=15) products for primer pairs (random 0-12 nt 5' tails,
                    18-25 nt annealing parts) on pUC19 / pBR322 (circular, incl. amplicons across the
                    origin) and seeded random linear and circular templates. Only cases where pydna
                    finds exactly one product are kept, plus cases where it finds none.
  ligation.json     Restriction cloning: pydna Dseqrecord.cut of a vector and an insert, the largest
                    vector fragment + the insert fragment ligated with `+` and closed with .looped(),
                    for directional (two enzymes) and single-enzyme cases, both orientations.
  gibson.json       pydna.assembly.Assembly(limit=minOverlap) circular and linear products of seeded
                    random fragment sets with 15-40 bp terminal overlaps.
  golden_gate.json  BsaI Golden Gate: pydna cuts each part, keeps the BsaI-free fragment cut at both ends,
                    ligates them in the designed order (+, .looped()).

Products are compared in the tests up to rotation and reverse complement for circular molecules.
"""

from __future__ import annotations

import json
import random
import warnings
from pathlib import Path

from Bio import SeqIO
from Bio.Restriction import BamHI, BglII, BsaI, EcoRI, HindIII, KpnI, PstI, SacI, SalI, XbaI, XhoI, NotI
from Bio.Seq import reverse_complement

warnings.filterwarnings("ignore", category=DeprecationWarning)
from pydna.amplify import Anneal  # noqa: E402
from pydna.assembly import Assembly  # noqa: E402
from pydna.dseqrecord import Dseqrecord  # noqa: E402
from pydna.primer import Primer  # noqa: E402

SEED = 20261009
REPO_ROOT = Path(__file__).resolve().parents[2]
OUT_DIR = REPO_ROOT / "packages" / "core" / "test" / "oracle" / "cloning"
FIXTURES = REPO_ROOT / "packages" / "core" / "test" / "fixtures" / "genbank"


def load(name: str) -> str:
    return str(SeqIO.read(FIXTURES / name, "genbank").seq).upper()


def random_dna(rng: random.Random, n: int, avoid: tuple[str, ...] = ()) -> str:
    while True:
        s = "".join(rng.choice("ACGT") for _ in range(n))
        if not any(a in s or reverse_complement(a) in s for a in avoid):
            return s


def pcr_cases(rng: random.Random) -> list[dict]:
    templates = [
        ("pUC19", load("pUC19_M77789.gb"), True),
        ("pBR322", load("pBR322_J01749.gb"), True),
    ]
    for i in range(4):
        templates.append((f"random{i}", random_dna(rng, rng.randint(400, 1500)), i % 2 == 0))
    cases = []
    for name, seq, circular in templates:
        L = len(seq)
        n_cases = 0
        attempts = 0
        while n_cases < 25 and attempts < 400:
            attempts += 1
            fa = rng.randint(18, 25)
            ra = rng.randint(18, 25)
            fs = rng.randrange(L)
            size = rng.randint(60, min(1200, L - 1))
            if not circular:
                fs = rng.randrange(0, max(1, L - size - 1))
            re = fs + size
            if not circular and re > L:
                continue
            ext = seq + seq if circular else seq
            fwd_anneal = ext[fs : fs + fa]
            rev_anneal = reverse_complement(ext[re - ra : re])
            ftail = random_dna(rng, rng.randint(0, 12))
            rtail = random_dna(rng, rng.randint(0, 12))
            # occasionally swap or break a primer to exercise the "no product" path
            mode = rng.random()
            fwd = ftail + fwd_anneal
            rev = rtail + rev_anneal
            if mode < 0.08:
                fwd, rev = reverse_complement(fwd), reverse_complement(rev)  # wrong orientation
            products = Anneal(
                [Primer(fwd, name="F"), Primer(rev, name="R")], Dseqrecord(seq, circular=circular), limit=15
            ).products
            if len(products) > 1:
                continue
            cases.append(
                {
                    "template": name,
                    "templateSeq": seq if name.startswith("random") else None,
                    "circular": circular,
                    "forward": fwd,
                    "reverse": rev,
                    "product": str(products[0].seq).upper() if products else None,
                }
            )
            n_cases += 1
    return cases


def ligation_cases(rng: random.Random) -> list[dict]:
    puc = load("pUC19_M77789.gb")
    pbr = load("pBR322_J01749.gb")
    enzymes = {"EcoRI": EcoRI, "BamHI": BamHI, "HindIII": HindIII, "PstI": PstI, "SalI": SalI, "XbaI": XbaI, "KpnI": KpnI, "SacI": SacI, "BglII": BglII, "XhoI": XhoI, "NotI": NotI}
    sites = {n: str(e.site) for n, e in enzymes.items()}
    combos = [
        ("pUC19", puc, ["EcoRI", "BamHI"], ["EcoRI", "BamHI"]),
        ("pUC19", puc, ["HindIII", "EcoRI"], ["HindIII", "EcoRI"]),
        ("pUC19", puc, ["PstI", "KpnI"], ["PstI", "KpnI"]),
        ("pUC19", puc, ["SalI", "SacI"], ["XhoI", "SacI"]),
        ("pUC19", puc, ["EcoRI"], ["EcoRI"]),
        ("pUC19", puc, ["BamHI"], ["BglII"]),
        ("pUC19", puc, ["XbaI", "HindIII"], ["XbaI", "HindIII"]),
        ("pBR322", pbr, ["EcoRI", "HindIII"], ["EcoRI", "HindIII"]),
        ("pBR322", pbr, ["BamHI", "SalI"], ["BglII", "XhoI"]),
    ]
    cases = []
    for vname, vseq, venz, ienz in combos:
        for rep in range(3):
            avoid = tuple(sites[e] for e in set(venz + ienz))
            body = random_dna(rng, rng.randint(200, 900), avoid)
            left = sites[ienz[0]]
            right = sites[ienz[-1]]
            if rep == 2 and len(ienz) == 2:
                left, right = right, left  # insert written the other way round
            insert = random_dna(rng, 6, avoid) + left + body + right + random_dna(rng, 6, avoid)
            try:
                vfr = Dseqrecord(vseq, circular=True).cut(*[enzymes[e] for e in venz])
                ifr = Dseqrecord(insert).cut(*[enzymes[e] for e in ienz])
            except ValueError as e:  # pydna refuses some digests (e.g. "internally split")
                print("skipped", vname, venz, ienz, str(e).splitlines()[0])
                continue
            vfrag = max(vfr, key=len)
            # the middle fragment (cut on both sides)
            ifrag = ifr[1]
            products = []
            for orientation, frag in (("forward", ifrag), ("reverse", ifrag.reverse_complement())):
                try:
                    p = (vfrag + frag).looped()
                    products.append({"orientation": orientation, "seq": str(p.seq).upper()})
                except Exception:  # noqa: BLE001 - incompatible ends
                    pass
            cases.append({"vector": vname, "vectorEnzymes": venz, "insertEnzymes": ienz, "insert": insert, "products": products})
    return cases


def gibson_cases(rng: random.Random) -> list[dict]:
    cases = []
    for i in range(30):
        n = rng.randint(1, 5) if i % 3 else rng.randint(2, 4)
        circular = i % 4 != 3
        min_overlap = rng.choice([15, 20])
        total = random_dna(rng, rng.randint(300 * n, 700 * n))
        # cut the molecule into n pieces with overlaps
        cuts = sorted(rng.sample(range(150, len(total) - 150), n - 1)) if n > 1 else []
        bounds = [0] + cuts + [len(total)]
        frags = []
        for k in range(n):
            ov = rng.randint(min_overlap, 40)
            a = bounds[k]
            b = bounds[k + 1]
            if circular:
                piece = (total + total)[a : b + ov]
            else:
                piece = total[a : min(len(total), b + ov)] if k < n - 1 else total[a:b]
            frags.append(piece)
        if circular and n == 1:
            ov = rng.randint(min_overlap, 40)
            frags = [total + total[:ov]]
        recs = [Dseqrecord(f) for f in frags]
        try:
            asm = Assembly(recs, limit=min_overlap)
            prods = asm.assemble_circular() if circular else asm.assemble_linear()
        except Exception as e:  # noqa: BLE001
            prods = []
            print("pydna assembly failed", e)
        full = [p for p in prods if len(p) == len(total)]
        seqs = sorted({str(p.seq).upper() for p in full})
        cases.append({"fragments": frags, "circular": circular, "minOverlap": min_overlap, "expected": total, "pydna": seqs})
    return cases


def golden_gate_cases(rng: random.Random) -> list[dict]:
    site = "GGTCTC"
    avoid = (site, "GAATTC")
    ohs_pool = ["GGAG", "TACT", "AATG", "GCTT", "CGCT", "TGCC", "ACTA", "TTCG"]
    cases = []
    for i in range(10):
        n = rng.randint(2, 5)
        ohs = rng.sample(ohs_pool, n + 1)
        parts = []
        # destination vector: backbone between ohs[n] ... ohs[0]; drop-out carries the sites
        backbone = random_dna(rng, 800, avoid)
        dropout = random_dna(rng, 100, avoid)
        dest = backbone + ohs[0] + "A" + reverse_complement(site) + dropout + site + "A" + ohs[n]
        parts.append({"seq": dest, "circular": True})
        for k in range(n):
            body = random_dna(rng, rng.randint(80, 400), avoid)
            insert = site + "A" + ohs[k] + body + ohs[k + 1] + "T" + reverse_complement(site)
            if k % 2 == 0:
                parts.append({"seq": random_dna(rng, 5, avoid) + insert + random_dna(rng, 5, avoid), "circular": False})
            else:
                parts.append({"seq": random_dna(rng, 300, avoid) + insert, "circular": True})
        frags = []
        for p in parts:
            d = Dseqrecord(p["seq"], circular=p["circular"]).cut(BsaI)
            keep = [
                f
                for f in d
                if all(x not in str(strand).upper() for x in (site, reverse_complement(site)) for strand in (f.seq.watson, f.seq.crick))
            ]
            assert len(keep) == 1, len(keep)
            frags.append(keep[0])
        prod = frags[0]
        for f in frags[1:]:
            prod = prod + f
        prod = prod.looped()
        # shuffle the parts for the input (order must be found from the overhangs)
        order = list(range(len(parts)))
        rest = order[1:]
        rng.shuffle(rest)
        order = [0] + rest
        shuffled = [parts[j] for j in order]
        if i % 3 == 1:
            # give one linear part in reverse complement
            for s in shuffled[1:]:
                if not s["circular"]:
                    s["seq"] = reverse_complement(s["seq"])
                    break
        cases.append({"parts": shuffled, "product": str(prod.seq).upper()})
    return cases


def main() -> None:
    rng = random.Random(SEED)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    meta = {"pydna": __import__("pydna").__version__, "seed": SEED}
    for name, fn in (("pcr", pcr_cases), ("ligation", ligation_cases), ("gibson", gibson_cases), ("golden_gate", golden_gate_cases)):
        data = {"meta": meta, "cases": fn(rng)}
        (OUT_DIR / f"{name}.json").write_text(json.dumps(data, indent=1) + "\n")
        print(name, len(data["cases"]))


if __name__ == "__main__":
    main()
