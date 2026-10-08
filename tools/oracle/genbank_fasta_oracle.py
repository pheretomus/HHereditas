#!/usr/bin/env python3
"""Biopython reference for the HHereditas FASTA reader/writer (module key: genbank).

Usage
-----
    genbank_fasta_oracle.py                 regenerate packages/core/test/oracle/genbank/fasta_cases.json
    genbank_fasta_oracle.py --dump F [F..]  print {path: [records]} as JSON (used by the live test)

The cases are random FASTA texts (fixed seed, so the file is reproducible) mixing upper/lower
case DNA, RNA and protein residues, ragged line widths, blank lines, ';' comment lines,
CRLF line endings, empty records, tabs and spaces inside sequence lines, and NCBI
[topology=...] modifiers. Each case stores the text and Biopython's parse with the
"fasta-pearson" format (comments allowed): id, description (the whole title) and sequence.
Digits and gap characters are not generated because Biopython keeps them in the sequence
while our reader removes them (documented deviation, unit-tested separately).
"""

from __future__ import annotations

import io
import json
import os
import random
import sys

import Bio
from Bio import SeqIO

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(ROOT, "packages", "core", "test", "oracle", "genbank", "fasta_cases.json")

SEED = 20261008
DNA = "ACGTRYSWKMBDHVN"
RNA = "ACGURYSWKMBDHVN"
PROTEIN = "ACDEFGHIKLMNPQRSTVWYXBZJUO"
WORDS = ["plasmid", "pUC19", "GFP", "promoter", "(partial)", "x=1", "a|b", "seq-7", "100%", "ß-gal", "[note]"]


def parse(text: str):
    return [
        {"id": r.id, "description": r.description, "seq": str(r.seq)}
        for r in SeqIO.parse(io.StringIO(text, newline=""), "fasta-pearson")
    ]


def random_sequence(rng: random.Random) -> str:
    kind = rng.choice(["dna", "dna", "rna", "protein"])
    n = rng.choice([0, 1, 5, 59, 60, 61, 70, 71, 140, 333])
    if kind == "dna":
        seq = "".join(rng.choice("ACGT" if rng.random() < 0.8 else DNA) for _ in range(n))
    elif kind == "rna":
        seq = "".join(rng.choice("ACGU") for _ in range(n))
    else:
        # always include a protein-only letter so the type is unambiguous
        seq = "".join(rng.choice(PROTEIN) for _ in range(n)) + ("L" if n else "")
        if rng.random() < 0.3 and seq:
            seq += "*"
    if rng.random() < 0.3:
        seq = seq.lower()
    return seq


def random_header(rng: random.Random, index: int) -> str:
    name = rng.choice(["seq", "pX", "contig_", "gi|123|ref|NC_1.1|", "chr"]) + str(index)
    words = [rng.choice(WORDS) for _ in range(rng.randrange(0, 5))]
    if rng.random() < 0.3:
        words.insert(rng.randrange(0, len(words) + 1), rng.choice(["[topology=circular]", "[topology=linear]", "[Topology=Circular]"]))
    header = " ".join([name] + words)
    if rng.random() < 0.2:
        header = " " + header + "  "
    return header


def random_case(rng: random.Random):
    parts = []
    if rng.random() < 0.3:
        parts.append(";" + rng.choice(["comment", " another comment", ""]))
    for index in range(rng.randrange(1, 5)):
        parts.append(">" + random_header(rng, index))
        seq = random_sequence(rng)
        width = rng.choice([10, 60, 70, 80, 1000])
        for start in range(0, len(seq), width):
            line = seq[start : start + width]
            if rng.random() < 0.1:
                line = line[: len(line) // 2] + rng.choice([" ", "\t", "  "]) + line[len(line) // 2 :]
            parts.append(line)
            if rng.random() < 0.05:
                parts.append("")
            if rng.random() < 0.05:
                parts.append(";inner comment")
    newline = "\r\n" if rng.random() < 0.2 else "\n"
    text = newline.join(parts) + (newline if rng.random() < 0.8 else "")
    return {"text": text, "records": parse(text)}


def regenerate():
    rng = random.Random(SEED)
    cases = [random_case(rng) for _ in range(300)]
    data = {"biopython": Bio.__version__, "format": "fasta-pearson", "seed": SEED, "cases": cases}
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8", newline="\n") as handle:
        json.dump(data, handle, indent=1, ensure_ascii=False)
        handle.write("\n")
    size = os.path.getsize(OUT)
    if size > 2_000_000:
        raise SystemExit(f"{OUT} is {size} bytes (> 2 MB)")
    print(f"{len(cases)} cases, {size} bytes", file=sys.stderr)


def main(argv):
    if argv[:1] == ["--dump"]:
        out = {}
        for path in argv[1:]:
            with open(path, encoding="utf-8", newline="") as handle:
                out[path] = parse(handle.read())
        json.dump(out, sys.stdout, ensure_ascii=False)
        return
    regenerate()


if __name__ == "__main__":
    main(sys.argv[1:])
