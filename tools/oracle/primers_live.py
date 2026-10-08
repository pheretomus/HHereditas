#!/usr/bin/env python3
"""Live primer3-py oracle for the @hhereditas/core `primers` tests.

Reads one JSON request object from stdin and writes one JSON response to stdout. Every key is a
list of argument tuples; the response has the same keys with one result per tuple:

  "tm":           [seq, mv_mM, dv_mM, dntp_mM, dna_nM, salt_method]             -> float (°C)
  "hairpin":      [seq, mv_mM, dv_mM, dntp_mM, dna_nM, temp_C, max_loop]        -> result object
  "homodimer":    [seq, mv_mM, dv_mM, dntp_mM, dna_nM, temp_C, max_loop]        -> result object
  "heterodimer":  [seq1, seq2, mv_mM, dv_mM, dntp_mM, dna_nM, temp_C, max_loop] -> result object
  "endStability": [seq1, seq2, mv_mM, dv_mM, dntp_mM, dna_nM, temp_C, max_loop] -> result object

Result objects are {"found": bool, "tm": °C, "dg": cal/mol, "dh": cal/mol, "ds": cal/(K·mol)}
exactly as primer3-py's ThermoResult reports them. Deterministic, no randomness.
Usage: tools/oracle/.venv/bin/python tools/oracle/primers_live.py < request.json
"""
from __future__ import annotations

import json
import sys

import primer3


def thermo_result(r: primer3.thermoanalysis.ThermoResult) -> dict:
    return {'found': r.structure_found, 'tm': r.tm, 'dg': r.dg, 'dh': r.dh, 'ds': r.ds}


def thermo_kwargs(mv: float, dv: float, dntp: float, dna: float, temp_c: float, max_loop: int) -> dict:
    return {'mv_conc': mv, 'dv_conc': dv, 'dntp_conc': dntp, 'dna_conc': dna, 'temp_c': temp_c,
            'max_loop': max_loop}


def main() -> None:
    request = json.load(sys.stdin)
    response: dict[str, list] = {}
    for seq, mv, dv, dntp, dna, method in request.get('tm', []):
        response.setdefault('tm', []).append(primer3.calc_tm(
            seq, mv_conc=mv, dv_conc=dv, dntp_conc=dntp, dna_conc=dna, salt_corrections_method=method))
    for seq, mv, dv, dntp, dna, temp_c, max_loop in request.get('hairpin', []):
        response.setdefault('hairpin', []).append(thermo_result(primer3.calc_hairpin(
            seq, **thermo_kwargs(mv, dv, dntp, dna, temp_c, max_loop))))
    for seq, mv, dv, dntp, dna, temp_c, max_loop in request.get('homodimer', []):
        response.setdefault('homodimer', []).append(thermo_result(primer3.calc_homodimer(
            seq, **thermo_kwargs(mv, dv, dntp, dna, temp_c, max_loop))))
    for s1, s2, mv, dv, dntp, dna, temp_c, max_loop in request.get('heterodimer', []):
        response.setdefault('heterodimer', []).append(thermo_result(primer3.calc_heterodimer(
            s1, s2, **thermo_kwargs(mv, dv, dntp, dna, temp_c, max_loop))))
    for s1, s2, mv, dv, dntp, dna, temp_c, max_loop in request.get('endStability', []):
        response.setdefault('endStability', []).append(thermo_result(primer3.calc_end_stability(
            s1, s2, **thermo_kwargs(mv, dv, dntp, dna, temp_c, max_loop))))
    json.dump(response, sys.stdout)


if __name__ == '__main__':
    main()
