/**
 * Nearest-neighbour thermodynamic parameters used by the two-state melting model in `tm.ts`.
 *
 * Source: SantaLucia J Jr (1998) "A unified view of polymer, dumbbell, and oligonucleotide DNA
 * nearest-neighbor thermodynamics", Proc Natl Acad Sci USA 95:1460–1465,
 * https://doi.org/10.1073/pnas.95.4.1460 — Table 2 ("unified" parameters, 1 M NaCl).
 * These are exactly the values primer3 (libprimer3 2.6.1 `oligotm.c`, table "DH_/DS_") and
 * Biopython (`MeltingTemp.DNA_NN3`) use, so Tm values agree with both tools.
 *
 * Units: ΔH° in kcal/mol, ΔS° in cal/(K·mol) (entropy units, e.u.). Negative = favours the duplex.
 * The secondary-structure parameters used by the thermodynamic alignment live in `thal-tables.ts`.
 */

/**
 * ΔH°/ΔS° of each Watson–Crick nearest-neighbour stack, keyed by the TOP strand dinucleotide read
 * 5'→3' (the bottom strand is its complement). 'AC' is the stack 5'-AC-3'/3'-TG-5', which
 * SantaLucia (1998) lists as GT/CA (the same stack read on the other strand).
 */
export const SANTALUCIA_1998_STACKS: Readonly<Record<string, readonly [dH: number, dS: number]>> = Object.freeze({
  AA: [-7.9, -22.2], // AA/TT
  TT: [-7.9, -22.2], // AA/TT
  AT: [-7.2, -20.4], // AT/TA
  TA: [-7.2, -21.3], // TA/AT
  CA: [-8.5, -22.7], // CA/GT
  TG: [-8.5, -22.7], // CA/GT
  GT: [-8.4, -22.4], // GT/CA
  AC: [-8.4, -22.4], // GT/CA
  CT: [-7.8, -21.0], // CT/GA
  AG: [-7.8, -21.0], // CT/GA
  GA: [-8.2, -22.2], // GA/CT
  TC: [-8.2, -22.2], // GA/CT
  CG: [-10.6, -27.2], // CG/GC
  GC: [-9.8, -24.4], // GC/CG
  GG: [-8.0, -19.9], // GG/CC
  CC: [-8.0, -19.9], // GG/CC
});

/**
 * Helix initiation with a terminal G·C pair, applied once per duplex end that is G·C
 * (SantaLucia 1998, Table 2, "Init. w/term. G·C"): ΔH° 0.1 kcal/mol, ΔS° −2.8 e.u.
 */
export const SANTALUCIA_1998_INIT_TERMINAL_GC: readonly [dH: number, dS: number] = Object.freeze([0.1, -2.8]);
/**
 * Helix initiation with a terminal A·T pair, applied once per duplex end that is A·T
 * (SantaLucia 1998, Table 2, "Init. w/term. A·T"): ΔH° 2.3 kcal/mol, ΔS° 4.1 e.u.
 */
export const SANTALUCIA_1998_INIT_TERMINAL_AT: readonly [dH: number, dS: number] = Object.freeze([2.3, 4.1]);

/** Symmetry correction for self-complementary duplexes (SantaLucia 1998, Table 2): ΔH° 0, ΔS° −1.4 e.u. */
export const SANTALUCIA_1998_SYMMETRY: readonly [dH: number, dS: number] = Object.freeze([0, -1.4]);

/** Gas constant in cal/(K·mol) as used by SantaLucia (1998), primer3's santalucia/schildkraut branches and Biopython. */
export const R_CAL = 1.987;

/** Gas constant in cal/(K·mol) as used by primer3's Owczarzy branch and its thermodynamic alignment (thal.c). */
export const R_CAL_PRIMER3_THAL = 1.9872;

/** 0 °C in kelvin. */
export const KELVIN_OFFSET = 273.15;
