"""
Live oracle for translateFeature (packages/core/src/seq/translate.test.ts): export the CDS features of
a (large) GenBank file, parsed by Biopython, as JSON on stdout, so the Vitest suite can translate
every CDS with the TypeScript engine and compare with NCBI's /translation qualifier.

Used for the 4.6 Mb E. coli genome fixture, which is gitignored; the test skips when the fixture or
the virtualenv is absent. Output per feature: locus_tag, strand, segments in the HHereditas
convention (top-strand join order), partial flags, qualifiers (without /translation) and the
/translation value.

    tools/oracle/.venv/bin/python -I tools/oracle/seqtools_live_cds.py <file.gb>
"""
import json
import sys
import warnings
from pathlib import Path

from Bio import BiopythonWarning, SeqIO

sys.path.insert(0, str(Path(__file__).resolve().parent))  # -I does not add the script directory
from seqtools_oracle import to_segments  # noqa: E402

warnings.simplefilter("ignore", BiopythonWarning)


def main():
    rec = SeqIO.read(sys.argv[1], "genbank")
    features = []
    skipped = 0
    for f in rec.features:
        if f.type != "CDS" or f.location is None:
            continue
        conv = to_segments(f.location)
        if conv is None:
            skipped += 1
            continue
        strand, segs, ps, pe = conv
        features.append(
            {
                "locusTag": f.qualifiers.get("locus_tag", ["?"])[0],
                "strand": strand,
                "segments": segs,
                "partialStart": ps,
                "partialEnd": pe,
                "qualifiers": [
                    {"key": k, "value": v} for k, vs in f.qualifiers.items() if k != "translation" for v in vs
                ],
                "translation": f.qualifiers.get("translation", [None])[0],
            }
        )
    json.dump(
        {
            "id": rec.id,
            "length": len(rec.seq),
            "topology": rec.annotations.get("topology", "linear"),
            "skipped": skipped,
            "features": features,
        },
        sys.stdout,
        separators=(",", ":"),
    )


if __name__ == "__main__":
    main()
