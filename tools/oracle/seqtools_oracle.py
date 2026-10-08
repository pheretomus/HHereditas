"""
Reference data ("oracle") for the seqtools module of @hhereditas/core
(packages/core/src/seq/{codon-tables,translate,orf,search,stats}.ts).

Writes JSON files into packages/core/test/oracle/seqtools/ that the Vitest suites compare the
TypeScript implementation against:

  tables.json     every NCBI table of Biopython's Bio.Data.CodonTable (forward table, starts, stops)
  codons.json     for every table, the translation of all 15^3 IUPAC codons, and whether Biopython's
                  ambiguous tables list each one as a start / stop codon
  translate.json  Bio.Seq.translate on random DNA/RNA (ambiguous codes, mixed case, U) for every
                  table and frame, with/without to_stop, and cds=True on valid random CDSs
  features.json   CDS features of the GenBank fixtures and of the NCBI records in
                  test/oracle/seqtools/ncbi/ (parsed by Biopython): segments in the HHereditas
                  convention, qualifiers, NCBI's /translation and Biopython's
                  SeqFeature.translate(cds=False) output
  stats.json      gc_fraction, molecular_weight (DNA/RNA, ss/ds, linear/circular, average and
                  monoisotopic), ProteinAnalysis molecular_weight / isoelectric_point /
                  charge_at_pH / molar_extinction_coefficient on random inputs, and pIRoot: the
                  root of the same charge_at_pH found by charge_root() below
  orfs.json       ORF lists from brute_force_orfs() below (written from the definition, see its
                  docstring) on random and stop-poor sequences with random options
  search.json     hits from brute_force_search() / brute_force_protein_search() below

Everything is seeded and deterministic; re-run with
    tools/oracle/.venv/bin/python -I tools/oracle/seqtools_oracle.py

Related files: seqtools_codons.py generates src/seq/codon-tables.ts from Bio.Data.CodonTable;
seqtools_live_cds.py is the live oracle translate.test.ts runs on the (gitignored) E. coli genome;
test/oracle/seqtools/ncbi_gc.prt is a verbatim copy of NCBI's gc.prt (version 4.6, downloaded
2026-10-08 from https://ftp.ncbi.nih.gov/entrez/misc/data/gc.prt) that codon-tables.test.ts parses.

test/oracle/seqtools/ncbi/*.gb are verbatim GenBank records downloaded 2026-10-08 with
    https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=nuccore&id=<ACCESSION.VERSION>&rettype=gbwithparts&retmode=text
They were chosen from 1,643 CDSs of 1,400 recent "partial cds" records (all of whose /translation
follow this rule) for CDSs whose length after /codon_start is not a multiple of 3: NCBI pads the 1-2
trailing bases with N and keeps the residue unless it is X (GC -> A kept; GA -> GAN = D/E dropped;
one base dropped).
They cover both strands (LC910909.1 complement(<1..65)), /codon_start 1-3, tables 1, 2, 4, 11 and 13
and a joined CDS (PZ798277.1).
"""
import json
import random
import warnings
from pathlib import Path

import Bio
from Bio import BiopythonWarning, SeqIO
from Bio.Data import CodonTable, IUPACData
from Bio.Seq import translate as bio_translate
from Bio.SeqFeature import AfterPosition, BeforePosition, CompoundLocation
from Bio.SeqUtils import gc_fraction, molecular_weight
from Bio.SeqUtils.ProtParam import ProteinAnalysis

warnings.simplefilter("ignore", BiopythonWarning)

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "packages/core/test/oracle/seqtools"
FIXTURES = ROOT / "packages/core/test/fixtures"

IUPAC = "ACGTRYSWKMBDHVN"
IUPAC_SETS = {k: set(v) for k, v in IUPACData.ambiguous_dna_values.items() if k in IUPAC}
COMPLEMENT = str.maketrans("ACGTRYSWKMBDHVN", "TGCAYRSWMKVHDBN")
TABLE_IDS = sorted(CodonTable.unambiguous_dna_by_id)


def revcomp(s):
    return s.translate(COMPLEMENT)[::-1]


def write(name, data):
    OUT.mkdir(parents=True, exist_ok=True)
    text = json.dumps(data, separators=(",", ":"), sort_keys=True)
    (OUT / name).write_text(text + "\n", encoding="utf-8", newline="\n")
    print(f"wrote {name}: {len(text) / 1024:.0f} KiB")
    assert len(text) < 2_000_000, name


def meta():
    return {"generator": "tools/oracle/seqtools_oracle.py", "biopython": Bio.__version__}


# ---------------------------------------------------------------------------
# Codon tables and translation
# ---------------------------------------------------------------------------


def gen_tables():
    tables = []
    for tid in TABLE_IDS:
        t = CodonTable.unambiguous_dna_by_id[tid]
        tables.append(
            {
                "id": tid,
                "names": [n for n in t.names if n],
                "forward": dict(sorted(t.forward_table.items())),
                "starts": list(t.start_codons),
                "stops": list(t.stop_codons),
            }
        )
    write("tables.json", {"meta": meta(), "tables": tables})


def all_iupac_codons():
    return [a + b + c for a in IUPAC for b in IUPAC for c in IUPAC]


def gen_codons():
    codons = all_iupac_codons()
    per_table = []
    for tid in TABLE_IDS:
        amb = CodonTable.ambiguous_dna_by_id[tid]
        starts = set(amb.start_codons)
        stops = set(amb.stop_codons)
        aa = "".join(bio_translate(c, table=tid) for c in codons)
        per_table.append(
            {
                "id": tid,
                "aa": aa,
                "start": "".join("1" if c in starts else "0" for c in codons),
                "stop": "".join("1" if c in stops else "0" for c in codons),
            }
        )
    write("codons.json", {"meta": meta(), "alphabet": IUPAC, "tables": per_table})


def random_nt(rng, n, ambiguous_rate=0.0, rna_rate=0.0, lower_rate=0.0):
    out = []
    for _ in range(n):
        if rng.random() < ambiguous_rate:
            ch = rng.choice("RYSWKMBDHVN")
        else:
            ch = rng.choice("ACGT")
        if ch == "T" and rng.random() < rna_rate:
            ch = "U"
        if rng.random() < lower_rate:
            ch = ch.lower()
        out.append(ch)
    return "".join(out)


def has_context_stops(tid):
    t = CodonTable.unambiguous_dna_by_id[tid]
    return any(c in t.forward_table for c in t.stop_codons)


def random_cds(rng, tid, n_codons, ambiguous_rate):
    """A valid CDS for Biopython's cds=True: start codon, n non-stop codons, stop codon.

    Some body codons get one base replaced by an ambiguity code, as long as Biopython still does
    not read the result as a stop codon (it raises on an internal stop when cds=True).
    """
    t = CodonTable.unambiguous_dna_by_id[tid]
    ambiguous_stops = set(CodonTable.ambiguous_dna_by_id[tid].stop_codons)
    coding = [c for c in t.forward_table if c not in t.stop_codons]
    body = []
    for _ in range(n_codons):
        codon = rng.choice(coding)
        if rng.random() < ambiguous_rate:
            i = rng.randrange(3)
            cand = codon[:i] + rng.choice("RYSWKMBDHVN") + codon[i + 1:]
            if cand not in ambiguous_stops and bio_translate(cand, table=tid) != "*":
                codon = cand
        body.append(codon)
    return rng.choice(t.start_codons) + "".join(body) + rng.choice(t.stop_codons)


def gen_translate():
    rng = random.Random(20261008)
    cases = []
    for tid in TABLE_IDS:
        for k in range(14):
            n = rng.choice([0, 1, 2, 3, 4, 5, 8, 30, 61, 150, 299, 300])
            amb = rng.choice([0.0, 0.0, 0.05, 0.2, 0.5])
            seq = random_nt(rng, n, ambiguous_rate=amb, rna_rate=0.3 if k % 4 == 1 else 0.0,
                            lower_rate=0.3 if k % 5 == 2 else 0.0)
            for frame in (0, 1, 2):
                sub = seq[frame:]
                plain = bio_translate(sub, table=tid)
                case = {"seq": seq, "table": tid, "frame": frame, "expected": plain}
                if has_context_stops(tid):
                    case["toStopError"] = True
                else:
                    case["expectedToStop"] = bio_translate(sub, table=tid, to_stop=True)
                cases.append(case)
    cds_cases = []
    for tid in TABLE_IDS:
        for _ in range(6):
            seq = random_cds(rng, tid, rng.randrange(0, 40), rng.choice([0.0, 0.1]))
            cds_cases.append({"seq": seq, "table": tid, "expected": bio_translate(seq, table=tid, cds=True)})
    write("translate.json", {"meta": meta(), "cases": cases, "cdsCases": cds_cases})


# ---------------------------------------------------------------------------
# CDS features of the GenBank fixtures
# ---------------------------------------------------------------------------

FEATURE_FILES = [
    "NC_005816.gb",
    "pBR322_J01749.gb",
    "EU851978.gbk",
    "HM138502.gbk",
    "KF527485.gbk",
    "addgene-plasmid-11664-sequence-180430.gbk",
    "addgene-plasmid-39296-sequence-49545.gbk",
    "arab1.gb",
    "bad_loc_wrap.gb",
    "bad_origin_wrap_CDS.gb",
    "cor6_6.gb",
    "extra_keywords.gb",
    "one_of.gb",
]


def to_segments(loc):
    """Biopython location -> (strand, segments in top-strand join order, partialStart, partialEnd)."""
    parts = list(loc.parts) if isinstance(loc, CompoundLocation) else [loc]
    if any(p.ref is not None for p in parts):
        return None  # part of the feature lies on another GenBank record
    strands = {p.strand for p in parts}
    if len(strands) != 1:
        return None  # mixed-strand (trans-spliced) features cannot be represented
    strand = parts[0].strand if parts[0].strand in (1, -1) else 0
    if strand == -1:
        parts = list(reversed(parts))  # Biopython lists minus-strand parts 5'->3' on the minus strand
    segs = [{"start": int(p.start), "end": int(p.end)} for p in parts]
    partial_start = isinstance(parts[0].start, (BeforePosition, AfterPosition))
    partial_end = isinstance(parts[-1].end, (BeforePosition, AfterPosition))
    return strand, segs, partial_start, partial_end


NCBI_RECORDS = OUT / "ncbi"


def gen_features():
    records = []
    sources = [(name, FIXTURES / "genbank" / name) for name in FEATURE_FILES]
    sources += [(f"ncbi/{path.name}", path) for path in sorted(NCBI_RECORDS.glob("*.gb"))]
    for name, path in sources:
        for ri, rec in enumerate(SeqIO.parse(str(path), "genbank")):
            seq = str(rec.seq).upper()
            feats = []
            for f in rec.features:
                if f.type != "CDS" or f.location is None:
                    continue
                conv = to_segments(f.location)
                if conv is None:
                    continue
                strand, segs, ps, pe = conv
                quals = [{"key": k, "value": v} for k, vs in f.qualifiers.items() for v in vs]
                try:
                    plain = str(f.translate(rec.seq, cds=False))
                except Exception as e:  # noqa: BLE001 - recorded, the test expects a throw
                    plain = {"error": f"{type(e).__name__}: {e}"}
                feats.append(
                    {
                        "type": f.type,
                        "strand": strand,
                        "segments": segs,
                        "partialStart": ps,
                        "partialEnd": pe,
                        "qualifiers": [q for q in quals if q["key"] != "translation"],
                        "translation": f.qualifiers.get("translation", [None])[0],
                        "bioPlain": plain,
                    }
                )
            if feats:
                topology = rec.annotations.get("topology", "linear")
                records.append(
                    {
                        "file": name,
                        "record": ri,
                        "id": rec.id,
                        "topology": "circular" if topology == "circular" else "linear",
                        "seq": seq,
                        "features": feats,
                    }
                )
    write("features.json", {"meta": meta(), "records": records})


# ---------------------------------------------------------------------------
# Statistics
# ---------------------------------------------------------------------------

AA20 = "ACDEFGHIKLMNPQRSTVWY"


def charge_root(pa):
    """The pH at which pa.charge_at_pH (Biopython's Bjellqvist charge model) changes sign.

    ProteinAnalysis.isoelectric_point() bisects only within [4.05, 12] and returns that interval's
    bound when the root lies outside. The charge decreases strictly with pH, from about +1 or more
    (N-terminus) to -1 or less (C-terminus), so the root is unique: widen [lo, hi] until the charge
    is positive at lo and not positive at hi, then bisect to floating-point resolution.
    """
    lo, hi = -1.0, 15.0
    while pa.charge_at_pH(lo) <= 0:
        lo -= 16.0
    while pa.charge_at_pH(hi) > 0:
        hi += 16.0
    for _ in range(200):
        mid = (lo + hi) / 2
        if mid in (lo, hi):
            break
        if pa.charge_at_pH(mid) > 0:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2


def gen_stats():
    rng = random.Random(1234567)
    gc = []
    for _ in range(300):
        n = rng.choice([0, 1, 2, 5, 17, 100, 1000])
        alphabet = rng.choice(["ACGT", "ACGTSW", "ACGTN", "ACGTRYSWKMBDHVN", "ACGU", "acgtSWn"])
        s = "".join(rng.choice(alphabet) for _ in range(n))
        gc.append({"seq": s, "expected": gc_fraction(s, "remove")})
    mw = []
    for _ in range(400):
        molecule = rng.choice(["DNA", "RNA"])
        n = rng.choice([1, 2, 3, 10, 50, 1000])
        letters = "ACGT" if molecule == "DNA" else "ACGU"
        s = "".join(rng.choice(letters) for _ in range(n))
        if rng.random() < 0.2:
            s = s.lower()
        ds = rng.random() < 0.5
        circ = rng.random() < 0.3
        mono = rng.random() < 0.3
        mw.append(
            {
                "seq": s,
                "molecule": molecule,
                "doubleStranded": ds,
                "circular": circ,
                "monoisotopic": mono,
                "expected": molecular_weight(s, molecule, double_stranded=ds, circular=circ, monoisotopic=mono),
            }
        )
    proteins = []
    for i in range(400):
        n = rng.choice([1, 2, 3, 5, 20, 100, 500])
        if i % 10 == 0:
            alphabet = "DEDEK"  # very acidic: pI mostly below Biopython's bisection interval [4.05, 12]
        elif i % 10 == 1:
            alphabet = "KRKRH"  # very basic: pI mostly above it
        elif i % 10 == 2:
            alphabet = AA20 + "UO"  # selenocysteine / pyrrolysine weights
        else:
            alphabet = AA20
        p = "".join(rng.choice(alphabet) for _ in range(n))
        if rng.random() < 0.1:
            p = p.lower()
        pa = ProteinAnalysis(p)
        entry = {
            "protein": p,
            "mw": pa.molecular_weight(),
            "pI": pa.isoelectric_point(),
            "pIRoot": charge_root(pa),
            "extinction": list(pa.molar_extinction_coefficient()),
            "charge": [[ph, pa.charge_at_pH(ph)] for ph in (2.0, 5.5, 7.0, 7.4, 9.0, 12.5)],
        }
        proteins.append(entry)
    # Ambiguous residues: Biopython ignores them for pI / extinction (molecular_weight raises).
    ambiguous = []
    for _ in range(60):
        n = rng.choice([2, 10, 60])
        p = "".join(rng.choice(AA20 + "XBZJ") for _ in range(n))
        pa = ProteinAnalysis(p)
        ambiguous.append(
            {
                "protein": p,
                "pI": pa.isoelectric_point(),
                "pIRoot": charge_root(pa),
                "extinction": list(pa.molar_extinction_coefficient()),
            }
        )
    write("stats.json", {"meta": meta(), "gc": gc, "mw": mw, "proteins": proteins, "ambiguousProteins": ambiguous})


# ---------------------------------------------------------------------------
# ORFs: brute force from the definition
# ---------------------------------------------------------------------------


def expansions(codon):
    return [a + b + c for a in sorted(IUPAC_SETS[codon[0]]) for b in sorted(IUPAC_SETS[codon[1]])
            for c in sorted(IUPAC_SETS[codon[2]])]


def is_stop(codon, tid):
    stops = CodonTable.unambiguous_dna_by_id[tid].stop_codons
    return all(e in stops for e in expansions(codon))


def is_start(codon, tid, mode):
    if mode == "ATG":
        return codon == "ATG"
    starts = CodonTable.unambiguous_dna_by_id[tid].start_codons
    return all(e in starts for e in expansions(codon))


def brute_force_orfs(seq, topology, opts):
    """ORFs straight from the definition (Orf in packages/core/src/types.ts), O(L * ORF length).

    For each strand, read 5'->3' on that strand (the bottom strand is the reverse complement, with
    local index x <-> top-strand base L-1-x). Every start codon at local index x (x in [0, L) on a
    circular molecule, reading across the origin; x in [0, L-3] on a linear one) opens a reading
    frame. Codons x+3k, k = 1, 2, ... are examined while the codon fits: linear x+3k+3 <= L,
    circular 3k+3 <= L (an ORF never covers more than one full turn). The first codon whose every
    IUPAC expansion is a stop codon of the table closes the ORF [x, x+3k+3) with aaLength k.
    A start codon is 'ATG' exactly, or (startCodons='table') a codon whose every expansion is a
    start codon of the table. Without a stop: if allowNoStop, the ORF runs to the last complete
    codon (linear: [x, x+3*floor((L-x)/3)); circular: one full turn [x, x+3*floor(L/3))), hasStop
    false; otherwise there is no ORF.
    Unless includeNested, ORFs are grouped by family and only the longest of each is kept:
    with a stop -> family = (strand, stop codon index mod L); without -> family = (strand, x mod 3)
    on linear molecules and on circular molecules whose length is a multiple of 3, (strand) on other
    circular molecules (one reading-frame cycle); ties (same length) keep the smallest local x.
    Then aaLength >= minAaLength is required, local ranges are mapped to top-strand coordinates
    (bottom: [L-b, L-a), +L when negative) and sorted by (start, end, strand desc).
    frame = local x mod 3 (for the bottom strand: relative to the end of the sequence).
    """
    L = len(seq)
    circular = topology == "circular"
    tid = opts["table"]
    mode = opts["startCodons"]
    strands = {"both": (1, -1), "top": (1,), "bottom": (-1,)}[opts["strands"]]
    out = []
    if L < 3:
        return out
    for strand in strands:
        s = seq if strand == 1 else revcomp(seq)

        def codon_at(x):
            return "".join(s[(x + i) % L] for i in range(3))

        cands = []
        for x in range(L) if circular else range(L - 2):
            if not is_start(codon_at(x), tid, mode):
                continue
            max_codons = L // 3 if circular else (L - x) // 3
            found = None
            for k in range(1, max_codons):
                if is_stop(codon_at(x + 3 * k), tid):
                    found = k
                    break
            if found is not None:
                cands.append((x, x + 3 * found + 3, found, True, ("stop", (x + 3 * found) % L)))
            elif opts["allowNoStop"]:
                fam = x % 3 if (not circular or L % 3 == 0) else 0
                cands.append((x, x + 3 * max_codons, max_codons, False, ("open", fam)))
        if not opts["includeNested"]:
            best = {}
            for c in cands:
                b = best.get(c[4])
                if b is None or c[2] > b[2] or (c[2] == b[2] and c[0] < b[0]):
                    best[c[4]] = c
            cands = list(best.values())
        for a, b, aa, has_stop, _ in cands:
            if aa < opts["minAaLength"]:
                continue
            if strand == 1:
                start, end = a, b
            else:
                start, end = L - b, L - a
                if start < 0:
                    start += L
                    end += L
            out.append({"start": start, "end": end, "strand": strand, "frame": a % 3, "aaLength": aa, "hasStop": has_stop})
    out.sort(key=lambda o: (o["start"], o["end"], -o["strand"]))
    return out


def stop_poor_seq(rng, n, tid):
    """Concatenated non-stop codons of frame 0 (long ORFs; other frames still have stops)."""
    t = CodonTable.unambiguous_dna_by_id[tid]
    coding = [c for c in t.forward_table if c not in t.stop_codons]
    s = "".join(rng.choice(coding) if rng.random() > 0.05 else "ATG" for _ in range(n // 3 + 1))
    return s[:n]


def gen_orfs():
    rng = random.Random(777)
    cases = []
    tables = [1, 1, 1, 2, 4, 11, 11, 12, 22, 23, 27, 28, 31, 33]
    for i in range(400):
        tid = rng.choice(tables)
        L = rng.choice([0, 1, 2, 3, 4, 5, 6, 7, 9, 10, 20, 30, 31, 32, 60, 61, 62, 150, 301, 302, 303, 600])
        kind = i % 4
        if kind == 0:
            seq = random_nt(rng, L)
        elif kind == 1:
            seq = stop_poor_seq(rng, L, tid)
        elif kind == 2:
            seq = random_nt(rng, L, ambiguous_rate=0.08)
        else:
            seq = "".join(rng.choice(["ATG", "ATG", "AAA", "TAA", "TTG", "GTG", "CCC"]) for _ in range(L // 3 + 1))[:L]
            seq = seq[: max(0, L - rng.randrange(3))]
        topology = rng.choice(["linear", "circular"])
        opts = {
            "minAaLength": rng.choice([0, 0, 1, 1, 2, 3, 5, 10, 30, 100]),
            "table": tid,
            "startCodons": rng.choice(["ATG", "table"]),
            "strands": rng.choice(["both", "both", "top", "bottom"]),
            "includeNested": rng.random() < 0.4,
            "allowNoStop": rng.random() < 0.4,
        }
        cases.append({"seq": seq, "topology": topology, "options": opts, "expected": brute_force_orfs(seq, topology, opts)})
    write("orfs.json", {"meta": meta(), "cases": cases})


# ---------------------------------------------------------------------------
# Sequence search: brute force from the definition
# ---------------------------------------------------------------------------


def nt_match(q, t, iupac):
    if not iupac:
        return q == t
    if q not in IUPAC_SETS or t not in IUPAC_SETS:
        return False
    return IUPAC_SETS[t] <= IUPAC_SETS[q]


def brute_force_search(seq, topology, query, opts):
    """Hits of `query` on the requested strands with at most maxMismatches mismatches.

    Case-insensitive, U read as T. A window [p, p+m) of the top strand (circular: p in [0, L),
    wrapping; linear: p in [0, L-m]; m > L never matches) is a strand +1 hit when position i
    mismatches query[i] at most maxMismatches times, and a strand -1 hit likewise for
    revcomp(query). Position match: iupac -> the target code's base set is a subset of the query
    code's set (target N only matches query N); not iupac -> identical letters. When the query is
    its own reverse complement and both strands are searched, only strand +1 hits are reported.
    Sorted by (start, strand desc).
    """
    s = seq.upper().replace("U", "T")
    q = query.upper().replace("U", "T")
    L, m = len(s), len(q)
    k = opts["maxMismatches"]
    iupac = opts["iupac"]
    strands = {"both": (1, -1), "top": (1,), "bottom": (-1,)}[opts["strands"]]
    if opts["strands"] == "both" and revcomp(q) == q:
        strands = (1,)
    hits = []
    if m == 0 or m > L:
        return hits
    positions = range(L) if topology == "circular" else range(L - m + 1)
    for strand in strands:
        pat = q if strand == 1 else revcomp(q)
        for p in positions:
            mm = sum(1 for i in range(m) if not nt_match(pat[i], s[(p + i) % L], iupac))
            if mm <= k:
                hits.append({"start": p, "end": p + m, "strand": strand, "mismatches": mm})
    hits.sort(key=lambda h: (h["start"], -h["strand"]))
    return hits


# Peptide letters that stand for a recoded stop codon: selenocysteine (U) is read from UGA, pyrrolysine
# (O) from UAG.
RECODED_CODON = {"U": "TGA", "O": "TAG"}


def pep_match(q, t, codon, tid):
    """Peptide letter q against the codon `codon` (uppercase DNA), whose translation in table tid is t.

    U and O match only the codon they are recoded from (TGA / TAG; an ambiguous codon such as TGR
    does not), whatever the table translates it to. '*' matches a stop codon of the table (is_stop:
    every expansion is one), including the context-dependent stops of tables 27, 28 and 31 that
    Biopython translates to their amino acid. Other letters match the translation: equal letters,
    X = any residue but '*', B = D/N/B, Z = E/Q/Z, J = I/L/J.
    """
    if q in RECODED_CODON:
        return codon == RECODED_CODON[q]
    if q == "*":
        return is_stop(codon, tid)
    if q == t:
        return True
    if q == "X":
        return t != "*"
    return t in {"B": "DNB", "Z": "EQZ", "J": "ILJ"}.get(q, "")


def brute_force_protein_search(seq, topology, peptide, tid):
    """Windows of 3n bases (n = peptide length) on either strand whose codons match the peptide
    (pep_match, translation by Biopython with table tid). Windows as in brute_force_search (circular
    windows wrap, 3n <= L). frame = local start mod 3 (bottom strand: relative to the end).
    Sorted by (start, strand desc).
    """
    s = seq.upper().replace("U", "T")
    L, n = len(s), len(peptide)
    w = 3 * n
    hits = []
    if n == 0 or w > L:
        return hits
    positions = range(L) if topology == "circular" else range(L - w + 1)
    for strand in (1, -1):
        t = s if strand == 1 else revcomp(s)
        for p in positions:
            window = "".join(t[(p + i) % L] for i in range(w))
            prot = bio_translate(window, table=tid)
            if all(pep_match(a, b, window[3 * k: 3 * k + 3], tid) for k, (a, b) in enumerate(zip(peptide, prot))):
                if strand == 1:
                    start, end = p, p + w
                else:
                    start, end = L - (p + w), L - p
                    if start < 0:
                        start += L
                        end += L
                hits.append({"start": start, "end": end, "strand": strand, "mismatches": 0, "frame": p % 3})
    hits.sort(key=lambda h: (h["start"], -h["strand"], h["end"]))
    return hits


def gen_search():
    rng = random.Random(4242)
    cases = []
    for i in range(300):
        L = rng.choice([0, 1, 3, 8, 20, 50, 200, 500])
        seq = random_nt(rng, L, ambiguous_rate=rng.choice([0.0, 0.0, 0.05]), lower_rate=0.1 if i % 7 == 0 else 0.0)
        topology = rng.choice(["linear", "circular"])
        m = rng.choice([1, 2, 3, 4, 6, 8, 12, 20])
        if L >= m and rng.random() < 0.6:
            p = rng.randrange(L)
            query = "".join(seq[(p + j) % L] for j in range(m)).upper()  # guaranteed hit (wraps sometimes)
            if rng.random() < 0.5:
                query = revcomp(query)
        else:
            query = random_nt(rng, m)
        if rng.random() < 0.3:
            query = "".join(rng.choice("RYSWKMBDHVN") if rng.random() < 0.3 else c for c in query)
        if rng.random() < 0.15:
            half = random_nt(rng, max(1, m // 2))
            query = half + revcomp(half)  # palindrome
        opts = {
            "strands": rng.choice(["both", "both", "top", "bottom"]),
            "maxMismatches": rng.choice([0, 0, 1, 2, 3]),
            "iupac": rng.random() < 0.8,
        }
        cases.append({"seq": seq, "topology": topology, "query": query, "options": opts,
                      "expected": brute_force_search(seq, topology, query, opts)})
    protein_cases = []
    for i in range(150):
        tid = rng.choice([1, 1, 2, 11, 27, 31])
        L = rng.choice([0, 3, 10, 30, 31, 32, 100, 301])
        seq = random_nt(rng, L, ambiguous_rate=rng.choice([0.0, 0.03]))
        topology = rng.choice(["linear", "circular"])
        n = rng.choice([1, 2, 3, 4])
        if L >= 3 * n and rng.random() < 0.7:
            strand_seq = seq if rng.random() < 0.5 else revcomp(seq)
            p = rng.randrange(L)
            window = "".join(strand_seq[(p + j) % L] for j in range(3 * n))
            peptide = bio_translate(window, table=tid)
        else:
            peptide = "".join(rng.choice(AA20 + "*") for _ in range(n))
        if rng.random() < 0.3:
            peptide = "".join(rng.choice("XBZJ") if rng.random() < 0.3 else c for c in peptide)
        protein_cases.append({"seq": seq, "topology": topology, "peptide": peptide, "table": tid,
                              "expected": brute_force_protein_search(seq, topology, peptide, tid)})
    write("search.json", {"meta": meta(), "cases": cases, "proteinCases": protein_cases,
                          "recodedProteinCases": gen_recoded_protein_cases()})


def gen_recoded_protein_cases():
    """Protein search cases with U / O in the peptide, and '*' at context-dependent stop codons (own
    seed, so the cases of gen_search() keep theirs). Sequences are built from codons rich in TGA / TAG
    and in ambiguous TGR / TRG / TAR, which U / O must not match; most cases plant a TGA or TAG codon
    inside a window on either strand (circular windows may cross the origin) and derive the peptide
    from that window, writing U / O for most recoded codons and '*' for most context-dependent stop
    codons. Tables read TGA / TAG as stops (1, 11), as amino acids (2, 6, 10, 25) or as both (27, 28,
    31).
    """
    rng = random.Random(4243)
    pool = ["TGA", "TAG", "TAA", "ATG", "AAA", "GCT", "TGG", "TTT", "CAG", "TGR", "TRG", "TAR", "TCA", "CTA"]
    base_complement = {"A": "T", "C": "G", "G": "C", "T": "A"}
    cases = []
    for i in range(200):
        tid = rng.choice([1, 1, 2, 6, 10, 11, 25, 27, 27, 28, 28, 31, 31])
        L = rng.choice([3, 9, 10, 30, 31, 32, 100, 301])
        seq = list("".join(rng.choice(pool) for _ in range(L // 3 + 1))[:L])
        topology = rng.choice(["linear", "circular"])
        n = rng.choice([1, 2, 3, 4])
        w = 3 * n
        peptide = None
        if L >= w and rng.random() < 0.85:
            top = rng.random() < 0.6
            last = L - 1 if topology == "circular" else L - w
            p = rng.randrange(last + 1)
            planted = rng.choice(["TGA", "TAG"])
            k = rng.randrange(n)
            for j, b in enumerate(planted):
                x = (p + 3 * k + j) % L  # index on the chosen strand
                if top:
                    seq[x] = b
                else:
                    seq[L - 1 - x] = base_complement[b]
            strand_seq = "".join(seq) if top else revcomp("".join(seq))
            window = "".join(strand_seq[(p + j) % L] for j in range(w))
            letters = []
            for c, aa in enumerate(bio_translate(window, table=tid)):
                codon = window[3 * c: 3 * c + 3]
                recoded = {"TGA": "U", "TAG": "O"}.get(codon)
                context_stop = aa != "*" and is_stop(codon, tid)  # tables 27, 28, 31
                r = rng.random()
                if recoded is not None and r < (0.45 if context_stop else 0.8):
                    letters.append(recoded)
                elif context_stop and r < 0.9:
                    letters.append("*")
                else:
                    letters.append(aa)
            peptide = "".join(letters)
        else:
            peptide = "".join(rng.choice(AA20 + "*UOX") for _ in range(n))
        seq = "".join(seq)
        if i % 9 == 4:
            seq = seq.lower()
        cases.append({"seq": seq, "topology": topology, "peptide": peptide, "table": tid,
                      "expected": brute_force_protein_search(seq, topology, peptide, tid)})
    return cases


def main():
    gen_tables()
    gen_codons()
    gen_translate()
    gen_features()
    gen_stats()
    gen_orfs()
    gen_search()


if __name__ == "__main__":
    main()
