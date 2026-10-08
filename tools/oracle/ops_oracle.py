#!/usr/bin/env python3
"""
Differential-test oracle for packages/core/src/ops (module key: ops).

Runs reference implementations on real GenBank fixtures and on seeded random records and writes
JSON into packages/core/test/oracle/ops/, which `src/ops/ops.oracle.test.ts` replays against the
TypeScript implementation.

Oracles (see the docstrings of the generators below):
  - Biopython 1.88  SeqRecord.reverse_complement      -> reverseComplementRecord
  - pydna 5.5.16    Dseqrecord.shifted                 -> rotateOrigin
  - Biopython       SeqRecord slicing rec[a:b]          -> extractRange (fully contained features)
    pydna           Dseqrecord[a:b] with a > b (wrap)   -> extractRange on circular records
  - Biopython       SeqRecord + SeqRecord               -> concatRecords (blunt parts)
  - Biopython       rec[:a] + insert + rec[b:]          -> insertBases / deleteRange / replaceRange
                                                          (features outside the edited region)
  - pydna           Dseqrecord + Dseqrecord, .looped()  -> concatRecords with sticky ends

Deterministic (fixed seed) and re-runnable:
    tools/oracle/.venv/bin/python tools/oracle/ops_oracle.py

Our feature model (types.ts): segments in top-strand order, 0-based half-open, an origin-crossing
segment of a circular record has end > L, strand 1 / -1 / 0, partialStart / partialEnd = '<' / '>'
on the left / right end in top-strand coordinates. Features are compared through a canonical
"path" (the runs of top-strand positions they cover, in traversal order, contiguous runs merged),
their zero-length sites, strand, partial flags and extracted sequence.
"""
from __future__ import annotations

import json
import pathlib
import random
import warnings

from Bio import SeqIO
from Bio.Seq import Seq
from Bio.SeqFeature import AfterPosition, BeforePosition, CompoundLocation, SeqFeature, SimpleLocation, UnknownPosition
from Bio.SeqRecord import SeqRecord
from pydna.dseq import Dseq
from pydna.dseqrecord import Dseqrecord
from pydna.utils import shift_location

warnings.simplefilter("ignore")

ROOT = pathlib.Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "packages/core/test/fixtures/genbank"
OUT = ROOT / "packages/core/test/oracle/ops"
SEED = 20261008
MAX_FEATURE_SEQ = 600

REAL_FILES = [
    "pUC19_M77789.gb",
    "pBR322_J01749.gb",
    "NC_005816.gb",
    "bad_origin_wrap_fuzzy.gb",
    "bad_origin_wrap.gb",
    "addgene-plasmid-39296-sequence-49545.gbk",
    "pBAD30.gb",
    "KF527485.gbk",
    "cor6_6.gb",
]
STRAND_IN = {1: 1, -1: -1, None: 0, 0: 0}
STRAND_OUT = {1: 1, -1: -1, 0: None}


# ---------------------------------------------------------------------------
# Conversions between our model (dicts) and Biopython
# ---------------------------------------------------------------------------


def our_feature_from_bio(f: SeqFeature, index: int, L: int) -> dict | None:
    """Our representation of a parsed Biopython feature, or None if our model cannot hold it."""
    loc = f.location
    if loc is None:
        return None
    parts = list(loc.parts)
    if any(p.ref or p.ref_db for p in parts):
        return None  # refers to another record
    if any(isinstance(p.start, UnknownPosition) or isinstance(p.end, UnknownPosition) for p in parts):
        return None
    strands = {p.strand for p in parts}
    if len(strands) != 1:
        return None  # mixed strands
    strand = STRAND_IN[parts[0].strand]
    top = parts[::-1] if strand == -1 else parts
    segments = [[int(p.start), int(p.end)] for p in top]
    if any(not (0 <= s <= e <= L) for s, e in segments):
        return None
    label = (f.qualifiers.get("label") or f.qualifiers.get("gene") or f.qualifiers.get("product") or [f.type])[0]
    return {
        "id": f"f{index}",
        "type": f.type,
        "name": label,
        "strand": strand,
        "segments": segments,
        "partialStart": isinstance(top[0].start, BeforePosition),
        "partialEnd": isinstance(top[-1].end, AfterPosition),
    }


def merge_origin_parts(segments: list[list[int]], L: int) -> list[list[int]]:
    """Variant representation: a part ending at L followed by one starting at 0 become one wrapping segment."""
    out: list[list[int]] = []
    for s, e in segments:
        if out and out[-1][1] == L and s == 0 and e > 0 and out[-1][0] > 0 and (out[-1][1] - out[-1][0]) + e <= L:
            out[-1] = [out[-1][0], L + e]
        else:
            out.append([s, e])
    return out


def bio_location(f: dict, L: int):
    """Biopython location for one of our features (origin-crossing segments split at the origin)."""
    strand = STRAND_OUT[f["strand"]]
    spans: list[tuple[int, int]] = []
    for s, e in f["segments"]:
        if e > L:
            spans += [(s, L), (0, e - L)]
        else:
            spans.append((s, e))
    locs = [SimpleLocation(s, e, strand) for s, e in spans]
    if f.get("partialStart"):
        locs[0] = SimpleLocation(BeforePosition(locs[0].start), locs[0].end, strand)
    if f.get("partialEnd"):
        locs[-1] = SimpleLocation(locs[-1].start, AfterPosition(locs[-1].end), strand)
    if strand == -1:
        locs = locs[::-1]  # Biopython lists the parts of a minus-strand feature in biological order
    return locs[0] if len(locs) == 1 else CompoundLocation(locs)


def bio_record(rec: dict) -> SeqRecord:
    L = len(rec["seq"])
    features = [
        SeqFeature(bio_location(f, L), type=f["type"], qualifiers={"hh_id": [f["id"]], "label": [f["name"]]})
        for f in rec["features"]
    ]
    return SeqRecord(
        Seq(rec["seq"]),
        id=rec["name"],
        name=rec["name"],
        description="",
        features=features,
        annotations={"molecule_type": "DNA", "topology": rec["topology"]},
    )


def canonical_path(segments: list[tuple[int, int]], L: int, circular: bool) -> list[list[int]]:
    """Runs [start, length] of covered top-strand positions in traversal order, contiguous runs merged."""
    runs: list[list[int]] = []
    for s, e in segments:
        if e == s:
            continue
        start = s % L if circular and L else s
        length = e - s
        if runs:
            ps, pl = runs[-1]
            nxt = (ps + pl) % L if circular and L else ps + pl
            if nxt == start:
                runs[-1][1] += length
                continue
        runs.append([start, length])
    return runs


def view(f: SeqFeature, parent_seq, L: int, circular: bool) -> dict:
    """What the tests compare for one output feature."""
    parts = list(f.location.parts)
    strand = STRAND_IN[parts[0].strand]
    top = parts[::-1] if strand == -1 else parts
    segs = [(int(p.start), int(p.end)) for p in top]
    out = {
        "id": f.qualifiers["hh_id"][0],
        "strand": strand,
        "path": canonical_path(segs, L, circular),
        "sites": [(s % L if circular and L else s) for s, e in segs if s == e],
        "partialStart": isinstance(top[0].start, BeforePosition),
        "partialEnd": isinstance(top[-1].end, AfterPosition),
    }
    # The extracted sequence follows from path + strand + record sequence; it is stored as an
    # explicit cross-check for features up to MAX_FEATURE_SEQ bp to keep the JSON files small.
    if len(f.location) <= MAX_FEATURE_SEQ:
        out["seq"] = str(f.extract(parent_seq)).upper()
    return out


def full_seq(record) -> str:
    """Top-strand text of a Biopython or pydna record (for pydna: the full duplex extent, with
    single-stranded bases written as their top-strand equivalent, like our `seq`)."""
    return str(record.seq).upper()


def views(record, circular: bool) -> list[dict]:
    seq = Seq(full_seq(record))
    L = len(seq)
    return [view(f, seq, L, circular) for f in record.features]


# ---------------------------------------------------------------------------
# Inputs
# ---------------------------------------------------------------------------


def real_records() -> dict[str, dict]:
    """Fixture records in our model; circular ones also in the 'merged' (wrapping segment) variant."""
    out: dict[str, dict] = {}
    for fn in REAL_FILES:
        rec = next(SeqIO.parse(str(FIXTURES / fn), "genbank"))
        try:
            str(rec.seq)
        except Exception:  # Bio.Seq.UndefinedSequenceError: a record without sequence data
            print(f"skipping {fn}: no sequence data")
            continue
        L = len(rec.seq)
        topology = "circular" if rec.annotations.get("topology") == "circular" else "linear"
        features = []
        for i, f in enumerate(rec.features):
            g = our_feature_from_bio(f, i, L)
            if g is not None:
                features.append(g)
        name = fn.rsplit(".", 1)[0]
        seq = str(rec.seq).upper().replace("U", "T")
        out[name] = {"name": name, "seq": seq, "topology": topology, "features": features}
        if topology == "circular":
            merged = [dict(f, segments=merge_origin_parts(f["segments"], L)) for f in features]
            if any(m["segments"] != f["segments"] for m, f in zip(merged, features)):
                out[name + "~merged"] = {"name": name + "~merged", "seq": seq, "topology": topology, "features": merged}
    return out


def random_segment(rng: random.Random, L: int, circular: bool, allow_site: bool) -> list[int]:
    if allow_site and rng.random() < 0.1:
        p = rng.randrange(L) if circular else rng.randint(0, L)
        return [p, p]
    if circular:
        s = rng.randrange(L)
        n = rng.choice([L, rng.randint(1, L), rng.randint(1, min(L, 5))])
        return [s, s + n]
    a, b = sorted((rng.randint(0, L), rng.randint(0, L)))
    if a == b:
        b = min(L, a + 1)
        a = b - 1
    return [a, b]


def random_record(rng: random.Random, name: str, topology: str, iupac: bool, sites_alone: bool = False) -> dict:
    L = rng.randint(1, 300)
    alphabet = "ACGTRYSWKMBDHVN" if iupac else "ACGT"
    seq = "".join(rng.choice("ACGT") if not iupac or rng.random() < 0.9 else rng.choice(alphabet) for _ in range(L))
    circular = topology == "circular"
    features = []
    for i in range(rng.randint(0, 8)):
        count = 1 if rng.random() < 0.7 else rng.randint(2, 3)
        segments = [random_segment(rng, L, circular, allow_site=(count == 1 or not sites_alone)) for _ in range(count)]
        features.append(
            {
                "id": f"f{i}",
                "type": "misc_feature",
                "name": f"f{i}",
                "strand": rng.choice([1, -1, 0]),
                "segments": segments,
                "partialStart": rng.random() < 0.2,
                "partialEnd": rng.random() < 0.2,
            }
        )
    return {"name": name, "seq": seq, "topology": topology, "features": features}


def pydna_safe(rec: dict) -> dict:
    """Copy of a circular record without the (random, pathological) features that pydna's
    shift_location cannot rotate: it merges touching parts and asserts that the length is kept,
    which fails for features covering more than the whole circle. Tried for every shift."""
    L = len(rec["seq"])
    keep = []
    for f in rec["features"]:
        loc = bio_location(f, L)
        try:
            for k in range(L):
                shift_location(loc, -k, L)
        except AssertionError:
            continue
        keep.append(f)
    return dict(rec, features=keep)


def boundary_positions(rec: dict) -> list[int]:
    L = len(rec["seq"])
    marks = {0, 1, L - 1, L}
    for f in rec["features"]:
        for s, e in f["segments"]:
            marks.update({s, e, s - 1, e + 1})
    return sorted(p % L if L else 0 for p in marks)


# ---------------------------------------------------------------------------
# Generators
# ---------------------------------------------------------------------------


def gen_reverse_complement(records: dict[str, dict], rng: random.Random) -> dict:
    """Biopython SeqRecord.reverse_complement(features=True): flips locations, strands, fuzzy ends."""
    inputs = dict(records)
    for i in range(150):
        name = f"rnd_rc_{i}"
        inputs[name] = random_record(rng, name, rng.choice(["linear", "circular"]), iupac=True)
    cases = []
    for name, rec in inputs.items():
        rc = bio_record(rec).reverse_complement(features=True)
        cases.append({"record": name, "expected": {"seq": str(rc.seq), "features": views(rc, rec["topology"] == "circular")}})
    return {"records": inputs, "cases": cases}


def gen_rotate(records: dict[str, dict], rng: random.Random) -> dict:
    """pydna Dseqrecord.shifted(k): circular records only; k includes 0, 1, L-1 and feature boundaries."""
    inputs = {k: v for k, v in records.items() if v["topology"] == "circular"}
    for i in range(150):
        name = f"rnd_rot_{i}"
        inputs[name] = pydna_safe(random_record(rng, name, "circular", iupac=False, sites_alone=True))
    cases = []
    for name, rec in inputs.items():
        L = len(rec["seq"])
        ks = sorted({0, 1 % L, L - 1, rng.randrange(L), *rng.sample(boundary_positions(rec), min(4, len(boundary_positions(rec))))})
        dsr = Dseqrecord.from_SeqRecord(bio_record(rec), circular=True)
        for k in ks:
            out = dsr.shifted(k)
            cases.append({"record": name, "k": k, "expected": {"seq": full_seq(out), "features": views(out, True)}})
    return {"records": inputs, "cases": cases}


def inside_ids(rec: dict, start: int, end: int) -> set[str]:
    """Ids of the features all of whose bases (and sites) lie in the region [start, end) of `rec`."""
    L = len(rec["seq"])
    circular = rec["topology"] == "circular"
    region = {(start + i) % L if circular else start + i for i in range(end - start)}
    out = set()
    for f in rec["features"]:
        ok = True
        for s, e in f["segments"]:
            if s == e:
                offset = (s - start) % L if circular else s - start
                ok = ok and 0 <= offset <= end - start
            else:
                ok = ok and all(((x % L) if circular else x) in region for x in range(s, e))
        if ok:
            out.add(f["id"])
    return out


def gen_extract(records: dict[str, dict], rng: random.Random) -> dict:
    """Biopython rec[a:b] (and pydna rec[a:b] with a > b on circular records) keep the features that lie
    entirely inside the slice, shifted. Ranges are written in our model ({start, end}, end > L to wrap)."""
    inputs = dict(records)
    for i in range(150):
        name = f"rnd_ext_{i}"
        rec = random_record(rng, name, rng.choice(["linear", "circular"]), iupac=False, sites_alone=True)
        inputs[name] = pydna_safe(rec) if rec["topology"] == "circular" else rec
    cases = []
    for name, rec in inputs.items():
        L = len(rec["seq"])
        circular = rec["topology"] == "circular"
        bio = bio_record(rec)
        marks = boundary_positions(rec)
        ranges = set()
        for _ in range(4):
            a = rng.choice(marks) if rng.random() < 0.5 else rng.randint(0, L - 1)
            b = rng.choice(marks) if rng.random() < 0.5 else rng.randint(0, L)
            if circular and a != b and L > 1:
                ranges.add((a, b if b > a else b + L))  # b < a: crosses the origin
            elif not circular:
                ranges.add(tuple(sorted((a, b))))
        for start, end in sorted(ranges):
            if end <= L:
                piece = bio[start:end]
            else:
                piece = Dseqrecord.from_SeqRecord(bio, circular=True)[start : end - L]
            # pydna judges containment by a feature's first and last part only; keep the features
            # whose every base lies in the region (Biopython's own criterion for linear slices).
            keep = inside_ids(rec, start, end)
            piece.features = [f for f in piece.features if f.qualifiers["hh_id"][0] in keep]
            cases.append(
                {"record": name, "range": {"start": start, "end": end}, "expected": {"seq": full_seq(piece), "features": views(piece, False)}}
            )
    return {"records": inputs, "cases": cases}


def gen_concat(records: dict[str, dict], rng: random.Random) -> dict:
    """Biopython SeqRecord + SeqRecord: the right part's features are shifted by len(left).
    Parts are linear slices of the real records (as Biopython slices them) and random records."""
    inputs: dict[str, dict] = {}
    for name, rec in records.items():
        if name.endswith("~merged"):
            continue
        L = len(rec["seq"])
        bio = bio_record(dict(rec, topology="linear", features=[f for f in rec["features"] if all(e <= L for _, e in f["segments"])]))
        for j in range(3):
            a, b = sorted(rng.sample(range(L + 1), 2))
            piece = bio[a:b]
            inputs[f"{name}[{a}:{b}]"] = bio_to_ours(piece, f"{name}[{a}:{b}]")
    for i in range(120):
        name = f"rnd_cat_{i}"
        inputs[name] = random_record(rng, name, "linear", iupac=True)
    names = list(inputs)
    cases = []
    for _ in range(300):
        parts = rng.sample(names, rng.randint(1, 3))
        total = bio_record(inputs[parts[0]])
        for p in parts[1:]:
            total = total + bio_record(inputs[p])
        cases.append({"parts": parts, "expected": {"seq": str(total.seq), "features": views(total, False)}})
    return {"records": inputs, "cases": cases}


def bio_to_ours(bio: SeqRecord, name: str) -> dict:
    L = len(bio.seq)
    features = []
    for f in bio.features:
        g = our_feature_from_bio(f, 0, L)
        if g is not None:
            g["id"] = f.qualifiers["hh_id"][0]
            g["name"] = f.qualifiers["label"][0]
            features.append(g)
    return {"name": name, "seq": str(bio.seq).upper(), "topology": "linear", "features": features}


def gen_edits(records: dict[str, dict], rng: random.Random) -> dict:
    """Insertion / deletion / replacement on LINEAR records simulated with Biopython as
    rec[:a] + inserted + rec[b:]. Biopython keeps exactly the features lying entirely on one side
    of the edited region, which our rules must leave untouched (moved as a block)."""
    inputs = {k: dict(v, topology="linear", features=[f for f in v["features"] if all(e <= len(v["seq"]) for _, e in f["segments"])]) for k, v in records.items() if not k.endswith("~merged")}
    for i in range(150):
        name = f"rnd_edit_{i}"
        inputs[name] = random_record(rng, name, "linear", iupac=True)
    cases = []
    for name, rec in inputs.items():
        L = len(rec["seq"])
        bio = bio_record(rec)
        marks = [p for p in boundary_positions(rec)] + [L]
        for _ in range(6):
            kind = rng.choice(["insert", "delete", "replace"])
            a = rng.choice(marks) if rng.random() < 0.6 else rng.randint(0, L)
            b = a if kind == "insert" else min(L, max(a, rng.choice(marks) if rng.random() < 0.5 else a + rng.randint(0, 12)))
            ins = "" if kind == "delete" else "".join(rng.choice("ACGT") for _ in range(rng.randint(1, 10)))
            total = bio[:a] + SeqRecord(Seq(ins), id="ins") + bio[b:] if ins else bio[:a] + bio[b:]
            case = {"record": name, "kind": kind, "range": {"start": a, "end": b}, "bases": ins}
            # Features at a zero-length site exactly at the insertion point appear on both sides in
            # Biopython (they fit both slices); our rule keeps one copy, before the insertion.
            case["expected"] = {"seq": str(total.seq), "features": views(total, False)}
            cases.append(case)
    return {"records": inputs, "cases": cases}


def ends_to_pydna(ends: dict) -> tuple[int, int]:
    """(crick_ovhg, watson_ovhg) of Dseq.from_full_sequence_and_overhangs for our FragmentEnds."""
    left, right = ends["left"], ends["right"]
    crick = {"blunt": 0, "5prime": -left["length"], "3prime": left["length"]}[left["kind"]]
    watson = {"blunt": 0, "5prime": -right["length"], "3prime": right["length"]}[right["kind"]]
    return crick, watson


def ends_from_pydna(dseq: Dseq) -> dict:
    def side(kind: str, sticky: str) -> dict:
        if kind == "blunt" or not sticky:
            return {"kind": "blunt", "length": 0}
        return {"kind": "5prime" if kind == "5'" else "3prime", "length": len(sticky)}

    return {"left": side(*dseq.five_prime_end()), "right": side(*dseq.three_prime_end())}


def pydna_record(rec: dict) -> Dseqrecord:
    crick, watson = ends_to_pydna(rec["ends"])
    dseq = Dseq.from_full_sequence_and_overhangs(rec["seq"], crick_ovhg=crick, watson_ovhg=watson)
    out = Dseqrecord(dseq)
    out.features = bio_record(rec).features
    return out


def gen_ligation(rng: random.Random) -> dict:
    """pydna ligation: Dseqrecord + Dseqrecord joins compatible sticky ends (TypeError otherwise) and
    .looped() circularizes a fragment whose two ends are compatible."""
    inputs: dict[str, dict] = {}
    cases = []

    def fragment(name: str, seq: str, left: dict, right: dict) -> dict:
        L = len(seq)
        rec = random_record(rng, name, "linear", iupac=False)
        features = []
        for i in range(rng.randint(0, 4)):
            a, b = sorted(rng.sample(range(L + 1), 2))
            features.append({"id": f"{name}_f{i}", "type": "misc_feature", "name": f"{name}_f{i}", "strand": rng.choice([1, -1, 0]), "segments": [[a, b]]})
        rec.update(seq=seq, features=features, ends={"left": left, "right": right})
        inputs[name] = rec
        return rec

    def end(kind: str, n: int) -> dict:
        return {"kind": "blunt", "length": 0} if n == 0 or kind == "blunt" else {"kind": kind, "length": n}

    for i in range(250):
        n = rng.choice([0, 1, 2, 3, 4, 4])
        kind = rng.choice(["5prime", "3prime"])
        over = "".join(rng.choice("ACGT") for _ in range(n))
        a_body = "".join(rng.choice("ACGT") for _ in range(rng.randint(5, 40)))
        b_body = "".join(rng.choice("ACGT") for _ in range(rng.randint(5, 40)))
        mode = rng.random()
        b_over, b_kind, b_n = over, kind, n
        if mode < 0.15 and n > 0:
            b_kind = "3prime" if kind == "5prime" else "5prime"  # kind mismatch
        elif mode < 0.3 and n > 0:
            b_over = over[:-1] + ("A" if over[-1] != "A" else "C")  # text mismatch
        elif mode < 0.4:
            b_n = 0 if n > 0 else 2  # sticky vs blunt
            b_over = "" if b_n == 0 else "AA"
        # outer ends: compatible with each other half of the time (for circularization)
        m = rng.choice([0, 2, 4])
        mk = rng.choice(["5prime", "3prime"])
        outer = "".join(rng.choice("ACGT") for _ in range(m))
        closing = outer if rng.random() < 0.6 else "".join(rng.choice("ACGT") for _ in range(m))
        a = fragment(f"lig{i}a", outer + a_body + over, end(mk, m), end(kind, n))
        b = fragment(f"lig{i}b", b_over + b_body + closing, end(b_kind, b_n), end(mk, m))
        case: dict = {"parts": [a["name"], b["name"]]}
        try:
            joined = pydna_record(a) + pydna_record(b)
        except TypeError:
            case["expected"] = {"error": True}
        else:
            case["expected"] = {"seq": full_seq(joined), "ends": ends_from_pydna(joined.seq), "features": views(joined, False)}
            try:
                looped = joined.looped()
            except TypeError:
                case["expectedCircular"] = {"error": True}
            else:
                case["expectedCircular"] = {"seq": full_seq(looped), "features": views(looped, True)}
        cases.append(case)
    return {"records": inputs, "cases": cases}


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    real = real_records()
    generators = {
        "reverse_complement": lambda rng: gen_reverse_complement(real, rng),
        "rotate": lambda rng: gen_rotate(real, rng),
        "extract": lambda rng: gen_extract(real, rng),
        "concat": lambda rng: gen_concat(real, rng),
        "edits": lambda rng: gen_edits(real, rng),
        "ligation": gen_ligation,
    }
    for i, (key, gen) in enumerate(generators.items()):
        data = gen(random.Random(SEED + i))
        data["oracle"] = "Biopython 1.88 / pydna 5.5.16 (tools/oracle/ops_oracle.py)"
        path = OUT / f"{key}.json"
        path.write_text(json.dumps(data, separators=(",", ":")) + "\n")
        print(f"{path.relative_to(ROOT)}: {len(data['cases'])} cases, {path.stat().st_size / 1e6:.2f} MB")


if __name__ == "__main__":
    main()
