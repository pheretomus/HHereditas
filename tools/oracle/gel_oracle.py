#!/usr/bin/env python
"""Differential-test oracle for packages/core/src/gel (ladders + agarose migration model).

Usage (from the repository root; deterministic, safe to re-run):

    tools/oracle/.venv/bin/python tools/oracle/gel_oracle.py

Writes JSON into packages/core/test/oracle/gel/:

  model_reference.json   Positions and derived parameters from the independent Python implementation
                         of the migration model (gel_model.py) on a grid of sizes x agarose % x
                         buffers x DNA forms. The TypeScript implementation must agree to ~1e-12.
  vendor_gels.json       Band positions measured on 20 reference gel photographs published by ladder
                         vendors (gel_vendor_gels.py; measurement: gel_measure_bands.py), the gel
                         conditions stated by the vendor, this script's model-agreement statistics,
                         and the calibration of the four empirical model constants against these
                         photographs (see calibrate(): SHAPE_EXPONENT, SMALL_DNA_POSITION by the original
                         single-shape fit; TBE_HIGH_SHAPE_EXPONENT, TBE_HIGH_SMALL_DNA_POSITION by a
                         constrained fit), with an out-of-sample check (fit without HOLDOUT_IDS).
  pydna_ladders.json     pydna 5.5.16 ladder definitions (GeneRuler 1 kb / 1 kb Plus): sizes, fmol and
                         the relative mobilities (Rf) pydna measured on the GeneRuler 1 kb Plus image.
  digests.json           Biopython 1.88 restriction digests: lambda cI857 ind1 Sam7 / HindIII (the
                         commercial marker: NC_001416.1 plus the mutations NEB documents) and pUC19
                         (fixture M77789) digests used for simulated lanes.

Network: NC_001416.1 is fetched from NCBI once and cached in tools/oracle/gel_cache/ (its SHA-256 is
checked). Nothing else needs the network. No randomness.
"""

from __future__ import annotations

import hashlib
import json
import sys
import urllib.request
from pathlib import Path

import Bio
import numpy as np
import pydna
from Bio import SeqIO
from Bio.Restriction import EcoRI, HaeIII, HindIII, MspI, PvuII
from Bio.Seq import Seq

sys.path.insert(0, str(Path(__file__).resolve().parent))
from gel_model import (  # noqa: E402
    BPB_POSITION,
    BPB_XC_SPEED_RATIO,
    DYE_COMIGRATION,
    FORM_SIZE_FACTOR,
    SHAPE_EXPONENT,
    SMALL_DNA_POSITION,
    TBE_HIGH_SHAPE_EXPONENT,
    TBE_HIGH_SMALL_DNA_POSITION,
    TBE_RAMP_PERCENT,
    gel_params,
    position,
)
from gel_vendor_gels import HOLDOUT_IDS, VENDOR_GELS  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[2]
OUT_DIR = REPO_ROOT / "packages" / "core" / "test" / "oracle" / "gel"
FIXTURES = REPO_ROOT / "packages" / "core" / "test" / "fixtures" / "genbank"
CACHE = Path(__file__).resolve().parent / "gel_cache"


# --------------------------------------------------------------------------------------------
# Model vs vendor photographs, and calibration of the two empirical constants
# --------------------------------------------------------------------------------------------

def agreement(gel: dict, **kw) -> dict:
    """Model vs photograph. With a visible well: positions relative to the well and one free
    run-length scale (vendors stop their runs at different points); residuals in units of the gel
    length implied by that scale. Cropped photograph: free affine map row = alpha*p + beta; residuals
    in units of the band span. Both are dimensionless and comparable."""
    sizes = np.array([b[0] for b in gel["bands"]], float)
    rows = np.array([b[1] for b in gel["bands"]], float)
    p = np.array([position(s, gel["pct"], gel["buffer"], **kw) for s in sizes])
    if gel["origin"] is not None:
        obs = rows - gel["origin"]
        s = float(p @ obs / (p @ p))
        res = (s * p - obs) / s
        fit = {"mode": "absolute", "pixelsPerGelLength": s}
    else:
        A = np.vstack([p, np.ones_like(p)]).T
        coef, *_ = np.linalg.lstsq(A, rows, rcond=None)
        res = (A @ coef - rows) / (rows.max() - rows.min())
        fit = {"mode": "affine", "alpha": float(coef[0]), "beta": float(coef[1])}
    return {**fit, "residuals": res.tolist(), "rms": float(np.sqrt(np.mean(res ** 2))),
            "maxAbs": float(np.max(np.abs(res)))}


#: Physical constraint of the high-% TBE fit: very long DNA must stay inside the gel (spec: positions
#: 0 = well .. 1, long fragments compress near the top), i.e. the top asymptote of every supported gel must
#: be at least this far below the well. Without it the high-% TBE photographs pull the 3 % TBE curve's limit
#: above the well (top asymptote about -0.1).
MIN_TOP_POSITION = 0.005
#: Gels checked for the constraint: both buffers x 0.5-3 % in 0.05 % steps (covers all table rows).
CONSTRAINT_PERCENTS = [round(0.5 + 0.05 * i, 2) for i in range(51)]


def pooled_rms(gels, **kw) -> float:
    res = np.concatenate([agreement(g, **kw)["residuals"] for g in gels])
    return float(np.sqrt(np.mean(res ** 2)))


def min_top(**kw) -> float:
    """Smallest top asymptote (position of very long DNA) over the supported gels; -inf without solution."""
    tops = []
    for buffer in ("TAE", "TBE"):
        for pct in CONSTRAINT_PERCENTS:
            try:
                tops.append(gel_params(pct, buffer, **kw)["a"])
            except ValueError:
                return float("-inf")
    return min(tops)


def nelder_mead(f, x0, step, iters=400, tol=1e-12):
    """Plain deterministic Nelder-Mead (SciPy is not in the oracle venv)."""
    n = len(x0)
    pts = [np.array(x0, float)] + [np.array(x0, float) + np.eye(n)[i] * step[i] for i in range(n)]
    vals = [f(p) for p in pts]
    for _ in range(iters):
        order = np.argsort(vals)
        pts = [pts[i] for i in order]
        vals = [vals[i] for i in order]
        if abs(vals[-1] - vals[0]) < tol:
            break
        c = np.mean(pts[:-1], axis=0)
        xr = c + (c - pts[-1])
        fr = f(xr)
        if fr < vals[0]:
            xe = c + 2 * (c - pts[-1])
            fe = f(xe)
            pts[-1], vals[-1] = (xe, fe) if fe < fr else (xr, fr)
        elif fr < vals[-2]:
            pts[-1], vals[-1] = xr, fr
        else:
            xc = c + 0.5 * (pts[-1] - c)
            fc = f(xc)
            if fc < vals[-1]:
                pts[-1], vals[-1] = xc, fc
            else:
                pts = [pts[0]] + [pts[0] + 0.5 * (p - pts[0]) for p in pts[1:]]
                vals = [vals[0]] + [f(p) for p in pts[1:]]
    i = int(np.argmin(vals))
    return pts[i], vals[i]


def single_shape_fit(gels) -> tuple[np.ndarray, float]:
    """The original calibration: one (exponent, bottom) for every gel, least squares over `gels`."""
    def objective(x):
        return pooled_rms(gels, k=x[0], b=x[1], k_tbe=x[0], b_tbe=x[1])
    return nelder_mead(objective, [1.1, 0.9], [0.05, 0.02])


def tbe_high_fit(gels, k: float, b: float) -> tuple[np.ndarray, float]:
    """Least squares for (TBE_HIGH_SHAPE_EXPONENT, TBE_HIGH_SMALL_DNA_POSITION) with the TAE constants fixed,
    subject to min_top() >= MIN_TOP_POSITION (penalty); Nelder-Mead from three fixed starts."""
    def objective(x):
        top = min_top(k=k, b=b, k_tbe=x[0], b_tbe=x[1])
        if top == float("-inf"):  # no solution for some gel
            return 1e9
        penalty = 0.0 if top >= MIN_TOP_POSITION else 0.01 + 10 * (MIN_TOP_POSITION - top)
        return pooled_rms(gels, k=k, b=b, k_tbe=x[0], b_tbe=x[1]) + penalty

    best = None
    for start in ([k, b], [1.0, 0.88], [1.2, 0.85]):
        x, value = nelder_mead(objective, start, [0.05, 0.02], iters=2000)
        if best is None or value < best[1]:
            best = (x, value)
    x = best[0]
    assert min_top(k=k, b=b, k_tbe=x[0], b_tbe=x[1]) >= MIN_TOP_POSITION - 1e-9
    return x, pooled_rms(gels, k=k, b=b, k_tbe=x[0], b_tbe=x[1])


def calibrate() -> dict:
    """Calibration of the four empirical constants (the model uses them rounded to 0.01):

    1. SHAPE_EXPONENT, SMALL_DNA_POSITION: the original calibration, one curve shape for every gel fitted to
       the photographs that predate review findings F8/F18 (all but HOLDOUT_IDS); kept, so that TAE gels and
       TBE gels up to 1 % are unchanged. For reference, refitting them on the photographs they now describe
       (TAE, and TBE <= 1 %) is reported as `stage1Refit` (not adopted: it compresses the 7-10 kb region of
       1 % TAE gels further than the Thermo photographs show, and no finding concerned TAE).
    2. TBE_HIGH_SHAPE_EXPONENT, TBE_HIGH_SMALL_DNA_POSITION: least squares over all photographs with the
       stage-1 constants fixed, subject to every top asymptote >= MIN_TOP_POSITION.
    Out-of-sample check: stage 2 without the photographs in HOLDOUT_IDS, and its agreement with them."""
    original = [g for g in VENDOR_GELS if g["id"] not in HOLDOUT_IDS]
    s1, s1_rms = single_shape_fit(original)
    assert [round(float(v), 2) for v in s1] == [SHAPE_EXPONENT, SMALL_DNA_POSITION], s1
    k, b = SHAPE_EXPONENT, SMALL_DNA_POSITION
    shared = [g for g in VENDOR_GELS if g["buffer"] == "TAE" or g["pct"] <= TBE_RAMP_PERCENT[0]]
    s1r, s1r_rms = single_shape_fit(shared)
    fitted, fitted_rms = tbe_high_fit(VENDOR_GELS, k, b)
    used = [TBE_HIGH_SHAPE_EXPONENT, TBE_HIGH_SMALL_DNA_POSITION]
    assert [round(float(v), 2) for v in fitted] == used, (fitted, used)
    used_kw = {"k": k, "b": b, "k_tbe": used[0], "b_tbe": used[1]}
    used_rms = pooled_rms(VENDOR_GELS, **used_kw)
    assert used_rms <= 1.02 * fitted_rms, (used_rms, fitted_rms)
    assert min_top(**used_kw) > 0, min_top(**used_kw)
    holdout, holdout_rms = tbe_high_fit(original, k, b)
    holdout_kw = {"k": k, "b": b, "k_tbe": float(holdout[0]), "b_tbe": float(holdout[1])}
    return {
        "model": "TAE: (shapeExponent, smallDnaPosition); TBE: those values up to "
                 f"{TBE_RAMP_PERCENT[0]} %, (tbeHighShapeExponent, tbeHighSmallDnaPosition) from "
                 f"{TBE_RAMP_PERCENT[1]} %, linear in the agarose % in between",
        "tbeRampPercent": list(TBE_RAMP_PERCENT),
        "stage1": {"photos": len(original), "fitted": {"shapeExponent": float(s1[0]), "smallDnaPosition": float(s1[1]),
                                                       "pooledRms": float(s1_rms)},
                   "used": {"shapeExponent": k, "smallDnaPosition": b}},
        "stage1Refit": {"photos": len(shared), "shapeExponent": float(s1r[0]), "smallDnaPosition": float(s1r[1]),
                        "pooledRms": float(s1r_rms), "pooledRmsUsed": pooled_rms(shared, k=k, b=b, k_tbe=k, b_tbe=b),
                        "adopted": False},
        "stage2": {"constraint": {"minTopPosition": MIN_TOP_POSITION,
                                  "percents": [CONSTRAINT_PERCENTS[0], CONSTRAINT_PERCENTS[-1]]},
                   "fitted": {"tbeHighShapeExponent": float(fitted[0]), "tbeHighSmallDnaPosition": float(fitted[1]),
                              "pooledRms": fitted_rms},
                   "used": {"tbeHighShapeExponent": used[0], "tbeHighSmallDnaPosition": used[1],
                            "pooledRms": used_rms, "minTop": min_top(**used_kw)}},
        "holdout": {
            "ids": list(HOLDOUT_IDS),
            "fitted": {"tbeHighShapeExponent": float(holdout[0]), "tbeHighSmallDnaPosition": float(holdout[1]),
                       "pooledRms": holdout_rms},
            "agreement": {g["id"]: {key: v for key, v in agreement(g, **holdout_kw).items() if key in ("mode", "rms", "maxAbs")}
                          for g in VENDOR_GELS if g["id"] in HOLDOUT_IDS},
        },
    }


def best_possible(gel: dict) -> dict:
    """Best agreement that any single dye-calibrated curve of the model family (free exponent k and bottom
    b for this photograph's gel) reaches with the photograph while its top asymptote stays >=
    MIN_TOP_POSITION: a floor under the error of any calibration of this model (Nelder-Mead, three fixed
    starts)."""
    def objective(x):
        if not (0.5 < x[0] < 3.0 and BPB_POSITION < x[1] < 1.0):
            return 1e9
        kw = {"k": x[0], "b": x[1], "k_tbe": x[0], "b_tbe": x[1]}
        try:
            top = gel_params(gel["pct"], gel["buffer"], **kw)["a"]
        except ValueError:
            return 1e9
        penalty = 0.0 if top >= MIN_TOP_POSITION else 0.01 + 10 * (MIN_TOP_POSITION - top)
        return agreement(gel, **kw)["rms"] + penalty

    x, _ = min((nelder_mead(objective, start, [0.05, 0.02], iters=1000)
                for start in ([1.12, 0.90], [0.95, 0.86], [1.40, 0.93])), key=lambda r: r[1])
    kw = {"k": float(x[0]), "b": float(x[1]), "k_tbe": float(x[0]), "b_tbe": float(x[1])}
    return {"shapeExponent": kw["k"], "smallDnaPosition": kw["b"], "rms": agreement(gel, **kw)["rms"],
            "topPosition": gel_params(gel["pct"], gel["buffer"], **kw)["a"]}


# --------------------------------------------------------------------------------------------
# Restriction digests (Biopython)
# --------------------------------------------------------------------------------------------

LAMBDA_ACC = "NC_001416.1"
LAMBDA_SHA256 = "36432a40f602258d19ae7c8152ddbc30390b559f2859c01d7047c77b048c71b3"  # of the upper-case sequence
#: Mutations of the commercial cI857 ind1 Sam7 lambda DNA relative to the reference sequence:
#: NEB FAQ "What are the mutations in your lambda DNA?" (ind1 creates the HindIII site at 37,584).
LAMBDA_MUTATIONS = [(37589, "C", "T", "ind1"), (37742, "C", "T", "cI857"), (43082, "G", "A", "cI857 S7 strain"),
                    (45352, "G", "A", "Sam7")]


def lambda_sequence() -> str:
    CACHE.mkdir(parents=True, exist_ok=True)
    path = CACHE / f"{LAMBDA_ACC}.fasta"
    if not path.exists():
        url = ("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=nuccore&id="
               f"{LAMBDA_ACC}&rettype=fasta&retmode=text")
        with urllib.request.urlopen(url, timeout=60) as resp:
            path.write_bytes(resp.read())
    seq = str(SeqIO.read(path, "fasta").seq).upper()
    assert hashlib.sha256(seq.encode()).hexdigest() == LAMBDA_SHA256, "unexpected NC_001416.1 content"
    return seq


def lambda_hindiii() -> dict:
    ref = lambda_sequence()
    seq = list(ref)
    for pos, frm, to, _ in LAMBDA_MUTATIONS:
        assert seq[pos - 1] == frm, (pos, seq[pos - 1], frm)
        seq[pos - 1] = to
    mutated = Seq("".join(seq))
    fragments = sorted((len(f) for f in HindIII.catalyse(mutated, linear=True)), reverse=True)
    ref_fragments = sorted((len(f) for f in HindIII.catalyse(Seq(ref), linear=True)), reverse=True)
    return {"accession": LAMBDA_ACC, "length": len(ref), "mutations": [list(m) for m in LAMBDA_MUTATIONS],
            "enzyme": "HindIII", "sites1": HindIII.search(mutated, linear=True), "fragments": fragments,
            "referenceFragments": ref_fragments}


def puc19_digests() -> dict:
    rec = SeqIO.read(FIXTURES / "pUC19_M77789.gb", "genbank")
    seq = rec.seq.upper()
    n = len(seq)
    out = {}
    for name, enzymes in {"EcoRI": [EcoRI], "PvuII": [PvuII], "EcoRI+HindIII": [EcoRI, HindIII], "MspI": [MspI],
                          "HaeIII": [HaeIII]}.items():
        # Biopython search(): 1-based position of the first base after each top-strand cut
        cuts = sorted({c for e in enzymes for c in e.search(seq, linear=False)})
        frags = [((cuts[(i + 1) % len(cuts)] - cuts[i]) % n) or n for i in range(len(cuts))]
        assert sum(frags) == n
        out[name] = sorted(frags, reverse=True)
    return {"file": "pUC19_M77789.gb", "id": rec.id, "length": n, "topology": rec.annotations.get("topology"),
            "digests": out}


# --------------------------------------------------------------------------------------------
# pydna ladders
# --------------------------------------------------------------------------------------------

def pydna_ladders() -> dict:
    from pydna.ladders import GeneRuler_1kb, GeneRuler_1kb_plus

    return {
        "GeneRuler_1kb_plus": [{"size": len(f), "fmol": f.n * 1e15, "rf": f.rf} for f in GeneRuler_1kb_plus],
        "GeneRuler_1kb": [{"size": len(f)} for f in GeneRuler_1kb],
    }


# --------------------------------------------------------------------------------------------

SIZES = sorted({int(round(10 ** (e / 8))) for e in range(0, 49)} | {75, 125, 250, 500, 517, 564, 1000, 1500, 2027,
               2322, 2686, 3000, 4361, 5000, 6557, 9416, 10000, 23130, 48502})
PERCENTS = [round(0.5 + 0.05 * i, 2) for i in range(51)] + [0.73, 1.37, 2.71]


def model_reference() -> dict:
    params = {}
    positions = {}
    for buffer in ("TAE", "TBE"):
        for pct in PERCENTS:
            key = f"{buffer}:{pct}"
            params[key] = gel_params(pct, buffer)
            positions[key] = {form: [position(s, pct, buffer, form) for s in SIZES] for form in FORM_SIZE_FACTOR}
    return {"constants": {"bpbPosition": BPB_POSITION, "bpbXcSpeedRatio": BPB_XC_SPEED_RATIO,
                          "shapeExponent": SHAPE_EXPONENT, "smallDnaPosition": SMALL_DNA_POSITION,
                          "tbeHighShapeExponent": TBE_HIGH_SHAPE_EXPONENT,
                          "tbeHighSmallDnaPosition": TBE_HIGH_SMALL_DNA_POSITION,
                          "tbeRampPercent": list(TBE_RAMP_PERCENT),
                          "formSizeFactor": FORM_SIZE_FACTOR, "dyeComigration": DYE_COMIGRATION},
            "sizes": SIZES, "percents": PERCENTS, "params": params, "positions": positions}


def write(name: str, data: dict) -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    text = json.dumps(data, indent=1, sort_keys=True) + "\n"
    (OUT_DIR / name).write_text(text)
    print(f"wrote {name} ({len(text) / 1024:.0f} KiB)")


def main() -> None:
    meta = {"generator": "tools/oracle/gel_oracle.py", "biopython": Bio.__version__, "pydna": pydna.__version__,
            "numpy": np.__version__}
    write("model_reference.json", {"meta": meta, **model_reference()})
    cal = calibrate()
    gels = [{**{k: v for k, v in g.items() if k != "bands"}, "bands": [list(b) for b in g["bands"]],
             "agreement": agreement(g), "bestPossible": best_possible(g)} for g in VENDOR_GELS]
    write("vendor_gels.json", {"meta": meta, "calibration": cal, "gels": gels})
    write("pydna_ladders.json", {"meta": meta, **pydna_ladders()})
    write("digests.json", {"meta": meta, "lambda": lambda_hindiii(), "puc19": puc19_digests()})
    print("calibration:", json.dumps(cal))
    for g in gels:
        a = g["agreement"]
        print(f"  {g['id']:28s} {a['mode']:8s} rms={a['rms']:.4f} max={a['maxAbs']:.4f} "
              f"(best possible {g['bestPossible']['rms']:.4f})")


if __name__ == "__main__":
    main()
