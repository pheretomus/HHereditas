/**
 * Where a double-stranded DNA fragment ends up on an agarose gel: a smooth semi-logarithmic
 * migration model for virtual gels.
 *
 * POSITIONS are fractions of the gel length measured from the well: 0 = well, 1 = bottom of the gel
 * at the end of a STANDARD RUN, i.e. a run stopped when the bromophenol blue front has travelled
 * about 75-80 % of the gel (Addgene "Agarose Gel Electrophoresis" protocol; {@link BPB_POSITION}).
 *
 * MODEL. For linear DNA of L bp
 *
 *     position(L) = top + span / (1 + (L / midpointBp) ^ exponent),     span = bottom - top
 *
 * a logistic curve in log10(L): straight in a semi-log plot in its middle part (DNA "migrates at
 * rates inversely proportional to the log10 of the number of base pairs", Helling et al. 1974, as
 * quoted by Sambrook & Russell, Molecular Cloning 3rd ed., 2001, p. 5.4), compressing smoothly
 * towards `top` above the resolving window (long DNA reaches a size-independent limiting mobility)
 * and towards `bottom` below it. Strictly decreasing in L.
 *
 * CALIBRATION, for each agarose percentage and buffer:
 *  - the sizes of linear DNA co-migrating with bromophenol blue and xylene cyanol FF
 *    ({@link DYE_COMIGRATION_BP}; Green & Sambrook 2012 as tabulated by Thermo Fisher) must sit at
 *    {@link BPB_POSITION} and at BPB_POSITION / {@link BPB_XC_SPEED_RATIO} (bromophenol blue runs
 *    ~2.2-fold faster than xylene cyanol FF at any agarose concentration; Sambrook & Russell p. 5.9);
 *  - {@link SHAPE_EXPONENT} and {@link SMALL_DNA_POSITION} are the two empirical constants, fitted to
 *    band positions measured on 17 reference gel photographs published by NEB, Thermo Fisher,
 *    Bioneer, Enzynomics and Promega (tools/oracle/gel_oracle.py; pooled RMS error 0.019 of the gel
 *    length / band span).
 * The two dye conditions have a closed-form solution (see {@link gelParameters}), so the curve
 * follows the agarose percentage smoothly. As a result the resolving windows of the NEB and
 * Green & Sambrook guidelines ({@link resolvingWindow}: 0.7 % = 0.8-12 kb, 1 % = 0.5-10 kb,
 * 1.5 % = 0.2-3 kb, 2 % = 0.1-2 kb) land in the central, steep part of the lane, with longer
 * fragments compressed near the top and shorter ones near the bottom (verified in the tests).
 *
 * LIMITS. A visualisation aid, not a sizing method: real runs vary with voltage (high fields
 * compress long DNA), ethidium bromide in the gel (~15 % slower linear DNA; Sambrook & Russell
 * p. 5.5), loading amount, agarose brand and run time. Supported range 0.5-3 % agarose (the range of
 * the calibration tables).
 */

/** Conformation of the DNA molecule. */
export type DnaForm = 'linear' | 'supercoiled' | 'nicked';

/** Electrophoresis buffer. */
export type GelBuffer = 'TAE' | 'TBE';

/** Gel conditions shared by every function of the gel module. */
export interface GelConditions {
  /** Agarose concentration, % (w/v). Default {@link DEFAULT_AGAROSE_PERCENT}; must lie in {@link AGAROSE_PERCENT_RANGE}. */
  agarosePercent?: number;
  /** Running buffer. Default 'TAE'. */
  buffer?: GelBuffer;
}

/** Options of {@link migrate} and {@link sizeAtPosition}. */
export interface MigrationOptions extends GelConditions {
  /** Conformation; default 'linear'. Circular forms use {@link FORM_SIZE_FACTOR} (approximate). */
  form?: DnaForm;
}

/** Default agarose concentration, % (w/v). */
export const DEFAULT_AGAROSE_PERCENT = 1;

/** Supported agarose concentrations, % (w/v): the span of {@link DYE_COMIGRATION_BP} and {@link resolvingWindow}. */
export const AGAROSE_PERCENT_RANGE: Readonly<{ min: number; max: number }> = Object.freeze({ min: 0.5, max: 3 });

/**
 * Position of the bromophenol blue front at the end of a standard run (fraction of the gel length).
 * Addgene, "Agarose Gel Electrophoresis": run "until the dye line is approximately 75-80% of the way
 * down the gel" (midpoint).
 */
export const BPB_POSITION = 0.775;

/**
 * Bromophenol blue migrates ~2.2-fold faster than xylene cyanol FF, independent of the agarose
 * concentration (Sambrook & Russell, Molecular Cloning 3rd ed., 2001, p. 5.9).
 */
export const BPB_XC_SPEED_RATIO = 2.2;

/** Positions of the two tracking-dye fronts at the end of a standard run (same at every agarose %). */
export const DYE_FRONT_POSITIONS: Readonly<{ bromophenolBlue: number; xyleneCyanolFF: number }> = Object.freeze({
  bromophenolBlue: BPB_POSITION,
  xyleneCyanolFF: BPB_POSITION / BPB_XC_SPEED_RATIO,
});

/**
 * Exponent of the logistic curve in log size (dimensionless). Empirical: least-squares fit to the
 * vendor gel photographs listed in tools/oracle/gel_oracle.py (fit 1.119, rounded).
 */
export const SHAPE_EXPONENT = 1.12;

/**
 * Position approached by very short DNA in a standard run (fraction of the gel length). Empirical,
 * same fit as {@link SHAPE_EXPONENT} (fit 0.902, rounded).
 */
export const SMALL_DNA_POSITION = 0.9;

/**
 * Approximate apparent-size factors of circular forms: a molecule of L bp in that form is drawn where
 * linear DNA of `factor * L` bp runs. HEURISTIC values reproducing the order usually seen for 2-10 kb
 * plasmids in 0.7-1.5 % gels stained after the run (supercoiled fastest, nicked/open circular
 * slowest; Thermo Fisher "DNA migration" reference,
 * https://assets.thermofisher.com/TFS-Assets/BID/Reference-Materials/s3-dna-migration-transcript.pdf;
 * Sambrook & Russell p. 5.5). The real mobilities
 * depend on agarose %, voltage, ethidium bromide and superhelical density (Johnson & Grossman,
 * Biochemistry 1977), and large supercoiled plasmids (> ~8 kb) can even run slower than their linear
 * form; always compare with a linearised control.
 */
export const FORM_SIZE_FACTOR: Readonly<Record<DnaForm, number>> = Object.freeze({
  linear: 1,
  supercoiled: 0.7,
  nicked: 1.6,
});

/**
 * Sizes (bp) of linear dsDNA co-migrating with bromophenol blue and xylene cyanol FF:
 * rows `[agarose %, bromophenol blue bp, xylene cyanol FF bp]`, per buffer.
 * Source: Thermo Fisher Scientific, Invitrogen School of Molecular Biology, "Steps in nucleic acid
 * gel electrophoresis", Table 7 (citing Green & Sambrook, Molecular Cloning 4th ed., 2012).
 * Rows above 3 % (4 and 5 %) are omitted: the model has no valid solution there for TAE.
 */
export const DYE_COMIGRATION_BP: Readonly<Record<GelBuffer, ReadonlyArray<readonly [number, number, number]>>> =
  Object.freeze({
    TAE: Object.freeze([
      [0.5, 1150, 16700], [0.6, 850, 11600], [0.7, 660, 8500], [0.8, 530, 6500], [0.9, 440, 5140],
      [1.0, 370, 4160], [1.2, 275, 2890], [1.5, 190, 1840], [2.0, 120, 1040], [3.0, 60, 460],
    ] as const),
    TBE: Object.freeze([
      [0.5, 750, 13000], [0.6, 540, 8820], [0.7, 410, 6400], [0.8, 320, 4830], [0.9, 260, 3770],
      [1.0, 220, 3030], [1.2, 160, 2070], [1.5, 110, 1300], [2.0, 65, 710], [3.0, 30, 300],
    ] as const),
  });

/**
 * Resolving-window guideline: rows `[agarose %, smallest bp, largest bp]` of linear DNA that is well
 * separated. 0.5-1.5 %: NEB "Agarose Gel Resolution" usage guideline ("optimum resolution for linear
 * DNA"); 2 % and 3 %: Thermo Fisher, Invitrogen School of Molecular Biology, Table 3 ("range of
 * efficient separation", citing Green & Sambrook 2012).
 */
export const RESOLVING_WINDOW_BP: ReadonlyArray<readonly [number, number, number]> = Object.freeze([
  [0.5, 1000, 30000], [0.7, 800, 12000], [1.0, 500, 10000], [1.2, 400, 7000], [1.5, 200, 3000],
  [2.0, 100, 2000], [3.0, 25, 1000],
] as const);

/** The migration curve for one gel (see the model description at the top of this file). */
export interface GelParameters {
  /** Agarose concentration, % (w/v). */
  agarosePercent: number;
  /** Running buffer. */
  buffer: GelBuffer;
  /** Position approached by very long linear DNA (the compression zone below the well). */
  topPosition: number;
  /** Position approached by very short DNA ({@link SMALL_DNA_POSITION}). */
  bottomPosition: number;
  /** Size (bp) halfway between top and bottom: centre of the semi-log part of the curve. */
  midpointBp: number;
  /** Steepness exponent ({@link SHAPE_EXPONENT}). */
  exponent: number;
  /** Size (bp) of linear DNA co-migrating with bromophenol blue (interpolated from the table). */
  bromophenolBlueBp: number;
  /** Size (bp) of linear DNA co-migrating with xylene cyanol FF (interpolated from the table). */
  xyleneCyanolBp: number;
}

function checkPercent(agarosePercent: number): void {
  if (!Number.isFinite(agarosePercent) || agarosePercent < AGAROSE_PERCENT_RANGE.min || agarosePercent > AGAROSE_PERCENT_RANGE.max) {
    throw new RangeError(
      `agarose percentage must be between ${AGAROSE_PERCENT_RANGE.min} and ${AGAROSE_PERCENT_RANGE.max} %, got ${agarosePercent}`,
    );
  }
}

function checkBuffer(buffer: GelBuffer): void {
  if (buffer !== 'TAE' && buffer !== 'TBE') throw new RangeError(`unknown gel buffer '${String(buffer)}'`);
}

/**
 * Interpolate the columns of a `[percent, ...values]` table at `percent`: log10(value) is linear in
 * the agarose percentage between neighbouring rows (rows must be sorted by percent).
 */
function interpolateLog(rows: ReadonlyArray<readonly number[]>, percent: number): number[] {
  let i = 0;
  while (i < rows.length - 2 && percent > rows[i + 1][0]) i++;
  const lo = rows[i];
  const hi = rows[i + 1];
  // published rows are returned exactly (10 ** log10(x) can be off by an ulp)
  if (percent === lo[0]) return lo.slice(1);
  if (percent === hi[0]) return hi.slice(1);
  const t = (percent - lo[0]) / (hi[0] - lo[0]);
  const out: number[] = [];
  for (let c = 1; c < lo.length; c++) {
    const a = Math.log10(lo[c]);
    out.push(10 ** (a + t * (Math.log10(hi[c]) - a)));
  }
  return out;
}

/**
 * Parameters of the migration curve for a gel. The two dye conditions p(Lbpb) = P1 and
 * p(Lxc) = P2 (P1 = {@link BPB_POSITION}, P2 = P1 / {@link BPB_XC_SPEED_RATIO}) with bottom
 * position b and exponent k have the closed-form solution
 *
 *     r = (Lxc / Lbpb)^k,  u = ((b - P1)(r - 1) / (P1 - P2) - 1) / r,
 *     span = (b - P1)(1 + u) / u,  top = b - span,  midpoint = Lbpb / u^(1/k)
 *
 * (u = (Lbpb/midpoint)^k; obtained by subtracting the two conditions). Throws RangeError outside
 * {@link AGAROSE_PERCENT_RANGE} or for an unknown buffer.
 */
export function gelParameters(agarosePercent: number = DEFAULT_AGAROSE_PERCENT, buffer: GelBuffer = 'TAE'): GelParameters {
  checkPercent(agarosePercent);
  checkBuffer(buffer);
  const [bpb, xc] = interpolateLog(DYE_COMIGRATION_BP[buffer], agarosePercent);
  const k = SHAPE_EXPONENT;
  const b = SMALL_DNA_POSITION;
  const p1 = DYE_FRONT_POSITIONS.bromophenolBlue;
  const p2 = DYE_FRONT_POSITIONS.xyleneCyanolFF;
  const r = (xc / bpb) ** k;
  const u = (((b - p1) * (r - 1)) / (p1 - p2) - 1) / r;
  // u > 0 for every row of the tables (xylene cyanol co-migrates with >= 7.7x longer DNA than
  // bromophenol blue); guarded so that a table edit cannot silently produce a nonsense curve.
  if (!(u > 0)) throw new Error(`migration model has no solution at ${agarosePercent}% ${buffer}`);
  const span = ((b - p1) * (1 + u)) / u;
  return {
    agarosePercent,
    buffer,
    topPosition: b - span,
    bottomPosition: b,
    midpointBp: bpb / u ** (1 / k),
    exponent: k,
    bromophenolBlueBp: bpb,
    xyleneCyanolBp: xc,
  };
}

/**
 * Position (0 = well .. 1 = bottom) of LINEAR DNA of `sizeBp` on the gel described by `g`.
 * Low-level: no argument checking (use {@link migrate} for validated input).
 */
export function positionOnGel(g: GelParameters, sizeBp: number): number {
  const span = g.bottomPosition - g.topPosition;
  return g.topPosition + span / (1 + (sizeBp / g.midpointBp) ** g.exponent);
}

function checkSize(sizeBp: number): void {
  if (!Number.isFinite(sizeBp) || sizeBp <= 0) throw new RangeError(`fragment size must be a finite number > 0 bp, got ${sizeBp}`);
}

/**
 * {@link FORM_SIZE_FACTOR} of a DNA form, validated (own properties only, so that a stray string from
 * untyped callers such as 'toString' is rejected instead of producing NaN).
 * @throws RangeError for an unknown form
 */
export function formSizeFactor(form: DnaForm): number {
  if (!Object.prototype.hasOwnProperty.call(FORM_SIZE_FACTOR, form)) {
    throw new RangeError(`unknown DNA form '${String(form)}'`);
  }
  return FORM_SIZE_FACTOR[form];
}

/**
 * Relative migration distance of a dsDNA fragment in a standard run: 0 = well, 1 = bottom of the
 * gel (see the file header). Linear DNA: strictly decreasing with size, always inside
 * (topPosition, bottomPosition) ⊂ (0, 1). Supercoiled / nicked circles are placed where linear DNA of
 * `FORM_SIZE_FACTOR[form] * sizeBp` runs (approximation).
 *
 * @param sizeBp length in base pairs (> 0; non-integers allowed)
 * @throws RangeError for a non-positive or non-finite size, an agarose % outside
 *   {@link AGAROSE_PERCENT_RANGE}, or an unknown form / buffer
 */
export function migrate(sizeBp: number, options: MigrationOptions = {}): number {
  checkSize(sizeBp);
  const g = gelParameters(options.agarosePercent ?? DEFAULT_AGAROSE_PERCENT, options.buffer ?? 'TAE');
  return positionOnGel(g, sizeBp * formSizeFactor(options.form ?? 'linear'));
}

/**
 * Inverse of {@link migrate}: the size (bp) of DNA of the given form that runs at `position`.
 * Undefined when the position lies outside the open interval (topPosition, bottomPosition), where the
 * curve is flat and no size can be read off (compression zones, or beyond them).
 *
 * @throws RangeError for a non-finite position or invalid gel options
 */
export function sizeAtPosition(position: number, options: MigrationOptions = {}): number | undefined {
  if (!Number.isFinite(position)) throw new RangeError(`position must be a finite number, got ${position}`);
  const g = gelParameters(options.agarosePercent ?? DEFAULT_AGAROSE_PERCENT, options.buffer ?? 'TAE');
  const factor = formSizeFactor(options.form ?? 'linear');
  if (position <= g.topPosition || position >= g.bottomPosition) return undefined;
  const ratio = (g.bottomPosition - g.topPosition) / (position - g.topPosition) - 1;
  const size = (g.midpointBp * ratio ** (1 / g.exponent)) / factor;
  return Number.isFinite(size) && size > 0 ? size : undefined;
}

/**
 * Guideline size range (bp) of linear DNA resolved well at this agarose concentration
 * ({@link RESOLVING_WINDOW_BP}; log-linear interpolation between the published rows). Buffer-agnostic,
 * as published. Throws RangeError outside {@link AGAROSE_PERCENT_RANGE}.
 */
export function resolvingWindow(agarosePercent: number = DEFAULT_AGAROSE_PERCENT): { minBp: number; maxBp: number } {
  checkPercent(agarosePercent);
  const [minBp, maxBp] = interpolateLog(RESOLVING_WINDOW_BP, agarosePercent);
  return { minBp, maxBp };
}
