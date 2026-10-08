You are a senior engineer on HHereditas: a free, offline, cross-platform (Windows/macOS/Linux now, a mobile viewer later) alternative to SnapGene for molecular-biology labs. Repository: /home/srdgjuchdr/HHereditas (npm workspaces, git). This task is in packages/core (@hhereditas/core): a pure-TypeScript sequence-analysis engine. Files under src/ must not use DOM or Node APIs (the engine runs in a Tauri webview, web workers and tests); test files may use node:fs, node:path, node:child_process, node:os.

READ FIRST:
- packages/core/src/types.ts: the shared data model and the COORDINATE CONVENTIONS (0-based half-open ranges; on circular molecules origin-spanning ranges have end > length; gap positions for cuts/carets; strand 1/-1/0; uppercase IUPAC sequences; FragmentEnds convention for sticky ends). Follow them exactly.
- packages/core/src/seq/alphabet.ts, range.ts, features.ts, id.ts: reuse these helpers (reverseComplement, complement, iupacMatches, iupacToRegexSource, normalizeDna, mod, normalizeRange, normalizeGap, rangeFromInclusive, splitAtOrigin, sliceRange, rangeContainsIndex, rangesOverlap, intersectRanges, coveringRange, featureLabel, getQualifier, featureSequence, featureLength, makeFeature, makeRecord, newId) instead of re-implementing them. Import them from the specific files (e.g. '../seq/range', '../seq/alphabet'), NOT from the '../seq' barrel, because another agent is extending seq/ concurrently.
- packages/core/src/io/types.ts: ParseResult / ParseWarning used by file readers.

TOOLING:
- TypeScript 7 + Vitest 5. Run tests: cd /home/srdgjuchdr/HHereditas/packages/core && npx vitest run <your paths>. Typecheck: npx tsc --noEmit -p /home/srdgjuchdr/HHereditas/packages/core . Other agents are writing other modules in sibling folders AT THE SAME TIME, so tsc/vitest may show errors in files you do not own: ignore those, but your own files must be error-free and your tests green. Always pass your own paths to vitest.
- The compiler is strict (noUnusedLocals/noUnusedParameters, verbatimModuleSyntax so use "import type" for type-only imports, isolatedModules). Use extensionless relative imports.
- Python reference implementations ("oracles") for differential testing: /home/srdgjuchdr/HHereditas/tools/oracle/.venv/bin/python (biopython 1.88, primer3-py 2.3.1, pydna 5.5.16). Put oracle scripts in tools/oracle/ with file names prefixed by your module key; make them deterministic (fixed seeds) and re-runnable; have them write JSON into packages/core/test/oracle/<module key>/ (keep each JSON file under ~2 MB); write Vitest tests that compare the implementation against that JSON. Tests must not need Python to run, except "live oracle" tests that validate output produced at test time: those may call the venv python via child_process and must skip cleanly when the venv is absent.
- Fixtures (read-only): packages/core/test/fixtures/genbank/ (Biopython edge-case files, pUC19_M77789.gb, pBR322_J01749.gb), fixtures/snapgene/*.dna, fixtures/large/ecoli_U00096.3.gb (11.7 MB E. coli genome, gitignored: tests using it must skip when it is absent).
- Web access is available for primary sources (load WebSearch / WebFetch via ToolSearch).

RULES:
- Only create or modify files in your ownership list. Never edit types.ts, seq/alphabet.ts, seq/range.ts, seq/features.ts, seq/id.ts, io/types.ts, any package.json or package-lock.json. If the shared model truly needs a change, work around it locally and explain the request in your final report.
- Do not run npm install or add dependencies (fast-xml-parser is already available to core). If you truly need one, say so in your report.
- Do not commit or otherwise touch git state.
- Pure functions: never mutate inputs; return new objects.
- This is scientific software: a wrong cut site, Tm or coordinate silently corrupts lab work. Prefer correctness and explicit warnings over guessing. Cite the source (paper, standard, datasheet or oracle) of every constant table in a comment.
- Every exported symbol gets a TSDoc comment stating coordinate conventions and units. Code should read like the existing seq/ files: small focused functions, clear names, comments where non-obvious.
- Each module directory gets an index.ts re-exporting its public API (except io/, whose index the integrator writes).
