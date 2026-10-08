#!/usr/bin/env python3
"""Oracle data for the @hhereditas/core `primers` module.

Generates deterministic JSON fixtures in packages/core/test/oracle/primers/:

  tm.json       primer3-py `calc_tm` (schildkraut / santalucia / owczarzy salt corrections) on
                seeded random oligos across a grid of cation / dNTP / oligo concentrations,
                plus long (> 60 nt, GC% formula) sequences, self-complementary oligos and
                DMSO / formamide cases. Biopython `MeltingTemp.Tm_NN` is recorded as a
                secondary sanity check (`santalucia`) and as the reference for the published
                Owczarzy 2008 equation (`owczarzy2008`, Biopython salt correction method 7).
  binding.json  brute-force reference of the anchored primer-binding semantics documented in
                src/primers/binding.ts on random templates with planted sites (mismatches,
                origin-spanning sites, reverse primers, 5' tails, IUPAC codes), plus templates
                as stored in RNA records (U for T) and in lower case, read as their DNA form.
  thal.json     primer3-py `calc_hairpin` / `calc_homodimer` / `calc_heterodimer` /
                `calc_end_stability` (thermodynamic alignment) on seeded random sequences.

Usage (from the repository root):
  tools/oracle/.venv/bin/python tools/oracle/primers_oracle.py [tm] [binding] [thal]
With no argument every section is regenerated. Output is byte-identical between runs.
"""
from __future__ import annotations

import json
import math
import os
import random
import sys
from typing import Any, Callable

import primer3
from Bio.SeqUtils import MeltingTemp as mt

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT_DIR = os.path.join(ROOT, 'packages', 'core', 'test', 'oracle', 'primers')

COMPLEMENT = {'A': 'T', 'C': 'G', 'G': 'C', 'T': 'A'}


def revcomp(s: str) -> str:
    return ''.join(COMPLEMENT[c] for c in reversed(s))


def random_oligo(rng: random.Random, length: int, gc: float) -> str:
    """Random ACGT oligo whose expected GC fraction is `gc`."""
    out = []
    for _ in range(length):
        if rng.random() < gc:
            out.append(rng.choice('GC'))
        else:
            out.append(rng.choice('AT'))
    return ''.join(out)


def write_json(name: str, payload: dict[str, Any]) -> None:
    os.makedirs(OUT_DIR, exist_ok=True)
    path = os.path.join(OUT_DIR, name)
    with open(path, 'w', encoding='utf-8') as fh:
        json.dump(payload, fh, separators=(',', ':'), sort_keys=False)
        fh.write('\n')
    size = os.path.getsize(path)
    print(f'wrote {os.path.relpath(path, ROOT)} ({size / 1024:.0f} KiB)')
    if size > 2 * 1024 * 1024:
        raise SystemExit(f'{name} is larger than 2 MiB')


# ---------------------------------------------------------------------------
# Tm
# ---------------------------------------------------------------------------

METHODS = ('schildkraut', 'santalucia', 'owczarzy')

# Discrete grid (mM, mM, mM, nM) sampled for half of the random cases; the other half draws
# continuous values from the same ranges.
GRID_MV = (10, 25, 50, 100, 200)
GRID_DV = (0, 0.5, 1.5, 3, 5)
GRID_DNTP = (0, 0.2, 0.6, 1)
GRID_DNA = (25, 50, 250, 500)


def p3_tm(seq: str, mv: float, dv: float, dntp: float, dna: float, method: str,
          dmso: float = 0.0, dmso_fact: float = 0.6, formamide: float = 0.0) -> float:
    return primer3.calc_tm(
        seq,
        mv_conc=mv,
        dv_conc=dv,
        dntp_conc=dntp,
        dna_conc=dna,
        dmso_conc=dmso,
        dmso_fact=dmso_fact,
        formamide_conc=formamide,
        salt_corrections_method=method,
    )


def is_self_complementary(seq: str) -> bool:
    return len(seq) % 2 == 0 and seq == revcomp(seq)


def bio_tm(seq: str, mv: float, dv: float, dntp: float, dna: float, saltcorr: int) -> float:
    """Biopython Tm_NN with the SantaLucia (1998) unified table and primer3's concentration
    convention (C/4 for non-self-complementary duplexes, C for self-complementary ones)."""
    selfcomp = is_self_complementary(seq)
    return mt.Tm_NN(
        seq,
        nn_table=mt.DNA_NN3,
        dnac1=dna if selfcomp else dna / 4.0,
        dnac2=0,
        selfcomp=selfcomp,
        Na=mv,
        Mg=dv,
        dNTPs=dntp,
        saltcorr=saltcorr,
    )


def random_conditions(rng: random.Random) -> tuple[float, float, float, float]:
    if rng.random() < 0.5:
        return (rng.choice(GRID_MV), rng.choice(GRID_DV), rng.choice(GRID_DNTP), rng.choice(GRID_DNA))
    mv = round(rng.uniform(10, 200), 3)
    dv = 0.0 if rng.random() < 0.15 else round(rng.uniform(0, 5), 3)
    dntp = 0.0 if rng.random() < 0.15 else round(rng.uniform(0, 1), 3)
    dna = round(rng.uniform(25, 500), 3)
    return (mv, dv, dntp, dna)


def tm_row(seq: str, cond: tuple[float, float, float, float]) -> list[Any]:
    mv, dv, dntp, dna = cond
    return [seq, mv, dv, dntp, dna] + [p3_tm(seq, mv, dv, dntp, dna, m) for m in METHODS]


def gen_tm() -> None:
    rng = random.Random(20261008)
    random_cases = []
    # >= 2000 unambiguous random oligos of 8-60 nt with varied GC content.
    for _ in range(2400):
        length = rng.randint(8, 60)
        gc = rng.uniform(0.1, 0.9)
        random_cases.append(tm_row(random_oligo(rng, length, gc), random_conditions(rng)))
    # Extreme compositions (all-AT, all-GC, homopolymers, alternating).
    for _ in range(150):
        length = rng.randint(8, 60)
        gc = rng.choice((0.0, 1.0))
        random_cases.append(tm_row(random_oligo(rng, length, gc), random_conditions(rng)))
    for base in 'ACGT':
        for length in (8, 20, 37, 60):
            random_cases.append(tm_row(base * length, random_conditions(rng)))
    # Self-complementary (palindromic) oligos exercise the symmetry correction.
    self_comp = []
    for _ in range(300):
        half = random_oligo(rng, rng.randint(4, 30), rng.uniform(0.1, 0.9))
        self_comp.append(tm_row(half + revcomp(half), random_conditions(rng)))
    # Very short oligos (primer3 accepts >= 2 nt).
    short = []
    for _ in range(150):
        length = rng.randint(2, 7)
        short.append(tm_row(random_oligo(rng, length, rng.uniform(0, 1)), random_conditions(rng)))
    # Long sequences: primer3 switches to the GC% formula above max_nn_length (60).
    long_rows = []
    for _ in range(300):
        length = rng.randint(61, 400)
        long_rows.append(tm_row(random_oligo(rng, length, rng.uniform(0.1, 0.9)), random_conditions(rng)))
    # DMSO / formamide (primer3's linear corrections), santalucia + owczarzy + long formula.
    additives = []
    for _ in range(300):
        length = rng.choice((rng.randint(8, 60), rng.randint(61, 150)))
        seq = random_oligo(rng, length, rng.uniform(0.1, 0.9))
        mv, dv, dntp, dna = random_conditions(rng)
        dmso = round(rng.choice((0, rng.uniform(0, 10))), 3)
        dmso_fact = round(rng.choice((0.6, rng.uniform(0.5, 0.75))), 3)
        formamide = round(rng.choice((0, rng.uniform(0, 1.5))), 3)
        additives.append([seq, mv, dv, dntp, dna, dmso, dmso_fact, formamide]
                         + [p3_tm(seq, mv, dv, dntp, dna, m, dmso, dmso_fact, formamide) for m in METHODS])
    # Biopython: SantaLucia entropy salt correction (method 5) and Owczarzy 2008 (method 7).
    biopython = []
    for _ in range(600):
        length = rng.randint(8, 60)
        seq = random_oligo(rng, length, rng.uniform(0.1, 0.9))
        if rng.random() < 0.1:
            half = seq[: length // 2]
            seq = half + revcomp(half)
        mv, dv, dntp, dna = random_conditions(rng)
        biopython.append([seq, mv, dv, dntp, dna, bio_tm(seq, mv, dv, dntp, dna, 5),
                          bio_tm(seq, mv, dv, dntp, dna, 7)])

    write_json('tm.json', {
        'generator': 'tools/oracle/primers_oracle.py tm',
        'oracle': f'primer3-py {primer3.__version__} calc_tm (libprimer3 2.6.1 oligotm.c / seqtm); '
                  f'Biopython {__import__("Bio").__version__} MeltingTemp.Tm_NN (DNA_NN3)',
        'columns': ['seq', 'mv_mM', 'dv_mM', 'dntp_mM', 'dna_nM', 'tm_schildkraut', 'tm_santalucia', 'tm_owczarzy'],
        'random': random_cases,
        'selfComplementary': self_comp,
        'short': short,
        'long': long_rows,
        'additivesColumns': ['seq', 'mv_mM', 'dv_mM', 'dntp_mM', 'dna_nM', 'dmso_percent', 'dmso_factor',
                             'formamide_M', 'tm_schildkraut', 'tm_santalucia', 'tm_owczarzy'],
        'additives': additives,
        'biopythonColumns': ['seq', 'mv_mM', 'dv_mM', 'dntp_mM', 'dna_nM', 'tm_bio_saltcorr5', 'tm_bio_saltcorr7'],
        'biopython': biopython,
    })


# ---------------------------------------------------------------------------
# Binding sites: brute-force reference of the semantics documented in src/primers/binding.ts
# ---------------------------------------------------------------------------

IUPAC = {
    'A': 'A', 'C': 'C', 'G': 'G', 'T': 'T', 'R': 'AG', 'Y': 'CT', 'S': 'CG', 'W': 'AT',
    'K': 'GT', 'M': 'AC', 'B': 'CGT', 'D': 'AGT', 'H': 'ACT', 'V': 'ACG', 'N': 'ACGT',
}
IUPAC_COMPLEMENT = {
    'A': 'T', 'T': 'A', 'C': 'G', 'G': 'C', 'R': 'Y', 'Y': 'R', 'S': 'S', 'W': 'W',
    'K': 'M', 'M': 'K', 'B': 'V', 'V': 'B', 'D': 'H', 'H': 'D', 'N': 'N',
}
RESUME_MATCHES = 2  # matches that must follow an accepted mismatch (one nearest-neighbour stack)


def iupac_accepts(pattern: str, base: str) -> bool:
    """Primer code `pattern` accepts template code `base` when every base `base` may be is in `pattern`."""
    if pattern not in IUPAC or base not in IUPAC:
        return False
    return set(IUPAC[base]) <= set(IUPAC[pattern])


def read_template(template: str) -> str:
    """Template as binding.ts reads it: ASCII lower case as upper case, U as T (RNA records keep U)."""
    return ''.join(chr(ord(ch) - 32) if 'a' <= ch <= 'z' else ch for ch in template).replace('U', 'T')


def brute_force_sites(template: str, circular: bool, primer: str, min_anneal: int, anchor3: int,
                      max_mismatches: int) -> list[dict[str, int]]:
    template = read_template(template)
    L, n = len(template), len(primer)
    sites: list[dict[str, int]] = []
    if L == 0 or n == 0:
        return sites
    min_anneal = max(1, min_anneal)
    anchor = min(anchor3, n)
    for strand in (1, -1):
        for q in range(L):  # template index paired with the primer's 3'-terminal base
            if circular:
                limit = min(n, L)
            elif strand == 1:
                limit = min(n, q + 1)
            else:
                limit = min(n, L - q)

            def ok(k: int) -> bool:
                pb = primer[n - 1 - k]
                if strand == 1:
                    tb = template[(q - k) % L] if circular else template[q - k]
                    return iupac_accepts(pb, tb)
                tb = template[(q + k) % L] if circular else template[q + k]
                return iupac_accepts(IUPAC_COMPLEMENT.get(pb, '?'), tb)

            if limit < anchor or not all(ok(k) for k in range(anchor)):
                continue
            k, mismatches = anchor, 0
            while k < limit:
                if ok(k):
                    k += 1
                elif (mismatches < max_mismatches and k + RESUME_MATCHES < limit
                      and all(ok(k + j) for j in range(1, RESUME_MATCHES + 1))):
                    mismatches += 1
                    k += 1 + RESUME_MATCHES
                else:
                    break
            if k < min_anneal:
                continue
            start = (q - k + 1) % L if strand == 1 else q
            if not circular and strand == 1:
                start = q - k + 1
            sites.append({'strand': strand, 'start': start, 'end': start + k, 'annealedLength': k,
                          'mismatches': mismatches, 'tailLength': n - k})
    sites.sort(key=lambda s: (s['start'], -s['strand'], s['end']))
    return sites


def random_iupac(rng: random.Random, length: int, ambiguity: float) -> str:
    codes = 'RYSWKMBDHVN'
    return ''.join(rng.choice(codes) if rng.random() < ambiguity else rng.choice('ACGT') for _ in range(length))


def expand_one(rng: random.Random, seq: str) -> str:
    return ''.join(rng.choice(IUPAC[c]) for c in seq)


def plant(template: list[str], start: int, text: str) -> None:
    L = len(template)
    for i, ch in enumerate(text):
        template[(start + i) % L] = ch


def mutate(rng: random.Random, seq: str, count: int, protect3: int) -> str:
    """Introduce `count` substitutions outside the 3'-terminal `protect3` bases."""
    s = list(seq)
    positions = list(range(0, max(0, len(s) - protect3)))
    rng.shuffle(positions)
    for pos in positions[:count]:
        s[pos] = rng.choice([b for b in 'ACGT' if b not in IUPAC.get(s[pos], s[pos])] or ['A'])
    return ''.join(s)


BINDING_OPTION_SETS = [
    {'minAnneal': 15, 'anchor3': 5, 'maxMismatches': 0},
    {'minAnneal': 12, 'anchor3': 3, 'maxMismatches': 1},
    {'minAnneal': 15, 'anchor3': 5, 'maxMismatches': 2},
    {'minAnneal': 18, 'anchor3': 8, 'maxMismatches': 3},
    {'minAnneal': 10, 'anchor3': 0, 'maxMismatches': 2},
    {'minAnneal': 8, 'anchor3': 1, 'maxMismatches': 0},
]


def random_binding_case(rng: random.Random, case_index: int) -> tuple[str, bool, str, dict[str, int]]:
    """Random template with 0-3 planted (mutated, truncated, reverse, origin-spanning) primer sites."""
    circular = rng.random() < 0.5
    L = rng.choice((rng.randint(20, 120), rng.randint(120, 1500)))
    template = list(random_oligo(rng, L, rng.uniform(0.3, 0.7)))
    if rng.random() < 0.2:  # sprinkle ambiguity codes into the template
        for _ in range(rng.randint(1, 6)):
            template[rng.randrange(L)] = rng.choice('NRYSWKM')
    core_len = rng.randint(10, 30)
    primer_core = random_iupac(rng, core_len, 0.15 if rng.random() < 0.3 else 0.0)
    tail = random_oligo(rng, rng.choice((0, 0, rng.randint(1, 15))), 0.5)
    primer = tail + primer_core
    # plant 0-3 copies of (a possibly mutated / truncated) primer core
    for _ in range(rng.randint(0, 3)):
        text = expand_one(rng, primer_core)
        if rng.random() < 0.4:
            text = mutate(rng, text, rng.randint(1, 3), rng.choice((0, 3, 6)))
        if rng.random() < 0.15:
            text = text[-rng.randint(5, len(text)):]  # only the 3' part
        if len(text) > L:
            text = text[-L:]
        strand = rng.choice((1, -1))
        if circular and rng.random() < 0.4:
            start = (L - rng.randint(1, max(1, len(text) - 1))) % L  # across the origin
        else:
            start = rng.randint(0, max(0, L - len(text)))
        plant(template, start, text if strand == 1 else ''.join(IUPAC_COMPLEMENT[c] for c in reversed(text)))
    return ''.join(template), circular, primer, BINDING_OPTION_SETS[case_index % len(BINDING_OPTION_SETS)]


def stored_form(rng: random.Random, template: str, form: int) -> str:
    """The template as an RNA record stores it (form 0), in lower case (1), or both mixed (2)."""
    if form in (0, 2):
        template = template.replace('T', 'U')
    if form == 1:
        return template.lower()
    if form == 2:
        return ''.join(ch.lower() if rng.random() < 0.3 else ch for ch in template)
    return template


def gen_binding() -> None:
    rng = random.Random(1008)
    cases = []
    for case_index in range(260):
        t, circular, primer, options = random_binding_case(rng, case_index)
        cases.append({
            'template': t,
            'topology': 'circular' if circular else 'linear',
            'primer': primer,
            'options': options,
            'sites': brute_force_sites(t, circular, primer, options['minAnneal'], options['anchor3'],
                                       options['maxMismatches']),
        })
    # Edge cases: primer longer than the template, empty primer, all-N primer, tiny circles.
    edge_specs = [
        ('ACGTACGGATCCTTAGCAAT', 'linear', 'GGGGGACGTACGGATCCTTAGCAAT', BINDING_OPTION_SETS[0]),
        ('ACGTACGGATCCTTAGCAAT', 'circular', 'TTAGCAATACGTACGGATCCTTAGCAAT', BINDING_OPTION_SETS[0]),
        ('ACGTACGGATCCTTAGCAAT', 'circular', 'ATCCTTAGCAATACGTACGGATCCTTAGCAAT', {'minAnneal': 10, 'anchor3': 5, 'maxMismatches': 1}),
        ('ACGTACGGATCCTTAGCAAT', 'linear', '', BINDING_OPTION_SETS[0]),
        ('ACGTACGGATCCTTAGCAATGGCA', 'linear', 'N' * 18, BINDING_OPTION_SETS[0]),
        ('ACGTACGGATCCTTAGCAATGGCA', 'circular', 'N' * 18, BINDING_OPTION_SETS[0]),
        ('ACGTNNGGATCCTTAGCAATGGCA', 'circular', 'N' * 18, BINDING_OPTION_SETS[1]),
        ('', 'linear', 'ACGTACGTACGTACGTACGT', BINDING_OPTION_SETS[0]),
        ('GAATTC', 'circular', 'GAATTC', {'minAnneal': 4, 'anchor3': 2, 'maxMismatches': 0}),
        ('GAATTCGAATTC', 'circular', 'GAATTCGAATTCGAATTC', {'minAnneal': 6, 'anchor3': 2, 'maxMismatches': 0}),
        ('AAAAAAAAAAAAAAAAAAAAAAAAA', 'linear', 'AAAAAAAAAAAAAAAA', BINDING_OPTION_SETS[0]),
        ('AAAAAAAAAAAAAAAAAAAAAAAAA', 'circular', 'TTTTTTTTTTTTTTTTTT', BINDING_OPTION_SETS[2]),
    ]
    for template, topology, primer, options in edge_specs:
        cases.append({
            'template': template,
            'topology': topology,
            'primer': primer,
            'options': options,
            'sites': brute_force_sites(template, topology == 'circular', primer, options['minAnneal'],
                                       options['anchor3'], options['maxMismatches']),
        })
    # Templates as stored in RNA records (U for T) and in lower case: the sites of their DNA form.
    rng_forms = random.Random(2026_1008)
    for case_index in range(60):
        t, circular, primer, options = random_binding_case(rng_forms, case_index)
        shown = stored_form(rng_forms, t, case_index % 3)
        cases.append({
            'template': shown,
            'topology': 'circular' if circular else 'linear',
            'primer': primer,
            'options': options,
            'sites': brute_force_sites(shown, circular, primer, options['minAnneal'], options['anchor3'],
                                       options['maxMismatches']),
        })
    total_sites = sum(len(c['sites']) for c in cases)
    write_json('binding.json', {
        'generator': 'tools/oracle/primers_oracle.py binding',
        'oracle': 'brute-force Python reference of the anchored binding semantics (every position, both strands)',
        'resumeMatches': RESUME_MATCHES,
        'totalSites': total_sites,
        'cases': cases,
    })


# ---------------------------------------------------------------------------
# Thermodynamic alignment (hairpins, dimers, 3'-end stability)
# ---------------------------------------------------------------------------

TETRALOOPS = ['GGAAAC', 'CGCAAG', 'AGAAAT', 'TGAAAA', 'GGGGAC', 'CTTCGG', 'GCTTGC', 'TTTCGA', 'AAAAAT', 'CAACCG']
TRILOOPS = ['AGAAT', 'CGCAG', 'GGGAC', 'TGTAA', 'CGAAG']


def thal_conditions(rng: random.Random) -> list[float]:
    mv, dv, dntp, dna = random_conditions(rng)
    temp_c = rng.choice((37.0, 37.0, 25.0, 50.0, 60.0, round(rng.uniform(20, 70), 3)))
    max_loop = rng.choice((30, 30, 30, 15, 5, 0))
    return [mv, dv, dntp, dna, temp_c, max_loop]


def thal_kwargs(cond: list[float], structure: bool) -> dict[str, Any]:
    mv, dv, dntp, dna, temp_c, max_loop = cond
    kwargs = {'mv_conc': mv, 'dv_conc': dv, 'dntp_conc': dntp, 'dna_conc': dna, 'temp_c': temp_c,
              'max_loop': int(max_loop)}
    if structure:  # calc_end_stability has no structure output
        kwargs['output_structure'] = True
    return kwargs


def structure_lines(r: Any) -> str:
    """ASCII structure without the SEQ/STR prefixes (rows joined by newlines)."""
    if not r.structure_found or getattr(r, 'ascii_structure', None) is None:
        return ''
    rows = r.ascii_structure.rstrip('\n').split('\n')
    return '\n'.join(row[4:] if row[:4] in ('SEQ\t', 'STR\t') else row for row in rows)


def thal_row(seqs: list[str], cond: list[float], fn: Callable[..., Any]) -> list[Any]:
    r = fn(*seqs, **thal_kwargs(cond, fn is not primer3.calc_end_stability))
    return seqs + cond + [bool(r.structure_found), r.tm, r.dg, r.dh, r.ds, structure_lines(r)]


def stem_loop(rng: random.Random) -> str:
    stem = random_oligo(rng, rng.randint(4, 12), rng.uniform(0.3, 0.7))
    loop = random_oligo(rng, rng.randint(3, 12), rng.uniform(0.2, 0.6))
    arm = revcomp(stem)
    if rng.random() < 0.4:  # a mismatch, bulge or internal loop in the stem
        k = rng.randrange(1, len(arm) - 1) if len(arm) > 2 else 0
        kind = rng.random()
        if kind < 0.4:
            arm = arm[:k] + rng.choice([b for b in 'ACGT' if b != arm[k]]) + arm[k + 1:]
        elif kind < 0.7:
            arm = arm[:k] + random_oligo(rng, rng.randint(1, 3), 0.5) + arm[k:]
        else:
            arm = arm[:k] + arm[k + rng.randint(1, 2):]
    seq = random_oligo(rng, rng.randint(0, 10), 0.5) + stem + loop + arm + random_oligo(rng, rng.randint(0, 10), 0.5)
    return seq[:60]


def mutate_indels(rng: random.Random, seq: str, events: int) -> str:
    s = seq
    for _ in range(events):
        if len(s) < 4:
            break
        k = rng.randrange(1, len(s) - 1)
        kind = rng.random()
        if kind < 0.5:
            s = s[:k] + rng.choice([b for b in 'ACGT' if b != s[k]]) + s[k + 1:]
        elif kind < 0.75:
            s = s[:k] + random_oligo(rng, rng.randint(1, 4), 0.5) + s[k:]
        else:
            s = s[:k] + s[k + rng.randint(1, 3):]
    return s


def gen_thal() -> None:
    rng = random.Random(4242)
    hairpins, homodimers, heterodimers, ends = [], [], [], []
    for _ in range(700):
        seq = random_oligo(rng, rng.randint(5, 60), rng.uniform(0.2, 0.8))
        hairpins.append(thal_row([seq], thal_conditions(rng), primer3.calc_hairpin))
    for _ in range(350):
        hairpins.append(thal_row([stem_loop(rng)], thal_conditions(rng), primer3.calc_hairpin))
    for loop in TETRALOOPS + TRILOOPS:
        for _ in range(6):
            arm = random_oligo(rng, rng.randint(3, 7), 0.5)
            seq = random_oligo(rng, rng.randint(0, 6), 0.5) + arm + loop + revcomp(arm) + random_oligo(rng, rng.randint(0, 6), 0.5)
            hairpins.append(thal_row([seq], thal_conditions(rng), primer3.calc_hairpin))
    for _ in range(60):
        seq = list(stem_loop(rng))
        for _ in range(rng.randint(1, 3)):
            seq[rng.randrange(len(seq))] = 'N'
        hairpins.append(thal_row([''.join(seq)], thal_conditions(rng), primer3.calc_hairpin))
    for _ in range(500):
        seq = random_oligo(rng, rng.randint(5, 60), rng.uniform(0.2, 0.8))
        homodimers.append(thal_row([seq], thal_conditions(rng), primer3.calc_homodimer))
    for _ in range(150):
        half = random_oligo(rng, rng.randint(3, 20), rng.uniform(0.2, 0.8))
        homodimers.append(thal_row([half + revcomp(half)], thal_conditions(rng), primer3.calc_homodimer))
    for _ in range(150):  # primers whose 3' end is self-complementary
        tail = random_oligo(rng, rng.randint(2, 5), 0.5)
        seq = random_oligo(rng, rng.randint(10, 30), 0.5) + tail + revcomp(tail)
        homodimers.append(thal_row([seq], thal_conditions(rng), primer3.calc_homodimer))
    for _ in range(600):
        s1 = random_oligo(rng, rng.randint(5, 60), rng.uniform(0.2, 0.8))
        s2 = random_oligo(rng, rng.randint(5, 60), rng.uniform(0.2, 0.8))
        heterodimers.append(thal_row([s1, s2], thal_conditions(rng), primer3.calc_heterodimer))
    for _ in range(350):
        s1 = random_oligo(rng, rng.randint(8, 60), rng.uniform(0.2, 0.8))
        a = rng.randrange(0, len(s1) - 4)
        b = rng.randint(a + 4, len(s1))
        s2 = random_oligo(rng, rng.randint(0, 8), 0.5) + mutate_indels(rng, revcomp(s1[a:b]), rng.randint(0, 3)) \
            + random_oligo(rng, rng.randint(0, 8), 0.5)
        heterodimers.append(thal_row([s1, s2[:60] or 'A'], thal_conditions(rng), primer3.calc_heterodimer))
    for _ in range(80):  # one sequence longer than 60 nt
        s1 = random_oligo(rng, rng.randint(10, 40), 0.5)
        s2 = random_oligo(rng, rng.randint(61, 250), 0.5)
        k = rng.randrange(0, len(s2) - len(s1))
        s2 = s2[:k] + revcomp(s1) + s2[k + len(s1):]
        pair = [s1, s2] if rng.random() < 0.5 else [s2, s1]
        heterodimers.append(thal_row(pair, thal_conditions(rng), primer3.calc_heterodimer))
    for _ in range(400):
        s1 = random_oligo(rng, rng.randint(8, 40), rng.uniform(0.2, 0.8))
        if rng.random() < 0.5:
            s2 = random_oligo(rng, rng.randint(0, 20), 0.5) + revcomp(s1[-rng.randint(3, 12):]) + random_oligo(rng, rng.randint(0, 20), 0.5)
        else:
            s2 = random_oligo(rng, rng.randint(8, 40), rng.uniform(0.2, 0.8))
        ends.append(thal_row([s1, s2], thal_conditions(rng), primer3.calc_end_stability))
    write_json('thal.json', {
        'generator': 'tools/oracle/primers_oracle.py thal',
        'oracle': f'primer3-py {primer3.__version__} calc_hairpin / calc_homodimer / calc_heterodimer / '
                  'calc_end_stability (libprimer3 2.6.1 thal.c), output_structure=True',
        'columns': ['seq...', 'mv_mM', 'dv_mM', 'dntp_mM', 'dna_nM', 'temp_C', 'max_loop', 'found', 'tm_C',
                    'dg_cal_per_mol', 'dh_cal_per_mol', 'ds_cal_per_K_mol', 'ascii_structure'],
        'hairpin': hairpins,
        'homodimer': homodimers,
        'heterodimer': heterodimers,
        'endStability': ends,
    })


SECTIONS: dict[str, Callable[[], None]] = {'tm': gen_tm, 'binding': gen_binding, 'thal': gen_thal}


def main(argv: list[str]) -> None:
    names = argv or list(SECTIONS)
    for name in names:
        if name not in SECTIONS:
            raise SystemExit(f'unknown section {name!r}; choose from {", ".join(SECTIONS)}')
        SECTIONS[name]()


if __name__ == '__main__':
    main(sys.argv[1:])
