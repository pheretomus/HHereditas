#!/usr/bin/env python3
"""Biopython reference ("live oracle") for HHereditas `parseLocation`.

Usage
-----
    genbank_location_oracle.py CASES.json

CASES.json is a JSON list of {"text": str, "length": int, "circular": bool}. For every case the
script prints (as one JSON list on stdout, in the same order) Biopython's
`Bio.SeqFeature.Location.fromstring(text, length, circular)`: the location parts (0-based
half-open start/end, strand, remote reference, fuzzy position kinds, as in genbank_oracle.py)
or the parser error, plus the warnings it emitted. This is the call Biopython's GenBank reader
makes for every feature location (`_FeatureConsumer.location`).

Deterministic: the output depends only on the input file.
"""

from __future__ import annotations

import json
import os
import sys
import warnings

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from Bio.SeqFeature import Location  # noqa: E402

from genbank_oracle import dump_location  # noqa: E402


def parse_case(case):
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        try:
            loc = Location.fromstring(case["text"], case["length"], case["circular"])
            result = {"location": dump_location(loc), "error": None}
        except Exception as exc:  # LocationParserError, ValueError, ...
            result = {"location": None, "error": f"{type(exc).__name__}: {exc}"}
    result["warnings"] = [str(w.message) for w in caught if not issubclass(w.category, ResourceWarning)]
    return result


def main(argv):
    if len(argv) != 1:
        raise SystemExit(__doc__)
    with open(argv[0], encoding="utf-8") as handle:
        cases = json.load(handle)
    json.dump([parse_case(c) for c in cases], sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main(sys.argv[1:])
