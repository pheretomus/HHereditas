MODULE KEY: gel
OWNERSHIP: packages/core/src/gel/** (ladders.ts, migration.ts, index.ts, *.test.ts).

API:
  interface LadderBand { size: number /* bp */; massNg?: number /* ng in the vendor's recommended load */; emphasized?: boolean /* reference band printed brighter */ }
  interface Ladder { id: string; name: string; vendor: string; catalog?: string; source: string /* URL of the datasheet you verified */; bands: LadderBand[] /* largest first */ }
  LADDERS: Ladder[]: at least NEB 1 kb DNA Ladder (N3232), NEB 1 kb Plus DNA Ladder (N3200), NEB 100 bp DNA Ladder (N3231), Thermo GeneRuler 1 kb (SM0311), GeneRuler 1 kb Plus (SM1331), GeneRuler 100 bp Plus (SM0321), GeneRuler DNA Ladder Mix (SM0331), Invitrogen 1 Kb Plus (10787018), Promega 1 kb (G5711), the classic λ DNA/HindIII marker, plus ladders common in Korean labs if you can verify them (e.g. Enzynomics, Bioneer, Takara, Dyne). EVERY band size and mass MUST be verified from the vendor's product page or datasheet via WebSearch/WebFetch: put the source URL in the ladder's 'source'. Omit any ladder you cannot verify rather than guessing.
  migrate(sizeBp: number, options?: { agarosePercent?: number /* default 1.0 */; form?: 'linear' | 'supercoiled' | 'nicked' }): number
     // relative migration distance 0 (well) .. 1 (bottom of a standard run), strictly decreasing with size for linear DNA; a smooth semi-log model whose resolving window depends on the agarose percentage (cite the guideline you calibrate against, e.g. 0.7% ≈ 0.8–12 kb, 1% ≈ 0.5–10 kb, 1.5% ≈ 0.2–3 kb, 2% ≈ 0.1–2 kb); fragments above the window compress near the top, below it near the bottom. Supercoiled plasmid runs faster than linear DNA of the same size, nicked/open-circular slower (approximate, documented).
  simulateLane(fragments: Array<{ size: number; molarAmount?: number /* default 1 */; form?: 'linear' | 'supercoiled' | 'nicked'; label?: string }>, options?: { agarosePercent?: number; resolution?: number }): GelBand[]
     // GelBand { size: number; position: number /* 0..1 */; intensity: number /* ∝ size × molarAmount, normalized so the brightest band in the lane is 1 */; count: number /* co-migrating fragments merged */; labels: string[] }
     // fragments closer than the resolution threshold merge into one band with summed intensity.
  ladderLane(ladder: Ladder, options?): GelBand[]   // intensity from the vendor masses
TESTS: monotonicity, window behaviour per agarose %, merging, intensities, every ladder sorted/positive/unique id, a pUC19-like digest lane.
