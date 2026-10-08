#!/usr/bin/env python
"""Live oracle for the enzymes Vitest suite (packages/core/src/enzymes/live-oracle.test.ts).

Usage:
    tools/oracle/.venv/bin/python tools/oracle/enzymes_live.py REQUEST.json

REQUEST.json:
    {"search": [{"enzyme": "EcoRI", "seq": "...", "topology": "linear" | "circular"}, ...],
     "digest": [{"enzymes": ["EcoRI", ...], "seq": "...", "topology": "...",
                 "ends": {"left": {"kind", "length"}, "right": {...}} (optional, linear only),
                 "endMargin": n (optional: report a conflict when a cut zone comes within n bases
                             of a single-stranded end, where pydna's validity checks differ)}, ...],
     "nearEnd": [{"enzymes": [...], "seq": "...", "ends": {...}, "reverseMargin": n}, ...]}
                (linear molecules with sites at the single-stranded ends; a case is reported
                 {"unreliable": true} when pydna's recognition-site check cannot be trusted for it,
                 see enzymes_common.pydna_site_check_reliable)

Prints JSON to stdout:
    {"search": [{"expected": [gaps], "biopython": [gaps], "deviation": str | null}, ...],
     "digest": [{"conflict": true} | {"error": "..."} | {"conflict": false, "fragments": [...]}, ...],
     "nearEnd": [{"unreliable": true} | {"conflict": true} | {"error": "..."}
                 | {"conflict": false, "fragments": [...], "shadowed": n}, ...]}

Positions are 0-based gap positions; see enzymes_common.py for conventions and corrections.
Deterministic: the output depends only on the request.
"""

from __future__ import annotations

import json
import sys

from enzymes_common import (
    biopython_enzyme,
    biopython_top_cuts,
    count_shadowed,
    deviation_kind,
    expected_top_cuts,
    has_conflict,
    make_dseq,
    pydna_fragments,
    pydna_site_check_reliable,
)


def main() -> None:
    with open(sys.argv[1], encoding="utf-8") as fh:
        request = json.load(fh)
    out: dict[str, list] = {"search": [], "digest": [], "nearEnd": []}
    for case in request.get("search", []):
        linear = case["topology"] == "linear"
        out["search"].append(
            {
                "expected": expected_top_cuts(case["enzyme"], case["seq"], linear),
                "biopython": biopython_top_cuts(case["enzyme"], case["seq"], linear),
                "deviation": deviation_kind(case["enzyme"]),
            }
        )
    for case in request.get("digest", []):
        ends = case.get("ends")
        dseq = make_dseq(case["seq"], case["topology"], ends)
        enzymes = [biopython_enzyme(n) for n in case["enzymes"]]
        if has_conflict(dseq, enzymes, end_margin=case.get("endMargin", 0)):
            out["digest"].append({"conflict": True})
            continue
        try:
            frags = pydna_fragments(case["seq"], case["topology"], case["enzymes"], ends)
        except Exception as exc:  # report, the test decides
            out["digest"].append({"error": repr(exc)})
            continue
        out["digest"].append({"conflict": False, "fragments": frags})
    for case in request.get("nearEnd", []):
        if not pydna_site_check_reliable(case["seq"], case["enzymes"], case["reverseMargin"]):
            out["nearEnd"].append({"unreliable": True})
            continue
        dseq = make_dseq(case["seq"], "linear", case["ends"])
        enzymes = [biopython_enzyme(n) for n in case["enzymes"]]
        if has_conflict(dseq, enzymes, end_margin=0):
            out["nearEnd"].append({"conflict": True})
            continue
        try:
            frags = pydna_fragments(case["seq"], "linear", case["enzymes"], case["ends"])
        except Exception as exc:  # report, the test decides
            out["nearEnd"].append({"error": repr(exc)})
            continue
        out["nearEnd"].append({"conflict": False, "fragments": frags, "shadowed": count_shadowed(dseq, enzymes)})
    json.dump(out, sys.stdout, separators=(",", ":"))


if __name__ == "__main__":
    main()
