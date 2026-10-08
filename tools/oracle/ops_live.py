#!/usr/bin/env python3
"""
Live oracle for packages/core/src/ops/ops.live-oracle.test.ts (module key: ops).

The Vitest test generates random cases with its own (seeded) TypeScript generator, writes them
to a JSON file and runs:
    tools/oracle/.venv/bin/python tools/oracle/ops_live.py <cases.json> <results.json>
This script evaluates every case with Biopython 1.88 / pydna 5.5.16, using the same conversions
as ops_oracle.py, and writes one result per case:
    {"seq": ..., "features": [views...]}   or   {"error": true}   (pydna rejected the ligation)
plus, for rotations, "kept": the ids of the features pydna can rotate (see pydna_safe).

Case kinds ("op"):
    rc       Biopython SeqRecord.reverse_complement
    rotate   pydna Dseqrecord.shifted(k)
    extract  Biopython rec[a:b] (pydna rec[a:b-L] when the range crosses the origin), keeping
             the features entirely inside the region
    concat   Biopython SeqRecord addition of blunt linear parts
    edit     Biopython rec[:a] + bases + rec[b:] on a linear record
    ligate   pydna Dseqrecord + Dseqrecord (and .looped() when "circular" is set)
"""
from __future__ import annotations

import json
import pathlib
import sys

sys.dont_write_bytecode = True  # do not leave __pycache__ behind when run from the test suite
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

import ops_oracle as O  # noqa: E402  (shares the conversions with the precomputed oracle)
from Bio.Seq import Seq  # noqa: E402
from Bio.SeqRecord import SeqRecord  # noqa: E402
from pydna.dseqrecord import Dseqrecord  # noqa: E402


def result(record, circular: bool) -> dict:
    return {"seq": O.full_seq(record), "features": O.views(record, circular)}


def run(case: dict) -> dict:
    op = case["op"]
    if op == "rc":
        rec = case["record"]
        return result(O.bio_record(rec).reverse_complement(features=True), rec["topology"] == "circular")
    if op == "rotate":
        rec = O.pydna_safe(case["record"])
        out = Dseqrecord.from_SeqRecord(O.bio_record(rec), circular=True).shifted(case["k"])
        return dict(result(out, True), kept=[f["id"] for f in rec["features"]])
    if op == "extract":
        rec = case["record"]
        start, end = case["range"]["start"], case["range"]["end"]
        L = len(rec["seq"])
        bio = O.bio_record(rec)
        piece = bio[start:end] if end <= L else Dseqrecord.from_SeqRecord(bio, circular=True)[start : end - L]
        keep = O.inside_ids(rec, start, end)
        piece.features = [f for f in piece.features if f.qualifiers["hh_id"][0] in keep]
        return result(piece, False)
    if op == "concat":
        total = O.bio_record(case["parts"][0])
        for part in case["parts"][1:]:
            total = total + O.bio_record(part)
        return result(total, False)
    if op == "edit":
        bio = O.bio_record(case["record"])
        a, b = case["range"]["start"], case["range"]["end"]
        bases = case["bases"]
        total = bio[:a] + SeqRecord(Seq(bases), id="ins") + bio[b:] if bases else bio[:a] + bio[b:]
        return result(total, False)
    if op == "ligate":
        try:
            joined = O.pydna_record(case["parts"][0])
            for part in case["parts"][1:]:
                joined = joined + O.pydna_record(part)
        except TypeError:
            return {"error": True}
        out = dict(result(joined, False), ends=O.ends_from_pydna(joined.seq))
        if case.get("circular"):
            try:
                out["circular"] = result(joined.looped(), True)
            except TypeError:
                out["circular"] = {"error": True}
        return out
    raise ValueError(f"unknown op {op!r}")


def run_guarded(case: dict) -> dict:
    """pydna's shift_location asserts on some pathological random features (e.g. a zero-length
    part merged into its neighbour); such cases are reported as skipped instead of crashing."""
    try:
        return run(case)
    except AssertionError:
        return {"skip": "pydna assertion"}


def main() -> None:
    cases = json.loads(pathlib.Path(sys.argv[1]).read_text())
    pathlib.Path(sys.argv[2]).write_text(json.dumps([run_guarded(c) for c in cases]))


if __name__ == "__main__":
    main()
