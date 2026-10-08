#!/usr/bin/env python
"""Generate packages/core/src/enzymes/data.ts from Biopython's REBASE-derived tables.

Usage (from the repository root; deterministic, safe to re-run):

    tools/oracle/.venv/bin/python tools/oracle/enzymes_generate.py
    tools/oracle/.venv/bin/python tools/oracle/enzymes_generate.py --bairoch path/to/bairoch.610

Sources
-------
* Biopython 1.88, Bio.Restriction.Restriction_Dictionary (rest_dict, suppliers, typedict),
  compiled by Biopython from REBASE "emboss" files version 404:
  Roberts RJ, Vincze T, Posfai J, Macelis D. REBASE: a database for DNA restriction and
  modification: enzymes, genes and genomes. Nucleic Acids Res. 2023;51(D1):D629-D630.
  doi:10.1093/nar/gkac975
* Methyl-directed flag: REBASE Bairoch-format file (bairoch.610, 28 Sep 2026), entries whose
  ET line is "R2*" ("the restriction enzyme is of type 2, but only recognizes the sequence
  when it is methylated", bairoch.doc section 2.2). The list is embedded below so the script
  runs offline; pass --bairoch FILE to recompute it from a newer download
  (http://rebase.neb.com/rebase/link_bairoch).

Selection rule
--------------
Every enzyme whose cleavage positions are defined (Biopython classes OneCut / TwoCuts) is
emitted. Enzymes with at least one supplier are commercial; the others are kept with
commercial = false (empty supplier string) because they still appear on published maps and
in older protocols; the UI filters them out by default. Enzymes whose cleavage is unknown
(Biopython NoCut) are excluded: their cut positions cannot be drawn or simulated.

Cut encoding
------------
For each cleavage event Biopython stores fst5/fst3 (and scd5/scd3 for a second event):
fst5 = top-strand cut, as a gap position counted from the first base of the site;
fst3 = bottom-strand cut counted from the END of the site (top-strand coordinates).
data.ts stores both as gap positions from the first base of the site:
top = fst5, bottom = size + fst3 (e.g. EcoRI G^AATTC -> 1, 5; BsaI GGTCTC(1/5) -> 7, 11).
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

import Bio
from Bio.Restriction.Restriction_Dictionary import rest_dict, suppliers, typedict

REPO_ROOT = Path(__file__).resolve().parents[2]
OUT_PATH = REPO_ROOT / "packages" / "core" / "src" / "enzymes" / "data.ts"

IUPAC = {
    "A": "A", "C": "C", "G": "G", "T": "T", "R": "AG", "Y": "CT", "S": "CG", "W": "AT",
    "K": "GT", "M": "AC", "B": "CGT", "D": "AGT", "H": "ACT", "V": "ACG", "N": "ACGT",
}
COMPLEMENT = dict(zip("ACGTRYSWKMBDHVN", "TGCAYRSWMKVHDBN"))

# REBASE bairoch.610 (28 Sep 2026): every entry with ET line "R2*" (methyl-directed type II).
METHYL_DIRECTED_REBASE_610 = (
    "AbaAI AbaBGI AbaCI AbaDI AbaHI AbaSI AbaTI AbaUI AbaUMB2I AcaPI Ala17612I AoxI AspBHI "
    "AspTB23I BbiDI Bce1273I Bce95I BceLI BceYI BisI BlsI BmeDI Bth171I CbuDI CfrCI CfuI "
    "DauS27I Dde51507I DpnI Dsp20I EcoBLMcrX EcoO157SI ElmI EsaMMI EsaNI Esp638I FcyTI FspEI "
    "FtnUIV GlaI GluI HboP9I HhaN23I HhiPV4I HpaD253I Hsa13891I HspDL1I HspZ19I KroI LpnPI "
    "LsaM18I MalI MbaR4I Mph1103II MspAK21I MspJI Mte37I MteI Nan19573II NgoAVI NgoDXIV NhoI "
    "NmeAII NmeBL859I NmuDI NmuEI NspC1119I NsuDI NtiG33I PaePS50I Pam7902I Pan13I PatTI PcsI "
    "Pfl8569I PfrCI PkrI PpeHI Pps170I Pru4541I Psp4BI Psp67I PsuGI PxyI RdeR2I Rfl17I RlaI "
    "SbgI ScoA3IV Sde240I SgeI SghWI SgrTI SguI Spe345I SqiI SruGX10I Sve396I SziI TagI "
    "TbiR51I TdeI VarFI Vsi48I Vvu009I YkrI"
).split()


def reverse_complement(site: str) -> str:
    return "".join(COMPLEMENT[c] for c in reversed(site))


def display_name(biopython_name: str) -> str:
    """REBASE spelling of a Biopython enzyme name (Biopython replaces '-' by '_', e.g. CviKI_1)."""
    return biopython_name.replace("_", "-")


def biopython_name(name: str) -> str:
    """Inverse of display_name."""
    return name.replace("-", "_")


def enzyme_cuts(entry: dict) -> list[tuple[int, int]]:
    """Cleavage events as (top, bottom) gap positions relative to the first base of the site."""
    size = entry["size"]
    cuts = [(entry["fst5"], size + entry["fst3"])]
    if entry["scd5"] is not None:
        cuts.append((entry["scd5"], size + entry["scd3"]))
    return cuts


def biopython_types() -> dict[str, tuple[str, ...]]:
    out = {}
    for _key, (bases, names) in typedict.items():
        for n in names:
            out[n] = bases
    return out


def select_enzymes() -> list[str]:
    """Biopython names of every enzyme with defined cleavage, sorted case-insensitively."""
    types = biopython_types()
    names = [n for n, e in rest_dict.items() if e["fst5"] is not None]
    for n in names:
        assert types[n][1] in ("OneCut", "TwoCuts"), n
    return sorted(names, key=lambda n: (n.lower(), n))


def read_methyl_directed(bairoch_path: str | None) -> set[str]:
    if bairoch_path is None:
        return set(METHYL_DIRECTED_REBASE_610)
    names, current = set(), None
    with open(bairoch_path, encoding="latin-1") as fh:
        for line in fh:
            if line.startswith("ID   "):
                current = line[5:].strip()
            elif line.startswith("ET   ") and current is not None:
                if re.fullmatch(r"R\d\*", line[5:].strip()):
                    names.add(current)
    return names


def check_entry(name: str, entry: dict, types: dict) -> list[str]:
    """Sanity checks; returns human-readable notes for source inconsistencies (not fatal)."""
    notes = []
    site = entry["site"]
    assert site and all(c in IUPAC for c in site), (name, site)
    assert entry["size"] == len(site), name
    cuts = enzyme_cuts(entry)
    palindromic = site == reverse_complement(site)
    assert palindromic == (types[name][0] == "Palindromic"), name
    if any(t - b != entry["ovhg"] for t, b in cuts):
        notes.append(
            f"{display_name(name)}: Biopython ovhg={entry['ovhg']} disagrees with fst5/fst3 "
            f"(cuts {cuts} -> overhang {cuts[0][0] - cuts[0][1]}); cuts are taken from fst5/fst3."
        )
    if palindromic:
        mirrored = sorted((len(site) - b, len(site) - t) for t, b in cuts)
        if mirrored != sorted(cuts):
            notes.append(
                f"{display_name(name)}: palindromic site {site} with asymmetric cleavage {cuts}; "
                "the search applies the mirrored cut as well (both orientations are recognised)."
            )
    return notes


def ts_string(s: str) -> str:
    assert "'" not in s and "\\" not in s
    return f"'{s}'"


def generate(bairoch_path: str | None) -> str:
    types = biopython_types()
    methyl = read_methyl_directed(bairoch_path)
    names = select_enzymes()
    lower = {}
    for n in names:
        key = display_name(n).lower()
        assert key not in lower, f"case-insensitive name clash: {n} / {lower[key]}"
        lower[key] = n

    notes: list[str] = []
    rows = []
    for n in names:
        e = rest_dict[n]
        notes += check_entry(n, e, types)
        cuts = enzyme_cuts(e)
        flat = ", ".join(f"{t}, {b}" for t, b in cuts)
        supp = "".join(sorted(e["suppl"]))
        assert all(code in suppliers for code in supp), n
        rows.append(
            f"  [{ts_string(display_name(n))}, {ts_string(e['site'])}, [{flat}], {ts_string(supp)}],"
        )

    commercial = sum(1 for n in names if rest_dict[n]["suppl"])
    methyl_in_data = sorted((display_name(n) for n in names if n in methyl), key=str.lower)
    supplier_lines = [
        f"  {code}: {ts_string(suppliers[code][0])}," for code in sorted(suppliers)
    ]
    rebase_version = re.search(r"emboss files version (\d+)", sys.modules[
        "Bio.Restriction.Restriction_Dictionary"].__doc__ or "")
    version = rebase_version.group(1) if rebase_version else "unknown"
    note_lines = "\n".join(f" *   - {line}" for line in notes) or " *   (none)"

    return f"""/**
 * Restriction enzyme catalogue. GENERATED FILE: DO NOT EDIT BY HAND.
 *
 * Source: REBASE, the Restriction Enzyme Database, "emboss" release {version}, as compiled into
 * Biopython {Bio.__version__} (Bio.Restriction.Restriction_Dictionary: rest_dict, suppliers, typedict).
 *   Roberts RJ, Vincze T, Posfai J, Macelis D. REBASE: a database for DNA restriction and
 *   modification: enzymes, genes and genomes. Nucleic Acids Res. 2023;51(D1):D629-D630.
 *   doi:10.1093/nar/gkac975
 *   Cock PJA et al. Biopython: freely available Python tools for computational molecular
 *   biology and bioinformatics. Bioinformatics. 2009;25(11):1422-1423.
 * Methyl-directed flags: REBASE Bairoch format (bairoch.610, 28 Sep 2026), entries typed "R2*"
 * ("only recognizes the sequence when it is methylated").
 *
 * Regenerate (from the repository root):
 *   tools/oracle/.venv/bin/python tools/oracle/enzymes_generate.py
 *
 * Selection: every enzyme whose cleavage positions are defined ({len(names)} enzymes). {commercial} have at
 * least one supplier (commercial); the other {len(names) - commercial} are kept with an empty supplier string
 * (commercial = false) because they still appear on published maps and in older protocols.
 * Enzymes whose cleavage is unknown in REBASE are excluded.
 *
 * Row format: [name, site, cuts, suppliers]
 *   name      REBASE name (Biopython writes 'CviKI_1' for REBASE 'CviKI-1'; the REBASE spelling is used).
 *   site      recognition sequence 5'->3' on the top strand, uppercase IUPAC.
 *   cuts      flat list of (top, bottom) pairs, one pair per cleavage event: GAP positions relative to
 *             the first base of the site, both in top-strand coordinates (Biopython: top = fst5,
 *             bottom = size + fst3). EcoRI G^AATTC -> [1, 5]; BsaI GGTCTC(1/5) -> [7, 11];
 *             BaeI (10/15)ACNNNNGTAYC(12/7) -> [-10, -15, 23, 18].
 *   suppliers REBASE supplier codes (see SUPPLIERS), sorted; '' = not commercially available.
 *
 * Inconsistencies found in the source data (checked by the generator):
{note_lines}
 */

/** REBASE / Biopython release this catalogue was generated from (for "About" dialogs). */
export const ENZYME_DATA_SOURCE = {{
  rebaseEmbossRelease: {ts_string(version)},
  biopythonVersion: {ts_string(Bio.__version__)},
  methylDirectedSource: 'REBASE bairoch.610 (2026-09-28)',
}} as const;

/** REBASE supplier code -> company name (from Biopython's `suppliers` table). */
export const SUPPLIERS: Readonly<Record<string, string>> = Object.freeze({{
{chr(10).join(supplier_lines)}
}});

/** One enzyme: [name, site, flat (top, bottom) cut pairs, supplier codes]. */
export type EnzymeRow = readonly [name: string, site: string, cuts: readonly number[], suppliers: string];

/** All enzymes with defined cleavage, sorted case-insensitively by name. */
export const ENZYME_ROWS: readonly EnzymeRow[] = [
{chr(10).join(rows)}
];

/**
 * Enzymes of {{@link ENZYME_ROWS}} that REBASE classifies as methyl-directed: they cleave only when
 * their site is methylated (e.g. DpnI needs Dam-methylated GATC) and do not cut PCR products.
 */
export const METHYL_DIRECTED_ENZYMES: readonly string[] = [
{chr(10).join(f"  {ts_string(n)}," for n in methyl_in_data)}
];
"""


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--bairoch", help="REBASE Bairoch-format file to read methyl-directed enzymes from")
    parser.add_argument("--out", default=str(OUT_PATH), help="output path (default: %(default)s)")
    args = parser.parse_args()
    text = generate(args.bairoch)
    Path(args.out).write_text(text, encoding="utf-8")
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
