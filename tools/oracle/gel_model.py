"""Reference (Python) implementation of the agarose migration model of packages/core/src/gel/migration.ts.

Written independently of the TypeScript code from the model description; the TypeScript tests compare
both implementations (model_reference.json, and live via gel_live.py). Pure Python, no dependencies.

Model: position(L) = a + span / (1 + (L/Lc)^k) for linear DNA of L bp, position 0 = well, 1 = bottom of
the gel after a standard run. a, span, Lc follow from two conditions per gel: DNA co-migrating with
bromophenol blue sits at BPB_POSITION, DNA co-migrating with xylene cyanol FF at
BPB_POSITION / BPB_XC_SPEED_RATIO, with bottom asymptote b = a + span and exponent k given by shape():
SHAPE_EXPONENT / SMALL_DNA_POSITION for TAE; for TBE linear in the agarose % from those values at
TBE_RAMP_PERCENT[0] to TBE_HIGH_SHAPE_EXPONENT / TBE_HIGH_SMALL_DNA_POSITION at TBE_RAMP_PERCENT[1] and above.
"""

from __future__ import annotations

import math

#: Addgene "Agarose Gel Electrophoresis" protocol: run "until the dye line is approximately 75-80% of
#: the way down the gel" (midpoint).
BPB_POSITION = 0.775
#: Bromophenol blue migrates ~2.2-fold faster than xylene cyanol FF, independent of the agarose
#: concentration (Sambrook & Russell, Molecular Cloning 3rd ed., 2001, p. 5.9).
BPB_XC_SPEED_RATIO = 2.2
XC_POSITION = BPB_POSITION / BPB_XC_SPEED_RATIO
#: Empirical constants, fitted by gel_oracle.calibrate() to vendor gel photographs (rounded): shape
#: exponent and bottom asymptote of TAE gels (and of TBE gels at <= 1 % agarose) ...
SHAPE_EXPONENT = 1.12
SMALL_DNA_POSITION = 0.90
#: ... and of TBE gels at >= 2 % agarose; in between linear in the agarose percentage.
TBE_HIGH_SHAPE_EXPONENT = 1.13
TBE_HIGH_SMALL_DNA_POSITION = 0.86
TBE_RAMP_PERCENT = (1.0, 2.0)
#: Heuristic apparent-size factors of circular forms (see migration.ts).
FORM_SIZE_FACTOR = {"linear": 1.0, "supercoiled": 0.7, "nicked": 1.6}

#: Linear dsDNA sizes (bp) co-migrating with bromophenol blue / xylene cyanol FF, by agarose %.
#: Thermo Fisher Scientific, Invitrogen School of Molecular Biology, "Steps in nucleic acid gel
#: electrophoresis", Table 7 (citing Green & Sambrook, Molecular Cloning 4th ed., 2012).
DYE_COMIGRATION = {
    "TAE": [(0.5, 1150, 16700), (0.6, 850, 11600), (0.7, 660, 8500), (0.8, 530, 6500), (0.9, 440, 5140),
            (1.0, 370, 4160), (1.2, 275, 2890), (1.5, 190, 1840), (2.0, 120, 1040), (3.0, 60, 460)],
    "TBE": [(0.5, 750, 13000), (0.6, 540, 8820), (0.7, 410, 6400), (0.8, 320, 4830), (0.9, 260, 3770),
            (1.0, 220, 3030), (1.2, 160, 2070), (1.5, 110, 1300), (2.0, 65, 710), (3.0, 30, 300)],
}


def dye_sizes(pct: float, buffer: str) -> tuple[float, float]:
    """BPB and XC co-migrating sizes: log10(size) interpolated linearly in agarose %."""
    rows = DYE_COMIGRATION[buffer]
    if not rows[0][0] <= pct <= rows[-1][0]:
        raise ValueError(pct)
    for p, b, x in rows:
        if pct == p:  # published rows exactly
            return float(b), float(x)
    for (p0, b0, x0), (p1, b1, x1) in zip(rows, rows[1:]):
        if p0 <= pct <= p1:
            t = (pct - p0) / (p1 - p0)
            lb = math.log10(b0) + t * (math.log10(b1) - math.log10(b0))
            lx = math.log10(x0) + t * (math.log10(x1) - math.log10(x0))
            return 10 ** lb, 10 ** lx
    raise AssertionError


def shape(pct: float, buffer: str, k: float = SHAPE_EXPONENT, b: float = SMALL_DNA_POSITION,
          k_tbe: float = TBE_HIGH_SHAPE_EXPONENT, b_tbe: float = TBE_HIGH_SMALL_DNA_POSITION) -> tuple[float, float]:
    """(exponent, bottom asymptote) of a gel: (k, b) for TAE; for TBE (k, b) up to TBE_RAMP_PERCENT[0],
    (k_tbe, b_tbe) from TBE_RAMP_PERCENT[1], linear in the agarose percentage in between (the end values
    are returned exactly)."""
    if buffer == "TAE":
        return k, b
    lo, hi = TBE_RAMP_PERCENT
    if pct <= lo:
        return k, b
    if pct >= hi:
        return k_tbe, b_tbe
    t = (pct - lo) / (hi - lo)
    return k + t * (k_tbe - k), b + t * (b_tbe - b)


def gel_params(pct: float, buffer: str, k: float = SHAPE_EXPONENT, b: float = SMALL_DNA_POSITION,
               k_tbe: float = TBE_HIGH_SHAPE_EXPONENT, b_tbe: float = TBE_HIGH_SMALL_DNA_POSITION,
               p1: float = BPB_POSITION, p2: float = XC_POSITION) -> dict:
    """Closed-form solution of p(L_bpb) = p1, p(L_xc) = p2 for p(L) = a + D / (1 + (L/Lc)^k), D = b - a,
    with (k, b) from shape().

    With u = (L_bpb/Lc)^k and r = (L_xc/L_bpb)^k the two conditions give
    u = ((b - p1)(r - 1)/(p1 - p2) - 1) / r,  D = (b - p1)(1 + u)/u,  Lc = L_bpb / u^(1/k).
    """
    k, b = shape(pct, buffer, k, b, k_tbe, b_tbe)
    lb, lx = dye_sizes(pct, buffer)
    r = (lx / lb) ** k
    u = ((b - p1) * (r - 1) / (p1 - p2) - 1) / r
    if not u > 0:
        raise ValueError("no solution")
    d = (b - p1) * (1 + u) / u
    return {"a": b - d, "span": d, "lc": lb / u ** (1 / k), "k": k, "b": b, "bpb": lb, "xc": lx}


def position(size: float, pct: float, buffer: str, form: str = "linear", **kw) -> float:
    """Position (0 = well .. 1 = bottom) of DNA of `size` bp in the given form."""
    g = gel_params(pct, buffer, **kw)
    le = size * FORM_SIZE_FACTOR[form]
    return g["a"] + g["span"] / (1 + (le / g["lc"]) ** g["k"])
