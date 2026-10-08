#!/usr/bin/env python
"""Live oracle for packages/core/src/gel/live-oracle.test.ts.

Reads a JSON array of cases {"size": bp, "pct": agarose %, "buffer": "TAE"|"TBE", "form": ...} from
the file named on the command line, evaluates the reference model (gel_model.py), and prints a JSON
array of {"position", "top", "midpoint", "sizeBack"} (sizeBack: the inverse of the model at that
position). Pure Python; run with tools/oracle/.venv/bin/python.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from gel_model import FORM_SIZE_FACTOR, gel_params, position  # noqa: E402


def size_back(p: float, g: dict, form: str) -> float | None:
    if not g["a"] < p < g["a"] + g["span"]:
        return None
    return g["lc"] * (g["span"] / (p - g["a"]) - 1) ** (1 / g["k"]) / FORM_SIZE_FACTOR[form]


def main() -> None:
    cases = json.loads(Path(sys.argv[1]).read_text())
    out = []
    for c in cases:
        g = gel_params(c["pct"], c["buffer"])
        p = position(c["size"], c["pct"], c["buffer"], c["form"])
        out.append({"position": p, "top": g["a"], "midpoint": g["lc"], "sizeBack": size_back(p, g, c["form"])})
    json.dump(out, sys.stdout)


if __name__ == "__main__":
    main()
