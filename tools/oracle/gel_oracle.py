#!/usr/bin/env python
"""Differential-test oracle for packages/core/src/gel (ladders + agarose migration model).

Usage (from the repository root; deterministic, safe to re-run):

    tools/oracle/.venv/bin/python tools/oracle/gel_oracle.py

Writes JSON into packages/core/test/oracle/gel/:

  model_reference.json   Positions and derived parameters from the independent Python implementation
                         of the migration model (gel_model.py) on a grid of sizes x agarose % x
                         buffers x DNA forms. The TypeScript implementation must agree to ~1e-12.
  vendor_gels.json       Band positions measured on 17 reference gel photographs published by ladder
                         vendors (gel_vendor_gels.py; measurement: gel_measure_bands.py), the gel
                         conditions stated by the vendor, this script's model-agreement statistics,
                         and the calibration of the two empirical model constants (SHAPE_EXPONENT,
                         SMALL_DNA_POSITION) against these photographs.
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
    gel_params,
    position,
)
from gel_vendor_gels import VENDOR_GELS  # noqa: E402

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


def pooled_rms(k: float, b: float) -> float:
    res = np.concatenate([agreement(g, k=k, b=b)["residuals"] for g in VENDOR_GELS])
    return float(np.sqrt(np.mean(res ** 2)))


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


def calibrate() -> dict:
    """Least-squares fit of (SHAPE_EXPONENT, SMALL_DNA_POSITION) to all photographs; the model uses
    the rounded values, which must be (nearly) as good as the optimum."""
    best, best_rms = nelder_mead(lambda x: pooled_rms(x[0], x[1]), [1.1, 0.9], [0.05, 0.02])
    used = pooled_rms(SHAPE_EXPONENT, SMALL_DNA_POSITION)
    assert used <= 1.02 * best_rms, (used, best_rms)
    return {"fitted": {"shapeExponent": float(best[0]), "smallDnaPosition": float(best[1]), "pooledRms": best_rms},
            "used": {"shapeExponent": SHAPE_EXPONENT, "smallDnaPosition": SMALL_DNA_POSITION, "pooledRms": used}}


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
             "agreement": agreement(g)} for g in VENDOR_GELS]
    write("vendor_gels.json", {"meta": meta, "calibration": cal, "gels": gels})
    write("pydna_ladders.json", {"meta": meta, **pydna_ladders()})
    write("digests.json", {"meta": meta, "lambda": lambda_hindiii(), "puc19": puc19_digests()})
    print("calibration:", json.dumps(cal))
    for g in gels:
        a = g["agreement"]
        print(f"  {g['id']:28s} {a['mode']:8s} rms={a['rms']:.4f} max={a['maxAbs']:.4f}")


if __name__ == "__main__":
    main()
