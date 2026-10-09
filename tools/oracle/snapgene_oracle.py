#!/usr/bin/env python3
"""Reference ("oracle") data for the HHereditas SnapGene reader/writer (packages/core/src/io/snapgene*.ts).

Usage
-----
    snapgene_oracle.py                  regenerate packages/core/test/oracle/snapgene/
                                        (fixtures.json, cases/*.dna + cases.json, random.json, html.json)
    snapgene_oracle.py --dump F [F..]   print {path: dump} as JSON on stdout; used by the live-oracle
                                        Vitest test, which feeds it files written by writeSnapGene

Every file is described by three independent views:

  "biopython"  Biopython's SnapGene parse (Bio.SeqIO "snapgene"): sequence, topology, description,
               annotations and every feature with its location parts (0-based, half-open, strand) and
               qualifiers in Biopython's dict order; or {"error": ...} when Biopython rejects the file.
  "raw"        The packets and XML as read by Python's own tools (struct, expat/minidom).
  "expected"   What HHereditas should read, computed here from the raw data by an implementation of the
               documented HHereditas mapping (snapgene*.ts module docs) written independently of the
               TypeScript code: XML via expat/minidom instead of fast-xml-parser, HTML rich text via
               html.parser instead of regular expressions, UTF-8 via Python's codec.

"cases" are handmade edge-case files and "random" a seeded corpus, both produced by the small packet
writer in this file (independent of the TypeScript writer). For random files the generator's own ground
truth is asserted against "expected" here, before anything is written.

The output is deterministic: fixed seeds, sorted file lists, no timestamps.
"""

from __future__ import annotations

import base64
import html as html_lib
import html.entities
import io
import json
import os
import random
import re
import struct
import sys
import warnings
from html.parser import HTMLParser
from xml.dom import minidom

import Bio
from Bio import SeqIO
from Bio.Seq import Seq
from Bio.SeqIO import SnapGeneIO
from Bio.SeqRecord import SeqRecord

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CORE = os.path.join(ROOT, "packages", "core")
FIXTURES = os.path.join(CORE, "test", "fixtures", "snapgene")
OUT_DIR = os.path.join(CORE, "test", "oracle", "snapgene")
CASES_DIR = os.path.join(OUT_DIR, "cases")

# Excerpts of two files of SnapGene's plasmid library (snapgene.com, "TA and GC cloning vectors"):
# lacZα has a stale codon_start=1 next to readingFrame="+-2"; SnapGene's /translation is frame 2.
LIBRARY_EXCERPTS = {
    # T-Vector pMD20, bases 1-200.
    "library_pmd20_lacz": (
        "AATCGGATCCCCGGGTACCGAGCTCGAATTCACTGGCCGTCGTTTTACAACGTCGTGACTGGGAAAACCCTGGCGTTACCCAACTTAATCGCCTTGCAGCACATCCCCC"
        "TTTCGCCAGCTGGCGTAATAGCGAAGAGGCCCGCACCGATCGCCCTTCCCAACAGTTGCGCAGCCTGAATGGCGAATGGCCCTGATGCGGT",
        '<Feature recentID="0" name="lacZα" directionality="1" type="CDS" allowSegmentOverlaps="0" readingFrame="2" '
        'consecutiveTranslationNumbering="1" hitsStopCodon="1"><Segment range="2-194" color="#993366" type="standard" translated="1"/>'
        '<Q name="codon_start"><V int="1"/></Q><Q name="transl_table"><V int="1"/></Q>'
        '<Q name="translation"><V text="SDPRVPSSNSLAVVLQRRDWENPGVTQLNRLAAHPPFASWRNSEEARTDRPSQQLRSLNGEWP*"/></Q></Feature>',
    ),
    # T-Vector pMD19 (Simple), bases 2401-2694 (range 2408-2693 in the file).
    "library_pmd19_lacz": (
        "GGCTTAACTATGCGGCATCAGAGCAGATTGTACTGAGAGTGCACCATATGCGGTGTGAAATACCGCACAGATGCGTAAGGAGAAAATACCGCATCAGGCGCCATTCGCCATTCA"
        "GGCTGCGCAACTGTTGGGAAGGGCGATCGGTGCGGGCCTCTTCGCTATTACGCCAGCTGGCGAAAGGGGGATGTGCTGCAAGGCGATTAAGTTGGGTAACGCCAGGGTTTTCCC"
        "AGTCACGACGTTGTAAAACGACGGCCAGTGAATTAGAACTCGGTACGCGCGGATCTTCCAGAGATT",
        '<Feature recentID="8" name="lacZα" directionality="2" type="CDS" swappedSegmentNumbering="1" allowSegmentOverlaps="0" '
        'readingFrame="-2" consecutiveTranslationNumbering="1" hitsStopCodon="1"><Segment range="8-293" color="#993366" type="standard" translated="1"/>'
        '<Q name="codon_start"><V int="1"/></Q><Q name="transl_table"><V int="1"/></Q>'
        '<Q name="translation"><V text="SLEDPRVPSSNSLAVVLQRRDWENPGVTQLNRLAAHPPFASWRNSEEARTDRPSQQLRSLNGEWRLMRYFLLTHLCGISHRIWCTLSTICSDAA*"/></Q></Feature>',
    ),
}

RANDOM_SEED = 20261008
RANDOM_COUNT = 120

IUPAC = "ACGTRYSWKMBDHVN"
LABEL_PRIORITY = [
    "label", "gene", "product", "locus_tag", "standard_name", "protein_id", "name", "allele", "bound_moiety",
    "mobile_element_type", "rpt_family", "regulatory_class", "ncRNA_class", "operon", "note",
]

# ----------------------------------------------------------------------------------------------
# Packets
# ----------------------------------------------------------------------------------------------


def iter_packets(data: bytes):
    """Split a file into (type, offset, payload) packets; stop at the first truncated one."""
    packets = []
    truncated = None
    i = 0
    while i < len(data):
        if len(data) - i < 5:
            truncated = {"type": data[i], "offset": i}
            break
        ptype = data[i]
        (length,) = struct.unpack(">I", data[i + 1 : i + 5])
        if length > len(data) - i - 5:
            truncated = {"type": ptype, "offset": i}
            break
        packets.append((ptype, i, data[i + 5 : i + 5 + length]))
        i += 5 + length
    return packets, truncated


def packet(ptype: int, payload: bytes) -> bytes:
    return struct.pack(">BI", ptype, len(payload)) + payload


def cookie_packet(seq_type: int = 1, export_version: int = 15, import_version: int = 19) -> bytes:
    return packet(0x09, b"SnapGene" + struct.pack(">HHH", seq_type, export_version, import_version))


# ----------------------------------------------------------------------------------------------
# Biopython
# ----------------------------------------------------------------------------------------------


def biopython_feature(feature) -> dict:
    return {
        "type": feature.type,
        "parts": [[int(p.start), int(p.end), p.strand] for p in feature.location.parts],
        "qualifiers": [[key, list(values)] for key, values in feature.qualifiers.items()],
    }


def biopython_packet_features(payload: bytes, length: int) -> dict:
    """Biopython's own features-packet parser applied to one packet (other packets cannot make it fail)."""
    record = SeqRecord(Seq("N" * length))
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            SnapGeneIO._parse_features_packet(len(payload), payload, record)  # noqa: SLF001
    except Exception as exc:  # noqa: BLE001
        return {"error": f"{type(exc).__name__}: {exc}"}
    return {"features": [biopython_feature(f) for f in record.features]}


def biopython_dump(data: bytes) -> dict:
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            record = SeqIO.read(io.BytesIO(data), "snapgene")
    except Exception as exc:  # noqa: BLE001 - any rejection is data for the comparison
        return {"error": f"{type(exc).__name__}: {exc}"}
    features = [biopython_feature(f) for f in record.features]
    annotations = record.annotations
    return {
        "id": record.id,
        "name": record.name,
        "description": record.description,
        "seq": str(record.seq),
        "topology": annotations.get("topology"),
        "division": annotations.get("data_file_division"),
        "date": annotations["date"].strftime("%Y-%m-%d") if "date" in annotations else None,
        "features": features,
    }


# ----------------------------------------------------------------------------------------------
# Text: rich text (HTML) rendering with html.parser
# ----------------------------------------------------------------------------------------------

HTML_MARKUP = re.compile(
    r"<!--.*?-->|<!doctype\s+html\b|</?(?:html|head|body|qt|p|br|div|span|font|b|i|u|s|em|strong|sub|sup|small"
    r"|big|a|ul|ol|li|table|tr|td|th|h[1-6]|pre|code|tt|blockquote|hr|img|center)(?:\s[^<>]*)?/?>",
    re.I | re.S,
)
BLOCK_TAGS = {
    "p", "div", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "dl", "dt", "dd", "table",
    "blockquote", "pre", "hr", "center", "address",
}
SKIP_TAGS = {"head", "style", "script", "title"}
SOFT, HARD = "\x01", "\x02"


def looks_like_html(value: str) -> bool:
    return "<" in value and HTML_MARKUP.search(value) is not None


class _HtmlText(HTMLParser):
    """Collects rendered text; block boundaries become SOFT, <br> becomes HARD."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.skip = 0

    def _tag(self, tag: str, start: bool) -> None:
        if tag in SKIP_TAGS:
            self.skip = self.skip + 1 if start else max(0, self.skip - 1)
            return
        if self.skip:
            return
        if tag == "br" and start:
            self.parts.append(HARD)
        elif tag in BLOCK_TAGS:
            self.parts.append(SOFT)

    def handle_starttag(self, tag, attrs):  # noqa: ARG002
        self._tag(tag, True)

    def handle_startendtag(self, tag, attrs):  # noqa: ARG002
        if tag not in SKIP_TAGS:
            self._tag(tag, True)

    def handle_endtag(self, tag):
        self._tag(tag, False)

    def handle_data(self, data):
        if not self.skip:
            self.parts.append(data)


def html_to_text(value: str, layout: str) -> str:
    parser = _HtmlText()
    parser.feed(value.replace(SOFT, "").replace(HARD, ""))
    parser.close()
    text = re.sub(r"[ \t\n\r\f]+", " ", "".join(parser.parts)).replace("\xa0", " ")
    if layout == "line":
        return re.sub(r"[\s\x01\x02]+", " ", text).strip()
    text = text.replace(HARD, "\n")
    text = re.sub(r"\x01(?:[ \t]*\x01)*", SOFT, text)
    text = re.sub(r"(^|\n)[ \t]*\x01", r"\1", text)
    text = text.replace(SOFT, "\n")
    lines = [re.sub(r"[^\S\n]+", " ", line).strip() for line in text.split("\n")]
    while lines and lines[0] == "":
        lines.pop(0)
    while lines and lines[-1] == "":
        lines.pop()
    return "\n".join(lines)


def render(value: str | None, layout: str = "line") -> str:
    """Documented HHereditas rule for a SnapGene text value (richTextToPlain)."""
    if value is None:
        return ""
    if looks_like_html(value):
        return html_to_text(value, layout)
    if layout == "line":
        return re.sub(r"\r\n|\r|\n", " ", value).strip()
    return re.sub(r"\r\n?", "\n", value).strip()


# ----------------------------------------------------------------------------------------------
# XML (minidom / expat)
# ----------------------------------------------------------------------------------------------


def decode_utf8(payload: bytes) -> str:
    if payload.startswith(b"\xef\xbb\xbf"):
        payload = payload[3:]
    return payload.decode("utf-8", errors="replace")


def parse_xml(payload: bytes):
    try:
        return minidom.parseString(decode_utf8(payload)).documentElement
    except Exception:  # noqa: BLE001
        return None


def children(element, name: str | None = None):
    return [c for c in element.childNodes if c.nodeType == c.ELEMENT_NODE and (name is None or c.tagName == name)]


def element_text(element) -> str:
    return "".join(c.data for c in element.childNodes if c.nodeType in (c.TEXT_NODE, c.CDATA_SECTION_NODE))


def attrs(element) -> dict:
    return {element.attributes.item(i).name: element.attributes.item(i).value for i in range(element.attributes.length)}


def raw_dump(data: bytes) -> dict:
    """Packets and XML as Python's own tools read them."""
    packets, truncated = iter_packets(data)
    out: dict = {"packets": [[t, o, len(p)] for t, o, p in packets], "truncated": truncated, "xml": []}
    for ptype, offset, payload in packets:
        if ptype == 0x09:
            out["cookie"] = list(struct.unpack(">HHH", payload[8:14])) if len(payload) >= 14 else None
        elif ptype == 0x00 and "dna" not in out and payload:
            out["dna"] = {"flags": payload[0], "length": len(payload) - 1}
        elif ptype in (0x05, 0x06, 0x08, 0x0A):
            root = parse_xml(payload)
            out["xml"].append({"type": ptype, "offset": offset, "root": None if root is None else root.tagName})
    return out


# ----------------------------------------------------------------------------------------------
# Expected HHereditas parse (documented mapping, independent implementation)
# ----------------------------------------------------------------------------------------------


def base_of(byte: int) -> str:
    ch = chr(byte).upper() if byte < 0x80 else ""
    if ch == "U":
        return "T"
    return ch if ch != "" and ch in IUPAC else "N"


def normalize_color(raw: str | None) -> str | None:
    if raw is None:
        return None
    value = raw.strip()
    if re.fullmatch(r"#[0-9a-fA-F]{6}", value):
        return value.lower()
    if re.fullmatch(r"#[0-9a-fA-F]{3}", value):
        return ("#" + "".join(c + c for c in value[1:])).lower()
    return None


def parse_range(text: str, length: int, topology: str):
    match = re.fullmatch(r"\s*(\d+)\s*-\s*(\d+)\s*", text)
    if not match:
        return None
    first, last = int(match.group(1)), int(match.group(2))
    if first < 1 or last < 1 or first > length or last > length:
        return None
    if first <= last:
        return [[first - 1, last]]
    if topology == "circular":
        return [[first - 1, last + length]]
    return [[first - 1, length], [0, last]]


def normalize_int(raw: str) -> str:
    value = raw.strip()
    if re.fullmatch(r"[+-]?\d+", value):
        number = int(value)
        return str(number) if abs(number) <= 2**53 - 1 else value
    return value


def qualifier_value(v_attrs: dict, key: str) -> str:
    text, predef, integer = v_attrs.get("text"), v_attrs.get("predef"), v_attrs.get("int")
    if text is not None:
        plain = render(text)
        prefix = render(predef) if predef is not None else ""
        value = f"{prefix}:{plain}" if prefix else plain
    elif predef is not None:
        value = render(predef)
    elif integer is not None:
        value = normalize_int(integer)
    else:
        value = ""
    if key == "translation":
        # SnapGene's segment separators and final stop go; its "?" (codon with ambiguous bases) is INSDC "X".
        value = value.replace(",", "").replace("?", "X")
        if value.endswith("*"):
            value = value[:-1]
    return value


def feature_label(ftype: str, qualifiers: list) -> str:
    for key in LABEL_PRIORITY:
        for k, v in qualifiers:
            if k == key and v is not None:
                if v.strip() != "":
                    clean = re.sub(r"\s+", " ", v).strip()
                    return clean[:39] + "…" if key == "note" and len(clean) > 40 else clean
                break
    return ftype


def reading_frame(raw: str | None):
    """Frame 1-3 of a SnapGene readingFrame attribute (sign = strand), or None if absent or invalid."""
    match = re.fullmatch(r"[ \t\n\r]*[+-]?([0-9]+)[ \t\n\r]*", raw) if raw is not None else None
    frame = int(match.group(1)) if match else None
    return frame if frame in (1, 2, 3) else None


def codon_start_agrees(value: str | None, frame: int) -> bool:
    match = re.fullmatch(r"[ \t\n\r]*\+?([0-9]+)[ \t\n\r]*", value) if value is not None else None
    return match is not None and int(match.group(1)) == frame


def biopython_decode(value: str) -> str:
    """Biopython SnapGeneIO `_decode`: strip anything tag-like."""
    return re.sub("<[^>]+>", "", value)


def expected_feature(element, length: int, topology: str):
    """Expected Feature plus test metadata: segment_groups and the source of every qualifier."""
    a = attrs(element)
    name = render(a.get("name"))
    ftype = a.get("type", "").strip() or "misc_feature"
    direction = (a.get("directionality") or "").strip()
    strand = 1 if direction == "1" else -1 if direction == "2" else 0
    segments, names, color, groups = [], [], None, []
    for segment in children(element, "Segment"):
        s = attrs(segment)
        if s.get("type", "").strip() == "gap":
            continue
        ranges = parse_range(s.get("range", ""), length, topology)
        if ranges is None:
            continue
        segment_name = render(s.get("name"))
        if segment_name:
            names.append((len(segments), segment_name))
        segments.extend(ranges)
        groups.append(len(ranges))
        if color is None:
            color = normalize_color(s.get("color"))
    if not segments:
        return None
    qualifiers, sources = [], []
    has_parts = False
    for q_index, q in enumerate(children(element, "Q")):
        raw_key = attrs(q).get("name", "")
        key = raw_key.strip()
        if not key:
            continue
        has_parts = has_parts or key == "parts"
        values = children(q, "V")
        if not values:
            qualifiers.append([key, None])
            sources.append({"kind": "Q", "q": q_index, "key": raw_key, "v": None})
        bio_index = 0
        for v in values:
            v_attrs = attrs(v)
            counted = any(k in v_attrs for k in ("text", "predef", "int"))
            qualifiers.append([key, qualifier_value(v_attrs, key)])
            sources.append({"kind": "Q", "q": q_index, "key": raw_key, "v": v_attrs, "bio_index": bio_index if counted else None})
            bio_index += 1 if counted else 0
    if names and not has_parts:
        numbered = sorted((len(segments) - i if strand == -1 else i + 1, n) for i, n in names)
        qualifiers.insert(0, ["parts", ";".join(f"{i}:{n}" for i, n in numbered)])
        sources.insert(0, {"kind": "parts"})
    frame = reading_frame(a.get("readingFrame")) if strand != 0 else None
    if frame is not None:
        # SnapGene translates in its readingFrame; a /codon_start that disagrees is stale.
        existing = [i for i, (k, _) in enumerate(qualifiers) if k == "codon_start"]
        if any(not codon_start_agrees(qualifiers[i][1], frame) for i in existing):
            for i in reversed(existing):
                del qualifiers[i]
                del sources[i]
            qualifiers.insert(existing[0], ["codon_start", str(frame)])
            sources.insert(existing[0], {"kind": "frame"})
        elif not existing and frame != 1:
            qualifiers.append(["codon_start", str(frame)])
            sources.append({"kind": "frame"})
    if name:
        first = next((i for i, (k, _) in enumerate(qualifiers) if k == "label"), None)
        if first is None:
            qualifiers.append(["label", name])
            sources.append({"kind": "label", "how": "appended", "raw": a.get("name", "")})
        elif qualifiers[first][1] != name:
            qualifiers.insert(first, ["label", name])
            sources.insert(first, {"kind": "label", "how": "inserted", "raw": a.get("name", "")})
    feature = {
        "type": ftype,
        "name": name if name else feature_label(ftype, qualifiers),
        "strand": strand,
        "segments": segments,
        "qualifiers": qualifiers,
        # Test metadata, not part of the record:
        "segment_groups": groups,  # model segments produced by each standard Segment element
        "sources": sources,  # where each qualifier comes from (aligned with "qualifiers")
    }
    if color is not None:
        feature["color"] = color
    return feature


def classify_value(ours, bio_value, v_attrs: dict | None, key: str) -> str:
    """Category of the relation between our value and Biopython's value for the same <V>."""
    if ours is not None and bio_value is not None and ours == str(bio_value):
        return "same"
    text = (v_attrs or {}).get("text")
    if text is not None and looks_like_html(text):
        return "html"
    if text is not None and (v_attrs or {}).get("predef") is not None:
        return "predef"
    if key == "translation":
        return "translation"
    if text is not None and re.search("<[^>]+>", text):
        return "plain-markup"
    return "unexplained"


def align_with_biopython(feature: dict, bio: dict) -> list:
    """[category, Biopython value] for each expected qualifier (see the TS oracle test for the categories)."""
    bio_q = {key: values for key, values in bio["qualifiers"]}
    last_q = {}
    for src in feature["sources"]:
        if src["kind"] == "Q":
            bio_key = biopython_decode(src["key"])
            last_q[bio_key] = max(last_q.get(bio_key, -1), src["q"])
    out = []
    for (key, value), src in zip(feature["qualifiers"], feature["sources"]):
        kind = src["kind"]
        if kind == "parts":
            bio_value = bio_q.get("parts", [None])[0]
            out.append(["same" if bio_value == value else "html", bio_value])
        elif kind == "frame":
            out.append(["reading-frame", None])
        elif kind == "label":
            bio_name = biopython_decode(src["raw"])
            if src["how"] == "appended":
                bio_value = bio_q.get("label", [None])[0]
                out.append([classify_value(value, bio_value, {"text": src["raw"]}, "label"), bio_value])
            elif bio_name == "" and re.search("<[^>]+>", src["raw"]):
                out.append(["plain-markup", None])  # Biopython's tag stripping erased the whole name
            else:
                ok = bio_name in bio_q.get("label", []) or bio_q.get("name") == [bio_name]
                out.append(["label-first" if ok else "unexplained", bio_q.get("name", [None])[0]])
        else:
            bio_key = biopython_decode(src["key"])
            if last_q.get(bio_key) != src["q"]:
                out.append(["duplicate-q", None])
            elif src["v"] is None:
                out.append(["no-value" if bio_q.get(bio_key) == [] else "unexplained", None])
            elif src["bio_index"] is None:
                out.append(["empty-v", None])
            else:
                values = bio_q.get(bio_key, [])
                bio_value = values[src["bio_index"]] if src["bio_index"] < len(values) else None
                out.append([classify_value(value, bio_value, src["v"], key), bio_value])
    return out


def clean_primer_sequence(raw: str) -> str:
    out = []
    for ch in raw:
        if re.match(r"[\s\d/\\|.\-*]", ch):
            continue
        up = ch.upper()
        up = "T" if up == "U" else up
        if up in IUPAC:
            out.append(up)
    return "".join(out)


def expected_primers(root) -> list:
    primers = []
    for index, element in enumerate(children(root, "Primer")):
        a = attrs(element)
        name = render(a.get("name")) or f"Primer {index + 1}"
        sequence = clean_primer_sequence(a.get("sequence", ""))
        if not sequence:
            continue
        primer = {"name": name, "sequence": sequence}
        description = render(a.get("description"))
        if description:
            primer["description"] = description
        primers.append(primer)
    return primers


MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"]


def genbank_date(text: str):
    match = re.fullmatch(r"\s*(\d{4})\.(\d{1,2})\.(\d{1,2})\s*", text)
    if not match:
        return None
    month, day = int(match.group(2)), int(match.group(3))
    if not (1 <= month <= 12 and 1 <= day <= 31):
        return None
    return f"{day:02d}-{MONTHS[month - 1]}-{match.group(1)}"


def references_summary(element) -> str:
    lines = []
    for reference in children(element, "Reference"):
        a = attrs(reference)
        parts = [render(a.get(k)) for k in ("authors", "title", "journal")]
        parts = [p if re.search(r"[.!?]$", p) else p + "." for p in parts if p]
        pubmed, doi = render(a.get("pubMedID")), render(a.get("doi"))
        if pubmed:
            parts.append(f"PubMed {pubmed}.")
        if doi:
            parts.append(f"doi:{doi}")
        if parts:
            lines.append(" ".join(parts))
    return "\n".join(lines)


def expected_notes(root, notes: dict) -> None:
    for child in children(root):
        tag, text = child.tagName, element_text(child)
        if tag == "Description":
            notes["description"] = render(text)
        elif tag == "Comments":
            comment = render(text, "block")
            if comment:
                notes["meta"].setdefault("comments", []).append(comment)
        elif tag in ("AccessionNumber", "Organism"):
            value = render(text)
            if value:
                notes["meta"]["accession" if tag == "AccessionNumber" else "organism"] = value
        elif tag == "References":
            summary = references_summary(child)
            if summary:
                notes["extras"]["References"] = summary
        elif not children(child):
            value = render(text)
            if value:
                notes["extras"][tag] = value
            for key, value in attrs(child).items():
                notes["extras"][f"{tag}.{key}"] = value.strip()


def expected_record(data: bytes, file_name: str | None = None) -> dict:
    """The record HHereditas should read, or None (it should then return no record)."""
    if not (len(data) >= 13 and data[0] == 0x09 and data[5:13] == b"SnapGene"):
        return None
    packets, truncated = iter_packets(data)
    if not packets or packets[0][0] != 0x09 or packets[0][2][:8] != b"SnapGene":
        return None
    cookie = packets[0][2]
    seq_type = struct.unpack(">H", cookie[8:10])[0] if len(cookie) >= 10 else 0
    if seq_type in (2, 7):
        return None
    dna = [p for p in packets if p[0] == 0x00]
    if not dna or len(dna[0][2]) == 0:
        return None
    payload = dna[0][2]
    flags = payload[0]
    seq = "".join(base_of(b) for b in payload[1:])
    topology = "circular" if flags & 1 else "linear"
    length = len(seq)
    record = {
        "description": "",
        "seq": seq,
        "topology": topology,
        "features": [],
        "primers": [],
    }
    notes = {"description": "", "meta": {}, "extras": {}}
    props_extras, ends = {}, None
    for ptype, _offset, data_bytes in packets:
        if ptype not in (0x05, 0x06, 0x08, 0x0A):
            continue
        root = parse_xml(data_bytes)
        expected_root = {0x05: "Primers", 0x06: "Notes", 0x08: "AdditionalSequenceProperties", 0x0A: "Features"}[ptype]
        if root is None or root.tagName != expected_root:
            continue
        if ptype == 0x0A:
            bio = biopython_packet_features(data_bytes, length)
            for index, element in enumerate(children(root, "Feature")):
                feature = expected_feature(element, length, topology)
                if feature is None:
                    continue
                bio_feature = bio["features"][index] if "features" in bio and index < len(bio["features"]) else None
                feature["biopython"] = bio_feature
                feature["alignment"] = None if bio_feature is None else align_with_biopython(feature, bio_feature)
                record["features"].append(feature)
        elif ptype == 0x05:
            record["primers"].extend(expected_primers(root))
        elif ptype == 0x06:
            expected_notes(root, notes)
        else:
            props_extras, ends = expected_properties(root, length, topology)
    extras = dict(notes["extras"])
    extras["Strandedness"] = "double" if flags & 2 else "single"
    extras["DamMethylated"] = "1" if flags & 4 else "0"
    extras["DcmMethylated"] = "1" if flags & 8 else "0"
    extras["EcoKIMethylated"] = "1" if flags & 16 else "0"
    extras.update(props_extras)
    meta = dict(notes["meta"])
    if notes["extras"].get("Type") == "Synthetic":
        meta["division"] = "SYN"
    elif re.fullmatch(r"[A-Z]{3}", notes["extras"].get("SequenceClass", "")):
        meta["division"] = notes["extras"]["SequenceClass"]
    date = genbank_date(notes["extras"]["LastModified"]) if "LastModified" in notes["extras"] else None
    if date:
        meta["date"] = date
    meta["sourceFormat"] = "snapgene"
    meta["extras"] = extras
    record["description"] = notes["description"]
    record["meta"] = meta
    if ends is not None:
        record["ends"] = ends
    name = "Untitled"
    if file_name is not None:
        base = re.split(r"[\\/]", file_name)[-1]
        dot = base.rfind(".")
        stem = (base[:dot] if dot > 0 else base).strip()
        name = stem or "Untitled"
    record["name"] = name
    return record


def expected_properties(root, length: int, topology: str):
    extras = {}
    values = {}
    for child in children(root):
        values.setdefault(child.tagName, element_text(child))
    for key in ("UpstreamModification", "DownstreamModification"):
        if key in values and values[key].strip():
            extras[key] = render(values[key])

    def stickiness(key):
        text = values.get(key, "").strip()
        return int(text) if re.fullmatch(r"[+-]?\d+", text) else 0

    up, down = stickiness("UpstreamStickiness"), stickiness("DownstreamStickiness")
    if (up == 0 and down == 0) or topology == "circular" or abs(up) + abs(down) >= length:
        return extras, None

    def end(value):
        if value == 0:
            return {"kind": "blunt", "length": 0}
        return {"kind": "5prime" if value > 0 else "3prime", "length": abs(value)}

    return extras, {"left": end(up), "right": end(down)}


def dump(data: bytes, file_name: str | None = None) -> dict:
    bio = biopython_dump(data)
    if "features" in bio:
        # Per-feature Biopython data is attached to the expected features; keep only the types here.
        bio["feature_types"] = [f["type"] for f in bio.pop("features")]
    return {
        "biopython": bio,
        "raw": raw_dump(data),
        "expected": expected_record(data, file_name),
    }


# ----------------------------------------------------------------------------------------------
# A small SnapGene writer for generated test files (independent of the TypeScript writer)
# ----------------------------------------------------------------------------------------------


def xml_attr(value: str) -> str:
    return (
        value.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")
        .replace("\n", "&#10;").replace("\r", "&#13;").replace("\t", "&#9;")
    )


def xml_text(value: str) -> str:
    return value.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def el(name: str, attributes: list, content: str | None = None) -> str:
    attr_text = "".join(f' {k}="{xml_attr(v)}"' for k, v in attributes if v is not None)
    return f"<{name}{attr_text}/>" if content is None else f"<{name}{attr_text}>{content}</{name}>"


def dna_packet(seq: str, flags: int) -> bytes:
    return packet(0x00, bytes([flags]) + seq.encode("latin-1"))


def xml_packet(ptype: int, xml: str, declaration: bool = True) -> bytes:
    text = ('<?xml version="1.0"?>' if declaration else "") + xml
    return packet(ptype, text.encode("utf-8"))


def properties_packet(up: int = 0, down: int = 0, mod_up: str = "Unmodified", mod_down: str = "Unmodified") -> bytes:
    xml = (
        "<AdditionalSequenceProperties>"
        f"<UpstreamStickiness>{up}</UpstreamStickiness><DownstreamStickiness>{down}</DownstreamStickiness>"
        f"<UpstreamModification>{mod_up}</UpstreamModification><DownstreamModification>{mod_down}</DownstreamModification>"
        "</AdditionalSequenceProperties>"
    )
    return xml_packet(0x08, xml, declaration=False)


def notes_packet(fields: list, newlines: bool = True) -> bytes:
    sep = "\n" if newlines else ""
    body = sep.join(fields)
    return xml_packet(0x06, f"<Notes>{sep}{body}{sep}</Notes>{sep}", declaration=False)


def features_packet(features: list, next_id: bool = True) -> bytes:
    attributes = [("nextValidID", str(len(features)) if next_id else None)]
    return xml_packet(0x0A, el("Features", attributes, "".join(features)) + "\n")


def primers_packet(primers: list) -> bytes:
    params = el("HybridizationParams", [("minContinuousMatchLen", "10"), ("allowMismatch", "1"), ("minMeltingTemperature", "40")])
    return xml_packet(0x05, el("Primers", [("nextValidID", str(len(primers)))], params + "".join(primers)) + "\n")


def feature_xml(name, ftype, segments, qualifiers, directionality=None, extra_attrs=()):
    """segments: list of (range, color, type, name); qualifiers: list of (key, [V attribute lists] or None)."""
    seg_xml = "".join(
        el("Segment", [("name", seg_name), ("range", rng), ("color", color), ("type", seg_type)]) for rng, color, seg_type, seg_name in segments
    )
    q_xml = ""
    for key, values in qualifiers:
        if values is None:
            q_xml += el("Q", [("name", key)])
        else:
            q_xml += el("Q", [("name", key)], "".join(el("V", v) for v in values))
    attributes = [("recentID", "0"), ("name", name), ("directionality", directionality), ("type", ftype), *extra_attrs]
    return el("Feature", attributes, seg_xml + q_xml)


# ----------------------------------------------------------------------------------------------
# Handmade edge cases
# ----------------------------------------------------------------------------------------------


def notes_basic(description: str = "Generated by snapgene_oracle.py") -> bytes:
    return notes_packet(
        [
            "<UUID>00000000-0000-4000-8000-000000000000</UUID>",
            "<Type>Synthetic</Type>",
            f"<Description>{xml_text(description)}</Description>",
            '<Created UTC="1:2:3">2026.10.8</Created>',
            '<LastModified UTC="4:5:6">2026.10.8</LastModified>',
        ]
    )


def case_files() -> dict:
    cases: dict[str, bytes] = {}
    seq60 = "GAATTCGGATCCAAGCTTCTGCAGGTCGACTCTAGAGCATGCCTGCAGGCATGCAAGCTT"

    # Sticky ends (sign convention: positive = 5' overhang, negative = 3' overhang).
    for name, up, down in [("sticky_5prime_both", 4, 4), ("sticky_3prime_both", -1, -1), ("sticky_topo", 0, 4), ("sticky_mixed", -3, 2)]:
        cases[name] = (
            cookie_packet()
            + dna_packet(seq60, 0x02)
            + properties_packet(up, down, "FivePrimePhosphorylated", "Unmodified")
            + features_packet([feature_xml("left end", "misc_feature", [("1-10", "#a6acb3", "standard", None)], [])])
            + notes_basic()
        )
    cases["sticky_invalid_circular"] = cookie_packet() + dna_packet(seq60, 0x03) + properties_packet(4, -4) + notes_basic()
    cases["sticky_invalid_too_long"] = cookie_packet() + dna_packet("ACGTACGT", 0x02) + properties_packet(5, -3) + notes_basic()
    cases["sticky_invalid_text"] = cookie_packet() + dna_packet(seq60, 0x02) + properties_packet("abc", 2) + notes_basic()

    # Rich text, entities, unicode.
    rich = [
        ("note", [[("text", "<html><body>A &amp; B &lt;i&gt; &quot;q&quot; it's</body></html>")]]),
        ("note", [[("text", "<html><body><!--StartFragment-->Origin of transfer<!--EndFragment-->\n\n</body></html>")]]),
        ("note", [[("text", "<html><body><b>Welcome</b><div><b><br></b></div><div>second&nbsp;line</div></body></html>")]]),
        ("note", [[("text", "<html><body>&alpha;-helix 37&deg;C 5&prime;&rarr;3&prime; &#956;g &#x3b1; caf&eacute;</body></html>")]]),
        ("note", [[("text", '<html><body>see <a href="https://www.ncbi.nlm.nih.gov/pubmed/3313277">Kozak</a> <span style="color:red">red</span></body></html>')]]),
        ("note", [[("text", "<html><head><style>p { margin: 0 }</style></head><body><p>styled</p><p>para</p></body></html>")]]),
        ("note", [[("text", "plain with newline\nand\r\nCRLF")]]),
        ("note", [[("text", "<unknown accession")]]),
        ("note", [[("text", "5' <- 3' & x > y")]]),
        ("product", [[("text", "β-lactamase µg/ml ≥ 5 naïve 🧬")]]),
        ("gene", [[("text", "<html><body><i>aph(3')-Ia</i></body></html>")]]),
    ]
    cases["rich_text"] = (
        cookie_packet()
        + dna_packet(seq60, 0x03)
        + features_packet(
            [
                feature_xml("<html><body>Name &amp; <i>italic</i></body></html>", "misc_feature", [("1-20", "#ABCDEF", "standard", None)], rich, "1"),
                feature_xml("tab\there", "misc_feature", [("21-30", "#abc", "standard", None)], [("label", [[("text", "tab\there")]])]),
            ]
        )
        + notes_packet(
            [
                "<Type>Natural</Type>",
                "<Description>&lt;html>&lt;body>&lt;b>Welcome to SnapGene Viewer!&lt;/b>&lt;div>&lt;b>&lt;br>&lt;/b>&lt;/div>&lt;div>This sample file.&lt;/div>&lt;/body>&lt;/html></Description>",
                "<Comments>&lt;html>&lt;body>Use the tabs. Sequence view shows:&lt;div>&lt;br>&lt;/div>&lt;div>-- an intron&lt;/div>&lt;div>&amp;nbsp;&amp;nbsp; &amp;nbsp; Val at 1a&lt;/div>&lt;div>&lt;br>&lt;/div>&lt;div>Last line&lt;/div>&lt;/body>&lt;/html></Comments>",
                "<Organism>Saccharomyces cerevisiae</Organism>",
                "<AccessionNumber>&lt;unknown</AccessionNumber>",
                "<TransformedInto>DH5α</TransformedInto>",
                "<SequenceClass>PHG</SequenceClass>",
                '<LastModified UTC="16:0:13">2018.6.19</LastModified>',
                "<Created>2012.4.15</Created>",
            ]
        )
    )

    # Qualifier value forms.
    forms = [
        ("db_xref", [[("text", "238030067"), ("predef", "GI")], [("text", "8197368"), ("predef", "GeneID")]]),
        ("rpt_type", [[("predef", "inverted")]]),
        ("pseudo", None),
        ("translation", [[("text", "M,,VTIGNAH,DDL*")]]),
        ("codon_start", [[("int", "01")]]),
        ("transl_table", [[("int", "11")]]),
        ("note", [[("text", "first note")]]),
        ("note", [[("text", "second note element (Biopython keeps only this one)")]]),
        ("experiment", [[]]),
        ("label", [[("text", "label one")], [("text", "label two")]]),
    ]
    cases["qualifier_forms"] = (
        cookie_packet()
        + dna_packet(seq60, 0x02)
        + features_packet([feature_xml("label one", "CDS", [("1-60", "#993366", "standard", None)], forms, "1")])
        + notes_basic()
    )

    # SnapGene writes "?" for a codon with ambiguous bases (SnapGene library: pAd/BLOCK-iT-DEST AmpR, codon NCA;
    # pJW168 Rep101(Ts), codon YAT); INSDC /translation uses "X". Bases 1-12: ATG NCA AAA TAA; bases 13-21
    # are the reverse complement of ATG NCA AAA.
    cds_color = "#993366"
    cases["translation_ambiguous"] = (
        cookie_packet()
        + dna_packet("ATGNCAAAATAATTTTGNCAT", 0x02)
        + features_packet(
            [
                feature_xml("orf", "CDS", [("1-12", cds_color, "standard", None)], [("translation", [[("text", "M?K*")]])], "1"),
                feature_xml("split orf", "CDS", [("1-6", cds_color, "standard", None), ("7-12", cds_color, "standard", None)], [("translation", [[("text", "M?,K*")]])], "1"),
                feature_xml("reverse", "CDS", [("13-21", cds_color, "standard", None)], [("translation", [[("text", "M?K")]])], "2", [("readingFrame", "-1")]),
            ]
        )
        + notes_basic()
    )

    # Ranges, wrapping, gaps, segment names, colours (circular, L=300).
    seq300 = "".join("ACGT"[(i * 7 + i // 5) % 4] for i in range(300))
    wrap_features = [
        feature_xml("over origin", "misc_feature", [("281-20", "#a6acb3", "standard", None)], [], "0"),
        feature_xml("full circle", "misc_feature", [("5-4", "#a6acb3", "standard", None)], [], None),
        feature_xml("whole from origin", "misc_feature", [("1-300", "#a6acb3", "standard", None)], [], "3"),
        feature_xml(
            "split across origin",
            "CDS",
            [("271-290", "#993366", "standard", "first"), ("291-294", "noColor", "gap", None), ("295-10", "#993366", "standard", None), ("11-20", "noColor", "gap", None), ("21-60", "#993366", "standard", "last")],
            [],
            "1",
        ),
        feature_xml(
            "reverse split",
            "terminator",
            [("100-149", "#ffffff", "standard", "subfeature3"), ("150-160", "noColor", "gap", None), ("161-170", "#ffffff", "standard", None), ("171-180", "#ffffff", "standard", "subfeature1")],
            [("note", [[("text", "reverse multi-segment feature")]])],
            "2",
            [("swappedSegmentNumbering", "1"), ("readingFrame", "-1")],
        ),
        feature_xml("adjacent no gaps", "misc_feature", [("201-210", "noColor", "standard", None), ("211-220", "#ABC", "standard", None)], [], "1"),
        feature_xml("non-adjacent without gap", "misc_feature", [("221-225", "#ff0000", "standard", None), ("231-235", "#00ff00", "standard", None)], [], "2"),
        feature_xml("overlapping", "CDS", [("236-250", "#993366", "standard", None), ("250-260", "#993366", "standard", None)], [], "1", [("allowSegmentOverlaps", "1")]),
        feature_xml("single base", "misc_feature", [("300-300", "#a6acb3", "standard", None)], [], "1"),
    ]
    cases["ranges_circular"] = cookie_packet() + dna_packet(seq300, 0x03) + features_packet(wrap_features) + notes_basic()
    cases["ranges_linear_wrap"] = (
        cookie_packet()
        + dna_packet(seq300, 0x02)
        + features_packet([feature_xml("wraps on linear", "misc_feature", [("291-10", "#a6acb3", "standard", None)], [], "2")])
        + notes_basic()
    )
    cases["ranges_invalid"] = (
        cookie_packet()
        + dna_packet(seq60, 0x02)
        + features_packet(
            [
                feature_xml("zero", "misc_feature", [("0-5", "#a6acb3", "standard", None), ("6-10", "#a6acb3", "standard", None)], [], "1"),
                feature_xml("too long", "misc_feature", [("50-61", "#a6acb3", "standard", None)], [], "1"),
                feature_xml("not a range", "misc_feature", [("abc", "#a6acb3", "standard", None), ("7", "#a6acb3", "standard", None), ("1-2-3", "#a6acb3", "standard", None)], [], "1"),
                feature_xml("fine", "misc_feature", [("2-3", "#a6acb3", "standard", None)], [], "x"),
            ]
        )
        + notes_basic()
    )
    cases["gap_only_feature"] = (
        cookie_packet()
        + dna_packet(seq60, 0x02)
        + features_packet([feature_xml("only a gap", "misc_feature", [("1-10", "noColor", "gap", None)], []), feature_xml("ok", "misc_feature", [("11-20", "#a6acb3", "standard", None)], [])])
        + notes_basic()
    )

    # Strands and reading frames (attribute layout of real SnapGene files).
    frames = [
        feature_xml("no dir", "misc_feature", [("1-6", "#a6acb3", "standard", None)], []),
        feature_xml("dir 0", "misc_feature", [("1-6", "#a6acb3", "standard", None)], [], "0"),
        feature_xml("dir 1", "misc_feature", [("1-6", "#a6acb3", "standard", None)], [], "1"),
        feature_xml("dir 2", "misc_feature", [("1-6", "#a6acb3", "standard", None)], [], "2"),
        feature_xml("dir 3", "misc_feature", [("1-6", "#a6acb3", "standard", None)], [], "3"),
        feature_xml("fwd frame 2", "CDS", [("1-57", "#993366", "standard", None)], [("codon_start", [[("int", "2")]])], "1", [("readingFrame", "2")]),
        feature_xml("rev frame 3", "CDS", [("1-57", "#993366", "standard", None)], [("codon_start", [[("int", "3")]])], "2", [("swappedSegmentNumbering", "1"), ("readingFrame", "-3")]),
        feature_xml("frame only", "CDS", [("1-57", "#993366", "standard", None)], [], "2", [("readingFrame", "-2")]),
        feature_xml("frame conflict", "CDS", [("1-57", "#993366", "standard", None)], [("codon_start", [[("int", "3")]])], "1", [("readingFrame", "2")]),
    ]
    cases["strands_frames"] = cookie_packet() + dna_packet(seq60, 0x02) + features_packet(frames) + notes_basic()

    # readingFrame vs /codon_start: SnapGene translates in readingFrame (sign = strand, magnitude = frame)
    # and leaves a stale codon_start qualifier behind (SnapGene library files; PlasmidPop issues #153, #164).
    cds = [("1-57", "#993366", "standard", None)]
    reverse = [("swappedSegmentNumbering", "1")]

    def int_v(*values):
        return [[("int", v)] for v in values]

    reading_frames = [
        feature_xml("fwd stale 1, frame 2", "CDS", cds, [("codon_start", int_v("1"))], "1", [("readingFrame", "2")]),
        feature_xml("rev stale 1, frame -3", "CDS", cds, [("codon_start", int_v("1"))], "2", [*reverse, ("readingFrame", "-3")]),
        feature_xml("rev stale 2, frame -1", "CDS", cds, [("codon_start", int_v("2"))], "2", [*reverse, ("readingFrame", "-1")]),
        feature_xml("rev agrees, frame -1", "CDS", cds, [("codon_start", int_v("1"))], "2", [*reverse, ("readingFrame", "-1")]),
        feature_xml("rev none, frame -1", "CDS", cds, [], "2", [*reverse, ("readingFrame", "-1")]),
        feature_xml("fwd none, frame 3", "CDS", cds, [("transl_table", int_v("11"))], "1", [("readingFrame", "3")]),
        feature_xml("fwd stale 3, no frame", "CDS", cds, [("codon_start", int_v("3"))], "1"),
        feature_xml("rev stale 2, no frame", "CDS", cds, [("codon_start", int_v("2"))], "2", reverse),
        feature_xml("non-directional, frame -1", "protein_bind", [("1-57", "#a6acb3", "standard", None)], [("codon_start", int_v("2"))], None, [("readingFrame", "-1")]),
        feature_xml("several values, frame 2", "CDS", cds, [("note", [[("text", "before")]]), ("codon_start", int_v("2", "3"))], "1", [("readingFrame", "2")]),
        feature_xml("agrees with leading zero", "CDS", cds, [("codon_start", [[("text", "02")]])], "1", [("readingFrame", "2")]),
        feature_xml("value-less, frame 2", "CDS", cds, [("codon_start", None)], "1", [("readingFrame", "2")]),
        feature_xml("plus sign, frame +3", "CDS", cds, [], "1", [("readingFrame", "+3")]),
        feature_xml("frame 0", "CDS", cds, [("codon_start", int_v("2"))], "1", [("readingFrame", "0")]),
        feature_xml("frame 4", "CDS", cds, [("codon_start", int_v("1"))], "2", [*reverse, ("readingFrame", "4")]),
        feature_xml("frame text", "CDS", cds, [("codon_start", int_v("1"))], "1", [("readingFrame", "two")]),
    ]
    cases["reading_frames"] = cookie_packet() + dna_packet(seq60, 0x02) + features_packet(reading_frames) + notes_basic()

    # Excerpts of SnapGene library files with a stale /codon_start (same data as testkit.ts PMD20_LACZ / PMD19_LACZ).
    for name, (seq, feature) in LIBRARY_EXCERPTS.items():
        cases[name] = cookie_packet() + dna_packet(seq, 0x1E) + features_packet([feature])

    # Several Notes packets: fields merge in file order (later ones win), comments accumulate.
    cases["notes_two_packets"] = (
        cookie_packet()
        + dna_packet(seq60, 0x02)
        + notes_packet(
            [
                "<UUID>11111111-0000-4000-8000-000000000000</UUID>",
                "<Type>Synthetic</Type>",
                "<CustomMapLabel>first</CustomMapLabel>",
                "<Description>first description</Description>",
                "<Organism>Escherichia coli</Organism>",
                "<Comments>comment one</Comments>",
            ]
        )
        + notes_packet(
            [
                "<CustomMapLabel>second</CustomMapLabel>",
                "<SequenceClass>PHG</SequenceClass>",
                '<LastModified UTC="1:2:3">2020.1.2</LastModified>',
                "<AccessionNumber>X12345</AccessionNumber>",
                "<Comments>comment two</Comments>",
            ]
        )
    )

    # Names and labels.
    labels = [
        feature_xml("no label", "misc_feature", [("1-5", "#a6acb3", "standard", None)], [("note", [[("text", "n")]])]),
        feature_xml("same", "misc_feature", [("1-5", "#a6acb3", "standard", None)], [("label", [[("text", "same")]])]),
        feature_xml("differs", "misc_feature", [("1-5", "#a6acb3", "standard", None)], [("note", [[("text", "n")]]), ("label", [[("text", "other")]])]),
        feature_xml("later", "misc_feature", [("1-5", "#a6acb3", "standard", None)], [("label", [[("text", "first")], [("text", "later")]])]),
        feature_xml("", "misc_feature", [("1-5", "#a6acb3", "standard", None)], [("gene", [[("text", "lacZ")]])]),
        feature_xml("", "promoter", [("1-5", "#a6acb3", "standard", None)], []),
    ]
    cases["names_labels"] = cookie_packet() + dna_packet(seq60, 0x02) + features_packet(labels) + notes_basic()

    # Full notes, references, unknown elements (no newlines, as third-party writers do).
    cases["notes_full"] = (
        cookie_packet()
        + dna_packet(seq60, 0x1F)
        + notes_packet(
            [
                "<UUID>aa4bf7ca-a9ee-4641-900f-ec849d2552ea</UUID>",
                "<Type>Synthetic</Type>",
                "<ConfirmedExperimentally>1</ConfirmedExperimentally>",
                "<CustomMapLabel>pUC18</CustomMapLabel>",
                "<UseCustomMapLabel>1</UseCustomMapLabel>",
                "<Description>pUC cloning vector.</Description>",
                '<Created UTC="21:28:41">2021.5.12</Created>',
                '<LastModified UTC="21:28:41">2021.5.32</LastModified>',
                "<AccessionNumber>L09137</AccessionNumber>",
                "<CodeNumber>XYZ-1</CodeNumber>",
                "<CreatedBy>Lab &amp; Co</CreatedBy>",
                "<Organism>&lt;html>&lt;body>&lt;i>Escherichia coli&lt;/i>&lt;/body>&lt;/html></Organism>",
                "<SequenceClass>UNA</SequenceClass>",
                "<TransformedInto>unspecified</TransformedInto>",
                "<Comments>See also GenBank accession L09137.</Comments>",
                '<FutureField kind="x" level="2">some value</FutureField>',
                "<EmptyField></EmptyField>",
                "<Structured><Child>ignored</Child></Structured>",
                "<References>"
                '<Reference title="Construction of improved M13 vectors." authors="Norrander J, Kempe T, Messing J" pubMedID="6323249" journal="Gene. 1983 Dec;26(1):101-6."/>'
                '<Reference type="Journal Article" pubMedID="17018144" journal="&lt;html>&lt;body>&lt;html>&lt;body>BMC Bioinformatics&lt;/body>&lt;/html> 2006 Oct 3;7:427&lt;/body>&lt;/html>" title="&lt;html>&lt;body>MICA: desktop software&lt;/body>&lt;/html>" authors="&lt;html>&lt;body>Stokes WA, Glick BS.&lt;/body>&lt;/html>" doi="10.1186/1471-2105-7-427"/>'
                "</References>",
            ],
            newlines=False,
        )
    )

    # Older layout: other cookie versions, packet order, no recentID/nextValidID, explicit parts qualifier.
    cases["old_layout"] = (
        cookie_packet(1, 10, 6)
        + dna_packet(seq300.lower(), 0x1F)
        + notes_packet(["<Type>Natural</Type>", "<Created>2012.4.15</Created>", "<LastModified>2012.4.15</LastModified>"])
        + primers_packet([el("Primer", [("recentID", "0"), ("name", "M13 Forward"), ("sequence", "tgtaaaacgacggccagt"), ("description", "In lacZ gene")])])
        + features_packet(
            [
                feature_xml("lac promoter", "promoter", [("10-16", "#ffffff", "standard", None), ("17-35", "#ffffff", "standard", None), ("36-41", "#ffffff", "standard", None)], [("parts", [[("text", "1:-35;3:-10")]]), ("color", [[("text", "#FF0000")]])], "2"),
            ],
            next_id=False,
        )
        + packet(0x08, b"<AdditionalSequenceProperties>\n<UpstreamStickiness>0</UpstreamStickiness>\n<DownstreamStickiness>0</DownstreamStickiness>\n<UpstreamModification>FivePrimePhosphorylated</UpstreamModification>\n<DownstreamModification>FivePrimePhosphorylated</DownstreamModification>\n</AdditionalSequenceProperties>")
    )

    # Sequence characters (ASCII only; Biopython cannot decode other bytes).
    cases["sequence_chars"] = cookie_packet() + dna_packet("acgtRYSWKMBDHVNuU-*. X\x00Zacgt", 0x00) + notes_basic()
    cases["sequence_non_ascii"] = cookie_packet() + packet(0x00, b"\x02ACGT\xff\xc3\xa9ACGT") + notes_basic()
    cases["empty_sequence"] = cookie_packet() + dna_packet("", 0x02) + notes_basic()

    # Primers.
    primer_list = [
        el("Primer", [("recentID", "0"), ("name", "fwd"), ("sequence", "acgtRYuU"), ("description", "<html><body></body></html>")]),
        el("Primer", [("recentID", "1"), ("name", "<html><body>rev &amp; co</body></html>"), ("sequence", "5'-ACG T-3'"), ("description", "<html><body>For <b>mutagenesis</b></body></html>")]),
        el("Primer", [("recentID", "2"), ("name", ""), ("sequence", "GGGG"), ("description", "plain, description")]),
        el("Primer", [("recentID", "3"), ("name", "no sequence")]),
        el("Primer", [("recentID", "4"), ("name", "only junk"), ("sequence", "123-xz")]),
        el(
            "Primer",
            [("recentID", "5"), ("name", "with sites"), ("sequence", "GAATTCGGATCC")],
            el("BindingSite", [("location", "0-11"), ("boundStrand", "0")]) + el("BindingSite", [("simplified", "1"), ("location", "0-11"), ("boundStrand", "0")]),
        ),
    ]
    cases["primers"] = cookie_packet() + dna_packet(seq60, 0x03) + primers_packet(primer_list) + notes_basic()

    # Container-level oddities.
    cases["unknown_packets"] = (
        cookie_packet()
        + packet(0x02, b"\x01\x00\x00\x00\x08")
        + dna_packet(seq60, 0x02)
        + packet(0x03, b"")
        + packet(0x07, b"\xfd7zXZ\x00garbage")
        + packet(0x0B, bytes(range(40)))
        + packet(0xFF, b"\xff" * 7)
        + packet(0x0A, b"")
        + notes_basic("packets galore")
        + packet(0x23, b"")
    )
    cases["two_dna_packets"] = cookie_packet() + dna_packet("ACGT", 0x02) + dna_packet("GGGGGG", 0x03) + notes_basic()
    cases["no_dna_packet"] = cookie_packet() + notes_basic()
    cases["protein_file"] = cookie_packet(2) + packet(0x15, b"\x00MKV*") + notes_basic()
    cases["rna_file"] = cookie_packet(7) + packet(0x20, b"\x00acgu") + notes_basic()
    cases["short_cookie"] = packet(0x09, b"SnapGene\x00\x01") + dna_packet("ACGT", 0x02)
    cases["unknown_sequence_type"] = cookie_packet(0) + dna_packet("ACGTACGT", 0x02) + notes_basic()
    cases["malformed_features_xml"] = (
        cookie_packet()
        + dna_packet(seq60, 0x02)
        + xml_packet(0x0A, '<Features><Feature name="broken"><Segment range="1-5"></Features>')
        + notes_basic("notes still readable")
    )
    cases["wrong_root"] = cookie_packet() + dna_packet(seq60, 0x02) + xml_packet(0x0A, "<Primers/>") + notes_basic("wrong root")
    return cases


# ----------------------------------------------------------------------------------------------
# Random corpus
# ----------------------------------------------------------------------------------------------

WORDS = [
    "AmpR", "promoter", "lac", "operator", "β-lactamase", "µg/ml", "5′→3′", "A&B", "<5kb>", "x>y", '"quoted"', "it's",
    "α-helix", "≥", "©", "naïve", "🧬", "Ori", "T7", "His6", "FLAG®", "37°C", "50%", "(+)", "[note]", "a;b", "key=value",
    "tab", "end.", "Sp6", "HindIII", "EcoRI", "M13", "pUC", "Kan", "Neo", "CMV", "SV40", "polyA", "&amp;",
]
NAMED = {"α": "&alpha;", "µ": "&micro;", "≥": "&ge;", "©": "&copy;", "ï": "&iuml;", "°": "&deg;", "′": "&prime;", "→": "&rarr;", "®": "&reg;", "β": "&beta;"}


def random_words(rng: random.Random, low: int = 1, high: int = 5) -> str:
    return " ".join(rng.choice(WORDS) for _ in range(rng.randint(low, high)))


def encode_rich(rng: random.Random, text: str) -> str:
    """Encode plain text the way SnapGene may store it; HHereditas must read back `text`."""
    mode = rng.random()
    if mode < 0.45 and not looks_like_html(text):
        return text
    body = html_lib.escape(text, quote=rng.random() < 0.5)
    if rng.random() < 0.5:
        body = "".join(NAMED.get(ch, ch) if rng.random() < 0.7 else (f"&#{ord(ch)};" if ord(ch) > 127 else ch) for ch in body)
    if rng.random() < 0.3:
        body = body.replace(" ", "&nbsp;", 1)
    if rng.random() < 0.3:
        words = body.split(" ")
        k = rng.randrange(len(words))
        words[k] = f"<{rng.choice(['i', 'b', 'span', 'font'])}>{words[k]}</{rng.choice(['i', 'b', 'span', 'font'])}>"
        body = " ".join(words)
    if rng.random() < 0.3:
        body = "<!--StartFragment-->" + body + "<!--EndFragment-->"
    if rng.random() < 0.3:
        body = body.replace(" ", "\n", 1)
    tail = "\n\n" if rng.random() < 0.3 else ""
    return f"<html><body>{body}{tail}</body></html>"


def encode_block(rng: random.Random, lines: list) -> str:
    if len(lines) == 1 and rng.random() < 0.5 and not looks_like_html(lines[0]):
        return lines[0]
    escaped = [html_lib.escape(line, quote=False) for line in lines]
    if rng.random() < 0.5:
        return "<html><body>" + "<br>".join(escaped) + "</body></html>"
    out = escaped[0]
    for line in escaped[1:]:
        out += "<div><br></div>" if line == "" else f"<div>{line}</div>"
    return f"<html><body>{out}</body></html>"


def random_sequence(rng: random.Random, length: int) -> str:
    alphabet = "ACGT" * 6 + "acgt" * 2 + "RYSWKMBDHVN" + "u"
    return "".join(rng.choice(alphabet) for _ in range(length))


def random_layout(rng: random.Random, length: int, topology: str):
    """Standard segments as (start0, end_exclusive_unwrapped) in ascending order."""
    count = rng.randint(1, 4)
    position = rng.randrange(length)
    segments = []
    for _ in range(count):
        size = rng.randint(1, max(1, min(60, length // 4)))
        start = position
        end = start + size
        if topology == "linear" and end > length:
            break
        if segments and end - segments[0][0] > length:
            break
        segments.append((start, end))
        position = end + (0 if rng.random() < 0.3 else rng.randint(1, 15))
        if topology == "linear" and position >= length:
            break
    return segments


def random_feature(rng: random.Random, length: int, topology: str):
    segments = random_layout(rng, length, topology)
    if not segments:
        return None, None
    direction = rng.choice([None, "0", "1", "2", "3", "1", "2"])
    strand = 1 if direction == "1" else -1 if direction == "2" else 0
    ftype = rng.choice(["CDS", "promoter", "misc_feature", "terminator", "rep_origin", "gene", "primer_bind"])
    color = rng.choice(["#a6acb3", "#FF00AA", "#0f0", "#993366", "#ffffff"])
    seg_xml, intended_segments, names = [], [], []
    with_gaps = rng.random() < 0.7
    previous_end = None
    for index, (start, end) in enumerate(segments):
        if previous_end is not None and start > previous_end and with_gaps:
            gap_start, gap_end = previous_end % length, (start - 1) % length
            seg_xml.append((f"{gap_start + 1}-{gap_end + 1}", "noColor", "gap", None))
        first = start % length
        last = (end - 1) % length
        name = rng.choice(WORDS) if rng.random() < 0.2 else None
        if name is not None:
            names.append((index, name))
        seg_xml.append((f"{first + 1}-{last + 1}", color if index == 0 or rng.random() < 0.5 else rng.choice(["#123456", "noColor"]), "standard", None if name is None else encode_rich(rng, name)))
        intended_segments.append([first, first + (end - start)])
        previous_end = end
    qualifiers, intended_q = [], []
    for _ in range(rng.randint(0, 5)):
        kind = rng.random()
        if kind < 0.45:
            key = rng.choice(["note", "product", "gene", "bound_moiety", "direction"])
            text = random_words(rng)
            qualifiers.append((key, [[("text", encode_rich(rng, text))]]))
            intended_q.append([key, text])
        elif kind < 0.55:
            key = rng.choice(["codon_start", "transl_table"])
            number = rng.randint(1, 3)
            qualifiers.append((key, [[("int", ("0" if rng.random() < 0.2 else "") + str(number))]]))
            intended_q.append([key, str(number)])
        elif kind < 0.65:
            db, ident = rng.choice(["GI", "GeneID", "taxon"]), str(rng.randint(1, 10**9))
            qualifiers.append(("db_xref", [[("text", ident), ("predef", db)]]))
            intended_q.append(["db_xref", f"{db}:{ident}"])
        elif kind < 0.72:
            protein = "".join(rng.choice("ACDEFGHIKLMNPQRSTVWY") for _ in range(rng.randint(1, 30)))
            cut = rng.randrange(len(protein) + 1)
            qualifiers.append(("translation", [[("text", protein[:cut] + "," + protein[cut:] + ("*" if rng.random() < 0.5 else ""))]]))
            intended_q.append(["translation", protein])
        elif kind < 0.78:
            qualifiers.append(("pseudo", None))
            intended_q.append(["pseudo", None])
        else:
            texts = [random_words(rng) for _ in range(rng.randint(1, 3))]
            qualifiers.append(("note", [[("text", encode_rich(rng, t))] for t in texts]))
            intended_q.extend(["note", t] for t in texts)
    name = random_words(rng, 1, 3)
    label_mode = rng.random()
    if name and label_mode < 0.3:
        qualifiers.append(("label", [[("text", name)]]))
        intended_q.append(["label", name])
    elif label_mode < 0.45:
        other = random_words(rng, 1, 2)
        qualifiers.append(("label", [[("text", other)]]))
        intended_q.append(["label", other])
    frame_attrs = []
    if ftype == "CDS" and strand != 0 and rng.random() < 0.5:
        frame = rng.randint(1, 3)
        frame_attrs.append(("readingFrame", str(frame if strand == 1 else -frame)))
    if strand == -1:
        frame_attrs.insert(0, ("swappedSegmentNumbering", "1"))
    if frame_attrs and frame_attrs[-1][0] == "readingFrame":
        frame = abs(int(frame_attrs[-1][1]))
        starts = [q for q in intended_q if q[0] == "codon_start"]
        if any(int(value) != frame for _, value in starts) or (not starts and frame != 1):
            intended_q = [q for q in intended_q if q[0] != "codon_start"] + [["codon_start", str(frame)]]
    xml = feature_xml(encode_rich(rng, name) if name else "", ftype, seg_xml, qualifiers, direction, frame_attrs)
    truth = {"type": ftype, "name": name, "strand": strand, "segments": intended_segments, "plain_qualifiers": intended_q, "segment_names": names}
    return xml, truth


def random_file(rng: random.Random, index: int):
    length = rng.randint(20, 700)
    topology = "circular" if rng.random() < 0.5 else "linear"
    raw_seq = random_sequence(rng, length)
    flags = (1 if topology == "circular" else 0) | (2 if rng.random() < 0.9 else 0) | (rng.choice([0, 28]))
    features, truths = [], []
    for _ in range(rng.randint(0, 7)):
        xml, truth = random_feature(rng, length, topology)
        if xml is not None:
            features.append(xml)
            truths.append(truth)
    primers, primer_truths = [], []
    for k in range(rng.randint(0, 3)):
        pname = random_words(rng, 1, 2)
        pseq = random_sequence(rng, rng.randint(12, 40))
        desc = rng.choice([None, "", random_words(rng)])
        attributes = [("recentID", str(k)), ("name", encode_rich(rng, pname)), ("sequence", pseq)]
        if desc is not None:
            attributes.append(("description", encode_rich(rng, desc) if desc else "<html><body></body></html>"))
        primers.append(el("Primer", attributes))
        truth = {"name": pname, "sequence": pseq.upper().replace("U", "T")}
        if desc:
            truth["description"] = desc
        primer_truths.append(truth)
    description = random_words(rng, 0, 8)
    comments = [random_words(rng) if rng.random() < 0.8 else "" for _ in range(rng.randint(1, 3))]
    comments = [c for i, c in enumerate(comments) if c or (0 < i < len(comments) - 1)]
    note_fields = [
        f"<UUID>{rng.getrandbits(32):08x}-0000-4000-8000-{rng.getrandbits(48):012x}</UUID>",
        f"<Type>{rng.choice(['Natural', 'Synthetic'])}</Type>",
        f'<Created UTC="{rng.randint(0, 23)}:{rng.randint(0, 59)}:{rng.randint(0, 59)}">20{rng.randint(10, 26)}.{rng.randint(1, 12)}.{rng.randint(1, 28)}</Created>',
        f"<LastModified>20{rng.randint(10, 26)}.{rng.randint(1, 12)}.{rng.randint(1, 28)}</LastModified>",
        f"<SequenceClass>{rng.choice(['UNA', 'PHG', 'BCT', 'unknown'])}</SequenceClass>",
    ]
    if description:
        note_fields.append(f"<Description>{xml_text(encode_rich(rng, description))}</Description>")
    if comments and any(comments):
        note_fields.append(f"<Comments>{xml_text(encode_block(rng, comments))}</Comments>")
    if rng.random() < 0.5:
        note_fields.append(f"<Organism>{xml_text(random_words(rng, 1, 2))}</Organism>")
    rng.shuffle(note_fields)
    up = down = 0
    if topology == "linear" and rng.random() < 0.5:
        up, down = rng.randint(-5, 5), rng.randint(-5, 5)
        if abs(up) + abs(down) >= length:
            up = down = 0
    body = [
        dna_packet(raw_seq, flags),
        properties_packet(up, down),
        primers_packet(primers),
        notes_packet(note_fields, newlines=rng.random() < 0.7),
    ]
    if features:
        body.insert(2, features_packet(features, next_id=rng.random() < 0.8))
    for _ in range(rng.randint(0, 3)):
        body.insert(rng.randint(1, len(body)), packet(rng.choice([0x02, 0x03, 0x0B, 0x0D, 0x11, 0x1C, 0x0E, 0x23]), bytes(rng.getrandbits(8) for _ in range(rng.randint(0, 30)))))
    data = cookie_packet(1, 15, rng.choice([19, 20])) + b"".join(body)
    truth = {
        "seq": raw_seq.upper().replace("U", "T"),
        "topology": topology,
        "features": truths,
        "primers": primer_truths,
        "description": description,
        "comments": "\n".join(comments).strip("\n"),
        "ends": None if up == 0 and down == 0 else [up, down],
    }
    return data, truth


def check_truth(expected: dict, truth: dict, label: str) -> None:
    """Assert that the independent mapping reads back what the generator encoded."""

    def fail(what):
        raise AssertionError(f"{label}: {what}")

    if expected["seq"] != truth["seq"] or expected["topology"] != truth["topology"]:
        fail("sequence/topology")
    if expected["description"] != truth["description"]:
        fail(f"description {expected['description']!r} != {truth['description']!r}")
    comments = expected["meta"].get("comments", [""])[0] if expected["meta"].get("comments") else ""
    if comments != truth["comments"]:
        fail(f"comments {comments!r} != {truth['comments']!r}")
    if len(expected["features"]) != len(truth["features"]):
        fail("feature count")
    for got, want in zip(expected["features"], truth["features"]):
        if got["segments"] != want["segments"] or got["strand"] != want["strand"] or got["type"] != want["type"]:
            fail(f"feature {want['name']!r} location")
        if want["name"] and got["name"] != want["name"]:
            fail(f"feature name {got['name']!r} != {want['name']!r}")
        plain = [q for q in got["qualifiers"] if q[0] not in ("parts",)]
        for q in want["plain_qualifiers"]:
            if q not in plain:
                fail(f"feature {want['name']!r}: missing qualifier {q!r} in {plain!r}")
    if len(expected["primers"]) != len(truth["primers"]):
        fail("primer count")
    for got, want in zip(expected["primers"], truth["primers"]):
        if got != want:
            fail(f"primer {got!r} != {want!r}")
    ends = expected.get("ends")
    if truth["ends"] is None:
        if ends is not None:
            fail("unexpected ends")
    else:
        up, down = truth["ends"]
        sign = lambda end: (end["length"] if end["kind"] == "5prime" else -end["length"])  # noqa: E731
        if ends is None or sign(ends["left"]) != up or sign(ends["right"]) != down:
            fail(f"ends {ends!r} != {truth['ends']!r}")


# ----------------------------------------------------------------------------------------------
# HTML entity references (for the decoder tests)
# ----------------------------------------------------------------------------------------------


def html_reference_data() -> dict:
    rng = random.Random(RANDOM_SEED + 1)
    samples = []
    names = sorted(html.entities.name2codepoint)
    for _ in range(300):
        parts = []
        for _ in range(rng.randint(1, 12)):
            r = rng.random()
            if r < 0.3:
                parts.append(f"&{rng.choice(names)};")
            elif r < 0.45:
                parts.append(f"&#{rng.choice([rng.randint(0, 0x2FFFF), rng.randint(0, 0x200), rng.randint(0xD7F0, 0xE010), rng.randint(0x10FFF0, 0x110010)])};")
            elif r < 0.55:
                parts.append(f"&#x{rng.randint(0, 0x2FFFF):x};")
            elif r < 0.62:
                parts.append(rng.choice(["&unknownentity;", "&;", "& ", "&#;", "AT&T", "&#xZZ;"]))
            else:
                parts.append(rng.choice(WORDS))
        samples.append("".join(parts))
    html_samples = []
    for _ in range(200):
        text = random_words(rng, 1, 8)
        html_samples.append(encode_rich(rng, text))
        lines = [random_words(rng) if rng.random() < 0.85 else "" for _ in range(rng.randint(1, 4))]
        lines = [line for i, line in enumerate(lines) if line or 0 < i < len(lines) - 1]
        if lines:
            html_samples.append(encode_block(rng, lines))
    return {
        "name2codepoint": html.entities.name2codepoint,
        # Code points the current HTML standard (and html.unescape) assigns to the HTML 4.01 names.
        "html5": {name: ord(html.entities.html5[name + ";"]) for name in html.entities.name2codepoint},
        "invalid_charrefs": {str(k): ord(v) for k, v in html_lib._invalid_charrefs.items()},  # noqa: SLF001
        "unescape": [[s, html_lib.unescape(s)] for s in samples],
        "render": [[s, render(s, "line"), render(s, "block")] for s in html_samples],
    }


# ----------------------------------------------------------------------------------------------
# Main
# ----------------------------------------------------------------------------------------------


def write_json(path: str, value, compact: bool = False) -> None:
    with open(path, "w", encoding="utf-8") as handle:
        if compact:
            json.dump(value, handle, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
        else:
            json.dump(value, handle, ensure_ascii=False, indent=1, sort_keys=True)
        handle.write("\n")
    size = os.path.getsize(path)
    if size > 2_000_000:
        raise SystemExit(f"{path} is {size} bytes (limit 2 MB)")
    print(f"wrote {os.path.relpath(path, ROOT)} ({size} bytes)")


def regenerate() -> None:
    os.makedirs(CASES_DIR, exist_ok=True)
    fixtures = {}
    for name in sorted(os.listdir(FIXTURES)):
        if name.endswith(".dna"):
            with open(os.path.join(FIXTURES, name), "rb") as handle:
                fixtures[name] = dump(handle.read(), name)
    write_json(os.path.join(OUT_DIR, "fixtures.json"), {"biopython": Bio.__version__, "files": fixtures})

    cases = {}
    for name, data in sorted(case_files().items()):
        with open(os.path.join(CASES_DIR, f"{name}.dna"), "wb") as handle:
            handle.write(data)
        cases[name] = dump(data, f"{name}.dna")
    write_json(os.path.join(OUT_DIR, "cases.json"), {"biopython": Bio.__version__, "files": cases})

    rng = random.Random(RANDOM_SEED)
    corpus = []
    for index in range(RANDOM_COUNT):
        data, truth = random_file(rng, index)
        entry = dump(data, f"random-{index}.dna")
        check_truth(entry["expected"], truth, f"random-{index}")
        entry["data"] = base64.b64encode(data).decode("ascii")
        corpus.append(entry)
    write_json(os.path.join(OUT_DIR, "random.json"), {"biopython": Bio.__version__, "seed": RANDOM_SEED, "files": corpus}, compact=True)

    write_json(os.path.join(OUT_DIR, "html.json"), html_reference_data())


def main(argv: list[str]) -> int:
    if len(argv) >= 1 and argv[0] == "--dump":
        result = {}
        for path in argv[1:]:
            with open(path, "rb") as handle:
                result[path] = dump(handle.read(), os.path.basename(path))
        json.dump(result, sys.stdout, ensure_ascii=False, sort_keys=True)
        sys.stdout.write("\n")
        return 0
    regenerate()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
