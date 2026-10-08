#!/usr/bin/env python3
"""Biopython reference ("oracle") for the HHereditas GenBank reader/writer.

Usage
-----
    genbank_oracle.py                 regenerate packages/core/test/oracle/genbank/biopython/*.json
    genbank_oracle.py --dump F [F..]  print {path: dump} as JSON on stdout (used by the live-oracle
                                      Vitest test, which feeds it files written by writeGenbank)

For every GenBank fixture the JSON holds Biopython's parse: per record the name, description,
sequence (or SHA-1 + length when long), topology, molecule type, header annotations and every
feature with its location parts (0-based half-open start/end, strand, remote reference, fuzzy
position kinds) and its qualifiers flattened in Biopython's dict order as [key, value] pairs.
For the (gitignored) 11.7 MB E. coli genome only counts, checksums and compact per-feature
summaries are stored, so every JSON file stays well under 2 MB.

The output is deterministic: no timestamps, sorted file lists, stable key order.
Biopython version used to generate the committed files: see the "biopython" field.
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
import warnings

import Bio
from Bio import SeqIO
from Bio.Seq import UndefinedSequenceError
from Bio.SeqFeature import (
    AfterPosition,
    BeforePosition,
    BetweenPosition,
    ExactPosition,
    OneOfPosition,
    UncertainPosition,
    UnknownPosition,
    WithinPosition,
)

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CORE = os.path.join(ROOT, "packages", "core")
FIXTURES = os.path.join(CORE, "test", "fixtures", "genbank")
LARGE = os.path.join(CORE, "test", "fixtures", "large", "ecoli_U00096.3.gb")
OUT_DIR = os.path.join(CORE, "test", "oracle", "genbank", "biopython")

# Sequences longer than this are stored as SHA-1 + length only.
MAX_INLINE_SEQ = 200_000


def position_kind(pos) -> str:
    """Name of the Biopython position class (order matters: subclasses first)."""
    if isinstance(pos, BeforePosition):
        return "before"
    if isinstance(pos, AfterPosition):
        return "after"
    if isinstance(pos, WithinPosition):
        return "within"
    if isinstance(pos, OneOfPosition):
        return "oneof"
    if isinstance(pos, BetweenPosition):
        return "between"
    if isinstance(pos, UnknownPosition):
        return "unknown"
    if isinstance(pos, UncertainPosition):
        return "uncertain"
    if isinstance(pos, ExactPosition):
        return "exact"
    return type(pos).__name__


def dump_location(loc):
    if loc is None:
        return None
    parts = []
    for p in loc.parts:
        parts.append(
            {
                "start": int(p.start),
                "end": int(p.end),
                "strand": p.strand,
                "ref": p.ref,
                "startKind": position_kind(p.start),
                "endKind": position_kind(p.end),
            }
        )
    return {
        "operator": getattr(loc, "operator", None),
        "strand": loc.strand,
        "parts": parts,
    }


def flat_qualifiers(feature):
    out = []
    for key, values in feature.qualifiers.items():
        if isinstance(values, (list, tuple)):
            for v in values:
                out.append([key, v])
        else:
            out.append([key, values])
    return out


def sha1_hex(text: str) -> str:
    return hashlib.sha1(text.encode("utf-8")).hexdigest()


def qualifier_digest(qualifiers) -> str:
    """SHA-1 (first 12 hex digits) of the flattened qualifiers, joined with \\x01 / \\x02."""
    return sha1_hex("\x02".join(k + "\x01" + ("" if v is None else v) for k, v in qualifiers))[:12]


def dump_reference(ref):
    return {
        "location": [[int(l.start), int(l.end)] for l in (ref.location or [])],
        "authors": ref.authors,
        "consrtm": ref.consrtm,
        "title": ref.title,
        "journal": ref.journal,
        "medline": ref.medline_id,
        "pubmed": ref.pubmed_id,
        "comment": ref.comment,
    }


def record_sequence(rec):
    try:
        return str(rec.seq)
    except UndefinedSequenceError:
        return None


def dump_record(rec, compact=False):
    a = rec.annotations
    seq = record_sequence(rec)
    out = {
        "name": rec.name,
        "id": rec.id,
        "description": rec.description,
        "seqDefined": seq is not None,
        "seqLength": len(rec.seq),
        "seqSha1": sha1_hex(seq) if seq is not None else None,
        "seq": seq if (seq is not None and len(seq) <= MAX_INLINE_SEQ and not compact) else None,
        "topology": a.get("topology"),
        "moleculeType": a.get("molecule_type"),
        "division": a.get("data_file_division"),
        "date": a.get("date"),
        "accessions": a.get("accessions"),
        "sequenceVersion": a.get("sequence_version"),
        "gi": a.get("gi"),
        "keywords": a.get("keywords"),
        "source": a.get("source"),
        "organism": a.get("organism"),
        "taxonomy": a.get("taxonomy"),
        "comment": a.get("comment"),
        "structuredComment": a.get("structured_comment"),
        "dbxrefs": list(rec.dbxrefs),
        "references": [dump_reference(r) for r in a.get("references", [])],
        "contig": a.get("contig"),
        "segment": a.get("segment"),
        "dbSource": a.get("db_source"),
        "featureCount": len(rec.features),
    }
    if compact:
        type_counts = {}
        feats = []
        for f in rec.features:
            type_counts[f.type] = type_counts.get(f.type, 0) + 1
            quals = flat_qualifiers(f)
            feats.append([f.type, compact_location(f.location), qualifier_digest(quals), len(quals)])
        out["typeCounts"] = dict(sorted(type_counts.items()))
        out["compactFeatures"] = feats
    else:
        out["features"] = [
            {
                "type": f.type,
                "location": dump_location(f.location),
                "qualifiers": flat_qualifiers(f),
            }
            for f in rec.features
        ]
    return out


def compact_location(loc) -> str:
    """Compact text form of a location, e.g. '<0-100+;200->300+' (mirrored in the Vitest test)."""
    if loc is None:
        return "None"
    texts = []
    for p in loc.parts:
        sk = position_kind(p.start)
        ek = position_kind(p.end)
        s = ("<" if sk == "before" else ">" if sk == "after" else "") + str(int(p.start))
        e = ("<" if ek == "before" else ">" if ek == "after" else "") + str(int(p.end))
        strand = "+" if p.strand == 1 else "-" if p.strand == -1 else "."
        ref = "@" + p.ref if p.ref else ""
        texts.append(f"{s}-{e}{strand}{ref}")
    return ";".join(texts)


def dump_file(path, compact=False):
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        try:
            with open(path, encoding="utf-8", newline=None) as handle:
                records = [dump_record(r, compact) for r in SeqIO.parse(handle, "genbank")]
            error = None
        except Exception as exc:  # Biopython raises on some malformed fixtures
            records = []
            error = f"{type(exc).__name__}: {exc}"
    messages = [str(w.message) for w in caught if not issubclass(w.category, ResourceWarning)]
    return {
        "file": os.path.basename(path),
        "biopython": Bio.__version__,
        "error": error,
        "warnings": messages,
        "records": records,
    }


def write_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as handle:
        json.dump(data, handle, indent=1, ensure_ascii=False, sort_keys=False)
        handle.write("\n")
    size = os.path.getsize(path)
    if size > 2_000_000:
        raise SystemExit(f"{path} is {size} bytes (> 2 MB)")
    return size


def regenerate():
    names = sorted(n for n in os.listdir(FIXTURES) if not n.startswith("."))
    for name in names:
        data = dump_file(os.path.join(FIXTURES, name))
        size = write_json(os.path.join(OUT_DIR, name + ".json"), data)
        print(f"{name}: {len(data['records'])} record(s), {size} bytes", file=sys.stderr)
    if os.path.exists(LARGE):
        data = dump_file(LARGE, compact=True)
        size = write_json(os.path.join(OUT_DIR, "large_" + os.path.basename(LARGE) + ".json"), data)
        print(f"{os.path.basename(LARGE)}: compact summary, {size} bytes", file=sys.stderr)
    else:
        print("large E. coli fixture absent: its summary was not regenerated", file=sys.stderr)


def main(argv):
    if len(argv) >= 1 and argv[0] == "--dump":
        result = {path: dump_file(path) for path in argv[1:]}
        json.dump(result, sys.stdout, ensure_ascii=False)
        return
    regenerate()


if __name__ == "__main__":
    main(sys.argv[1:])
