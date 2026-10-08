"""
Generate packages/core/src/seq/codon-tables.ts from Biopython's NCBI codon tables.

Source of truth: Biopython 1.88, Bio.Data.CodonTable, which is itself generated from the NCBI
genetic code file gc.prt (https://ftp.ncbi.nih.gov/entrez/misc/data/gc.prt, data version 4.5).
The generated TypeScript stores each table in NCBI's own layout (the 64 codons in TCAG order,
the `ncbieaa` string of gc.prt) plus explicit start / stop codon lists, so the file can be checked
by eye against https://www.ncbi.nlm.nih.gov/Taxonomy/Utils/wprintgc.cgi . The Vitest suite
(codon-tables.test.ts) additionally checks the generated data against a copy of NCBI gc.prt
(packages/core/test/oracle/seqtools/ncbi_gc.prt) and against tables.json written by
seqtools_oracle.py.

Deterministic and re-runnable:
    tools/oracle/.venv/bin/python -I tools/oracle/seqtools_codons.py            # write the file
    tools/oracle/.venv/bin/python -I tools/oracle/seqtools_codons.py --stdout   # print it instead
"""
import ast
import inspect
import re
import sys
from pathlib import Path

import Bio
from Bio.Data import CodonTable

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "packages/core/src/seq/codon-tables.ts"
# Copy of https://ftp.ncbi.nih.gov/entrez/misc/data/gc.prt (version 4.6, downloaded 2026-10-08).
NCBI_GC_PRT = ROOT / "packages/core/test/oracle/seqtools/ncbi_gc.prt"

BASES = "TCAG"
NCBI_ORDER = [a + b + c for a in BASES for b in BASES for c in BASES]
STANDARD_AA = set("ACDEFGHIKLMNPQRSTVWY")


def raw_names():
    """The `name` / `alt_name` arguments of every register_ncbi_table(...) call, keyed by table id.

    Biopython splits the NCBI name into several aliases ('Bacterial', 'Archaeal', 'Plant Plastid');
    the original string ('Bacterial, Archaeal and Plant Plastid') is the better display name, so it
    is read back from the module source.
    """
    tree = ast.parse(inspect.getsource(CodonTable))
    out = {}
    for node in ast.walk(tree):
        if (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Name)
            and node.func.id == "register_ncbi_table"
        ):
            kw = {k.arg: k.value for k in node.keywords}
            if "id" not in kw:
                continue  # the def's own recursive references, if any
            tid = ast.literal_eval(kw["id"])
            out[tid] = (ast.literal_eval(kw["name"]), ast.literal_eval(kw["alt_name"]))
    return out


def ncbi_names():
    """Names of every table in the vendored NCBI gc.prt, keyed by id ({} when the file is absent).

    NCBI renames codes from time to time (gc.prt 4.6 renamed table 24 'Pterobranchia Mitochondrial'
    to 'Rhabdopleuridae Mitochondrial'); current NCBI names are added as aliases so a search for
    either finds the table.
    """
    if not NCBI_GC_PRT.exists():
        return {}
    text = "\n".join(
        line for line in NCBI_GC_PRT.read_text(encoding="ascii").splitlines()
        if not line.lstrip().startswith("--")
    )
    out = {}
    for block in re.findall(r"\{([^{}]*)\}", text):
        m = re.search(r"\bid\s+(\d+)", block)
        if not m:
            continue
        names = [" ".join(n.split()) for n in re.findall(r'name\s+"([^"]*)"', block)]
        out[int(m.group(1))] = names
    return out


def table_rows():
    names = raw_names()
    current = ncbi_names()
    rows = []
    for tid, table in sorted(CodonTable.unambiguous_dna_by_id.items()):
        fwd = table.forward_table
        starts = list(table.start_codons)
        stops = list(table.stop_codons)
        ncbieaa = "".join(fwd.get(c, "*") for c in NCBI_ORDER)
        # Sanity checks the TypeScript engine relies on.
        assert len(fwd) + sum(1 for c in NCBI_ORDER if c not in fwd) == 64
        for c in NCBI_ORDER:
            if c not in fwd:
                assert c in stops, (tid, c, "codon neither translated nor a stop")
        assert set(fwd.values()) <= STANDARD_AA, (tid, set(fwd.values()) - STANDARD_AA)
        assert not set(starts) & set(stops), (tid, "a codon is both start and stop")
        assert all(c in NCBI_ORDER for c in starts + stops)
        name, alt = names[tid]
        aliases = [n for n in table.names if n]
        all_names = aliases if name in aliases else [name] + aliases
        for n in current.get(tid, []):
            if n not in all_names:
                all_names.append(n)
        rows.append(
            {
                "id": tid,
                "name": name,
                "names": all_names,
                "alt": alt,
                "ncbieaa": ncbieaa,
                "starts": starts,
                "stops": stops,
            }
        )
    return rows


def ts_str(s):
    return "'" + s.replace("\\", "\\\\").replace("'", "\\'") + "'"


def ts_list(items):
    return "[" + ", ".join(ts_str(x) for x in items) + "]"


def ts_field(name, items, indent="    "):
    """`name: [...]` on one line, or one item per line when that would exceed 120 columns."""
    line = f"{indent}{name}: {ts_list(items)},\n"
    if len(line) <= 121:
        return line
    inner = "".join(f"{indent}  {ts_str(x)},\n" for x in items)
    return f"{indent}{name}: [\n{inner}{indent}],\n"


HEADER = """\
/**
 * NCBI genetic codes ("translation tables"): the values of the INSDC `/transl_table` qualifier.
 *
 * GENERATED FILE: do not edit by hand. Regenerate with
 *   tools/oracle/.venv/bin/python -I tools/oracle/seqtools_codons.py
 *
 * Source: Biopython @@BIOPYTHON@@ Bio.Data.CodonTable, itself generated from the NCBI genetic code
 * file gc.prt (data version 4.5), https://ftp.ncbi.nih.gov/entrez/misc/data/gc.prt , see also
 * https://www.ncbi.nlm.nih.gov/Taxonomy/Utils/wprintgc.cgi . codon-tables.test.ts checks this data
 * against a copy of NCBI gc.prt version 4.6 (test/oracle/seqtools/ncbi_gc.prt).
 *
 * Each table is stored in NCBI's layout: `ncbieaa` lists the amino acid of the 64 codons in the
 * order TTT, TTC, TTA, TTG, TCT, ... GGG (bases T, C, A, G; the first base varies slowest), with
 * '*' for codons that are never translated. Codons are DNA (T, never U).
 */

/** One NCBI genetic code. All codons are uppercase DNA triplets (T, never U). */
export interface GeneticCode {
  /** NCBI table id, i.e. the value of a `/transl_table` qualifier (1 = standard, 11 = bacterial). */
  readonly id: number;
  /** NCBI name of the code, e.g. 'Bacterial, Archaeal and Plant Plastid'. */
  readonly name: string;
  /**
   * Every name Biopython registers for the code (alternative names such as 'SGC0' included), plus
   * the current NCBI name where NCBI renamed the code later (gc.prt 4.6: table 24 is now
   * 'Rhabdopleuridae Mitochondrial').
   */
  readonly names: readonly string[];
  /**
   * Amino acid (one-letter code) of every codon that is translated, keyed by codon (61 to 64
   * entries). Codons that only terminate translation are absent. A codon present here AND in
   * `stopCodons` (tables 27, 28 and 31) is a context-dependent stop: it codes for the amino acid
   * inside a gene and terminates translation at the end of a gene.
   */
  readonly forwardTable: Readonly<Record<string, string>>;
  /** Codons that can initiate translation (alternative start codons included), in NCBI order. */
  readonly startCodons: readonly string[];
  /** Codons that terminate translation, in NCBI order. */
  readonly stopCodons: readonly string[];
  /** Amino acids of the 64 codons in NCBI order (see {@link NCBI_CODON_ORDER}); '*' = never translated. */
  readonly ncbieaa: string;
}

/** The 64 codons in NCBI order: bases T, C, A, G, first codon position varying slowest (TTT, TTC, ... GGG). */
export const NCBI_CODON_ORDER: readonly string[] = Object.freeze(
  (() => {
    const bases = 'TCAG';
    const out: string[] = [];
    for (const a of bases) for (const b of bases) for (const c of bases) out.push(a + b + c);
    return out;
  })(),
);

interface RawGeneticCode {
  id: number;
  name: string;
  names: string[];
  ncbieaa: string;
  startCodons: string[];
  stopCodons: string[];
}

const RAW_CODES: readonly RawGeneticCode[] = [
"""

FOOTER = """\
];

function buildGeneticCode(raw: RawGeneticCode): GeneticCode {
  const forwardTable: Record<string, string> = {};
  for (let i = 0; i < 64; i++) {
    const aa = raw.ncbieaa[i];
    if (aa !== '*') forwardTable[NCBI_CODON_ORDER[i]] = aa;
  }
  return Object.freeze({
    id: raw.id,
    name: raw.name,
    names: Object.freeze([...raw.names]),
    forwardTable: Object.freeze(forwardTable),
    startCodons: Object.freeze([...raw.startCodons]),
    stopCodons: Object.freeze([...raw.stopCodons]),
    ncbieaa: raw.ncbieaa,
  });
}

/** Every NCBI genetic code known to Biopython, sorted by id (1-6, 9-16, 21-33). Frozen. */
export const GENETIC_CODES: readonly GeneticCode[] = Object.freeze(RAW_CODES.map(buildGeneticCode));

const CODES_BY_ID: ReadonlyMap<number, GeneticCode> = new Map(GENETIC_CODES.map((c) => [c.id, c]));

/**
 * The NCBI genetic code with the given table id (default 1, the standard code).
 * @throws RangeError when no such table exists (NCBI ids 7, 8 and 17-20 are unassigned).
 */
export function getGeneticCode(id = 1): GeneticCode {
  const code = CODES_BY_ID.get(id);
  if (code === undefined) {
    const known = GENETIC_CODES.map((c) => c.id).join(', ');
    throw new RangeError(`Unknown NCBI genetic code (translation table) ${id}; known tables: ${known}`);
  }
  return code;
}
"""


def render():
    rows = table_rows()
    parts = [HEADER.replace("@@BIOPYTHON@@", Bio.__version__)]
    for r in rows:
        parts.append("  {\n")
        parts.append(f"    id: {r['id']},\n")
        parts.append(f"    name: {ts_str(r['name'])},\n")
        parts.append(ts_field("names", r["names"]))
        parts.append(f"    ncbieaa: {ts_str(r['ncbieaa'])},\n")
        parts.append(f"    startCodons: {ts_list(r['starts'])},\n")
        parts.append(f"    stopCodons: {ts_list(r['stops'])},\n")
        parts.append("  },\n")
    parts.append(FOOTER)
    return "".join(parts)


def main():
    text = render()
    if "--stdout" in sys.argv[1:]:
        sys.stdout.write(text)
        return
    OUT.write_text(text, encoding="utf-8", newline="\n")
    print(f"wrote {OUT.relative_to(ROOT)} ({len(text)} bytes)")


if __name__ == "__main__":
    main()
