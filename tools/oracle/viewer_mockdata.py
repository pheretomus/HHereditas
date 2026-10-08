"""
Generate realistic mock data for developing the viewer components before the
@hhereditas/core parsers/enzyme engine are wired in.

Converts a few plasmid fixtures (parsed with Biopython) into the SeqRecord JSON
shape of packages/core/src/types.ts, plus approximate EnzymeSite lists for common
enzymes. This data is for visual development only; correctness of enzyme sites is
verified in packages/core, not here.

Run: tools/oracle/.venv/bin/python -I tools/oracle/viewer_mockdata.py
"""
import json
import re
from pathlib import Path

from Bio import SeqIO
from Bio.Restriction import Restriction as R
from Bio.SeqFeature import CompoundLocation

ROOT = Path(__file__).resolve().parents[2]
FIX = ROOT / "packages/core/test/fixtures"
OUT = ROOT / "packages/viewer/src/__fixtures__"

LABEL_PRIORITY = ["label", "gene", "product", "locus_tag", "standard_name", "protein_id", "name", "note"]

COMMON = [
    "EcoRI", "BamHI", "HindIII", "XhoI", "XbaI", "NotI", "NdeI", "NcoI", "KpnI", "SacI", "SalI", "PstI",
    "SphI", "SmaI", "EcoRV", "BglII", "NheI", "SpeI", "AgeI", "MluI", "ApaI", "ClaI", "AscI", "PacI",
    "SbfI", "BsaI", "BsmBI", "BbsI", "SapI", "NsiI", "AvrII", "MfeI", "XmaI", "HpaI", "ScaI", "StuI",
    "PmeI", "SwaI", "FseI", "DraI", "SspI", "AatII", "BsrGI", "PvuI", "PvuII", "AflII", "BstBI",
]

IUPAC = {
    "A": "A", "C": "C", "G": "G", "T": "T", "R": "[AG]", "Y": "[CT]", "S": "[CG]", "W": "[AT]",
    "K": "[GT]", "M": "[AC]", "B": "[CGT]", "D": "[AGT]", "H": "[ACT]", "V": "[ACG]", "N": "[ACGT]",
}
COMP = str.maketrans("ACGTRYSWKMBDHVN", "TGCAYRSWMKVHDBN")


def revcomp(s):
    return s.translate(COMP)[::-1]


def label_of(ftype, quals):
    for k in LABEL_PRIORITY:
        for key, value in quals:
            if key == k and value:
                v = " ".join(value.split())
                return v if k != "note" or len(v) <= 40 else v[:39] + "…"
    return ftype


def segments_of(loc, length, circular):
    parts = list(loc.parts) if isinstance(loc, CompoundLocation) else [loc]
    strand = loc.strand if loc.strand in (1, -1) else 0
    segs = [{"start": int(p.start), "end": int(p.end)} for p in parts]
    if strand == -1:
        segs = list(reversed(segs))  # Biopython lists minus-strand parts 5'->3' on the minus strand
    merged = []
    for s in segs:
        if circular and merged and merged[-1]["end"] == length and s["start"] == 0:
            merged[-1] = {"start": merged[-1]["start"], "end": length + s["end"]}
        else:
            merged.append(s)
    return strand, merged


def record_json(path, fmt, rid):
    rec = SeqIO.read(path, fmt)
    seq = str(rec.seq).upper()
    circular = rec.annotations.get("topology", "linear") == "circular"
    features = []
    for i, f in enumerate(rec.features):
        if f.type == "source" or f.location is None:
            continue
        quals = [(k, v) for k, vs in f.qualifiers.items() for v in (vs if isinstance(vs, list) else [vs])]
        strand, segs = segments_of(f.location, len(seq), circular)
        features.append({
            "id": f"{rid}_f{i}",
            "type": f.type,
            "name": label_of(f.type, quals),
            "strand": strand,
            "segments": segs,
            "qualifiers": [{"key": k, "value": v} for k, v in quals],
        })
    return {
        "id": rid,
        "name": rec.name if rec.name not in ("Exported", "<unknown name>") else Path(path).stem,
        "description": rec.description,
        "seq": seq,
        "topology": "circular" if circular else "linear",
        "molecule": "DNA",
        "features": features,
        "primers": [],
        "meta": {"sourceFormat": "genbank"},
    }


def enzyme_sites(seq, circular):
    L = len(seq)
    sites = []
    for name in COMMON:
        enz = getattr(R, name)
        site = str(enz.site)
        n = len(site)
        # top-strand cut offset relative to site start, bottom-strand cut offset (gap positions)
        top = enz.fst5
        bottom = n + enz.fst3
        if enz.fst5 is None:
            continue
        target = seq + (seq[: n - 1] if circular else "")
        pats = [(1, site)]
        if revcomp(site) != site:
            pats.append((-1, revcomp(site)))
        for strand, pat in pats:
            rx = re.compile("(?=(" + "".join(IUPAC[c] for c in pat) + "))")
            for m in rx.finditer(target):
                p = m.start()
                if p >= L:
                    continue
                if strand == 1:
                    ct, cb = p + top, p + bottom
                else:
                    ct, cb = p + n - bottom, p + n - top
                cuts = []
                if circular:
                    cuts.append({"top": ct % L, "bottom": cb % L})
                elif 0 < ct < L and 0 < cb < L:
                    cuts.append({"top": ct, "bottom": cb})
                sites.append({"enzyme": name, "range": {"start": p, "end": p + n}, "strand": strand, "cuts": cuts})
    sites.sort(key=lambda s: (s["range"]["start"], s["enzyme"]))
    return sites


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    jobs = [
        ("pFA6a-kanMX6", FIX / "genbank/addgene-plasmid-39296-sequence-49545.gbk", "genbank"),
        ("pBAD30", FIX / "genbank/pBAD30.gb", "genbank"),
        ("pBR322", FIX / "genbank/pBR322_J01749.gb", "genbank"),
        ("addgene-11664-linear", FIX / "genbank/addgene-plasmid-11664-sequence-180430.gbk", "genbank"),
    ]
    index = []
    for rid, path, fmt in jobs:
        rec = record_json(path, fmt, rid)
        rec["name"] = rid
        data = {"record": rec, "enzymeSites": enzyme_sites(rec["seq"], rec["topology"] == "circular")}
        (OUT / f"{rid}.json").write_text(json.dumps(data, indent=1))
        index.append(rid)
        print(rid, len(rec["seq"]), rec["topology"], len(rec["features"]), "features", len(data["enzymeSites"]), "sites")


if __name__ == "__main__":
    main()
